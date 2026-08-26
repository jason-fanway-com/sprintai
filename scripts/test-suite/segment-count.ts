#!/usr/bin/env deno run --allow-net --allow-env --allow-read --allow-write
/**
 * segment-count.ts — Measure SMS segment counts from SprintAI ordering bot.
 *
 * Two modes:
 *   1. --live <shop_id>    → runs a representative conversation against the live
 *                            chat-sms endpoint and measures real segment counts.
 *   2. --db <test_run_id>  → reads transcripts from a completed test_run in
 *                            Supabase and computes segment stats.
 *
 * Usage:
 *   deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --live <shop_id>
 *   deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --db <run_id>
 */

// ── GSM-7 Detection ─────────────────────────────────────────────────────────

const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split(""),
);
const GSM7_EXTENDED = new Set("|^{}[]~\\€");

function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

function gsm7CharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    count += GSM7_EXTENDED.has(ch) ? 2 : 1;
  }
  return count;
}

function segmentCount(text: string): number {
  if (text.length === 0) return 0;
  if (isGsm7(text)) {
    const chars = gsm7CharCount(text);
    return chars <= 160 ? 1 : 1 + Math.ceil((chars - 160) / 153);
  }
  return text.length <= 70 ? 1 : 1 + Math.ceil((text.length - 70) / 67);
}

// ── Stats helpers ───────────────────────────────────────────────────────────

interface SegStats {
  count: number;
  replyCount: number;
  totalSegments: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
  distribution: Record<string, number>; // segments → count of replies
  perTurn: Array<{
    turn: number;
    chars: number;
    segments: number;
    isGsm7: boolean;
    preview: string;
    phase: string;
  }>;
}

function pct(sortedVals: number[], p: number): number {
  if (sortedVals.length === 0) return 0;
  const idx = Math.min(sortedVals.length - 1, Math.floor(sortedVals.length * p));
  return sortedVals[idx];
}

function stats(replies: { text: string; chars: number; phase: string }[]): SegStats {
  const segs = replies.map((r) => segmentCount(r.text));
  const sorted = [...segs].sort((a, b) => a - b);
  const totalSegments = sorted.reduce((s, v) => s + v, 0);
  const dist: Record<string, number> = {};
  for (const s of sorted) dist[String(s)] = (dist[String(s)] || 0) + 1;

  return {
    count: replies.length,
    replyCount: replies.length,
    totalSegments,
    mean: totalSegments / sorted.length,
    p50: pct(sorted, 0.5),
    p90: pct(sorted, 0.9),
    p95: pct(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    distribution: dist,
    perTurn: replies.map((r, i) => ({
      turn: i + 1,
      chars: r.chars,
      segments: segs[i],
      isGsm7: isGsm7(r.text),
      preview: r.text.slice(0, 120),
      phase: r.phase,
    })),
  };
}

// ── Live mode: representative conversation ──────────────────────────────────

interface LiveConfig {
  supabaseUrl: string;
  supabaseKey: string;
  chatFunctionUrl: string;
  shopId: string;
}

async function sendChat(
  config: LiveConfig,
  message: string,
  sessionId: string,
): Promise<{ reply: string; phase: string }> {
  const res = await fetch(config.chatFunctionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({ shop_id: config.shopId, message, session_id: sessionId }),
  });
  const data = await res.json();
  return { reply: data.reply ?? "", phase: data.phase ?? "unknown" };
}

async function runLive(config: LiveConfig) {
  const sessionId = `segment-metrics-${Date.now()}`;
  const replies: { text: string; chars: number; phase: string }[] = [];

  function record(reply: string, phase: string) {
    replies.push({ text: reply, chars: reply.length, phase });
  }

  console.error("=== LIVE SEGMENT MEASUREMENT ===\n");

  // Turn 1: Greeting — includes mandatory first-contact disclosure
  console.error("  [1] Sending: hi");
  let r = await sendChat(config, "hi", sessionId);
  record(r.reply, r.phase);
  console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);
  console.error(`  → "${r.reply.slice(0, 150)}..."`);

  // Turn 2: Single item order
  console.error("  [2] Sending: I'd like a plain bagel with butter");
  r = await sendChat(config, "I'd like a plain bagel with butter", sessionId);
  record(r.reply, r.phase);
  console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);

  // Turn 3: Add another item
  console.error("  [3] Sending: add a bacon egg and cheese on a roll");
  r = await sendChat(config, "add a bacon egg and cheese on a roll", sessionId);
  record(r.reply, r.phase);
  console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);

  // Turn 4: Ask for total / start checkout
  console.error("  [4] Sending: that's everything, what's my total?");
  r = await sendChat(config, "that's everything, what's my total?", sessionId);
  record(r.reply, r.phase);
  console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);

  // Turn 5: Confirm & provide name
  console.error("  [5] Sending: yes, and pickup for Jason");
  r = await sendChat(config, "yes, and pickup for Jason", sessionId);
  record(r.reply, r.phase);
  console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);

  // Turn 6: Checkout phase — payment link sent
  if (r.phase === "checkout" || r.phase === "review") {
    console.error("  [6] Sending: Jason (pickup name)");
    r = await sendChat(config, "Jason", sessionId);
    record(r.reply, r.phase);
    console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);
  }

  // Turn 7: Order confirmed
  if (r.phase === "checkout") {
    console.error("  [7] Sending: STATUS (status check while payment pending)");
    r = await sendChat(config, "STATUS", sessionId);
    record(r.reply, r.phase);
    console.error(`  → ${r.reply.length} chars, ${segmentCount(r.reply)} segs | phase: ${r.phase}`);
  }

  // Print stats
  const s = stats(replies);
  console.log("\n=== SEGMENT STATS (live conversation) ===");
  console.log(`Total replies: ${s.replyCount}`);
  console.log(`Total segments: ${s.totalSegments}`);
  console.log(`Mean: ${s.mean.toFixed(2)} | p50: ${s.p50} | p90: ${s.p90} | p95: ${s.p95} | max: ${s.max}`);
  console.log(`Distribution: ${JSON.stringify(s.distribution)}`);
  console.log(`\nPer-turn breakdown:`);
  for (const t of s.perTurn) {
    console.log(`  Turn ${t.turn} [${t.phase}]: ${t.chars} chars → ${t.segments} segment(s) | GSM7: ${t.isGsm7}`);
  }

  // Also output JSON for piping
  const output = { mode: "live", shopId: config.shopId, stats: s };
  await Deno.writeTextFile("/tmp/sprintai-segment-live.json", JSON.stringify(output, null, 2));
}

