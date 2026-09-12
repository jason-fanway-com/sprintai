// P0 LIVE verification (2026-09-11) — GUARD 7c silent item-collapse fix,
// commit 301a7a0. See that commit's message and index.ts's GUARD 7c comment
// (~line 5412) for the full root-cause writeup: a leading order-intent
// preamble ("can I get") used to bypass the leftover-content-word safety
// check ENTIRELY (not just relax it), letting GUARD 7c silently resolve and
// add only ONE duplicate-named item (e.g. "Cheesesteak", which exists across
// 4 different Vito's categories) while discarding every other item named in
// the same message — no error, no flag, a cheerful "Got it... Anything
// else?" This is NOT a phrase-splitter bug: splitCustomerPhrases correctly
// splits the exact repro message into 4 phrases regardless of the preamble
// (verified directly against phrase-split.ts before writing this fix).
//
// This matrix drives the real deployed endpoint across 8 preambles x 5 runs
// on Vito's (the real repro, legacy path, has the duplicate-named
// "Cheesesteak" item) and the same 8x5 on Zio's (compiled path, no
// duplicate-named item in this combo — a regression/sanity check that a
// preamble doesn't newly break a normal multi-item compiled order, not a
// GUARD 7c repro in itself, since GUARD 7c never had signal to fire there).
// Two seeded control cases at the end prove the fix's own leftover-check
// still does its job post-fix, not just that it stopped over-firing:
//   - POSITIVE control: a genuinely bare single-item message ("cheesesteak
//     flatbread") must still resolve via GUARD 7c's fast deterministic path
//     (this is what the guard exists for — it must still work).
//   - NEGATIVE control: an order-intent message with a duplicate-named item
//     PLUS clearly unrelated leftover content ("...and can you tell me if
//     you have parking") must still correctly fall through to the LLM/tool
//     loop rather than silently adding just the one item — proving the
//     leftover check still fires when it should, not that it was simply
//     disabled.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

interface Line { name: string; price_cents: number; quantity: number; menu_item_id: string; options?: Record<string, string[]>; unverified_requests?: string[] }

async function send(message: string, sessionId: string, shopId: string): Promise<{ reply: string | null; debug_perf?: { toolCallCount?: number } }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function fetchCart(sessionId: string): Promise<Line[]> {
  const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
  const [conv] = await convRes.json();
  const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
  const [cart] = await cartRes.json();
  return (cart.cart_json ?? []) as Line[];
}

const RUNS_PER_PREAMBLE = 5;
const RESULTS_PATH = new URL("./tmp-guard7c-preamble-matrix-20260911-results.json", import.meta.url).pathname;

interface RunResult {
  shop: "vitos-legacy" | "zios-compiled";
  preamble: string;
  turn2: string;
  run: number;
  toolCallCount2: number;
  namedItemCount: number;
  lineCount: number;
  collapseDetected: boolean;
  cartLines: { name: string; menu_item_id: string; price_cents: number; quantity: number }[];
}

interface ControlResult {
  label: string;
  message: string;
  reply: string | null;
  toolCallCount: number;
  lineCount: number;
  expectedBehavior: string;
  pass: boolean;
}

const resultsState: { startedAt: string; runs: RunResult[]; controls: ControlResult[]; done: boolean } = {
  startedAt: new Date().toISOString(),
  runs: [],
  controls: [],
  done: false,
};

async function persistResults() {
  await Deno.writeTextFile(RESULTS_PATH, JSON.stringify(resultsState, null, 2));
}

const PREAMBLES = ["can I get", "I'd like", "I'll take", "could I get", "lemme get", "gimme", "we want", ""];

function buildVitosTurn2(preamble: string): string {
  const body = "a chicken bacon ranch flatbread, a bbq chicken one with pepperoni on it, a cheesesteak and a margherita";
  return preamble ? `${preamble} ${body}` : body;
}
function buildZiosTurn2(preamble: string): string {
  const body = "1 plain, 1 pepperoni, 1 meat lovers and one hawaii";
  return preamble ? `${preamble} ${body}` : body;
}

console.log(`=== GUARD 7c preamble matrix: ${PREAMBLES.length} preambles x ${RUNS_PER_PREAMBLE} runs x 2 shops ===\n`);

let totalRuns = 0, totalCollapses = 0, totalNoToolCall = 0;

