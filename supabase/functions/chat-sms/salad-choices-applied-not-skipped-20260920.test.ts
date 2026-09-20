// PO dispatch (2026-09-20, real live conv 561f161f-9d7b-4675-8b62-
// bea9718660762, v582 (currently deployed), error_log row propose_success
// d3759350-e719-415f-8311-72caa7f68fbb, PAID): "hey, lemme get 2x house
// salads w/ black diamond steak, shrimp, and bleu cheese dressing. also 1x
// mikes hot n honey medium 14" w/ half spinach" -- this is tonight's own
// veto fix (dbfb1fa4, "off-menu veto never fires when the span is a real
// choice on an item named in the same message") shipping and immediately
// producing a NEW, different regression on the very next real conversation.
//
// Verified FALSE first: this is NOT the veto path at all. The real captured
// PROPOSE payload above (quoted verbatim below) never splits "bleu cheese
// dressing"/"shrimp"/"black diamond steak" into their own `adds` the way the
// EARLIER real conv (b71cbbdc, dbfb1fa4's own fixture) did -- here PROPOSE
// keeps ONE add for "house salads" and attaches a single {group_id,
// choice_id} pair directly as that add's own `choices`. findVetoedOffMenuTerm
// is never even called for this add (item_span is "house salads", not
// "bleu cheese dressing"), so dbfb1fa4's veto branch plays no role here.
//
// ROOT CAUSE 1 (turn-engine.ts, decide()'s add-resolution loop, 00-BF's own
// modifier-floor gate, "let effectiveChoices = add.choices ?? [];" just
// above): the model's one {group_id, choice_id} pair -- group_id
// "1c032716-6fe4-4b30-846a-5d00de9c78d3", choice_id
// "b5808b2c-f858-4494-9b97-95e38e9c1edc" -- matches NEITHER House Salad's
// real Dressing slot NOR its real Add-ons modifier group (confirmed against
// the live compiled ask_plan below, queried 2026-09-20): a model
// hallucination, the exact same failure class describeDroppedChoiceForDecline
// already documents at a different call site ("a model hallucination, not a
// real 'this topping isn't available' menu fact"). Because `add.choices` was
// non-empty (ONE garbled entry), the 00-BF floor's own gate --
// "effectiveChoices.length === 0 && customerMessage" -- never ran, so the
// customer's own plainly-stated, genuinely real "black diamond steak" and
// "shrimp" words were never recovered from text at all. resolveChoiceDisplays
// then dropped the one bogus pair (matches nothing on House's ask_plan),
// producing the generic "A requested option for House wasn't recognized --
// skipped" decline, and the House Salad line landed completely plain
// ($8.99 base, no add-ons, no charge for either) -- reproduced deterministically
// against real Vito's menu/lexicon data via the runner, see this dispatch's
// own PO report for the exact 3-run transcript.
//
// FIX 1: a choices array holding ONLY entries that match nothing real on
// THIS item carries exactly as much real information as an empty array --
// treat it the same way and fall through to the 00-BF floor. If even ONE
// asserted choice DOES resolve, this still trusts the model entirely and
// never runs the floor -- the "never override a choice it did make" contract
// is unchanged.
//
// ROOT CAUSE 2 (same loop, the per-step modifier-floor scan a few dozen
// lines below FIX 1): with FIX 1 alone, the floor's own scoped text for the
// House Salad add does contain BOTH "black diamond steak" and "shrimp" (via
// scopedModifierText's phrase attribution + the R4 adjacent-orphan-phrase
// fold), but recoverAssertedChoicesFromText's own tie-guard
// (`allPlainHitsLand = plainHits.length === 1 || noCompetingItems || ...`)
// drops BOTH silently: `noCompetingItems` is only ever `soleAddThisTurn`,
// which is false here because the Mikes Hot n Honey pizza is ALSO being
// added this same turn -- even though the pizza's own real ask_plan (toppings
// only: Pepperoni, Sausage, Spinach, etc.) shares NONE of House Salad's own
// Add-ons choice names, so there is no OTHER real thing in this turn either
// word could plausibly mean. Confirmed: with FIX 1 alone (no FIX 2), the
// spurious decline disappears but the House Salad line STILL lands plain --
// a new, silent, undetected money loss (missing $14.00 of real, named
// add-ons with no decline to even flag it), which does not satisfy "choices
// named with the item apply."
//
// FIX 2 (stepChoicesCollideWithAnySibling, declared above
// spanIsWholeChoiceOfAnyAdd): generalizes soleAddThisTurn's own privilege
// from "no other item anywhere in the turn" to "no other item THIS TURN
// shares any of this step's own choice names" -- scoped to the STEP (not the
// whole item), so a genuine name collision on a real sibling item (two items
// that both happen to offer a "Shrimp" choice, say) stays exactly as
// conservative as before for that one step. Reuses the SAME connective-
// stripping-free, exact-display-name comparison already trusted throughout
// this file; no new fuzzy matching introduced.
//
// SCOPE NOTE: Dressing is a required SLOT (ask_mode "ask") on House Salad's
// own compiled ask_plan. Neither fix above touches slot handling --
// "slots are ASKED, never inferred" is untouched, deliberate, pre-existing
// design (00-BF's own header; also the EXPLICIT, tested behavior dbfb1fa4's
// own regression test asserts for this identical shape, same night). This
// dispatch's own fixture describes the Dressing as silently applied rather
// than asked; that directly conflicts with the still-passing, still-current
// dbfb1fa4 test asserting a "Which dressing?" question fires for the
// identical text. Not resolved here -- flagged in this dispatch's own PO
// report as a genuine design fork for an explicit decision, not silently
// picked either way.
//
// METHODOLOGY: drives the real production call path, turn-engine-runner.ts's
// runTurnEngineTurn -- PROPOSE mocked with the REAL captured proposal
// (error_log row d3759350-e719-415f-8311-72caa7f68fbb, conversation
// 561f161f-9d7b-4675-8b62-b69718660762, quoted verbatim below, queried live
// 2026-09-20), everything downstream (resolveItem, decide, ask, render) is
// the genuine, unmodified production code. MENU/LEXICON below are Vito's own
// real House Salad and Medium Mikes Hot n Honey Pizza ask_plans and the real
// active item-lexicon rows this repro depends on, queried live 2026-09-20
// (shop_id e0000000-0000-0000-0000-000000000001) -- never hand-invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-20.
const HOUSE_SALAD = "a9f637bb-8264-44ef-b6c1-a5ffb4a83391";
const MIKES_MEDIUM = "0c4c4803-77dc-4543-bb5f-e6c0c19df7fe";
const DRESSING_GROUP = "1c9f5bb5-aca0-4e41-ae6f-9b9e151fd35a";
const ADDONS_GROUP = "df0444a4-149f-4c03-8e7b-4ef4f88e76c1";
const BLACK_DIAMOND_STEAK = "8cf98102-2faa-4869-a1be-f5c22d81d4e8";
const SHRIMP = "a93d731e-e8f6-4dda-800b-ce65c6050fc0";
const TOPPINGS_GROUP = "10f39735-b412-45bb-8623-0ef80db5cf86";
const SPINACH_HALF = "62458da4-cdb9-4887-8081-b4d08607892a";
// The real model-hallucinated pair from the live capture -- matches NEITHER
// House Salad's Dressing slot NOR its Add-ons group.
const HALLUCINATED_GROUP = "1c032716-6fe4-4b30-846a-5d00de9c78d3";
const HALLUCINATED_CHOICE = "b5808b2c-f858-4494-9b97-95e38e9c1edc";

