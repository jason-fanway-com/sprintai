/**
 * SprintAI eval-sweep — the Conversation Judge worker (Spec 06 §3-4).
 *
 * ASYNC, READ-ONLY, OUT-OF-BAND. This is a SCHEDULED sweep (cron / Supabase
 * scheduled function), NEVER called inline by chat-sms. It:
 *   1. Finds completed/idle un-judged conversations PER TENANT.
 *   2. Loads each conversation's transcript + THAT tenant's ground truth
 *      (menu/hours/shop/cart) — absolute tenant isolation.
 *   3. Calls a cheap/fast judge model with the versioned rubric.
 *   4. Writes one conversation_evals row (verdict + flags), idempotent on
 *      (conversation_id, transcript_hash).
 *   5. Assembles + (gated) sends the Telegram digest for NEW critical/major.
 *   6. Reaches the auto-fix seam (OFF by default).
 *
 * HARD INVARIANT: it reads conversations after the fact. It writes ONLY to
 * conversation_evals. It NEVER touches order_carts / messages / checkout. If the
 * LLM is down or this whole function crashes, the diner bot (chat-sms) is
 * completely unaffected — they share no code path and no table writes.
 *
 * Cost/reliability guards:
 *   - cheap model (JUDGE_MODEL, default claude-haiku-4-5)
 *   - one LLM call per conversation
 *   - cap conversations per sweep (MAX_CONVERSATIONS_PER_SWEEP)
 *   - retry/backoff on transient LLM failure
 *   - on LLM/parse failure: write eval verdict='errored' and CONTINUE (never
 *     block, never crash the sweep)
 *   - hard daily spend ceiling (JUDGE_DAILY_SPEND_CEILING_CENTS), logged; stop
 *     judging once exceeded.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  assembleJudgePrompt,
  maxSeverityOf,
  parseJudgeJson,
  RUBRIC_VERSION,
  CHECK_SEVERITY,
  type CheckId,
  type JudgeGroundTruth,
  type JudgeTranscriptMessage,
  type Severity,
} from "../_shared/judge-rubric.ts";
import {
  buildImmediateDigest,
  sendDigest,
  type EvalFlag,
  type FlaggedEvalRow,
} from "../_shared/judge-notify.ts";
import { maybeAutoFix, autofixEnabled } from "../_shared/judge-autofix.ts";

// ─── Config ──────────────────────────────────────────────────────────────────
const JUDGE_MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-haiku-4-5";
const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const IDLE_MINUTES = Number(Deno.env.get("JUDGE_IDLE_MINUTES") ?? "10"); // Spec §6 N=10
const MAX_CONVERSATIONS_PER_SWEEP = Number(
  Deno.env.get("JUDGE_MAX_PER_SWEEP") ?? "50",
);
const MAX_RETRIES = 2;
// Hard daily spend ceiling. Haiku is cheap (~$0.001-0.005/conversation); 200¢/day
// = ~$2/day is a very generous testing-scale ceiling. Named in BUILD-NOTES.
const DAILY_SPEND_CEILING_CENTS = Number(
  Deno.env.get("JUDGE_DAILY_SPEND_CEILING_CENTS") ?? "200",
);
// Rough Haiku pricing for cost accounting (USD per Mtok).
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function transcriptHashInput(msgs: JudgeTranscriptMessage[]): string {
  return msgs.map((m) => `${m.role}:${m.content}`).join("\n");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sum today's spend from conversation_evals so we honor the daily ceiling. */
async function spentTodayCents(supabase: SupabaseClient): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data } = await supabase
    .from("conversation_evals")
    .select("cost_cents")
    .gte("judged_at", since.toISOString());
  return (data ?? []).reduce(
    (acc: number, r: { cost_cents: number | null }) => acc + (Number(r.cost_cents) || 0),
    0,
  );
}

// ─── Ground truth (TENANT-ISOLATED) ────────────────────────────────────────────
// Loads ONLY the given conversation's own tenant/shop data. The shop is derived
// from this conversation's order_cart (or its tenant's single shop). A
// conversation's ground truth is NEVER built from another tenant's menu.
//
// Returns the JudgeGroundTruth PLUS a resolution signal used to annotate eval
// CONFIDENCE (orthogonal to severity): `confidence` is 'high' iff a real, in-
// tenant menu with >=1 item was loaded for this conversation; otherwise 'low'
// (no resolvable shop, or a shop with no menu items). This does NOT change what
// the judge flags — it only labels how much menu ground truth backed the eval.
interface GroundTruthResult {
  ground: JudgeGroundTruth;
  shopId: string | null;
  menuLoaded: boolean;
  confidence: "high" | "low";
}

