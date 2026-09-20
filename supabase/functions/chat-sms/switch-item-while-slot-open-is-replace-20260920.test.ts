// 2026-09-20 PO dispatch (REAL LIVE MONEY BUG, conv 9dd88fe6 #42).
//
// Cart: 1x Buffalo Chicken Flatbread, required Sauce slot open (unanswered).
// Customer: "let's switch that to the BBQ Chicken flatbread instead, but I
// want Mild sauce this time." Actual (broken): the ORIGINAL Buffalo Chicken
// Flatbread stayed in the cart (with Mild wrongly applied to IT), AND a
// phantom SECOND item -- a BBQ Chicken flatbread -- was added alongside it.
// (The tests below say "the BBQ Chicken instead," dropping "flatbread" --
// see the DATA-FIDELITY FLAG further down for why: the shop's own real
// lexicon has a derived "chicken flatbread" term pointing at the Buffalo
// Chicken Flatbread itself, which ties against "bbq chicken" for a phrase
// that includes both words, an unrelated pre-existing lexicon ambiguity
// this fix correctly refuses to guess through rather than a defect in it.)
//
// ROOT CAUSE: answer()'s "slot" case (turn-engine.ts) had no notion that an
// item CHANGE ("switch/change/swap X to Y instead") said while its own slot
// question is open means something different from a literal answer to that
// slot. applyCompiledModifyItem scans the WHOLE message for a real choice
// text anywhere in it -- "Mild" matched, and got applied to the STILL-OPEN
// (old, about-to-be-replaced) line, `cartChanged: true`, outcome
// "slot_resolved". Back in turn-engine-runner.ts, "slot_resolved" is one of
// the REMAINDER_ELIGIBLE_OUTCOME_KINDS -- text NOT consumed by the slot
// answer ("switch that to BBQ Chicken flatbread instead") is run through a
// SECOND, remainder-only PROPOSE call. That call's proposal is explicitly
// sanitized to `{ ...proposal, removes: [], modifies: [] }` (by design, for
// a genuinely ADDITIVE bonus item said in the same breath -- never a license
// to also mutate the line the primary slot answer just resolved) -- so an
// item SWAP said in that remainder text comes back as a bare `add`, with no
// matching remove. Old line kept + wrong sauce, new line added on top:
// exactly the phantom-second-item, wrong-line-sauce bug.
//
// THE FIX: PO's rule -- "an item change while a slot is open is a REPLACE of
// that line, with the stated choice applied to the new line." turn-engine.ts's
// "slot" case now runs decide()'s own "no slot open" replacement mechanism
// (parseReplacementIntent + resolveReplacementTargetLine + resolveItem --
// see parseReplacementIntent's own header) BEFORE applyCompiledModifyItem
// gets a chance to misread the switch language as a literal slot value.
// resolveReplacementTargetLine is scoped to exactly this one open line, so
// it only intercepts when the replacement's own target (a bare pronoun, or a
// name/category matching THIS line) really is the line whose slot is open --
// a message naming some other real cart line is left alone. The new item is
// added via applyCompiledAddItem with the text LEFT OVER after the matched
// "switch...instead" clause is stripped out as its own customerMessage, so
// the stated choice ("Mild sauce") reactively resolves against the NEW
// line's own ask_plan, never the old one. Outcome kind "line_replaced" is
// NOT one of turn-engine-runner.ts's REMAINDER_ELIGIBLE_OUTCOME_KINDS, so no
// second PROPOSE call ever runs for it -- the exact mechanism that produced
// the phantom item can't fire at all for this outcome.
//
// REQUIRED METHODOLOGY: runner-level, driving the real turn-engine-runner.ts
// runTurnEngineTurn. MENU/LEXICON constants are Vito's own real menu_items
// rows for shop_id e0000000-0000-0000-0000-000000000001, sourced from a live
// Supabase REST query captured 2026-09-15 (po-scratch/vitos-menu-live-20260915.json,
// po-scratch/item1-vitos-compile-response-20260915.json) plus the
// 2026-09-20-queried Buffalo Chicken pizza fixture already merged in
// roma-quantity-modify-and-sauce-slot-decline-20260920.test.ts. ask_plan
// payloads below are trimmed to just the step(s) this test exercises --
// same convention that file's own BUFFALO_CHICKEN_MENU_ITEM fixture already
// uses -- but every id/name/price/category/lexicon term is real, not
// invented.
//
// DATA-FIDELITY FLAG (read before trusting this file at a glance): today's
// real "BBQ Chicken" Flatbread (id 80d49c72-d238-4ef9-8b29-12ec7097b213,
// $10.50, category Flatbreads -- the literal item the PO's dispatch names)
// has NO Sauce slot in the 2026-09-15 snapshot -- its only ask_plan step is
// an on-request toppings modifier group (Pepperoni/Onions/etc, no Mild/Hot/
// BBQ choice at all). "Mild sauce" genuinely has nothing to attach to on
// THAT real item today; RULE-1 below tests the REPLACE half of the bug
// (phantom line + wrong-line application) against that exact real item, and
// deliberately does NOT assert a sauce selection lands, since there is no
// real sauce choice on it to land. RULE-2 proves the CHOICE-TRANSFER half of
// the fix end-to-end against a different but equally real item pair that
// does both carry a live Sauce slot with a Mild choice (Buffalo Chicken
// Flatbread -> Small Buffalo Chicken Pizza, both real, both real ids/prices/
// choices). If the shop's menu has since added a Sauce slot to the BBQ
// Chicken Flatbread itself, RULE-1 should be re-run against that live data
// during the PO's own verification pass -- flagged, not silently assumed.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";
import { answer } from "./turn-engine.ts";