// Real House Salad ask_plan (queried live 2026-09-20) -- Dressing is a
// required SLOT (ask_mode "ask"), Add-ons is an on_request MODIFIER step.
const MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_SALAD, name: "House", category: "Salads", price_cents: 899,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "House",
      base_price_cents: 899, recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: DRESSING_GROUP,
          slot_key: null, prompt_template: "dressing.ask",
          choices: [
            { id: "1715bc67-3d08-4c06-a400-af84f6478a73", display: "French", price_delta_cents: 0 },
            { id: "1af6b431-0e2f-44f7-89fa-388bad8fb334", display: "Bleu Cheese", price_delta_cents: 0 },
            { id: "cef0542e-6ce8-47c8-b53d-4879fcb48312", display: "Ranch", price_delta_cents: 0 },
          ],
        },
        {
          kind: "modifier", ask_mode: "on_request", group_id: ADDONS_GROUP,
          slot_key: null, prompt_template: "add-ons.on_request",
          choices: [
            { id: "619c0983-1827-4b80-9e6e-cbb88ed518a4", display: "Chicken", price_delta_cents: 400 },
            { id: "832329a7-ab84-4755-9e4c-1c08040db2e6", display: "Blackened Salmon", price_delta_cents: 800 },
            { id: BLACK_DIAMOND_STEAK, display: "Black Diamond Steak", price_delta_cents: 800 },
            { id: SHRIMP, display: "Shrimp", price_delta_cents: 600 },
          ],
        },
      ],
    },
  },
  // Real Medium Mikes Hot n Honey Pizza ask_plan (queried live 2026-09-20,
  // trimmed to a representative subset of its real toppings step) -- shares
  // NONE of House Salad's own Add-ons choice names, which is exactly what
  // FIX 2 above depends on to safely land both House Add-ons.
  {
    id: MIKES_MEDIUM, name: "Medium Mikes Hot N Honey Pizza", category: "Pizza", price_cents: 1999,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "Medium Mikes Hot N Honey Pizza",
      base_price_cents: 1999, recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "modifier", ask_mode: "on_request", group_id: TOPPINGS_GROUP,
          slot_key: null, prompt_template: "toppings.on_request",
          choices: [
            { id: SPINACH_HALF, display: "Spinach (Half pizza)", price_delta_cents: 400 },
            { id: "d50a94da-3c35-449d-aced-e458f1c42cc6", display: "Spinach (Whole pizza)", price_delta_cents: 500 },
            { id: "ef181dbe-d4bb-4650-9ebc-8882ee321c7a", display: "Sausage (Whole pizza)", price_delta_cents: 450 },
            { id: "63f3949a-70b7-45be-9396-755913ab33b4", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
          ],
        },
      ],
    },
  },
];

