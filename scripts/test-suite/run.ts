#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * run.ts — CLI entrypoint for the shop conversation test suite engine.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read scripts/test-suite/run.ts <shop_id> [--limit N] [--dry-run]
 *
 * --dry-run: generate + print cases, NO bot calls, NO LLM cost, NO persist.
 * --limit N: run at most N cases (default: run all generated cases).
 *
 * Secrets: sourced from environment (see .env or inline). Required:
 *   SPRINTAI_CHAT_SUPABASE_URL
 *   SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (for judge LLM, routed through OpenRouter)
 */

import { generateCases } from "./generator.ts";
import { runCase } from "./runner.ts";
import { judgeCase } from "./judge.ts";
import { buildScorecard, formatScorecard, type ScoredCase } from "./scorecard.ts";
import { persistResults } from "./persist.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── SCORER_VERSION — frozen 2026-08-28 ────────────────────────────────────
// Do not change scoring logic without recording why and incrementing this.
const SCORER_VERSION = 3;
import { generateRootCauseFix } from "./fix.ts";
import { verifyCartOpsInvariants, verifyStatedTotal, verifyCheckoutFinalize, verifyHallucinationGuard, verifyCartPersistence } from "./cart-ops.ts";
import { verifyHoursClosed } from "./hours-closed.ts";

// ── Config from env ────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Chat function URL for web-chat-test path.
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL or SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = Deno.args;
if (args.length === 0 || args.includes("--help")) {
  console.log("Usage: deno run --allow-net --allow-env --allow-read scripts/test-suite/run.ts <shop_id> [--limit N] [--dry-run] [--cases id1,id2,...]");
  console.log("  --dry-run    Generate + print cases, NO bot calls, NO LLM cost.");
  console.log("  --limit N    Run at most N cases.");
  console.log("  --cases CSV  Run only the listed case ids (comma-separated).");
  Deno.exit(0);
}

