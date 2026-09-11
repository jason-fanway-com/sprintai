// P0 LIVE replay (2026-09-10, third revision) — closes the gap the
// unit-level replay in
// supabase/functions/chat-sms/zios-89-95-vs-95-95-20260909.test.ts declared
// up front: that file exercises only the extracted pricing/detection/render
// functions in isolation, never the live LLM tool-call sequence. This script
// drives the actual deployed chat-sms endpoint against real Zio's/Vito's DB
// rows on test-mode Stripe/hours rails — not a fabricated event.
//
// HISTORY OF THIS DEFECT FAMILY (all four sites, chronological):
//  1. Money leg (2026-09-09, Zio's, GUARD 2c fix): pepperoni applied and
//     PRICED as a modifier on both the Meat Lover's and Hawaiian lines from
//     one turn naming "1 pepperoni" once. Fixed via source_phrase/
//     sourcePhraseIndex on the compiled add_item path.
//  2. Kitchen-ticket leg, compiled path (2026-09-10, GUARD 16 fix, commit
//     b2e1ebf): the same whole-turn scan, one level up — GUARD 16's
//     "did the reply falsely confirm an unresolved modifier" check matched
//     "pepperoni" against the WHOLE turn for every touched line, not the
//     phrase that claimed it.
//  3. Kitchen-ticket leg, legacy path (2026-09-10, GUARD 12 fix, commit
//     c2f8e3c): the identical defect on GUARD 12, the legacy/option_groups
//     counterpart of GUARD 16.
//  4. Real PRICED overcharge, legacy path (2026-09-10, THIS fix): the actual
//     modifier-RESOLUTION code (reactive-modifier-match.ts's
//     matchReactiveExtras, called from index.ts's legacy add_item/
//     modify_item) was still scanning the raw, unscoped, un-stripped whole
//     turn — worse than 2/3, this one APPLIES AND PRICES the false claim,
//     not just flags it. Live repro (PO, Vito's, 3/3): "Chicken Bacon Ranch
//     flatbread, BBQ Chicken flatbread with pepperoni, Cheesesteak
//     flatbread, Margherita flatbread" charged a "Bacon" topping — sourced
//     from nothing but three letters of item 1's OWN NAME — onto all four
//     lines, while the one line that DID ask for a real topping (BBQ
//     Chicken + pepperoni) was the line MOST LIKELY to miss its own charge
//     (2 of 3 runs), since "Pepperoni" landed in unverified_requests instead
//     of being applied.
//
// STRUCTURAL FIX: scopedModifierText (phrase-split.ts) is now the ONE shared
// primitive every consumer of "what text may this item's modifier claim be
// matched against" reads from — legacy add_item/modify_item's reactive
// modifier match (the actual resolver/pricer, fixed here), GUARD 12, and
// GUARD 16 (both re-pointed at the same function instead of each
// re-deriving their own scoping+name-stripping logic). It (a) scopes to the
// item's own claimed phrase, never the whole turn, and (b) strips the item's
// own display name out as one contiguous unit before matching, so naming a
// dish is never read as a request for an ingredient of its own name.
//
// NOT folded into the shared function: the compiled path's `modifierScopeText`
// (index.ts's add_item call, used only for isNegated() checks in
// ask-plan-engine.ts). Rank-2 fix (2026-09-09) already removed ALL reactive
// free-text modifier MATCHING from the compiled path — a compiled modifier
// only ever resolves via matchAssertedChoice (the model's own validated
// tool-call input), never via scanning customer text — so it was never
// exposed to the identity-word-collision class this fix addresses, and its
// undefined/""/text three-way fallback contract is deliberately different
// from the guards' whole-turn fallback. Forcing it through the same function
// would risk a heavily-hardened, P0-incident-dense path for no bug-fixing
// benefit.
//
// KNOWN RESIDUAL GAP (pre-existing, not introduced or fixed by this change):
// phrase-split.ts's splitter only treats "and" as a phrase boundary when
// immediately followed by a quantity/article. "...cheesesteak flatbread and
// margherita flatbread" (no digit/article before "margherita") does NOT
// split into two phrases — Cheesesteak and Margherita share one merged
// phrase. This repro's own phrasings (matching the PO's exact live text)
// exhibit this; it does not affect this test's outcome since no leaking
// modifier word sits inside that merged phrase, but a future case where a
// leaking word DOES sit inside such an unsplit "and X" tail would still be
// exposed. Out of scope for this dispatch — touching the boundary regex
// risks regressing GUARD 2c's hardened money-path splitting.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

