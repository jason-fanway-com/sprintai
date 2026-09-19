// Round 4 P0 (2026-09-19, remove-guard pronoun + replacement). ede12f60's
// hallucinated-remove guard (removeHasRemovalLanguage) correctly blocked a
// re-proposed remove pulled from conversation history, but it broke two
// real shapes:
//
//   1. "switch THAT to Cheesesteak instead" -- "that" is a pronoun the guard
//      only accepted as the sole referent when it was the ONLY real line in
//      the cart; "switch"/"instead" alone weren't in the removal-verb list
//      either, so hasVerb failed before the pronoun check was ever reached.
//   2. "swap out the pizza for Buffalo Chicken" / "change my Grilled Cheese
//      to Chicken Fingers" -- a remove-and-add spoken in one breath, where
//      PROPOSE's own removes/adds for the pair is exactly as unreliable as
//      the hallucinated-remove case the guard was built for.
//
// Fix: parseReplacementIntent + resolveReplacementTargetLine in
// turn-engine.ts resolve the replacement directly from the CUSTOMER'S
// CURRENT message, in code, bypassing PROPOSE's own removes/adds for that
// pair entirely; removeHasRemovalLanguage's pronoun check now resolves
// against the most-recently-added real line (resolvePronounTargetLineKey)
// instead of requiring a single-line cart.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decide, type Proposal, type TurnEngineCartLine, type TurnEngineMenuItem } from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const SLICE_ID = "slice-001-0000-0000-0000-000000000000";
const CHEESESTEAK_ID = "steak-001-0000-0000-0000-000000000000";
const CBR_PIZZA_ID = "cbr-p-001-0000-0000-0000-000000000000";
const BUFFALO_CHICKEN_ID = "buffalo01-0000-0000-0000-000000000000";
const GRILLED_CHEESE_ID = "grcheese1-0000-0000-0000-000000000000";
const CHICKEN_FINGERS_ID = "chickfing-0000-0000-0000-000000000000";
const FRIES_ID = "fries-0001-0000-0000-0000-000000000000";
const PIZZA_A_ID = "pizza-a01-0000-0000-0000-000000000000";
const PIZZA_B_ID = "pizza-b01-0000-0000-0000-000000000000";
const PIZZA_C_ID = "pizza-c01-0000-0000-0000-000000000000";
const PIZZA_D_ID = "pizza-d01-0000-0000-0000-000000000000";

function askPlan(displayName: string, priceCents: number) {
  return {
    compiled_at: "", compiler_version: 1, display_name: displayName,
    base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [],
  };
}

const MENU: TurnEngineMenuItem[] = [
  { id: SLICE_ID, name: "The Slice", category: "Sandwiches", price_cents: 899, bot_state: "orderable", ask_plan: askPlan("The Slice", 899) },
  { id: CHEESESTEAK_ID, name: "Cheesesteak", category: "Sandwiches", price_cents: 999, bot_state: "orderable", ask_plan: askPlan("Cheesesteak", 999) },
  { id: CBR_PIZZA_ID, name: "Cheese Bacon Ranch - Large (16\")", category: "Pizza", price_cents: 2095, bot_state: "orderable", ask_plan: askPlan("Cheese Bacon Ranch - Large (16\")", 2095) },
  { id: BUFFALO_CHICKEN_ID, name: "Buffalo Chicken - Large (16\")", category: "Pizza", price_cents: 2095, bot_state: "orderable", ask_plan: askPlan("Buffalo Chicken - Large (16\")", 2095) },
  { id: GRILLED_CHEESE_ID, name: "Grilled Cheese", category: "Sandwiches", price_cents: 599, bot_state: "orderable", ask_plan: askPlan("Grilled Cheese", 599) },
  { id: CHICKEN_FINGERS_ID, name: "Chicken Fingers", category: "Sides", price_cents: 799, bot_state: "orderable", ask_plan: askPlan("Chicken Fingers", 799) },
  { id: FRIES_ID, name: "French Fries", category: "Sides", price_cents: 499, bot_state: "orderable", ask_plan: askPlan("French Fries", 499) },
  { id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", category: "Pizza", price_cents: 1895, bot_state: "orderable", ask_plan: askPlan("Pepperoni - Large (16\")", 1895) },
  { id: PIZZA_B_ID, name: "Plain - Large (16\")", category: "Pizza", price_cents: 1795, bot_state: "orderable", ask_plan: askPlan("Plain - Large (16\")", 1795) },
  { id: PIZZA_C_ID, name: "Hawaiian - Large (16\")", category: "Pizza", price_cents: 1995, bot_state: "orderable", ask_plan: askPlan("Hawaiian - Large (16\")", 1995) },
  { id: PIZZA_D_ID, name: "Meat Lovers - Large (16\")", category: "Pizza", price_cents: 2295, bot_state: "orderable", ask_plan: askPlan("Meat Lovers - Large (16\")", 2295) },
];

const LEXICON: LexiconTerm[] = [
  { term: "the slice", target_id: SLICE_ID },
  { term: "cheesesteak", target_id: CHEESESTEAK_ID },
  { term: "cheese bacon ranch", target_id: CBR_PIZZA_ID },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_ID },
  { term: "grilled cheese", target_id: GRILLED_CHEESE_ID },
  { term: "chicken fingers", target_id: CHICKEN_FINGERS_ID },
  { term: "fries", target_id: FRIES_ID },
  { term: "french fries", target_id: FRIES_ID },
];

