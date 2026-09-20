// PO dispatch (2026-09-19), REAL LIVE MONEY BUG (v559 50-run, conv 8c64d701
// #12). Cart already holds a Small Chicken Bacon Ranch Pizza (Broccoli,
// Bacon) $22.45. A soup disambiguation ("Chicken Noodle Cup / Chicken Noodle
// Bowl / Lobster Bisque Cup") is open. The customer picks a soup AND, in the
// same breath, restates the pizza already in the cart:
//   "Cup of chicken noodle soup for me. The small Chicken Bacon Ranch pizza
//   with bacon and broccoli stays on the order."
// Broken (pre-fix): a SECOND, PLAIN (no toppings) Small Chicken Bacon Ranch
// Pizza gets added to the cart, and the soup disambiguation is never
// resolved — left open, re-asked next turn.
//
// ROOT CAUSE, traced against the real call path (methodology: this file
// drives runTurnEngineTurn end to end, PROPOSE forbidden, exactly like
// option-pick-and-restatement-dup-20260919.test.ts):
//
// isAnswerRestatementOfCartLine (turn-engine.ts, landed earlier tonight on
// fix/option-pick-and-restatement-dup-20260919) already resolves the outside
// span to a real menu_item_id (messageNamesItemOutsideCandidates) and
// already compares that id against the cart's own menu_item_id — so PO's
// literal framing ("compares raw TEXT against the cart line's text") is not
// quite the defect. Confirmed directly, with the model call forbidden:
// PO's own EXACT quoted message ("...So that's a small Chicken Bacon Ranch
// pizza...") already resolves CORRECTLY under tonight's pre-existing fix,
// because "so that's" happens to be one of isRestatementOfExistingOrder's
// dozen fixed marker phrases — see the "PO's literal fixture" regression
// test below, which passes both before and after this change.
//
// The REAL defect: isAnswerRestatementOfCartLine required BOTH (a) the
// resolved item already being in the cart AND (b) the customer's exact
// words containing one of those ~12 fixed phrases ("so that's", "just the",
// "to recap", "i already", ...). Any equally plain restatement that doesn't
// happen to use one of those exact phrases — which is most of the ways
// people actually talk, including this test's own money-bug fixture below —
// fails condition (b), so the guard reads a restated, unchanged line as a
// brand-new add. Two consequences in the SAME turn: (1) a second, PLAIN
// line (addNarrowedCandidateToCart never carries topping text into the add)
// for an item already in the cart WITH its toppings, and (2) because that
// branch returns immediately with a resolved outcome, the disambiguation
// actually open this turn (the soup pick) is never reached at all — not
// merely re-shown, but silently dropped and left open for next turn.
//
// FIX (turn-engine.ts): isAnswerRestatementOfCartLine now matches on the
// RESOLVED item plus topping compatibility (toppingsCompatibleWithCartLine)
// instead of requiring a marker phrase — exactly PO's own framing of the
// correct rule. ADDITION_MARKERS ("another"/"add"/"also"/"one more"/etc.) is
// kept as the one veto that still matters, so a customer explicitly asking
// for a second, deliberate item is never swallowed as a restatement.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const PIZZA_ID = "pizza-cbr-small";
const SOUP_CUP_ID = "soup-cnc-cup";
const SOUP_BOWL_ID = "soup-cnc-bowl";
const BISQUE_CUP_ID = "soup-bisque-cup";

// A real ask_plan modifier (toppings) group — needed so
// toppingsCompatibleWithCartLine has real choices to check the restated
// text against, not just a bare item with no steps.
const PIZZA_WITH_TOPPINGS: TurnEngineMenuItem = {
  id: PIZZA_ID, name: "Chicken Bacon Ranch Pizza - Small (10\")", category: "Pizza", price_cents: 2245, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Chicken Bacon Ranch Pizza - Small (10\")", base_price_cents: 2245,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: "toppings", slot_key: "toppings", kind: "modifier", ask_mode: "skip",
      prompt_template: "Any extra toppings?",
      choices: [
        { id: "t-broccoli", display: "Broccoli", price_delta_cents: 0 },
        { id: "t-bacon", display: "Bacon", price_delta_cents: 0 },
        { id: "t-pepperoni", display: "Pepperoni", price_delta_cents: 0 },
      ],
    }],
  },
} as unknown as TurnEngineMenuItem;

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  } as unknown as TurnEngineMenuItem;
}