interface Line {
  name: string;
  price_cents: number;
  quantity: number;
  menu_item_id: string;
  options?: Record<string, string[]>;
  ask_plan_selections?: Record<string, string | string[]>;
  unverified_requests?: string[];
}

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

const RUNS_PER_PHRASING = 5;
const RESULTS_PATH = new URL("./tmp-consumed-token-fix-verify-20260910-results.json", import.meta.url).pathname;

interface RunResult {
  suite: "zios-compiled" | "vitos-legacy";
  phrasing: string;
  turn2: string;
  run: number;
  toolCallCount2: number;
  leakedOntoLines: string[];
  missingOwnTopping: boolean;
  subtotalCents: number;
  expectedSubtotalCents: number;
  subtotalCorrect: boolean;
  cartLines: { name: string; menu_item_id: string; price_cents: number; quantity: number; options?: Record<string, string[]>; ask_plan_selections?: Record<string, string | string[]>; unverified_requests?: string[] }[];
}

interface CanaryResult {
  label: string;
  steps: { message: string; reply: string | null }[];
  subtotalCents: number;
  expectedSubtotalCents: number;
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

async function fetchBasePriceCents(menuItemId: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?select=price_cents&id=eq.${menuItemId}`, { headers: restHeaders });
  const [row] = await res.json();
  return row.price_cents as number;
}

// ── Suite 1: Zio's (compiled path), the original pepperoni-bleed repro ────
const ZIOS_TURN1 = "I need 4 large pizzas please";
const PLAIN_ID = "35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd"; // Neapolitan Cheese Pizza - Large 18''
const MEAT_LOVERS_ID = "0b7a33b7-f02c-4609-b7d2-1b99c08e805a";
const HAWAIIAN_ID = "5eb4554f-d4f7-4f8d-8440-55b051856650";
const PEPPERONI_PIZZA_ID = "6ac9c4cf-255b-4098-bdbb-f006cf2cf3c6"; // its own item, not a topping — the ONLY line "pepperoni" should ever attach to
const PLAIN_BASE_CENTS = 2499; // Meat Lover's / Hawaiian base, confirmed live via qa_ro
// Expected subtotal is computed from real, live base prices (fetched below)
// rather than hardcoded — the prior draft of this file guessed a round
// number without verifying it against the DB and would have been wrong.
let ZIOS_EXPECTED_SUBTOTAL = 0;

const ZIOS_PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit (verbatim incident)", turn2: "1 plain, 1 pepperoni, 1 meat lovers and one hawaii" },
  { label: "comma+word", turn2: "one plain, one pepperoni, one meat lover and one hawaiian" },
  { label: "and-separated", turn2: "a plain one and a pepperoni one and a meat lovers and a hawaiian" },
  { label: "bare list", turn2: "plain pepperoni meat lovers hawaiian" },
  { label: "conversational", turn2: "can I get one with nothing on it, one pepperoni, one meat lovers, and one hawaiian please" },
];

// No line in this repro asks for an ADDABLE topping (pepperoni here is its
// own standalone item, not a modifier on another pizza) — there is no
// "missing" direction to check for this suite. Only leaked-onto (ticket) and
// subtotal (money) are meaningful here; see the file header for why.
function classifyZios(lines: Line[]) {
  const leakedOnto = lines.filter(l =>
    l.menu_item_id !== PEPPERONI_PIZZA_ID &&
    (l.unverified_requests ?? []).some(u => u.toLowerCase().includes("pepperoni")),
  );
  const meatLovers = lines.find(l => l.menu_item_id === MEAT_LOVERS_ID);
  const hawaiian = lines.find(l => l.menu_item_id === HAWAIIAN_ID);
  const moneyLeakOnOthers =
    (!!meatLovers && meatLovers.price_cents !== PLAIN_BASE_CENTS) ||
    (!!hawaiian && hawaiian.price_cents !== PLAIN_BASE_CENTS);
  if (moneyLeakOnOthers) {
    for (const l of [meatLovers, hawaiian]) {
      if (l && l.price_cents !== PLAIN_BASE_CENTS && !leakedOnto.includes(l)) leakedOnto.push(l);
    }
  }
  return { leakedOnto, missingOwnTopping: false };
}

// ── Suite 2: Vito's (legacy path), the real-overcharge repro ──────────────
const VITOS_TURN1 = "I'd like 4 flatbreads please";
const CHICKEN_BACON_RANCH_ID = "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d";
const BBQ_CHICKEN_ID = "80d49c72-d238-4ef9-8b29-12ec7097b213"; // the ONLY line pepperoni should ever attach to, and it MUST attach here
const CHEESESTEAK_ID = "80f8624c-358c-4004-9b94-75d8c66e6008";
const MARGHERITA_ID = "a37a47a9-7f6c-47bb-acdd-933f572890de";
const FLATBREAD_BASE_CENTS = 1050;
const PEPPERONI_TOPPING_CENTS = 50;
let VITOS_EXPECTED_SUBTOTAL = 0; // computed below from live base prices

const VITOS_PHRASINGS: { label: string; turn2: string }[] = [
  { label: "comma+digit", turn2: "1 chicken bacon ranch, 1 bbq chicken with pepperoni, 1 cheesesteak and 1 margherita" },
  { label: "comma+word", turn2: "one chicken bacon ranch, one bbq chicken with pepperoni, one cheesesteak and one margherita" },
  { label: "and-separated", turn2: "a chicken bacon ranch and a bbq chicken with pepperoni and a cheesesteak and a margherita" },
  { label: "bare list", turn2: "chicken bacon ranch bbq chicken pepperoni cheesesteak margherita, four flatbreads" },
  { label: "conversational", turn2: "can I get a chicken bacon ranch, a bbq chicken with pepperoni on it, a cheesesteak, and a margherita please" },
];

const OTHER_FLATBREAD_IDS = [CHICKEN_BACON_RANCH_ID, CHEESESTEAK_ID, MARGHERITA_ID];

function hasToppingNamed(l: Line, needle: string): boolean {
  const inOptions = Object.values(l.options ?? {}).flat().some(v => v.toLowerCase().includes(needle));
  const inUnverified = (l.unverified_requests ?? []).some(u => u.toLowerCase().includes(needle));
  return inOptions || inUnverified || l.price_cents !== FLATBREAD_BASE_CENTS;
}

function classifyVitos(lines: Line[]) {
  // Leaked onto: any OTHER line carrying a "Bacon" or "Pepperoni" claim
  // (priced, in options, or flagged unverified) it was never asked for.
  const leakedOnto = lines.filter(l => OTHER_FLATBREAD_IDS.includes(l.menu_item_id) && (hasToppingNamed(l, "bacon") || hasToppingNamed(l, "pepperoni")));
  // Missing own topping: BBQ Chicken's phrase DID ask for pepperoni — it
  // must actually be applied (priced +$0.50, in options.Toppings), not just
  // flagged as an unverified request.
  const bbq = lines.find(l => l.menu_item_id === BBQ_CHICKEN_ID);
  const bbqHasPepperoniApplied = !!bbq &&
    Object.values(bbq.options ?? {}).flat().some(v => v.toLowerCase().includes("pepperoni")) &&
    bbq.price_cents === FLATBREAD_BASE_CENTS + PEPPERONI_TOPPING_CENTS;
  const missingOwnTopping = !bbqHasPepperoniApplied;
  return { leakedOnto, missingOwnTopping };
}

ZIOS_EXPECTED_SUBTOTAL =
  (await fetchBasePriceCents(PLAIN_ID)) +
  (await fetchBasePriceCents(PEPPERONI_PIZZA_ID)) +
  (await fetchBasePriceCents(MEAT_LOVERS_ID)) +
  (await fetchBasePriceCents(HAWAIIAN_ID));
VITOS_EXPECTED_SUBTOTAL =
  (await fetchBasePriceCents(CHICKEN_BACON_RANCH_ID)) +
  (await fetchBasePriceCents(BBQ_CHICKEN_ID)) + PEPPERONI_TOPPING_CENTS +
  (await fetchBasePriceCents(CHEESESTEAK_ID)) +
  (await fetchBasePriceCents(MARGHERITA_ID));
console.log(`Zio's expected subtotal: ${ZIOS_EXPECTED_SUBTOTAL} cents`);
console.log(`Vito's expected subtotal: ${VITOS_EXPECTED_SUBTOTAL} cents\n`);

console.log(`=== Suite 1: Zio's (compiled), ${ZIOS_PHRASINGS.length} phrasings x ${RUNS_PER_PHRASING} runs ===\n`);
let zTotal = 0, zLeaks = 0, zSubtotalWrong = 0, zNoToolCall = 0;
for (const { label, turn2 } of ZIOS_PHRASINGS) {
  console.log(`\n--- Phrasing: ${label} ---`);
  console.log(`  turn2: "${turn2}"`);
  for (let run = 1; run <= RUNS_PER_PHRASING; run++) {
    zTotal++;
    const sessionId = `consumedfix-zios-${Math.floor(Math.random() * 1e9)}`;
    await send(ZIOS_TURN1, sessionId, ZIOS);
    const r2 = await send(turn2, sessionId, ZIOS);
    const lines = await fetchCart(sessionId);
    const { leakedOnto, missingOwnTopping } = classifyZios(lines);
    const toolCallCount2 = r2.debug_perf?.toolCallCount ?? -1;
    if (toolCallCount2 === 0) zNoToolCall++;
    if (leakedOnto.length > 0) zLeaks++;
    const subtotalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
    const subtotalCorrect = subtotalCents === ZIOS_EXPECTED_SUBTOTAL;
    if (!subtotalCorrect) zSubtotalWrong++;
    console.log(
      `  run ${run}: toolCallCount(turn2)=${toolCallCount2} ` +
      `leak=${leakedOnto.length > 0 ? `YES (${leakedOnto.map(l => l.name).join(", ")})` : "no"} ` +
      `subtotal=${subtotalCents} (expected ${ZIOS_EXPECTED_SUBTOTAL}) ${subtotalCorrect ? "OK" : "WRONG"}`,
    );
    resultsState.runs.push({
      suite: "zios-compiled", phrasing: label, turn2, run, toolCallCount2,
      leakedOntoLines: leakedOnto.map(l => l.name), missingOwnTopping,
      subtotalCents, expectedSubtotalCents: ZIOS_EXPECTED_SUBTOTAL, subtotalCorrect,
      cartLines: lines.map(l => ({ name: l.name, menu_item_id: l.menu_item_id, price_cents: l.price_cents, quantity: l.quantity, options: l.options, ask_plan_selections: l.ask_plan_selections, unverified_requests: l.unverified_requests })),
    });
    await persistResults();
  }
}

console.log(`\n=== Suite 2: Vito's (legacy), ${VITOS_PHRASINGS.length} phrasings x ${RUNS_PER_PHRASING} runs ===\n`);
let vTotal = 0, vLeaks = 0, vMissing = 0, vSubtotalWrong = 0, vNoToolCall = 0;
for (const { label, turn2 } of VITOS_PHRASINGS) {
  console.log(`\n--- Phrasing: ${label} ---`);
  console.log(`  turn2: "${turn2}"`);
  for (let run = 1; run <= RUNS_PER_PHRASING; run++) {
    vTotal++;
    const sessionId = `consumedfix-vitos-${Math.floor(Math.random() * 1e9)}`;
    await send(VITOS_TURN1, sessionId, VITOS_ID);
    const r2 = await send(turn2, sessionId, VITOS_ID);
    const lines = await fetchCart(sessionId);
    const { leakedOnto, missingOwnTopping } = classifyVitos(lines);
    const toolCallCount2 = r2.debug_perf?.toolCallCount ?? -1;
    if (toolCallCount2 === 0) vNoToolCall++;
    if (leakedOnto.length > 0) vLeaks++;
    if (missingOwnTopping) vMissing++;
    const subtotalCents = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
    const subtotalCorrect = subtotalCents === VITOS_EXPECTED_SUBTOTAL;
    if (!subtotalCorrect) vSubtotalWrong++;
    console.log(
      `  run ${run}: toolCallCount(turn2)=${toolCallCount2} ` +
      `leak=${leakedOnto.length > 0 ? `YES (${leakedOnto.map(l => l.name).join(", ")})` : "no"} ` +
      `missingOwnTopping=${missingOwnTopping ? "YES" : "no"} ` +
      `subtotal=${subtotalCents} (expected ${VITOS_EXPECTED_SUBTOTAL}) ${subtotalCorrect ? "OK" : "WRONG"}`,
    );
    resultsState.runs.push({
      suite: "vitos-legacy", phrasing: label, turn2, run, toolCallCount2,
      leakedOntoLines: leakedOnto.map(l => l.name), missingOwnTopping,
      subtotalCents, expectedSubtotalCents: VITOS_EXPECTED_SUBTOTAL, subtotalCorrect,
      cartLines: lines.map(l => ({ name: l.name, menu_item_id: l.menu_item_id, price_cents: l.price_cents, quantity: l.quantity, options: l.options, ask_plan_selections: l.ask_plan_selections, unverified_requests: l.unverified_requests })),
    });
    await persistResults();
  }
}

console.log(`\n=== VITO'S CANARY (cheeseburger, medium) ===`);
{
  // HARNESS BUG FIX (2026-09-10, PO catch): this used to compare the cart
  // SUBTOTAL (849 = $8.49, no fee) against 948 (subtotal + the $0.99
  // delivery/service fee applied at CHECKOUT, never present in cart_json).
  // There was never a real regression here — comparing subtotal to
  // subtotal+fee always fails regardless of code correctness. Fixed to
  // assert the subtotal alone.
  const sessionId = `consumedfix-vitos-canary-${Math.floor(Math.random() * 1e9)}`;
  const steps: { message: string; reply: string | null }[] = [];
  const r1 = await send("cheeseburger", sessionId, VITOS_ID);
  steps.push({ message: "cheeseburger", reply: r1.reply ?? null });
  const r2 = await send("medium", sessionId, VITOS_ID);
  steps.push({ message: "medium", reply: r2.reply ?? null });
  const r3 = await send("thats it", sessionId, VITOS_ID);
  steps.push({ message: "thats it", reply: r3.reply ?? null });
  const cartLines = await fetchCart(sessionId);
  const subtotalCents = cartLines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const pass = subtotalCents === 849;
  console.log(`  cart subtotal: ${subtotalCents} cents (expected 849) -> ${pass ? "PASS" : "FAIL"}`);
  resultsState.canary = { label: "vitos-cheeseburger-medium", steps, subtotalCents, expectedSubtotalCents: 849, pass };
  await persistResults();
}

resultsState.done = true;
await persistResults();

console.log(`\n=== SUMMARY ===`);
console.log(`Zio's (compiled):  ${zTotal} runs, ${zLeaks} ticket-leaks, ${zSubtotalWrong} wrong subtotal, ${zNoToolCall} zero-tool-call turns`);
console.log(`Vito's (legacy):   ${vTotal} runs, ${vLeaks} leaks-onto, ${vMissing} missing-own-topping, ${vSubtotalWrong} wrong subtotal, ${vNoToolCall} zero-tool-call turns`);
console.log(`canary: ${resultsState.canary?.pass ? "PASS" : "FAIL"}`);
console.log(`results file: ${RESULTS_PATH}`);
const allClean = zLeaks === 0 && zSubtotalWrong === 0 && vLeaks === 0 && vMissing === 0 && vSubtotalWrong === 0 && resultsState.canary?.pass;
console.log(allClean
  ? "\nPASS — no leak, no missing-topping, no subtotal defect across either suite."
  : "\nFAIL — see per-run detail above for which suite, phrasing, and direction.");
