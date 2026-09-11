// P0 LIVE replay (2026-09-10, updated same day after a PO re-diagnosis) —
// closes the gap the unit-level replay in
// supabase/functions/chat-sms/zios-89-95-vs-95-95-20260909.test.ts declared
// up front: that file exercises only the extracted pricing/detection/render
// functions in isolation, never the live LLM tool-call sequence. This script
// drives the actual deployed chat-sms endpoint with the real customer's own
// words from conversation f0ecf0fe-909f-4bd6-aa1a-e73f778c501c (Zio's,
// 2026-09-09 11:07-11:10 UTC), pulled fresh from the messages table, not
// paraphrased. test:true is real chat-sms code + real Zio's DB rows on
// test-mode Stripe/hours rails — not a fabricated event.
//
// Original incident (money leg): pepperoni applied as a priced $3.00
// modifier to BOTH the Meat Lover's and the Hawaiian, producing a $95.95
// total against the correct $89.95. GUARD 2c and the modifier-scope fixes
// shipped since then close this leg — first run of this script (three
// consecutive PASS) confirmed it does NOT reproduce on the live pipeline.
//
// SAME-DAY RECURRENCE (kitchen-ticket leg, PO live repro, 2026-09-10
// 21:06 EDT): the money doesn't reproduce, but the SAME root cause — a
// token ("pepperoni") consumed as an item AND left available to bleed onto
// other phrases — was still live one level up: GUARD 16 (compiled-path
// "reply falsely confirmed an unresolved modifier" check) matched the
// customer's word "pepperoni" against the WHOLE raw turn text for every
// touched cart line, not the specific phrase that claimed it, so it flagged
// `unverified_requests: ["Pepperoni"]` onto the plain/Meat Lover's/Hawaiian
// lines too (3 of 4 runs) whenever the model's reply happened to name
// "pepperoni" while summarizing the order back. Not a money bug —
// `unverified_requests` isn't priced — but it reaches the kitchen ticket as
// a request the shop must act on: not-forgivable #3 (promising/flagging
// something on food the customer didn't ask for).
//
// FIX (this session, index.ts GUARD 16): scope the "did the customer name
// this" check to the cart line's own `sourcePhraseIndex` (already recorded
// per line by the add_item/compiled-engine phrase-claim machinery built
// 2026-09-09 for the pricing leg of this same defect family) instead of the
// whole turn's raw text, when the turn has more than one phrase. Deployed
// chat-sms v358.
//
// Per PO instruction: this is intermittent (3/4), so a single clean run
// proves nothing — run each phrasing 5x, report leaked-onto counts and
// toolCallCount per run, not a bare pass/fail.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";

const MEAT_LOVERS_ID = "0b7a33b7-f02c-4609-b7d2-1b99c08e805a";
const HAWAIIAN_ID = "5eb4554f-d4f7-4f8d-8440-55b051856650";
const NEAPOLITAN_LARGE_ID = "35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd";
const PEPPERONI_PIZZA_ID = "6ac9c4cf-255b-4098-bdbb-f006cf2cf3c6"; // "Pepperoni Pizza - 18''" — the ONLY line pepperoni should ever attach to
const BASE_PRICE_CENTS = 2499; // Meat Lover's / Hawaiian base, confirmed live 2026-09-09 via qa_ro

interface Line { name: string; price_cents: number; quantity: number; menu_item_id: string; unverified_requests?: string[] }

async function send(message: string, sessionId: string, shopId: string = ZIOS): Promise<{ reply: string | null; debug_perf?: { toolCallCount?: number } }> {
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

// Matrix of phrasings for turn 2, per PO instruction: comma+digit, comma+word,
// "and"-separated, bare list, conversational. Turn 1 is held constant
// (verbatim from the real conversation) since it only establishes "4 large
// pizzas" and never touches the pepperoni token.
const TURN1 = "I need 4 large pizzas please";
const PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit (verbatim incident)", turn2: "1 plain, 1 pepperoni, 1 meat lovers and one hawaii" },
  { label: "comma+word", turn2: "one plain, one pepperoni, one meat lover and one hawaiian" },
  { label: "and-separated", turn2: "a plain one and a pepperoni one and a meat lovers and a hawaiian" },
  { label: "bare list", turn2: "plain pepperoni meat lovers hawaiian" },
  { label: "conversational", turn2: "can I get one with nothing on it, one pepperoni, one meat lovers, and one hawaiian please" },
];
const RUNS_PER_PHRASING = 5;

// GUARD 16 fix verification (2026-09-10 dispatch): extend the existing
// per-line assertions beyond price_cents to unverified_requests, and persist
// every run incrementally to a JSON results file so a background-detached
// process (25+ live LLM calls, 20-80min wall clock) can be inspected mid-run
// instead of requiring the caller to block on completion.
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const RESULTS_PATH = new URL("./tmp-guard16-consumed-token-verify-20260910-results.json", import.meta.url).pathname;