export async function loadGroundTruth(
  supabase: SupabaseClient,
  conv: { id: string; tenant_id: string },
): Promise<GroundTruthResult> {
  // shop + cart state for THIS conversation
  const { data: cart } = await supabase
    .from("order_carts")
    .select("shop_id, phase, payment_status, stripe_checkout_session_id")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let shopId: string | null = cart?.shop_id ?? null;

  // Fallback: a tenant's shop (still tenant-scoped — only this tenant's shops).
  if (!shopId) {
    const { data: shopRow } = await supabase
      .from("shops")
      .select("id")
      .eq("tenant_id", conv.tenant_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    shopId = shopRow?.id ?? null;
  }

  let shopName = "Unknown shop";
  let timezone = "America/New_York";
  let openHours: JudgeGroundTruth["open_hours"] = {};
  let menu: JudgeGroundTruth["menu"] = [];
  let menuLoaded = false;

  if (shopId) {
    const { data: shop } = await supabase
      .from("shops")
      .select("name, timezone, open_hours, tenant_id")
      .eq("id", shopId)
      .maybeSingle();

    // ISOLATION GUARD: refuse to use a shop that belongs to a different tenant.
    if (shop && shop.tenant_id === conv.tenant_id) {
      shopName = shop.name ?? shopName;
      timezone = shop.timezone ?? timezone;
      openHours = (shop.open_hours as JudgeGroundTruth["open_hours"]) ?? {};

      const { data: menuRow } = await supabase
        .from("menus")
        .select("id")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (menuRow?.id) {
        const { data: items } = await supabase
          .from("menu_items")
          .select("name, price_cents, category")
          .eq("menu_id", menuRow.id)
          .eq("active", true)
          .order("display_order", { ascending: true });
        menu = (items ?? []) as JudgeGroundTruth["menu"];
        // Real menu ground truth = an in-tenant shop whose latest menu has >=1
        // active item. Empty/absent menu stays low-confidence.
        menuLoaded = menu.length > 0;
      }
    } else if (shop && shop.tenant_id !== conv.tenant_id) {
      console.error(
        `[eval-sweep] ISOLATION: shop ${shopId} tenant mismatch for conv ${conv.id}; refusing cross-tenant ground truth.`,
      );
      shopId = null;
    }
  }

  // Confidence: HIGH only when a real, in-tenant menu was actually loaded for
  // this conversation. shopId may be non-null but still yield no menu items →
  // that is LOW (we had no menu ground truth to judge invented_item against).
  const confidence: "high" | "low" = (shopId && menuLoaded) ? "high" : "low";

  return {
    ground: {
      shop_name: shopName,
      timezone,
      open_hours: openHours,
      menu,
      has_checkout_session: Boolean(cart?.stripe_checkout_session_id),
      cart_phase: cart?.phase ?? null,
      payment_status: cart?.payment_status ?? null,
    },
    shopId,
    menuLoaded,
    confidence,
  };
}

// ─── Judge LLM call ─────────────────────────────────────────────────────────────
interface JudgeCallResult {
  flags: EvalFlag[];
  raw: string;
  costCents: number;
}

function estimateCostCents(inTok: number, outTok: number): number {
  return (
    (inTok / 1_000_000) * PRICE_IN_PER_MTOK * 100 +
    (outTok / 1_000_000) * PRICE_OUT_PER_MTOK * 100
  );
}

function coerceFlags(parsed: unknown): EvalFlag[] {
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { flags?: unknown }).flags;
  if (!Array.isArray(arr)) return [];
  const out: EvalFlag[] = [];
  for (const f of arr) {
    if (!f || typeof f !== "object") continue;
    const check = (f as { check?: string }).check;
    if (!check || !(check in CHECK_SEVERITY)) continue; // reject unknown checks
    // Severity is authoritative from the rubric map — never trust the model to
    // downgrade/upgrade. This keeps severities consistent.
    const severity: Severity = CHECK_SEVERITY[check as CheckId];
    const ids = (f as { evidence_message_ids?: unknown }).evidence_message_ids;
    out.push({
      check,
      severity,
      evidence_message_ids: Array.isArray(ids) ? ids.map(String) : [],
      explanation: String((f as { explanation?: unknown }).explanation ?? "").slice(0, 400),
    });
  }
  return out;
}

async function callJudge(
  ground: JudgeGroundTruth,
  transcript: JudgeTranscriptMessage[],
): Promise<JudgeCallResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const { system, user } = assembleJudgePrompt(ground, transcript);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(CLAUDE_API, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          max_tokens: 1024,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        lastErr = new Error(`Claude ${res.status}: ${t}`);
        if (res.status >= 500 || res.status === 429) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw lastErr; // non-retryable
      }
      const data = await res.json();
      const text: string = (data.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("")
        .trim();
      const inTok = data.usage?.input_tokens ?? 0;
      const outTok = data.usage?.output_tokens ?? 0;
      const costCents = estimateCostCents(inTok, outTok);

      // Parse the JSON object out of the reply (tolerate fences / trailing prose).
      const parsed = parseJudgeJson(text);
      if (parsed === null) throw new Error("judge output not parseable JSON");
      return { flags: coerceFlags(parsed), raw: text, costCents };
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("judge call failed");
}