const MENU: TurnEngineMenuItem[] = [
  PIZZA_WITH_TOPPINGS,
  realItem(SOUP_CUP_ID, "Chicken Noodle Soup - Cup", "Soups", 399),
  realItem(SOUP_BOWL_ID, "Chicken Noodle Soup - Bowl", "Soups", 549),
  realItem(BISQUE_CUP_ID, "Lobster Bisque - Cup", "Soups", 499),
];

const LEXICON = [
  { term: "chicken bacon ranch pizza", target_id: PIZZA_ID, category: "Pizza", size_label: "Small" },
  { term: "small chicken bacon ranch pizza", target_id: PIZZA_ID, category: "Pizza", size_label: "Small" },
  { term: "chicken bacon ranch", target_id: PIZZA_ID, category: "Pizza", size_label: "Small" },
  { term: "chicken noodle soup", target_id: SOUP_CUP_ID, category: "Soups", size_label: "Cup" },
  { term: "chicken noodle soup cup", target_id: SOUP_CUP_ID, category: "Soups", size_label: "Cup" },
  { term: "chicken noodle soup", target_id: SOUP_BOWL_ID, category: "Soups", size_label: "Bowl" },
  { term: "chicken noodle soup bowl", target_id: SOUP_BOWL_ID, category: "Soups", size_label: "Bowl" },
  { term: "lobster bisque", target_id: BISQUE_CUP_ID, category: "Soups", size_label: "Cup" },
];

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
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
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
  return supabase;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function cartBefore(): TurnEngineCartLine[] {
  return [
    {
      menu_item_id: PIZZA_ID,
      name: "Chicken Bacon Ranch Pizza - Small (10\")",
      quantity: 1,
      price_cents: 2245,
      modifiers: ["Broccoli", "Bacon"],
      line_key: `${PIZZA_ID}::1`,
    } as unknown as TurnEngineCartLine,
  ];
}

function soupDisambiguationOpen(): DialogueState {
  return {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [SOUP_CUP_ID, SOUP_BOWL_ID, BISQUE_CUP_ID], quantity: 1 },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  } as unknown as DialogueState;
}

function failingPropose(label: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => {
    throw new Error(`${label}: PROPOSE must never be called — this turn must resolve deterministically`);
  };
}

function baseInput(message: string): RunTurnInput {
  return {
    conversationId: "conv-8c64d701",
    shopId: "shop-repro",
    tenantId: "shop-repro",
    cartId: "cart-repro",
    message,
    history: [],
    menu: MENU,
    cart: cartBefore(),
    dialogueState: soupDisambiguationOpen(),
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
  } as unknown as RunTurnInput;
}

// ============================================================
// PRIMARY ACCEPTANCE (real money bug, marker-free phrasing): confirmed RED
// against pre-fix code — reproduced both halves (phantom duplicate pizza,
// lost soup pick) exactly, then GREEN after the fix.
// ============================================================
Deno.test("runner-level (money bug, marker-free restatement): picking the open soup while restating the identical in-cart pizza never duplicates the pizza and always resolves the soup", async () => {
  const deps: RunTurnDeps = {
    supabase: makeFakeSupabase(), apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("PRIMARY"),
  };
  const result = await runTurnEngineTurn(
    baseInput("Cup of chicken noodle soup for me. The small Chicken Bacon Ranch pizza with bacon and broccoli stays on the order."),
    deps,
  );

  const pizzaLines = result.cart.filter(l => l.menu_item_id === PIZZA_ID);
  assertEquals(pizzaLines.length, 1, `must be exactly ONE pizza line, never a phantom duplicate: ${JSON.stringify(result.cart)}`);
  assertEquals(pizzaLines[0].quantity, 1);
  assertEquals(pizzaLines[0].modifiers, ["Broccoli", "Bacon"], "the existing line's toppings must be untouched");
  const soupLines = result.cart.filter(l => l.menu_item_id === SOUP_CUP_ID);
  assertEquals(soupLines.length, 1, `the soup pick must resolve and be added, never lost: ${JSON.stringify(result.cart)}`);
  assert(
    result.dialogueState.open?.kind !== "disambiguation",
    `the soup disambiguation must be closed, not left open/re-asked: ${JSON.stringify(result.dialogueState.open)}`,
  );
});