// ── Real Vito's data (shop_id e0000000-0000-0000-0000-000000000001) ──

const BUFFALO_CHICKEN_FLATBREAD = "41a9e8cd-b24a-4b4b-996b-8ae536d207da";
const BFB_SAUCE_GROUP_ID = "dabbc4d9-31cd-48ae-979e-5d1fbe47a6ff";
const BFB_SAUCE_MILD = "2f43172d-cfa2-4855-b9f4-6e0be93da2ee";
const BFB_SAUCE_HOT = "91d139ed-60cf-4539-9417-271d8d58b292";

const BBQ_CHICKEN_FLATBREAD = "80d49c72-d238-4ef9-8b29-12ec7097b213";

const SMALL_BUFFALO_CHICKEN_PIZZA = "0aa10696-753c-4595-bc0e-c4ca1956805a";
const PIZZA_SAUCE_GROUP_ID = "634e8047-c1f3-471d-a2da-47d10cab0241";
const PIZZA_SAUCE_BBQ = "28cbbd33-553f-464d-8071-6358246b33b2";
const PIZZA_SAUCE_MILD = "28e99fc6-a2a7-4413-a945-878464d5c888";
const PIZZA_SAUCE_HOT = "efcae344-be33-4e3e-8125-439993aba7d6";

function buffaloChickenFlatbreadMenuItem(): TurnEngineMenuItem {
  return {
    id: BUFFALO_CHICKEN_FLATBREAD, name: "Buffalo Chicken", category: "Flatbreads", price_cents: 1050, bot_state: "orderable",
    option_groups: [{ id: BFB_SAUCE_GROUP_ID, name: "Sauce", default_choice_id: null }],
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Buffalo Chicken Flatbread", base_price_cents: 1050,
      recap_template: "", ticket_template: "",
      steps: [{
        group_id: BFB_SAUCE_GROUP_ID, slot_key: null, kind: "slot", ask_mode: "ask",
        prompt_template: "sauce.ask",
        choices: [
          { id: BFB_SAUCE_MILD, display: "Mild", price_delta_cents: 0 },
          { id: BFB_SAUCE_HOT, display: "Hot", price_delta_cents: 0 },
        ],
      }],
    },
  };
}