Deno.test("Sim #46: 'I want to switch that to a Cheesesteak instead' replaces the lone cart line via pronoun, even when PROPOSE proposes nothing", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: SLICE_ID, name: "The Slice", quantity: 1, price_cents: 899, modifiers: [], line_key: "line-slice" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, () => "steak-line", "I want to switch that to a Cheesesteak instead");

  assertEquals(result.cart.filter(l => l.menu_item_id === SLICE_ID).length, 0, "The Slice must be gone");
  assertEquals(result.cart.filter(l => l.menu_item_id === CHEESESTEAK_ID).length, 1, "one Cheesesteak must be in the cart");
  assertEquals(result.cart.length, 1);
});

Deno.test("Sim #12: 'actually, can we swap out the pizza for Buffalo Chicken?' replaces the CBR pizza via category match", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CBR_PIZZA_ID, name: "Cheese Bacon Ranch - Large (16\")", quantity: 1, price_cents: 2095, modifiers: [], line_key: "line-cbr" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, () => "buffalo-line", "actually, can we swap out the pizza for Buffalo Chicken?");

  assertEquals(result.cart.filter(l => l.menu_item_id === CBR_PIZZA_ID).length, 0, "Cheese Bacon Ranch must be gone");
  assertEquals(result.cart.filter(l => l.menu_item_id === BUFFALO_CHICKEN_ID).length, 1, "one Buffalo Chicken must be in the cart");
  assertEquals(result.cart.length, 1);
});

Deno.test("Sim #21: 'change my Grilled Cheese to Chicken Fingers, and add fries' replaces by name AND still adds fries through the normal path", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: GRILLED_CHEESE_ID, name: "Grilled Cheese", quantity: 1, price_cents: 599, modifiers: [], line_key: "line-gc" },
  ];
  // The model still sees "fries" and proposes it normally -- the replacement
  // parser must not interfere with (or duplicate) that unrelated add.
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "fries", quantity: 1, choices: [] }],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, cart, MENU, LEXICON, () => "new-line", "change my Grilled Cheese to Chicken Fingers, and add fries");

  assertEquals(result.cart.filter(l => l.menu_item_id === GRILLED_CHEESE_ID).length, 0, "Grilled Cheese must be gone");
  assertEquals(result.cart.filter(l => l.menu_item_id === CHICKEN_FINGERS_ID).length, 1, "one Chicken Fingers must be in the cart");
  assertEquals(result.cart.filter(l => l.menu_item_id === FRIES_ID).length, 1, "fries must still be added");
  assertEquals(result.cart.length, 2);
});

Deno.test("regression: 'actually can you add some fries' with 4 pizzas in cart removes nothing (no removal/replacement language at all)", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", quantity: 1, price_cents: 1895, modifiers: [], line_key: "line-a" },
    { menu_item_id: PIZZA_B_ID, name: "Plain - Large (16\")", quantity: 1, price_cents: 1795, modifiers: [], line_key: "line-b" },
    { menu_item_id: PIZZA_C_ID, name: "Hawaiian - Large (16\")", quantity: 1, price_cents: 1995, modifiers: [], line_key: "line-c" },
    { menu_item_id: PIZZA_D_ID, name: "Meat Lovers - Large (16\")", quantity: 1, price_cents: 2295, modifiers: [], line_key: "line-d" },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "fries", quantity: 1, choices: [] }],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, cart, MENU, LEXICON, () => "fries-line", "actually can you add some fries");

  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_A_ID).length, 1, "Pepperoni must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_B_ID).length, 1, "Plain must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_C_ID).length, 1, "Hawaiian must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_D_ID).length, 1, "Meat Lovers must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === FRIES_ID).length, 1, "fries must be added");
  assertEquals(result.cart.length, 5);
});

Deno.test("pronoun target resolves to the most-recently-added line in a multi-line cart: 'switch that to Buffalo Chicken' targets the last pizza added", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", quantity: 1, price_cents: 1895, modifiers: [], line_key: "line-a" },
    { menu_item_id: PIZZA_B_ID, name: "Plain - Large (16\")", quantity: 1, price_cents: 1795, modifiers: [], line_key: "line-b" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, () => "buffalo-line-2", "actually switch that to Buffalo Chicken instead");

  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_A_ID).length, 1, "Pepperoni (not the most recent) must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_B_ID).length, 0, "Plain (the most recently added) must be replaced");
  assertEquals(result.cart.filter(l => l.menu_item_id === BUFFALO_CHICKEN_ID).length, 1, "one Buffalo Chicken must be in the cart");
  assertEquals(result.cart.length, 2);
});

Deno.test("X cannot be identified: 'swap out the salad for fries' with no salad in cart asks which item, touches nothing", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: GRILLED_CHEESE_ID, name: "Grilled Cheese", quantity: 1, price_cents: 599, modifiers: [], line_key: "line-gc" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, () => "new-line", "swap out the salad for fries");

  assertEquals(result.cart.length, 1, "cart must be untouched");
  assertEquals(result.cart[0].menu_item_id, GRILLED_CHEESE_ID);
  assert(result.declines.some(d => d.reason.includes("Which item")), "must ask which item to replace");
});