// ─── Candidate selection ─────────────────────────────────────────────────────────
// A conversation is judgeable when it is "done": its latest cart phase is
// terminal (confirmed/expired) OR it has been idle > IDLE_MINUTES. We then skip
// any conversation that already has a live eval for its current transcript hash.
//
// SELECTION ORDER (within the SAME cap): cart-bearing (shop-resolvable)
// conversations are judged FIRST, then cart-less ones. Cart-less conversations
// are NOT skipped — they are still judged if cap/budget remains; they just sort
// after. This pulls real, menu-backed conversations to the front so the per-
// sweep cap spends its budget on high-confidence evals first. Deterministic:
// a stable partition preserves each group's existing relative order so repeated
// sweeps are reproducible. The cap is unchanged.
export async function selectCandidates(
  supabase: SupabaseClient,
): Promise<Array<{ id: string; tenant_id: string }>> {
  const idleCutoff = new Date(Date.now() - IDLE_MINUTES * 60_000).toISOString();

  // Idle conversations (no new messages for N minutes).
  const { data: idle } = await supabase
    .from("conversations")
    .select("id, tenant_id, last_message_at")
    .lt("last_message_at", idleCutoff)
    .order("last_message_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_CONVERSATIONS_PER_SWEEP * 3);

  // Terminal-phase conversations (confirmed/expired carts), even if recent.
  const { data: terminalCarts } = await supabase
    .from("order_carts")
    .select("conversation_id")
    .in("phase", ["confirmed", "expired"])
    .limit(MAX_CONVERSATIONS_PER_SWEEP * 3);

  // Insertion order here defines the stable base order of the candidate set.
  const ids = new Map<string, { id: string; tenant_id: string }>();
  for (const c of idle ?? []) ids.set(c.id, { id: c.id, tenant_id: c.tenant_id });

  if (terminalCarts?.length) {
    const convIds = [...new Set(terminalCarts.map((c) => c.conversation_id))];
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, tenant_id")
      .in("id", convIds);
    for (const c of convs ?? []) ids.set(c.id, { id: c.id, tenant_id: c.tenant_id });
  }

  const candidates = [...ids.values()];
  if (candidates.length === 0) return [];

  // Which candidate conversations have ANY cart at all (→ shop-resolvable)?
  // A cart-bearing conversation can resolve a shop (and thus a menu) and is
  // therefore eligible for high-confidence ground truth. We prioritize these.
  const cartBearing = new Set<string>();
  const candidateIds = candidates.map((c) => c.id);
  // Chunk the IN() to stay well under URL/row limits on large sweeps.
  const CHUNK = 200;
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const slice = candidateIds.slice(i, i + CHUNK);
    const { data: carts } = await supabase
      .from("order_carts")
      .select("conversation_id")
      .in("conversation_id", slice);
    for (const c of carts ?? []) cartBearing.add(c.conversation_id);
  }

  // Stable partition: cart-bearing first (in their existing relative order),
  // then cart-less (in their existing relative order). No comparator that could
  // reshuffle equal keys non-deterministically. THEN apply the (unchanged) cap.
  const prioritized = [
    ...candidates.filter((c) => cartBearing.has(c.id)),
    ...candidates.filter((c) => !cartBearing.has(c.id)),
  ];

  return prioritized.slice(0, MAX_CONVERSATIONS_PER_SWEEP);
}

// ─── Sweep ──────────────────────────────────────────────────────────────────────
interface SweepReport {
  scanned: number;
  judged: number;
  flagged: number;
  clean: number;
  errored: number;
  skipped_unchanged: number;
  spend_cents: number;
  ceiling_hit: boolean;
  digest: { stubbed: boolean; sent: boolean; lines: number } | null;
}

