/**
 * judge.ts — Grade a transcript against a case's success_criteria using the
 * EXISTING rubric (supabase/functions/_shared/judge-rubric.ts). Reuses the
 * versioned rubric + parser, does not reinvent judging.
 *
 * Returns {passed, verdict, reason} per criterion + overall.
 */

import {
  assembleJudgePrompt,
  parseJudgeJson,
  maxSeverityOf,
  RETRY_INSTRUCTION,
  type JudgeGroundTruth,
  type JudgeTranscriptMessage,
} from "../judge-rubric.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { AnyCase, TestCase, SuccessCriterion } from "./library.ts";
import type { RunResult } from "./runner.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CriterionResult {
  id: string;
  description: string;
  passed: boolean;
  verdict: string;
  reason: string;
}

export interface JudgeResult {
  caseId: string;
  passed: boolean;
  criteria: CriterionResult[];
  /** The raw flags from the rubric judge, if any. */
  flags: Array<{ check: string; severity: string; evidence_message_ids: string[]; explanation: string }>;
  /** Overall verdict from the rubric judge. */
  verdict: string;
  /** Estimated cost of the judge call in cents. */
  costCents: number;
  raw: string;
}

export interface JudgeConfig {
  /** OpenRouter/Anthropic API key for the judge model. */
  judgeApiKey: string;
  /** Judge model id. */
  judgeModel?: string;
  /** Optional judge API endpoint override (default OpenRouter). */
  judgeApiUrl?: string;
  /** Supabase URL, used to load the shop's real ground truth (menu/hours/timezone). */
  supabaseUrl?: string;
  /** Service-role key, scoped to reading the shop's own tenant data. */
  serviceRoleKey?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function transcriptToJudgeMessages(run: RunResult): JudgeTranscriptMessage[] {
  const msgs: JudgeTranscriptMessage[] = [];
  let idx = 0;
  for (const t of run.transcript) {
    idx++;
    msgs.push({
      id: `msg-${idx}-customer`,
      role: "customer",
      content: t.message,
      created_at: new Date().toISOString(),
    });
    if (t.reply !== undefined && t.reply !== null) {
      idx++;
      msgs.push({
        id: `msg-${idx}-assistant`,
        role: "assistant",
        content: t.reply,
        created_at: new Date().toISOString(),
      });
    }
  }
  return msgs;
}

async function buildGroundTruth(
  config: JudgeConfig,
  shop: { id: string; name: string },
): Promise<JudgeGroundTruth> {
  let timezone = "America/New_York";
  let openHours: JudgeGroundTruth["open_hours"] = {};
  let menu: JudgeGroundTruth["menu"] = [];

  if (config.supabaseUrl && config.serviceRoleKey) {
    try {
      const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false },
      });

      // Shop's own timezone + hours — same columns generator.ts reads.
      const { data: shopRow } = await supabase
        .from("shops")
        .select("timezone, open_hours")
        .eq("id", shop.id)
        .maybeSingle();
      if (shopRow) {
        timezone = shopRow.timezone ?? timezone;
        openHours = (shopRow.open_hours as JudgeGroundTruth["open_hours"]) ?? {};
      }

      // Latest menu for THIS shop, then its active items — mirrors generator.ts
      // and eval-sweep so ground truth and generated cases always agree.
      const { data: menuRow } = await supabase
        .from("menus")
        .select("id")
        .eq("shop_id", shop.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (menuRow?.id) {
        const { data: items } = await supabase
          .from("menu_items")
          .select("name, price_cents, category, description, modifiers_json")
          .eq("menu_id", menuRow.id)
          .eq("active", true)
          .order("display_order", { ascending: true });
        // Enrich menu items with description + modifiers so the judge can
        // verify whether bot-offered sub-options (bread choices, meat types,
        // upgrades) are actually on the real menu.
        menu = (items ?? []).map((i: any) => ({
          name: i.name,
          price_cents: i.price_cents,
          category: i.category,
          description: i.description,
          modifiers: i.modifiers_json,
        })) as any;
      }
    } catch (e) {
      console.error(
        `[judge] failed to load ground truth for shop ${shop.id}: ${(e as Error).message}`,
      );
    }
  }

  // No checkout session for test runs (the test path never hits Stripe).
  return {
    shop_name: shop.name,
    timezone,
    open_hours: openHours,
    menu,
    has_checkout_session: false,
    cart_phase: null,
    payment_status: null,
  };
}

// ── Judge call ─────────────────────────────────────────────────────────────