for (const shop of ["vitos-legacy", "zios-compiled"] as const) {
  const shopId = shop === "vitos-legacy" ? VITOS_ID : ZIOS;
  const turn1 = shop === "vitos-legacy" ? "I'd like 4 flatbreads please" : "I need 4 large pizzas please";
  const buildTurn2 = shop === "vitos-legacy" ? buildVitosTurn2 : buildZiosTurn2;
  console.log(`\n### Shop: ${shop} ###`);
  for (const preamble of PREAMBLES) {
    const turn2 = buildTurn2(preamble);
    console.log(`\n--- preamble: "${preamble || "(bare)"}" ---`);
    console.log(`  turn2: "${turn2}"`);
    for (let run = 1; run <= RUNS_PER_PREAMBLE; run++) {
      totalRuns++;
      const sessionId = `guard7c-preamble-${shop}-${Math.floor(Math.random() * 1e9)}`;
      await send(turn1, sessionId, shopId);
      const r2 = await send(turn2, sessionId, shopId);
      const lines = await fetchCart(sessionId);
      const toolCallCount2 = r2.debug_perf?.toolCallCount ?? -1;
      if (toolCallCount2 === 0) totalNoToolCall++;
      const namedItemCount = 4;
      const collapseDetected = lines.length < namedItemCount;
      if (collapseDetected) totalCollapses++;
      console.log(
        `  run ${run}: toolCallCount(turn2)=${toolCallCount2} named=${namedItemCount} lines=${lines.length} ` +
        `${collapseDetected ? "COLLAPSE DETECTED" : "OK"}`,
      );
      resultsState.runs.push({
        shop, preamble, turn2, run, toolCallCount2, namedItemCount, lineCount: lines.length, collapseDetected,
        cartLines: lines.map(l => ({ name: l.name, menu_item_id: l.menu_item_id, price_cents: l.price_cents, quantity: l.quantity })),
      });
      await persistResults();
    }
  }
}

console.log(`\n=== CONTROL CASES ===`);
{
  // POSITIVE control: a genuinely bare single-item message must still
  // resolve deterministically via GUARD 7c (toolCallCount should be 0/low —
  // no LLM tool loop needed for a pure pre-LLM guard hit).
  const sessionId = `guard7c-control-positive-${Math.floor(Math.random() * 1e9)}`;
  const r1 = await send("I'd like 4 flatbreads please", sessionId, VITOS_ID);
  const r2 = await send("cheesesteak flatbread", sessionId, VITOS_ID);
  const lines = await fetchCart(sessionId);
  const toolCallCount = r2.debug_perf?.toolCallCount ?? -1;
  const pass = lines.length === 1 && lines[0]?.name === "Cheesesteak";
  console.log(`  POSITIVE control: "cheesesteak flatbread" -> lines=${lines.length} (${lines.map(l => l.name).join(", ")}) toolCallCount=${toolCallCount} -> ${pass ? "PASS" : "FAIL"}`);
  resultsState.controls.push({
    label: "positive-bare-single-item", message: "cheesesteak flatbread", reply: r2.reply ?? null,
    toolCallCount, lineCount: lines.length, expectedBehavior: "GUARD 7c still resolves a genuine bare single-item order", pass,
  });
  await persistResults();
}
{
  // NEGATIVE control: order-intent phrase + duplicate-named item + CLEARLY
  // unrelated leftover content. This must NOT silently add just Cheesesteak
  // — the leftover check must still catch "tell"/"parking" as leftover and
  // fall through to the LLM/tool loop (which will answer the parking
  // question and/or ask for clarification, not silently confirm an order).
  const sessionId = `guard7c-control-negative-${Math.floor(Math.random() * 1e9)}`;
  const r1 = await send("I'd like 4 flatbreads please", sessionId, VITOS_ID);
  const r2 = await send("can I get a cheesesteak flatbread and can you tell me if you have parking", sessionId, VITOS_ID);
  const lines = await fetchCart(sessionId);
  const toolCallCount = r2.debug_perf?.toolCallCount ?? -1;
  // Pass condition: this must NOT look like a guard-7c-style instant,
  // zero-tool-call silent resolution while ALSO ignoring the parking
  // question — i.e. toolCallCount > 0 (LLM engaged) is the signal the
  // leftover check correctly declined the fast path.
  const pass = toolCallCount !== 0;
  console.log(`  NEGATIVE control: "...cheesesteak...and...parking" -> lines=${lines.length} toolCallCount=${toolCallCount} -> ${pass ? "PASS (fell through to LLM as expected)" : "FAIL (guard silently fast-pathed despite unrelated content)"}`);
  resultsState.controls.push({
    label: "negative-unrelated-leftover-content", message: "can I get a cheesesteak flatbread and can you tell me if you have parking", reply: r2.reply ?? null,
    toolCallCount, lineCount: lines.length, expectedBehavior: "leftover check still blocks GUARD 7c's fast path when unrelated content is present", pass,
  });
  await persistResults();
}

resultsState.done = true;
await persistResults();

console.log(`\n=== SUMMARY ===`);
console.log(`total runs: ${totalRuns}`);
console.log(`collapses detected (lines < named items): ${totalCollapses}/${totalRuns}`);
console.log(`zero-tool-call turns: ${totalNoToolCall}/${totalRuns}`);
console.log(`control cases: ${resultsState.controls.filter(c => c.pass).length}/${resultsState.controls.length} passed`);
console.log(`results file: ${RESULTS_PATH}`);
console.log(totalCollapses === 0 && resultsState.controls.every(c => c.pass)
  ? "\nPASS — no collapse across either shop's preamble matrix, both control cases behaved correctly."
  : "\nFAIL — see per-run detail above.");