export async function runSweep(supabase: SupabaseClient): Promise<SweepReport> {
  const report: SweepReport = {
    scanned: 0, judged: 0, flagged: 0, clean: 0, errored: 0,
    skipped_unchanged: 0, spend_cents: 0, ceiling_hit: false, digest: null,
  };

  let spentToday = await spentTodayCents(supabase);
  const candidates = await selectCandidates(supabase);
  report.scanned = candidates.length;

  const newlyFlaggedRows: FlaggedEvalRow[] = [];

  for (const conv of candidates) {
    if (spentToday >= DAILY_SPEND_CEILING_CENTS) {
      report.ceiling_hit = true;
      console.warn(
        `[eval-sweep] daily spend ceiling ${DAILY_SPEND_CEILING_CENTS}¢ reached (spent ${spentToday.toFixed(3)}¢) — stopping.`,
      );
      break;
    }

    // Load transcript (tenant-scoped by conversation_id; messages carry tenant_id).
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true });

    const transcript = (msgs ?? []) as JudgeTranscriptMessage[];
    if (transcript.length === 0) continue;

    const hash = await sha256Hex(transcriptHashInput(transcript));

    // Idempotency: already judged at this exact transcript hash? skip.
    const { data: existing } = await supabase
      .from("conversation_evals")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("transcript_hash", hash)
      .maybeSingle();
    if (existing) {
      report.skipped_unchanged += 1;
      continue;
    }

    const gt = await loadGroundTruth(supabase, conv);
    const ground = gt.ground;
    // Confidence is decided by ground-truth resolution, independent of the
    // judge's verdict/severity. An errored eval (judge couldn't complete) is
    // labeled by the SAME ground-truth signal; if no menu was resolvable it is
    // 'low'. This never suppresses or downgrades a flag.
    const confidence: "high" | "low" = gt.confidence;

    let verdict: "clean" | "flagged" | "errored" = "clean";
    let flags: EvalFlag[] = [];
    let raw = "";
    let costCents = 0;
    let maxSev: Severity | null = null;

    try {
      const result = await callJudge(ground, transcript);
      flags = result.flags;
      raw = result.raw;
      costCents = result.costCents;
      maxSev = maxSeverityOf(flags);
      verdict = flags.length > 0 ? "flagged" : "clean";
    } catch (e) {
      // SAFE-DEGRADE: mark errored, continue. Never crash the sweep.
      verdict = "errored";
      raw = `ERROR: ${(e as Error).message}`;
      console.error(`[eval-sweep] judge errored for conv ${conv.id}:`, (e as Error).message);
    }

    spentToday += costCents;
    report.spend_cents += costCents;

    const { data: inserted, error: insErr } = await supabase
      .from("conversation_evals")
      .insert({
        tenant_id: conv.tenant_id,
        shop_id: gt.shopId, // resolved in-tenant shop (null when none resolvable)
        conversation_id: conv.id,
        transcript_hash: hash,
        model: `${JUDGE_MODEL}/${RUBRIC_VERSION}`,
        verdict,
        max_severity: maxSev,
        confidence, // 'high' iff real menu ground truth was loaded; else 'low'
        flags,
        raw_judge_output: raw,
        cost_cents: Number(costCents.toFixed(4)),
      })
      .select("id")
      .maybeSingle();

    if (insErr) {
      // Unique-index race (already inserted by a concurrent sweep) → treat as skip.
      console.warn(`[eval-sweep] insert skipped for conv ${conv.id}:`, insErr.message);
      report.skipped_unchanged += 1;
      continue;
    }

    report.judged += 1;
    if (verdict === "flagged") {
      report.flagged += 1;
      newlyFlaggedRows.push({
        id: inserted?.id ?? "",
        tenant_id: conv.tenant_id,
        shop_id: gt.shopId,
        conversation_id: conv.id,
        shop_name: ground.shop_name,
        max_severity: maxSev,
        flags,
        judged_at: new Date().toISOString(),
      });
      // Auto-fix seam (OFF by default — pure no-op when disabled).
      maybeAutoFix({ conversationId: conv.id, shopName: ground.shop_name, flags });
    } else if (verdict === "clean") {
      report.clean += 1;
    } else {
      report.errored += 1;
    }
  }

  // ─── Notify: immediate digest for NEW critical/major; quiet on clean ────────
  const digest = buildImmediateDigest(newlyFlaggedRows);
  if (digest) {
    const sendRes = await sendDigest(digest);
    report.digest = { stubbed: sendRes.stubbed, sent: sendRes.sent, lines: digest.lines.length };
    // Mark these evals notified so we never re-ping them.
    if (digest.eval_ids.length) {
      await supabase
        .from("conversation_evals")
        .update({ notified_at: new Date().toISOString() })
        .in("id", digest.eval_ids);
    }
  } else {
    report.digest = null; // quiet
  }

  return report;
}

// ─── Entry point ────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing SUPABASE_URL / SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } },
    );
  }

  // Service-role client. Bypasses RLS; we enforce tenant isolation in code by
  // only ever loading a conversation's OWN tenant/shop ground truth.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    const report = await runSweep(supabase);
    return new Response(
      JSON.stringify({ ok: true, autofix_enabled: autofixEnabled(), report }),
      { status: 200, headers: { ...CORS, "content-type": "application/json" } },
    );
  } catch (e) {
    // Even a total failure must not crash anything live — just report it.
    console.error("[eval-sweep] sweep failed:", (e as Error).message);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 200, headers: { ...CORS, "content-type": "application/json" } },
    );
  }
});