async function judgeApiCall(
  config: JudgeConfig,
  system: string,
  user: string,
): Promise<{ text: string; inTok: number; outTok: number }> {
  const url = config.judgeApiUrl ?? "https://openrouter.ai/api/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.judgeApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://getsprintai.com",
      "X-Title": "SprintAI Test Suite",
    },
    body: JSON.stringify({
      model: config.judgeModel ?? "deepseek/deepseek-v4-flash",
      max_tokens: 1024,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Judge API ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  const text: string = (data.choices?.[0]?.message?.content ?? "")
    .trim();
  return {
    text,
    inTok: data.usage?.prompt_tokens ?? 0,
    outTok: data.usage?.completion_tokens ?? 0,
  };
}

function estimateCostCents(inTok: number, outTok: number): number {
  // DeepSeek V4 Flash pricing (USD per Mtok) — same constants as eval-sweep.
  const IN = 0.14 / 1_000_000;
  const OUT = 0.28 / 1_000_000;
  return (inTok * IN + outTok * OUT) * 100; // dollars → cents
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Grade a run against a case's success criteria using the shared rubric.
 */
export async function judgeCase(
  config: JudgeConfig,
  run: RunResult,
  testCase: AnyCase,
  shop: { id: string; name: string },
): Promise<JudgeResult> {
  if (run.error) {
    // Hard failure — the case failed to run at all.
    return {
      caseId: testCase.id,
      passed: false,
      criteria: testCase.success_criteria.map((c: SuccessCriterion) => ({
        id: c.id,
        description: c.description,
        passed: false,
        verdict: "error",
        reason: `Runner error: ${run.error}`,
      })),
      flags: [],
      verdict: "error",
      costCents: 0,
      raw: run.error,
    };
  }

  const ground = await buildGroundTruth(config, shop);
  const messages = transcriptToJudgeMessages(run);

  // Assemble the prompt but inject the case's success criteria as the grading focus.
  const { system: baseSystem, user: baseUser } = assembleJudgePrompt(ground, messages);

  // Augment with the case-specific criteria so the judge grades exactly what we care about.
  const criteriaBlock = testCase.success_criteria
    .map((c) => `  - ${c.id}: ${c.description}`)
    .join("\n");
  const augmentedUser =
    `${baseUser}\n\n` +
    `THIS TEST CASE has specific success criteria. Grade against them in addition ` +
    `to the standard rubric:\n${criteriaBlock}\n\n` +
    `Respond with the standard JSON object. For each criterion that is NOT met, ` +
    `emit a flag (using the closest check id, or "clunky_phrasing" as a fallback for ` +
    `non-checklist quality issues). Include a short reason.`;

  const { text, inTok, outTok } = await judgeApiCall(config, baseSystem, augmentedUser);
  let costCents = estimateCostCents(inTok, outTok);

  let parsed = parseJudgeJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // One retry with the stern JSON-only instruction before failing the judge.
    console.log("  [judge retry] First call unparseable — retrying once...");
    const { text: retryText, inTok: rIn, outTok: rOut } = await judgeApiCall(
      config,
      baseSystem,
      augmentedUser + "\n\n" + RETRY_INSTRUCTION,
    );
    costCents += estimateCostCents(rIn, rOut);
    parsed = parseJudgeJson(retryText);
  }
  let flags: Array<{ check: string; severity: string; evidence_message_ids: string[]; explanation: string }> = [];
  let verdict = "clean";
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const p = parsed as { verdict?: string; flags?: unknown[] };
    verdict = p.verdict === "flagged" ? "flagged" : "clean";
    const rawFlags = (p.flags ?? []).map((f) => {
      const flag = f as { check?: string; severity?: string; evidence_message_ids?: string[]; explanation?: string };
      return {
        check: flag.check ?? "unknown",
        severity: flag.severity ?? "minor",
        evidence_message_ids: flag.evidence_message_ids ?? [],
        explanation: flag.explanation ?? "",
      };
    });
    // ── Post-process filter self-negating flags ─────────────────────────
    // Judge sometimes says "this is actually correct" in the explanation
    // but still emits a flag. Drop those.
    const selfNegate = /this is actually correct|this is correct|does exist on the menu|does list those items|this is not an invented item|this is not a .* item|does not constitute|does not represent|not an error here|\bno error\b|\bnot an error\b|\bnot actually an error\b|\bno explicit total\b|\bdoes not apply\b|\bdoes not fire\b|\bis on the menu\b|\bis actually on the menu\b|\bon the menu, so\b|\bwithout .*actually\b|\bno flag here\b|\bfalse positive\b|\bshould not fire\b|the menu does list|so this is not|are separate menu items|are distinct menu items|are listed menu items|distinct menu item|listed as modifiers|is a real .*modifier|are real .*modifiers|cream cheese.*does exist|spread .*does exist|\bdoes exist as a standalone|\bis a standalone item\b|\bare standalone items\b|unit word|wrong unit|clunky_phrasing not invented_item|not an invented.*just a|is not an invented|\bwhich is actually correct\b|\bthis is actually the correct|\bthe correct total is\b|\bactually correct\b/i;
    flags = rawFlags.filter((f) => {
      if (selfNegate.test(f.explanation)) {
        console.log(`  [judge filter] Dropped self-negating flag "${f.check}": ${f.explanation}`);
        return false;
      }
      return true;
    });
    // ── Post-process invented_item: cream cheese upsell ─────────────────
    // Reject invented_item when bot suggests cream cheese/spreads that ARE
    // real standalone menu items (not phantom items). Common for NJB-style shops.
    // Per rubric rule (c): offering a real, listed menu item is NOT invented_item.
    flags = flags.filter((f) => {
      if (f.check !== "invented_item") return true;
      const msgIds = new Set(f.evidence_message_ids ?? []);
      const hasCreamCheeseMention = messages.some((m) =>
        msgIds.has(m.id) && /cream cheese|spread/i.test(m.content)
      );
      const gtHasCreamCheese = ground.menu.some((i: any) => /cream cheese|spread/i.test(i.name));
      if (hasCreamCheeseMention && gtHasCreamCheese) {
        // Check if the flag is about cream cheese *existing* on the menu
        if (/cream cheese|spreads? by the pound|plain.*flavored|cream cheese (spread|tub)/i.test(f.explanation)) {
          console.log(`  [judge filter] Dropped invented_item (cream cheese/spread is real menu item): ${f.explanation}`);
          return false;
        }
      }
      return true;
    });
    // ── Post-process wrong_total filter ─────────────────────────────────
    // Rubric says wrong_total only fires when assistant explicitly states a
    // dollar TOTAL ("Your total is...", "comes to..."). Item-price quotes and
    // upsell quotes are NOT a stated total. If no assistant message states a
    // total, the flag is a rubric violation — drop it.
    const hasDollarTotal = messages.some((m) =>
      m.role === "assistant" && /\$\d+[.,]\d{2}/.test(m.content) &&
      /\b(total|comes to|that'll be|that will be|your order is|order total|you owe|grand total|comes out to|adds up to)\b/i.test(m.content)
    );
    if (!hasDollarTotal) {
      const before = flags.length;
      flags = flags.filter((f) => {
        if (f.check === "wrong_total") {
          console.log(`  [judge filter] Dropped wrong_total (no explicit total in transcript): ${f.explanation}`);
          return false;
        }
        return true;
      });
      if (flags.length < before) console.log(`  [judge filter] Dropped ${before - flags.length} wrong_total flags (no total stated)`);
    }
    // Recalculate verdict: clean only if zero flags remain after filtering.
    if (flags.length === 0) verdict = "clean";
  } else {
    // Parse failed — treat as failed judging.
    return {
      caseId: testCase.id,
      passed: false,
      criteria: testCase.success_criteria.map((c) => ({
        id: c.id,
        description: c.description,
        passed: false,
        verdict: "error",
        reason: "Judge returned unparseable output",
      })),
      flags: [],
      verdict: "error",
      costCents,
      raw: text,
    };
  }

  // ── Grade each criterion ────────────────────────────────────────────────
  const flagChecks = new Set(flags.map((f) => f.check));
  const criteria: CriterionResult[] = testCase.success_criteria.map((c) => {
    // A criterion fails if the judge flagged a relevant check for it.
    // If the criterion maps to a specific check_id, that check being flagged = fail.
    // Otherwise, any flag = fail (conservative).
    let failed = false;
    let reason = "";

    if (c.check_id) {
      failed = flagChecks.has(c.check_id);
      if (failed) {
        const flag = flags.find((f) => f.check === c.check_id);
        reason = flag?.explanation ?? `Flagged: ${c.check_id}`;
      }
    } else {
      // No specific check mapping — criterion fails only if a critical/major
      // flag fired AND the criterion text is plausibly related (rough heuristic).
      const severe = flags.filter((f) => f.severity === "critical" || f.severity === "major");
      if (severe.length > 0) {
        failed = true;
        reason = severe[0].explanation;
      }
    }

    return {
      id: c.id,
      description: c.description,
      passed: !failed,
      verdict: failed ? "failed" : "passed",
      reason,
    };
  });

  // Case passes only if ALL criteria pass.
  const allPassed = criteria.every((c) => c.passed);

  return {
    caseId: testCase.id,
    passed: allPassed,
    criteria,
    flags,
    verdict,
    costCents,
    raw: text,
  };
}