// Real active item-lexicon rows (queried live 2026-09-20).
const ACTIVE_ITEM_LEXICON = [
  { term: "house", target_id: HOUSE_SALAD, active: true },
  { term: "house salad", target_id: HOUSE_SALAD, active: true },
  { term: "houses", target_id: HOUSE_SALAD, active: true },
  { term: "mikes hot n honey", target_id: MIKES_MEDIUM, active: true },
  { term: "hot n honey", target_id: MIKES_MEDIUM, active: true },
  { term: "medium mikes hot n honey", target_id: MIKES_MEDIUM, active: true },
];
const INACTIVE_ITEM_LEXICON: Array<{ term: string; target_id: string; active: boolean }> = [];
const ALL_LEXICON_ROWS = [...ACTIVE_ITEM_LEXICON, ...INACTIVE_ITEM_LEXICON];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-561f161f-house-black-diamond-shrimp",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
  };
}

// Same shape as offmenu-veto-choice-of-same-message-item-20260920.test.ts's
// own makeFakeSupabase.
// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder(table: string) {
    const eqFilters: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq(col: string, val: unknown) { eqFilters[col] = val; return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        if (table !== "lexicon") return Promise.resolve({ data: [], error: null });
        const filtered = ALL_LEXICON_ROWS.filter(r => r.active === eqFilters["active"]);
        return Promise.resolve({
          data: filtered.slice(from, to + 1).map(r => ({ term: r.term, target_id: r.target_id })),
          error: null,
        });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = MENU
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void) {
        if (table === "lexicon") {
          const filtered = ALL_LEXICON_ROWS.filter(r => r.active === eqFilters["active"]);
          return Promise.resolve({ data: null, error: null, count: filtered.length }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

const MESSAGE = "hey, lemme get 2x house salads w/ black diamond steak, shrimp, and bleu cheese dressing. also 1x mikes hot n honey medium 14\" w/ half spinach";

// Real error_log propose_success capture (row d3759350-e719-415f-8311-
// 72caa7f68fbb, conv 561f161f-9d7b-4675-8b62-b69718660762), quoted verbatim.
function realCapturedPropose(): Promise<ProposeResult> {
  return Promise.resolve({
    ok: true, attempts: 1,
    proposal: {
      intent: "order",
      adds: [
        { choices: [{ group_id: HALLUCINATED_GROUP, choice_id: HALLUCINATED_CHOICE }], quantity: 2, item_span: "house salads" },
        { choices: [], quantity: 1, item_span: "mikes hot n honey medium 14\"" },
      ],
      removes: [], modifies: [],
    },
  });
}

for (let run = 1; run <= 3; run++) {
  Deno.test(`runner (PO fixture, real live conv 561f161f, v582, run ${run}/3): named add-ons apply, no false "wasn't recognized" decline, Dressing still asked (not silently guessed)`, async () => {
    const supabase = makeFakeSupabase();
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: realCapturedPropose,
    };
    const result = await runTurnEngineTurn(baseInput({ message: MESSAGE }), deps);

    assert(!/wasn't recognized/i.test(result.reply), `must never show the generic "wasn't recognized" decline once the model's own choice is a real, named modifier: ${JSON.stringify(result.reply)}`);
    assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline: ${JSON.stringify(result.reply)}`);

    const house = result.cart.find(l => l.menu_item_id === HOUSE_SALAD);
    assert(house, `House salad must be in the cart: ${JSON.stringify(result.cart)}`);
    assertEquals(house!.quantity, 2);
    const addOns = house!.ask_plan_selections?.[ADDONS_GROUP];
    const addOnIds = Array.isArray(addOns) ? addOns : addOns ? [addOns] : [];
    assert(addOnIds.includes(BLACK_DIAMOND_STEAK), `Black Diamond Steak must apply to the House add-ons, not be silently dropped: ${JSON.stringify(house)}`);
    assert(addOnIds.includes(SHRIMP), `Shrimp must apply to the House add-ons, not be silently dropped: ${JSON.stringify(house)}`);
    // base 899 + Black Diamond Steak 800 + Shrimp 600 = 2299 per unit
    // (quantity tracked separately on the line).
    assertEquals(house!.price_cents, 2299, `both real add-ons must be priced in: ${JSON.stringify(house)}`);

    const pizza = result.cart.find(l => l.menu_item_id === MIKES_MEDIUM);
    assert(pizza, `Mikes Hot n Honey pizza must be in the cart: ${JSON.stringify(result.cart)}`);
    const toppings = pizza!.ask_plan_selections?.[TOPPINGS_GROUP];
    const toppingIds = Array.isArray(toppings) ? toppings : toppings ? [toppings] : [];
    assert(toppingIds.includes(SPINACH_HALF), `Spinach (Half) must still apply to the pizza, unaffected by this fix: ${JSON.stringify(pizza)}`);

    // Dressing is a required SLOT -- by existing, unchanged, deliberate
    // design ("slots are ASKED, never inferred", also dbfb1fa4's own
    // regression test for the identical shape), it is never auto-filled
    // from raw text even though the customer already said "bleu cheese
    // dressing" in the same breath. Flagged as a real design fork in this
    // dispatch's own PO report -- not silently resolved either way here.
    assert(/dressing/i.test(result.reply), `Dressing must still be asked (unchanged, deliberate design) rather than silently guessed: ${JSON.stringify(result.reply)}`);
  });
}

Deno.test("runner (PO fixture, regression guard): a genuinely off-menu word (matches nothing anywhere) must still decline, never silently apply as a fabricated choice", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { choices: [], quantity: 2, item_span: "house salads" },
          { choices: [], quantity: 1, item_span: "unicorn glitter dust" },
        ],
        removes: [], modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "2 house salads and a unicorn glitter dust please" }),
    deps,
  );
  assert(/didn't catch|wasn't recognized|don't have/i.test(result.reply), `a genuinely off-menu word matching nothing must still be declined/flagged, not silently applied: ${JSON.stringify(result.reply)}`);
  const house = result.cart.find(l => l.menu_item_id === HOUSE_SALAD);
  assert(house, "House salad must still land");
  const addOns = house!.ask_plan_selections?.[ADDONS_GROUP];
  assertEquals(addOns, undefined, `a fabricated, off-menu word must never resolve as a real House add-on: ${JSON.stringify(house)}`);
});