interface RunResult {
  phrasing: string;
  turn2: string;
  run: number;
  lines: number;
  toolCallCount2: number;
  moneyLeakApplied: boolean;
  leakedOntoLines: string[];
  totalCents: number;
  cartLines: { name: string; menu_item_id: string; price_cents: number; quantity: number; unverified_requests?: string[] }[];
}

interface CanaryResult {
  label: string;
  steps: { message: string; reply: string | null }[];
  finalTotalCents: number;
  expectedCents: number;
  pass: boolean;
}

const resultsState: { startedAt: string; runs: RunResult[]; canary?: CanaryResult; done: boolean } = {
  startedAt: new Date().toISOString(),
  runs: [],
  done: false,
};

async function persistResults() {
  await Deno.writeTextFile(RESULTS_PATH, JSON.stringify(resultsState, null, 2));
}

function classify(lines: Line[]) {
  const leakedOnto = lines.filter(l =>
    l.menu_item_id !== PEPPERONI_PIZZA_ID &&
    (l.unverified_requests ?? []).some(u => u.toLowerCase().includes("pepperoni")),
  );
  const meatLovers = lines.find(l => l.menu_item_id === MEAT_LOVERS_ID);
  const hawaiian = lines.find(l => l.menu_item_id === HAWAIIAN_ID);
  const moneyLeakApplied =
    (!!meatLovers && meatLovers.price_cents !== BASE_PRICE_CENTS) ||
    (!!hawaiian && hawaiian.price_cents !== BASE_PRICE_CENTS);
  return { leakedOnto, moneyLeakApplied };
}

// GUARD 12 EXTENSION (2026-09-10, PO-authorized follow-up dispatch): the
// GUARD 16 fix above only covers the compiled/ask_plan path (Zio's). GUARD
// 12 is the identical whole-turn-text-scan defect on the LEGACY/option_groups
// path (Vito's, NJB pizzas). Live-shop check: NJB carries ZERO option_groups
// rows menu-wide (confirmed via qa_ro query, 2026-09-10) — its items use
// modifiers_json instead, a structurally different guard's domain, so GUARD
// 12's code path cannot be exercised there at all; NJB is out of scope for
// this verification, not because it's fixed but because it was never
// exposed. Vito's Flatbreads category (Chicken Bacon Ranch/BBQ Chicken/
// Cheesesteak/Margherita, all $10.50, all sharing a non-required "Toppings"
// option group that includes a plain "Pepperoni" choice, +$0.50) is the
// closest live structural analog to the Zio's pizza repro and IS exposed.
// Run with `--guard12-only` to skip phase 1 (already covered by a prior
// still-running/completed process against the same results file) and only
// append this phase's runs.
const GUARD12_ONLY = Deno.args.includes("--guard12-only");

const CHICKEN_BACON_RANCH_ID = "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d";
const BBQ_CHICKEN_ID = "80d49c72-d238-4ef9-8b29-12ec7097b213"; // the ONLY line pepperoni should ever attach to
const CHEESESTEAK_ID = "80f8624c-358c-4004-9b94-75d8c66e6008";
const MARGHERITA_ID = "a37a47a9-7f6c-47bb-acdd-933f572890de";
const FLATBREAD_BASE_CENTS = 1050;
const VITOS_ID = VITOS_SHOP_ID;

const GUARD12_TURN1 = "I'd like 4 flatbreads please";
const GUARD12_PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit", turn2: "1 chicken bacon ranch, 1 bbq chicken with pepperoni, 1 cheesesteak and 1 margherita" },
  { label: "comma+word", turn2: "one chicken bacon ranch, one bbq chicken with pepperoni, one cheesesteak and one margherita" },
  { label: "and-separated", turn2: "a chicken bacon ranch and a bbq chicken with pepperoni and a cheesesteak and a margherita" },
  { label: "bare list", turn2: "chicken bacon ranch bbq chicken pepperoni cheesesteak margherita, four flatbreads" },
  { label: "conversational", turn2: "can I get a chicken bacon ranch, a bbq chicken with pepperoni on it, a cheesesteak, and a margherita please" },
];

function classifyGuard12(lines: Line[]) {
  const leakedOnto = lines.filter(l =>
    l.menu_item_id !== BBQ_CHICKEN_ID &&
    [CHICKEN_BACON_RANCH_ID, CHEESESTEAK_ID, MARGHERITA_ID].includes(l.menu_item_id) &&
    (l.unverified_requests ?? []).some(u => u.toLowerCase().includes("pepperoni")),
  );
  const bbq = lines.find(l => l.menu_item_id === BBQ_CHICKEN_ID);
  const others = lines.filter(l => l.menu_item_id !== BBQ_CHICKEN_ID && [CHICKEN_BACON_RANCH_ID, CHEESESTEAK_ID, MARGHERITA_ID].includes(l.menu_item_id));
  const moneyLeakApplied = others.some(l => l.price_cents !== FLATBREAD_BASE_CENTS);
  return { leakedOnto, moneyLeakApplied, bbq };
}