// ============================================================
// REGRESSION (PO's literal fixture, exactly as reported): already correct
// pre-fix (the marker phrase "so that's" already protected it) — locked in
// here so it stays correct going forward, since this rule now no longer
// depends on that phrase being present at all.
// ============================================================
Deno.test("runner-level (PO's literal fixture): 'So that's a small Chicken Bacon Ranch pizza...' while the soup disambiguation is open never duplicates the pizza and resolves the soup", async () => {
  const deps: RunTurnDeps = {
    supabase: makeFakeSupabase(), apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("LITERAL_FIXTURE"),
  };
  const result = await runTurnEngineTurn(
    baseInput("Actually, let's just go with the cup of chicken noodle soup. So that's a small Chicken Bacon Ranch pizza with bacon and broccoli and the soup."),
    deps,
  );

  const pizzaLines = result.cart.filter(l => l.menu_item_id === PIZZA_ID);
  assertEquals(pizzaLines.length, 1, `must be exactly ONE pizza line: ${JSON.stringify(result.cart)}`);
  assertEquals(pizzaLines[0].modifiers, ["Broccoli", "Bacon"]);
  const soupLines = result.cart.filter(l => l.menu_item_id === SOUP_CUP_ID);
  assertEquals(soupLines.length, 1, `the soup pick must resolve: ${JSON.stringify(result.cart)}`);
  assert(result.dialogueState.open?.kind !== "disambiguation", "the soup disambiguation must be closed");
});

// ============================================================
// MUST NOT SWALLOW A GENUINELY DIFFERENT PIZZA: naming a topping that is NOT
// on the existing line (toppingsCompatibleWithCartLine's own veto) means
// this is a real change, not a restatement. Documents the pre-existing,
// out-of-scope limitation this task did not fix: the "outside item" add path
// (addNarrowedCandidateToCart) never carries topping text into the add
// either way, so the genuinely-different case still lands as a second,
// PLAIN line rather than a properly-modified one — unchanged from this
// mechanism's pre-existing behavior for every other "genuinely new outside
// item" case (see turn-engine.test.ts's Hawaiian-vs-Meat-Lover test).
// ============================================================
Deno.test("runner-level (must not swallow a real change): restating the pizza with a DIFFERENT topping is never treated as a restatement of the identical line", async () => {
  const deps: RunTurnDeps = {
    supabase: makeFakeSupabase(), apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("DIFFERENT_TOPPINGS"),
  };
  const result = await runTurnEngineTurn(
    baseInput("Cup of chicken noodle soup for me. The small Chicken Bacon Ranch pizza with pepperoni instead of bacon."),
    deps,
  );

  const pizzaLines = result.cart.filter(l => l.menu_item_id === PIZZA_ID);
  assertEquals(pizzaLines.length, 2, `a genuinely different topping must NOT be swallowed as a restatement of the (Broccoli, Bacon) line: ${JSON.stringify(result.cart)}`);
  const original = pizzaLines.find(l => JSON.stringify(l.modifiers) === JSON.stringify(["Broccoli", "Bacon"]));
  assert(original, "the original (Broccoli, Bacon) line must still be present, untouched");
});

// ============================================================
// ADDITION_MARKERS VETO STILL APPLIES: an explicit "another" names a real,
// deliberate second item and must never be swallowed as a restatement no
// matter how identical it is to the line already in the cart.
// ============================================================
Deno.test("runner-level (addition marker still wins): 'I'll take another small Chicken Bacon Ranch pizza with bacon and broccoli' adds a genuine second line", async () => {
  const deps: RunTurnDeps = {
    supabase: makeFakeSupabase(), apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("ADDITION_MARKER"),
  };
  const result = await runTurnEngineTurn(
    baseInput("Cup of chicken noodle soup for me. I'll take another small Chicken Bacon Ranch pizza with bacon and broccoli."),
    deps,
  );

  const pizzaLines = result.cart.filter(l => l.menu_item_id === PIZZA_ID);
  assertEquals(pizzaLines.length, 2, `an explicit 'another' must still add a real second line: ${JSON.stringify(result.cart)}`);
});