const shopId = args[0];
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && limitIdx + 1 < args.length ? parseInt(args[limitIdx + 1], 10) : null;
const casesIdx = args.indexOf("--cases");
const casesFilter = casesIdx >= 0 && casesIdx + 1 < args.length
  ? new Set(args[casesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// ── Generate cases ─────────────────────────────────────────────────────────

console.log(`\nGenerating test cases for shop ${shopId}...`);
const genResult = await generateCases({
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  shopId,
});

console.log(
  `Shop: ${genResult.shop.name} (tenant: ${genResult.shop.tenant_id}) | ` +
  `Menu items: ${genResult.menuItemCount} | ` +
  `Cases: ${genResult.derivedCount} menu-derived + ${genResult.libraryCount} library + ` +
  `${genResult.cartOpsCount} CartOps + ${genResult.conversationalCount} conversational = ${genResult.cases.length} total`,
    `Including ${genResult.hoursClosedCount} hours-closed `,
);

console.log(`\n═══ TEST CASES ═══`);
for (const c of genResult.cases) {
  const crit = c.criticality === "critical" ? " [CRITICAL]" : "";
  console.log(`  [${c.category}] ${c.label}${crit}`);
}

if (dryRun) {
  console.log("\n=== DRY RUN COMPLETE (no bot calls, no LLM cost, no persist) ===");
  // Print one detailed case as a sample
  const sample = genResult.cases[0];
  if (sample) {
    console.log(`\nSAMPLE CASE: ${sample.label}`);
    console.log(JSON.stringify(sample, null, 2));
  }
  Deno.exit(0);
}

// ── Filter by limit ────────────────────────────────────────────────────────

let casesToRun = genResult.cases;

if (casesFilter) {
  const filtered = casesToRun.filter((c) => casesFilter.has(c.id));
  const notFound = [...casesFilter].filter((id) => !casesToRun.some((c) => c.id === id));
  if (notFound.length > 0) {
    console.log(`\n⚠ Missing case ids: ${notFound.join(", ")}`);
  }
  if (filtered.length === 0) {
    console.error("No matching cases found. Exiting.");
    Deno.exit(1);
  }
  console.log(`\nFiltering to ${filtered.length} specific cases: ${filtered.map((c) => c.id).join(", ")}`);
  casesToRun = filtered;
} else if (limit !== null && limit > 0 && limit < casesToRun.length) {
  console.log(`\nLimiting to ${limit} cases...`);
  casesToRun = casesToRun.slice(0, limit);
}

// ── Run cases ──────────────────────────────────────────────────────────────

console.log(`\nRunning ${casesToRun.length} test cases...`);
const runConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_FUNCTION_URL,
  simulatorApiKey: ANTHROPIC_API_KEY,
  simulatorModel: "deepseek/deepseek-v4-flash",
};
const judgeConfig = {
  judgeApiKey: ANTHROPIC_API_KEY,
  judgeModel: "deepseek/deepseek-v4-flash",
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
};
const fixConfig = {
  fixApiKey: ANTHROPIC_API_KEY,
  fixModel: "deepseek/deepseek-v4-flash",
};

const scored: ScoredCase[] = [];
let totalJudgeCost = 0;

for (let i = 0; i < casesToRun.length; i++) {
  const tc = casesToRun[i];
  console.log(`\n[${i + 1}/${casesToRun.length}] ${tc.id}: ${tc.label}`);

  try {
    // 1. Run the bot interaction
    const run = await runCase(runConfig, shopId, tc);
    console.log(`  → ${run.transcript.length} turns returned` + (run.error ? ` (ERROR: ${run.error})` : ""));

    // 2. Judge the result
    console.log(`  → judging...`);
    let judge = await judgeCase(judgeConfig, run, tc, genResult.shop);
    totalJudgeCost += judge.costCents;

    // 3. Stated-total pre-check (console only)
    const totalCheck = verifyStatedTotal(run);
    console.log(`  → Stated-total pre-check: ${totalCheck.passed ? "PASS" : "FAIL"} — ${totalCheck.detail}`);

    // ── v3 three-state scoring (mirrors edge function dispatch) ──────────
    const qualityPassed = judge.passed;
    const expectedItemCents = "expectedItemCents" in tc ? (tc as any).expectedItemCents : undefined;
    const expectsCheckout = "expects_checkout" in tc ? (tc as any).expects_checkout === true : false;
    const hoursMode = "hoursMode" in tc ? (tc as any).hoursMode : undefined;
    const hasCart = (run.transcript ?? []).some((t: any) => (t.cart as any[]).length > 0);
    const appliedInvariants: string[] = [];
    const detReasons: string[] = [];
    let detPassed = true;
    let anyInvariantApplied = false;

    // CartOps — apply whenever server cart was produced
    if (hasCart) {
      const cartOpsVerify = verifyCartOpsInvariants(run);
      let anyCartOpsApplied = false;
      for (const inv of cartOpsVerify.invariants) {
        appliedInvariants.push(`cartops:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
        if (inv.applied) anyCartOpsApplied = true;
      }
      if (anyCartOpsApplied) anyInvariantApplied = true;
      if (!cartOpsVerify.passed) {
        detPassed = false;
        const failed = cartOpsVerify.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
        detReasons.push(`cartops: ${failed.join("; ")}`);
      }
    }

    // Totals
    if ((expectedItemCents ?? 0) > 0 || hasCart) {
      appliedInvariants.push(`stated-total:${totalCheck.passed ? "PASS" : "FAIL"}`);
      if (totalCheck.applied) anyInvariantApplied = true;
      if (!totalCheck.passed) {
        detPassed = false;
        detReasons.push(`stated-total: ${totalCheck.detail}`);
      }
    }

    // Checkout-finalize
    if (expectsCheckout) {
      const supabaseCheckout = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
      const checkoutCheck = await verifyCheckoutFinalize(supabaseCheckout as any, run);
      appliedInvariants.push(`checkout-finalize:${checkoutCheck.passed ? "PASS" : "FAIL"}`);
      if (checkoutCheck.applied) anyInvariantApplied = true;
      if (!checkoutCheck.passed) {
        detPassed = false;
        detReasons.push(`checkout-finalize: ${checkoutCheck.detail}`);
      }
    }

    // Hours-closed HARD verification
    if (hoursMode === "closed") {
      const hoursVerify = verifyHoursClosed(run);
      let anyHoursApplied = false;
      for (const inv of hoursVerify.invariants) {
        appliedInvariants.push(`hours-closed:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
        if (inv.applied) anyHoursApplied = true;
      }
      if (anyHoursApplied) anyInvariantApplied = true;
      if (!hoursVerify.passed) {
        detPassed = false;
        const failed = hoursVerify.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
        detReasons.push(`hours-closed: ${failed.join("; ")}`);
      }
    }

    // Hallucination guard
    {
      const menuNames = await loadMenuNames(shopId);
      if (menuNames.size > 0) {
        const hg = verifyHallucinationGuard(run, menuNames);
        appliedInvariants.push(`hallucination-guard:${hg.passed ? "PASS" : "FAIL"}`);
        if (hg.applied) anyInvariantApplied = true;
        if (!hg.passed) {
          detPassed = false;
          detReasons.push(`hallucination-guard: ${hg.detail}`);
        }
      }
    }

    // Cart persistence
    {
      const cp = verifyCartPersistence(run);
      appliedInvariants.push(`cart-persistence:${cp.passed ? "PASS" : "FAIL"}`);
      if (cp.applied) anyInvariantApplied = true;
      if (!cp.passed) {
        detPassed = false;
        detReasons.push(`cart-persistence: ${cp.detail}`);
      }
    }

    const proofPassed: boolean | null = anyInvariantApplied ? detPassed : null;
    if (!anyInvariantApplied) {
      appliedInvariants.push("no-invariant-applied");
    }

    const status = detPassed ? "PASS" : "FAIL";
    const gradedLabel = anyInvariantApplied ? "" : " (ungraded)";
    console.log(`  → Proof ${status}${gradedLabel} | Quality ${qualityPassed ? "PASS" : "FAIL"} | ${judge.criteria.filter(c => c.passed).length}/${judge.criteria.length} criteria | cost $${(judge.costCents / 100).toFixed(4)}`);

    if (!detPassed) {
      for (const r of detReasons) {
        console.log(`      ✗ ${r}`);
      }
    }

    scored.push({
      testCase: tc, judge, run,
      appliedInvariants,
      deterministicReason: detReasons.join("; "),
      proofPassed,
      qualityPassed,
    });
  } catch (e) {
    console.log(`  → CRASH: ${(e as Error).message}`);
    // Insert a synthetic failure
    const fakeRun = {
      caseId: tc.id,
      shopId,
      transcript: [{ role: "customer" as const, message: "[crash]", reply: `[CRASH: ${(e as Error).message}]` }],
      sessionId: "error",
      error: (e as Error).message,
    };
    const judge = await judgeCase(judgeConfig, fakeRun, tc, genResult.shop);
    scored.push({
      testCase: tc, judge, run: fakeRun,
      appliedInvariants: ["no-invariant-applied"],
      deterministicReason: "",
      proofPassed: null,
      qualityPassed: false,
    });
  }
}

// ── Fix loop: root cause + proposed fix for every FAILING case ────────────
// Criticals first (they must never be left empty).
const failedScored = scored.filter((s) => s.proofPassed === false);
failedScored.sort((a, b) => {
  const rank = (c: string) => (c === "critical" ? 0 : 1);
  return rank(a.testCase.criticality) - rank(b.testCase.criticality);
});

console.log(`\nGenerating root cause + fix for ${failedScored.length} failing cases...`);
let fixFailures = 0;
for (let i = 0; i < failedScored.length; i++) {
  const s = failedScored[i];
  try {
    const fix = await generateRootCauseFix(fixConfig, s.run, s.testCase, s.judge);
    s.fix = fix;
    console.log(`  [${i + 1}/${failedScored.length}] ${s.testCase.id}: ${fix.root_cause.slice(0, 80)}${fix.root_cause.length > 80 ? "…" : ""}`);
  } catch (e) {
    fixFailures++;
    console.log(`  [${i + 1}/${failedScored.length}] ${s.testCase.id}: FIX GEN FAILED: ${(e as Error).message}`);
    s.fix = {
      root_cause: `Case "${s.testCase.id}" failed and root-cause generation errored: ${(e as Error).message}`,
      proposed_fix: `Investigate case "${s.testCase.id}" manually.`,
    };
  }
}
if (fixFailures > 0) {
  console.log(`  ⚠ ${fixFailures} fix-generation calls failed (fallback persisted).`);
}

// ── Scorecard ──────────────────────────────────────────────────────────────

const scorecard = buildScorecard(scored);
console.log(formatScorecard(scorecard, genResult.shop.name));
console.log(`\nTotal judge cost: $${(totalJudgeCost / 100).toFixed(4)}`);

// ── Persist ────────────────────────────────────────────────────────────────

console.log(`\nPersisting results...`);
try {
  const persistResult = await persistResults({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SUPABASE_KEY,
    shopId,
    tenantId: genResult.shop.tenant_id,
    shopName: genResult.shop.name,
    scorecard,
    scored: scored.map((s) => s),
    modelTier: "deepseek-v4-flash-test-suite",
    scorerVersion: SCORER_VERSION,
  });
  console.log(`  Run ID: ${persistResult.runId}`);
  console.log(`  test_runs: 1 row inserted`);
  console.log(`  test_case_results: ${scored.length} rows inserted`);

  // Segment summary: mean segments per checkout-completing conversation.
  const checkerOut = scored.filter((s) =>
    s.run.transcript.some((t) => t.phase === "checkout")
  );
  if (checkerOut.length > 0) {
    // Small inline SMS segment counter (same GSM-7 logic as persist.ts).
    const gsm7 = new Set(
      "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split("")
    );
    const gsm7Ext = new Set("|^{}[]~\\€");
    const segs = (t: string) => {
      if (!t) return 0;
      const isG = [...t].every((c) => gsm7.has(c) || gsm7Ext.has(c));
      if (isG) { const ch = [...t].reduce((n, c) => n + (gsm7Ext.has(c) ? 2 : 1), 0); return ch <= 160 ? 1 : 1 + Math.ceil((ch - 160) / 153); }
      return t.length <= 70 ? 1 : 1 + Math.ceil((t.length - 70) / 67);
    };
    let total = 0;
    for (const s of checkerOut) {
      for (const t of s.run.transcript) {
        if (t.role === "customer" && t.reply) total += segs(t.reply);
      }
    }
    console.log(`  📊 SMS segments: ${checkerOut.length} checkout cases, mean ${Math.round(total / checkerOut.length)} segments/order`);
  } else {
    console.log(`  ⚠ No checkout cases in this run — 0 segment data points`);
  }
} catch (e) {
  console.error(`  Persist failed: ${(e as Error).message}`);
}

console.log("\n=== TEST SUITE COMPLETE ===");

// ── Helper: load menu names for hallucination guard ─────────────────────
async function loadMenuNames(shopId: string): Promise<Set<string>> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data: menus } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!menus?.length) return new Set<string>();
  const { data: items } = await supabase
    .from("menu_items")
    .select("name")
    .eq("menu_id", menus[0].id)
    .eq("active", true);
  return new Set<string>((items ?? []).map((i: { name: string }) => i.name));
}