async function waitForPriorPhaseDone(): Promise<Record<string, unknown>> {
  // Deliberate hand-off, not a busy loop the caller blocks on: this whole
  // script runs as a detached background OS process, so polling here costs
  // the caller (this dispatch's turn) nothing. It exists because the phase-1
  // (GUARD 16/Zio's) process still writing this exact file overwrites the
  // WHOLE file on every persistResults() call from its own in-memory state —
  // starting phase 2 before phase 1 sets done:true would race and could
  // silently drop either phase's data, invisible until someone reads the
  // file expecting both.
  while (true) {
    try {
      const raw = await Deno.readTextFile(RESULTS_PATH);
      const parsed = JSON.parse(raw);
      if (parsed.done === true) return parsed;
    } catch {
      // file not yet created or mid-write (invalid JSON) — keep polling
    }
    await new Promise(r => setTimeout(r, 15000));
  }
}

if (GUARD12_ONLY) {
  console.log("=== GUARD 12 phase: waiting for phase-1 (GUARD 16/Zio's) results to finish before touching the shared results file ===");
  const priorState = await waitForPriorPhaseDone();
  resultsState.startedAt = priorState.startedAt as string ?? resultsState.startedAt;
  resultsState.runs = (priorState.runs as RunResult[]) ?? [];
  resultsState.canary = priorState.canary as CanaryResult | undefined;
  resultsState.done = false; // reopen: this phase still has work to persist
  await persistResults();
  console.log("Phase 1 confirmed done — proceeding with GUARD 12 (Vito's Flatbreads) matrix.\n");
}

interface Guard12RunResult {
  phrasing: string;
  turn2: string;
  run: number;
  lines: number;
  toolCallCount2: number;
  moneyLeakApplied: boolean;
  leakedOntoLines: string[];
  totalCents: number;
  cartLines: { name: string; menu_item_id: string; price_cents: number; quantity: number; unverified_requests?: string[] }[];
}

const guard12ResultsState: { runs: Guard12RunResult[] } = { runs: [] };
(resultsState as unknown as { guard12Runs: Guard12RunResult[] }).guard12Runs = guard12ResultsState.runs;

if (GUARD12_ONLY) {
  console.log(`=== GUARD 12 matrix replay (Vito's Flatbreads, ${GUARD12_PHRASINGS.length} phrasings x ${RUNS_PER_PHRASING} runs) ===\n`);
  let g12TotalRuns = 0, g12MoneyLeaks = 0, g12TicketLeaks = 0, g12NoToolCall = 0;
  for (const { label, turn2 } of GUARD12_PHRASINGS) {
    console.log(`\n--- Phrasing: ${label} ---`);
    console.log(`  turn2: "${turn2}"`);
    for (let run = 1; run <= RUNS_PER_PHRASING; run++) {
      g12TotalRuns++;
      const sessionId = `guard12-vitos-flatbread-${Math.floor(Math.random() * 1e9)}`;
      await send(GUARD12_TURN1, sessionId, VITOS_ID);
      const r2 = await send(turn2, sessionId, VITOS_ID);
      const lines = await fetchCart(sessionId);
      const { leakedOnto, moneyLeakApplied } = classifyGuard12(lines);
      const toolCallCount2 = r2.debug_perf?.toolCallCount ?? -1;
      if (toolCallCount2 === 0) g12NoToolCall++;
      if (moneyLeakApplied) g12MoneyLeaks++;
      if (leakedOnto.length > 0) g12TicketLeaks++;
      const totalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
      console.log(
        `  run ${run}: lines=${lines.length} toolCallCount(turn2)=${toolCallCount2} ` +
        `moneyLeak=${moneyLeakApplied ? "YES" : "no"} ` +
        `ticketLeak=${leakedOnto.length > 0 ? `YES (${leakedOnto.map(l => l.name).join(", ")})` : "no"} ` +
        `total=${totalCents}`,
      );
      guard12ResultsState.runs.push({
        phrasing: label, turn2, run, lines: lines.length, toolCallCount2, moneyLeakApplied,
        leakedOntoLines: leakedOnto.map(l => l.name), totalCents,
        cartLines: lines.map(l => ({ name: l.name, menu_item_id: l.menu_item_id, price_cents: l.price_cents, quantity: l.quantity, unverified_requests: l.unverified_requests })),
      });
      await persistResults();
    }
  }
  resultsState.done = true;
  await persistResults();
  console.log(`\n=== GUARD 12 SUMMARY ===`);
  console.log(`total runs: ${g12TotalRuns}`);
  console.log(`money leak (priced pepperoni topping on wrong line): ${g12MoneyLeaks}/${g12TotalRuns}`);
  console.log(`kitchen-ticket leak (unverified_requests pepperoni on wrong line): ${g12TicketLeaks}/${g12TotalRuns}`);
  console.log(`turn2 made zero tool calls: ${g12NoToolCall}/${g12TotalRuns}`);
  console.log(`results file: ${RESULTS_PATH}`);
  console.log(g12MoneyLeaks === 0 && g12TicketLeaks === 0
    ? "\nPASS — GUARD 12 pepperoni-bleed did not reproduce across the Vito's Flatbreads matrix."
    : "\nFAIL — see per-run detail above for which phrasing.");
  Deno.exit(0);
}