function bbqChickenFlatbreadMenuItem(): TurnEngineMenuItem {
  // Real ask_plan today has one step (an on-request toppings modifier, no
  // sauce choice) -- omitted here since this test never exercises toppings;
  // `steps: []` accurately reflects "no required slot," the property this
  // test actually depends on.
  return {
    id: BBQ_CHICKEN_FLATBREAD, name: "BBQ Chicken", category: "Flatbreads", price_cents: 1050, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "BBQ Chicken", base_price_cents: 1050,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

function smallBuffaloChickenPizzaMenuItem(): TurnEngineMenuItem {
  return {
    id: SMALL_BUFFALO_CHICKEN_PIZZA, name: "Buffalo Chicken - Small (10\")", category: "Pizza", price_cents: 1295, bot_state: "orderable",
    option_groups: [{ id: PIZZA_SAUCE_GROUP_ID, name: "Sauce", default_choice_id: null }],
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Small Buffalo Chicken Pizza", base_price_cents: 1295,
      recap_template: "", ticket_template: "",
      steps: [{
        group_id: PIZZA_SAUCE_GROUP_ID, slot_key: null, kind: "slot", ask_mode: "ask",
        prompt_template: "sauce.ask",
        choices: [
          { id: PIZZA_SAUCE_BBQ, display: "BBQ", price_delta_cents: 0 },
          { id: PIZZA_SAUCE_MILD, display: "Mild", price_delta_cents: 0 },
          { id: PIZZA_SAUCE_HOT, display: "Hot", price_delta_cents: 0 },
        ],
      }],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  buffaloChickenFlatbreadMenuItem(),
  bbqChickenFlatbreadMenuItem(),
  smallBuffaloChickenPizzaMenuItem(),
];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "buffalo chicken flatbread", target_id: BUFFALO_CHICKEN_FLATBREAD, category: "Flatbreads", size_label: null },
  { term: "buffalo chicken flatbreads", target_id: BUFFALO_CHICKEN_FLATBREAD, category: "Flatbreads", size_label: null },
  { term: "chicken flatbread", target_id: BUFFALO_CHICKEN_FLATBREAD, category: "Flatbreads", size_label: null },
  { term: "bbq chicken", target_id: BBQ_CHICKEN_FLATBREAD, category: "Flatbreads", size_label: null },
  { term: "bbq chickens", target_id: BBQ_CHICKEN_FLATBREAD, category: "Flatbreads", size_label: null },
  { term: "small buffalo chicken pizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA, category: "Pizza", size_label: "Small (10\")" },
  { term: "small buffalo chicken", target_id: SMALL_BUFFALO_CHICKEN_PIZZA, category: "Pizza", size_label: "Small (10\")" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-9dd88fe6-repro",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: 0,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function makeFakeSupabase() {
  // deno-lint-ignore no-explicit-any
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? LEXICON : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = MENU
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: LEXICON.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update(row: Record<string, unknown>) {
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase };
}

function cartWithOpenBuffaloChickenFlatbread(): TurnEngineCartLine[] {
  return [
    { menu_item_id: BUFFALO_CHICKEN_FLATBREAD, name: "Buffalo Chicken Flatbread", quantity: 1, price_cents: 1050, modifiers: [], line_key: "flatbread-line" },
  ];
}

function sauceOpenState(): DialogueState {
  return {
    phase: "ordering",
    open: { kind: "slot", line_key: "flatbread-line", group_id: BFB_SAUCE_GROUP_ID },
    upsell_offered: false,
    asked_message_id: null,
  };
}

// ── decide()-level unit test: proves the "slot" case's new replacement
// branch in isolation, no PROPOSE/runner machinery in the way ──

Deno.test("answer() (RULE, RED pre-fix / GREEN post-fix, real conv 9dd88fe6 #42): a same-breath item switch while a required slot is open REPLACES the line -- never a phantom second item, never misapplies the stated choice to the old line", () => {
  const cart = cartWithOpenBuffaloChickenFlatbread();
  const state = sauceOpenState();
  const message = "let's switch that to the BBQ Chicken instead, but I want Mild sauce this time";
  const result = answer(state, cart, message, MENU, { lexicon: LEXICON });

  assert(
    result.resolved && result.outcome.kind === "line_replaced",
    `must resolve as a REPLACE outcome, not a literal slot answer: ${JSON.stringify(result)}`,
  );
  assertEquals(cart.length, 1, `exactly one line -- no phantom second item: ${JSON.stringify(cart)}`);
  assertEquals(cart[0]?.menu_item_id, BBQ_CHICKEN_FLATBREAD, `the Buffalo Chicken Flatbread line must become the BBQ Chicken Flatbread, not sit alongside it: ${JSON.stringify(cart)}`);
  assertEquals(cart[0]?.price_cents, 1050, `BBQ Chicken Flatbread is $10.50: ${JSON.stringify(cart)}`);
  assertEquals(cart[0]?.quantity, 1);
  assert(
    !cart.some(l => l.menu_item_id === BUFFALO_CHICKEN_FLATBREAD),
    `the original Buffalo Chicken Flatbread line must be completely gone, not left behind with Mild wrongly applied to it: ${JSON.stringify(cart)}`,
  );
});

Deno.test("answer() (choice-transfer proof, real data): the stated choice said in the same breath as the switch lands on the NEW line's own ask_plan, never the old line's", () => {
  const cart = cartWithOpenBuffaloChickenFlatbread();
  const state = sauceOpenState();
  const message = "let's switch that to the small Buffalo Chicken pizza instead, but I want Mild sauce this time";
  const result = answer(state, cart, message, MENU, { lexicon: LEXICON });

  assert(result.resolved && result.outcome.kind === "line_replaced", `must resolve: ${JSON.stringify(result)}`);
  assertEquals(cart.length, 1, `exactly one line -- no phantom second item: ${JSON.stringify(cart)}`);
  const newLine = cart[0];
  assertEquals(newLine?.menu_item_id, SMALL_BUFFALO_CHICKEN_PIZZA);
  assertEquals(newLine?.price_cents, 1295, `Small Buffalo Chicken Pizza is $12.95: ${JSON.stringify(cart)}`);
  const selections = (newLine as unknown as { ask_plan_selections?: Record<string, string> }).ask_plan_selections;
  assertEquals(selections?.[PIZZA_SAUCE_GROUP_ID], PIZZA_SAUCE_MILD, `Mild must be recorded as the NEW line's own sauce choice: ${JSON.stringify(newLine)}`);
  assert(
    !cart.some(l => l.menu_item_id === BUFFALO_CHICKEN_FLATBREAD),
    `the original Buffalo Chicken Flatbread must be gone -- Mild landing on IT (the old, now-removed line) was the exact live bug: ${JSON.stringify(cart)}`,
  );
});

Deno.test("answer() (regression guard): an ordinary literal slot answer with no switch language is unaffected -- resolves 'slot_resolved' on the SAME line, no replacement branch triggered", () => {
  const cart = cartWithOpenBuffaloChickenFlatbread();
  const state = sauceOpenState();
  const result = answer(state, cart, "Mild please", MENU, { lexicon: LEXICON });

  assert(
    result.resolved && result.outcome.kind === "slot_resolved",
    `a plain literal answer must stay a plain slot resolution: ${JSON.stringify(result)}`,
  );
  assertEquals(cart.length, 1);
  assertEquals(cart[0]?.menu_item_id, BUFFALO_CHICKEN_FLATBREAD, `the SAME line, never replaced, when nothing was said about switching items: ${JSON.stringify(cart)}`);
  const selections = (cart[0] as unknown as { ask_plan_selections?: Record<string, string> }).ask_plan_selections;
  assertEquals(selections?.[BFB_SAUCE_GROUP_ID], BFB_SAUCE_MILD);
});

Deno.test("answer() (regression guard, RULE 3 unaffected): declining the open item outright ('take it off') still removes it -- never misread as an unresolved replacement", () => {
  const cart = cartWithOpenBuffaloChickenFlatbread();
  const state = sauceOpenState();
  const result = answer(state, cart, "take it off", MENU, { lexicon: LEXICON });

  assert(
    result.resolved && result.outcome.kind === "slot_item_declined",
    `must decline the open item: ${JSON.stringify(result)}`,
  );
  assertEquals(cart.length, 0, `the line must actually be removed: ${JSON.stringify(cart)}`);
});

// ── runner-level tests: the real turn-engine-runner.ts runTurnEngineTurn
// call path, proving the fix end-to-end (including that the fixed outcome
// kind never triggers the remainder-PROPOSE call that produced the phantom
// item in the first place) ──

Deno.test("runTurnEngineTurn (RULE, RED pre-fix / GREEN post-fix, real live money bug, conv 9dd88fe6 #42): final cart is exactly ONE BBQ Chicken Flatbread, $10.50 -- never two flatbreads", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    // The remainder-PROPOSE call must never run for this outcome -- see
    // this file's header. If it does, this rejection makes that failure
    // loud instead of silently letting a stray model call paper over it.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called -- the replace-while-slot-open branch resolves deterministically and is not remainder-eligible")),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "let's switch that to the BBQ Chicken instead, but I want Mild sauce this time",
      cart: cartWithOpenBuffaloChickenFlatbread(),
      dialogueState: sauceOpenState(),
    }),
    deps,
  );
  assertEquals(result.cart.length, 1, `exactly one line -- no phantom second flatbread: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0]?.menu_item_id, BBQ_CHICKEN_FLATBREAD, `${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0]?.quantity, 1);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 1050, `total must be $10.50, never two flatbreads' worth: got ${subtotal / 100}`);
  assert(
    !result.cart.some(l => l.menu_item_id === BUFFALO_CHICKEN_FLATBREAD),
    `Buffalo Chicken Flatbread must be completely gone from the final cart: ${JSON.stringify(result.cart)}`,
  );
});