// ── DB mode: read from Supabase test_case_results ───────────────────────────

async function runDb(supabaseUrl: string, supabaseKey: string, runId: string) {
  console.error(`=== DB SEGMENT ANALYSIS — run ${runId} ===\n`);

  const res = await fetch(
    `${supabaseUrl}/rest/v1/test_case_results?select=case_id,category,criticality,passed,transcript&run_id=eq.${runId}&order=case_id`,
    { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) {
    console.error(`Failed to query test_case_results: ${res.status}`);
    Deno.exit(1);
  }
  const rows = (await res.json()) as Array<{
    case_id: string;
    category: string;
    criticality: string;
    passed: boolean;
    transcript: Array<{ role: string; message: string; reply?: string | null; phase?: string }>;
  }>;

  const allReplies: { text: string; chars: number; phase: string }[] = [];
  const perCase: Record<string, { segments: number; replies: number }> = {};

  for (const row of rows) {
    if (!row.transcript) continue;
    for (const turn of row.transcript) {
      if (turn.role === "customer" && turn.reply) {
        allReplies.push({ text: turn.reply, chars: turn.reply.length, phase: turn.phase ?? "unknown" });
        if (!perCase[row.case_id]) perCase[row.case_id] = { segments: 0, replies: 0 };
        perCase[row.case_id].segments += segmentCount(turn.reply);
        perCase[row.case_id].replies++;
      }
    }
  }

  // Also compute per-conversation segment totals (for the 8-segment model assumption)
  const caseIds = Object.keys(perCase);
  const segmentsPerConv = caseIds.map((id) => perCase[id].segments);

  const s = stats(allReplies);
  const convStats = segmentsPerConv.length > 0 ? {
    count: segmentsPerConv.length,
    total: segmentsPerConv.reduce((a, b) => a + b, 0),
    mean: segmentsPerConv.reduce((a, b) => a + b, 0) / segmentsPerConv.length,
  } : { count: 0, total: 0, mean: 0 };

  console.log("\n=== SEGMENT STATS (per reply) ===");
  console.log(`Total replies: ${s.replyCount} across ${rows.length} cases`);
  console.log(`Total segments: ${s.totalSegments}`);
  console.log(`Mean: ${s.mean.toFixed(2)} | p50: ${s.p50} | p90: ${s.p90} | p95: ${s.p95} | max: ${s.max}`);
  console.log(`Distribution: ${JSON.stringify(s.distribution)}`);

  console.log("\n=== SEGMENT STATS (per conversation) ===");
  console.log(`Conversations: ${convStats.count}`);
  console.log(`Total segments/conversation: mean ${convStats.mean.toFixed(2)}`);
  const sorted = [...segmentsPerConv].sort((a, b) => a - b);
  console.log(`p50: ${pct(sorted, 0.5)} | p90: ${pct(sorted, 0.9)} | max: ${sorted[sorted.length - 1] ?? 0}`);

  const output = { mode: "db", runId, stats: s, conversationStats: convStats };
  await Deno.writeTextFile("/tmp/sprintai-segment-db.json", JSON.stringify(output, null, 2));
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = Deno.args;
if (args.length < 2 || args.includes("--help")) {
  console.log(`Usage:
  deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --live <shop_id>
  deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --db <test_run_id>`);
  Deno.exit(0);
}

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CHAT_FUNCTION_URL = `https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

if (args[0] === "--live") {
  await runLive({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, chatFunctionUrl: CHAT_FUNCTION_URL, shopId: args[1] });
} else if (args[0] === "--db") {
  await runDb(SUPABASE_URL, SUPABASE_KEY, args[1]);
} else {
  console.error("Unknown mode. Use --live <shop_id> or --db <test_run_id>");
  Deno.exit(1);
}