console.log(`=== f0ecf0fe matrix replay (${PHRASINGS.length} phrasings x ${RUNS_PER_PHRASING} runs) ===\n`);

let totalRuns = 0;
let totalMoneyLeaks = 0;
let totalTicketLeaks = 0;
let totalNoToolCall = 0;

for (const { label, turn2 } of PHRASINGS) {
  console.log(`\n--- Phrasing: ${label} ---`);
  console.log(`  turn2: "${turn2}"`);
  for (let run = 1; run <= RUNS_PER_PHRASING; run++) {
    totalRuns++;
    const sessionId = `item4-f0ecf0fe-matrix-${Math.floor(Math.random() * 1e9)}`;
    const r1 = await send(TURN1, sessionId);
    const r2 = await send(turn2, sessionId);
    const lines = await fetchCart(sessionId);
    const { leakedOnto, moneyLeakApplied } = classify(lines);
    const toolCallCount2 = r2.debug_perf?.toolCallCount ?? -1;
    if (toolCallCount2 === 0) totalNoToolCall++;
    if (moneyLeakApplied) totalMoneyLeaks++;
    if (leakedOnto.length > 0) totalTicketLeaks++;
    const totalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
    console.log(
      `  run ${run}: lines=${lines.length} toolCallCount(turn2)=${toolCallCount2} ` +
      `moneyLeak=${moneyLeakApplied ? "YES" : "no"} ` +
      `ticketLeak=${leakedOnto.length > 0 ? `YES (${leakedOnto.map(l => l.name).join(", ")})` : "no"} ` +
      `total=${totalCents}`,
    );
    resultsState.runs.push({
      phrasing: label,
      turn2,
      run,
      lines: lines.length,
      toolCallCount2,
      moneyLeakApplied,
      leakedOntoLines: leakedOnto.map(l => l.name),
      totalCents,
      cartLines: lines.map(l => ({
        name: l.name, menu_item_id: l.menu_item_id, price_cents: l.price_cents,
        quantity: l.quantity, unverified_requests: l.unverified_requests,
      })),
    });
    await persistResults();
  }
}

console.log(`\n=== VITO'S CANARY (expect $9.48) ===`);
{
  const sessionId = `guard16-vitos-canary-${Math.floor(Math.random() * 1e9)}`;
  const steps: { message: string; reply: string | null }[] = [];
  const r1 = await send("cheeseburger", sessionId, VITOS_SHOP_ID);
  steps.push({ message: "cheeseburger", reply: r1.reply ?? null });
  const r2 = await send("medium", sessionId, VITOS_SHOP_ID);
  steps.push({ message: "medium", reply: r2.reply ?? null });
  const r3 = await send("thats it", sessionId, VITOS_SHOP_ID);
  steps.push({ message: "thats it", reply: r3.reply ?? null });
  const cartLines = await fetchCart(sessionId);
  const finalTotalCents = cartLines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const pass = finalTotalCents === 948;
  console.log(`  final total: ${finalTotalCents} cents (expected 948) -> ${pass ? "PASS" : "FAIL"}`);
  resultsState.canary = { label: "vitos-cheeseburger-medium", steps, finalTotalCents, expectedCents: 948, pass };
  await persistResults();
}

resultsState.done = true;
await persistResults();

console.log(`\n=== SUMMARY ===`);
console.log(`total runs: ${totalRuns}`);
console.log(`money leak (priced pepperoni modifier on wrong line): ${totalMoneyLeaks}/${totalRuns}`);
console.log(`kitchen-ticket leak (unverified_requests pepperoni on wrong line): ${totalTicketLeaks}/${totalRuns}`);
console.log(`turn2 made zero tool calls (model never acted): ${totalNoToolCall}/${totalRuns}`);
console.log(`results file: ${RESULTS_PATH}`);
console.log(totalMoneyLeaks === 0 && totalTicketLeaks === 0
  ? "\nPASS — neither leg of the pepperoni-bleed defect reproduced across the full matrix."
  : "\nFAIL — see per-run detail above for which leg and which phrasing.");