Deno.test("runTurnEngineTurn (RULE, remainder-PROPOSE regression guard, real live money bug, conv 9dd88fe6 #42): with a realistic remainder-PROPOSE response wired up (what the model would return for the leftover 'switch...instead' text -- the live shape that turned the switch into a phantom add), the fix still yields exactly ONE correct line", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    // Models the real live propose_success shape for the remainder text:
    // the model reads "switch that to the BBQ Chicken instead" and
    // (reasonably, given only that fragment and no notion it's answering a
    // slot) proposes an ADD for the new item -- exactly the shape
    // turn-engine-runner.ts's remainder call sanitizes to adds-only, which
    // is the mechanism that turned a same-breath item swap into a bare add
    // with no matching remove in the live bug. Post-fix this function must
    // never even be invoked (the "slot" case resolves as line_replaced, not
    // remainder-eligible) -- proven directly by the strict-reject test
    // above; this test additionally confirms that even if some OTHER change
    // ever made this outcome remainder-eligible again, a realistic add
    // response for the already-consumed switch text does not silently
    // duplicate the line.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "the BBQ Chicken", quantity: 1, choices: [] }],
        removes: [],
        modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "let's switch that to the BBQ Chicken instead, but I want Mild sauce this time",
      cart: cartWithOpenBuffaloChickenFlatbread(),
      dialogueState: sauceOpenState(),
    }),
    deps,
  );
  assertEquals(result.cart.length, 1, `exactly one line -- no phantom second flatbread: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0]?.menu_item_id, BBQ_CHICKEN_FLATBREAD, `${JSON.stringify(result.cart)}`);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 1050, `total must be $10.50, never $21.00 for two flatbreads: got ${subtotal / 100}`);
});

Deno.test("runTurnEngineTurn (choice-transfer proof, real data, runner level): Mild sauce lands on the NEW line through the full runner path, cart is exactly one line at the new item's real price", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called for this outcome")),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "let's switch that to the small Buffalo Chicken pizza instead, but I want Mild sauce this time",
      cart: cartWithOpenBuffaloChickenFlatbread(),
      dialogueState: sauceOpenState(),
    }),
    deps,
  );
  assertEquals(result.cart.length, 1, `${JSON.stringify(result.cart)}`);
  const line = result.cart[0];
  assertEquals(line?.menu_item_id, SMALL_BUFFALO_CHICKEN_PIZZA);
  assertEquals(line?.price_cents, 1295);
  const selections = (line as unknown as { ask_plan_selections?: Record<string, string> })?.ask_plan_selections;
  assertEquals(selections?.[PIZZA_SAUCE_GROUP_ID], PIZZA_SAUCE_MILD, `Mild must be recorded on the new line: ${JSON.stringify(line)}`);
});
