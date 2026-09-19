// Round 3 P0 (2026-09-19, hallucinated-remove): live repro on Jason's own
// order -- 4 distinct pizzas already in the cart, customer says "Yes, I want
// some fries too." PROPOSE re-proposed removes for all four pizza lines
// (pulled from conversation HISTORY, same failure class as the stale-add
// bug already guarded against), and the code executed them on trust: final
// cart was 4x Large Cheese + Fries at $70.99 instead of 4 distinct pizzas +
// fries at $91.47. The customer said nothing about removing anything.
//
// Fix: decide()'s removes loop now validates each proposed remove against
// the customer's OWN current message before deleting a line -- see
// removeHasRemovalLanguage's header in turn-engine.ts. This file exercises
// that guard directly at the decide() level (unit, not live), covering both
// the hallucination it must block and the real removals it must not break.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decide, type Proposal, type TurnEngineCartLine, type TurnEngineMenuItem } from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const FRIES_ID = "fries-0001-0000-0000-0000-000000000000";
const ONION_RINGS_ID = "onion-001-0000-0000-0000-000000000000";
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
  { id: FRIES_ID, name: "French Fries", category: "Sides", price_cents: 499, bot_state: "orderable", ask_plan: askPlan("French Fries", 499) },
  { id: ONION_RINGS_ID, name: "Onion Rings", category: "Sides", price_cents: 599, bot_state: "orderable", ask_plan: askPlan("Onion Rings", 599) },
  { id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", category: "Pizza", price_cents: 1895, bot_state: "orderable", ask_plan: askPlan("Pepperoni - Large (16\")", 1895) },
  { id: PIZZA_B_ID, name: "Plain - Large (16\")", category: "Pizza", price_cents: 1795, bot_state: "orderable", ask_plan: askPlan("Plain - Large (16\")", 1795) },
  { id: PIZZA_C_ID, name: "Hawaiian - Large (16\")", category: "Pizza", price_cents: 1995, bot_state: "orderable", ask_plan: askPlan("Hawaiian - Large (16\")", 1995) },
  { id: PIZZA_D_ID, name: "Meat Lovers - Large (16\")", category: "Pizza", price_cents: 2295, bot_state: "orderable", ask_plan: askPlan("Meat Lovers - Large (16\")", 2295) },
];

const LEXICON: LexiconTerm[] = [
  { term: "fries", target_id: FRIES_ID },
  { term: "french fries", target_id: FRIES_ID },
  { term: "onion rings", target_id: ONION_RINGS_ID },
];

function pizzaCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", quantity: 1, price_cents: 1895, modifiers: [], line_key: "line-a" },
    { menu_item_id: PIZZA_B_ID, name: "Plain - Large (16\")", quantity: 1, price_cents: 1795, modifiers: [], line_key: "line-b" },
    { menu_item_id: PIZZA_C_ID, name: "Hawaiian - Large (16\")", quantity: 1, price_cents: 1995, modifiers: [], line_key: "line-c" },
    { menu_item_id: PIZZA_D_ID, name: "Meat Lovers - Large (16\")", quantity: 1, price_cents: 2295, modifiers: [], line_key: "line-d" },
  ];
}

Deno.test("P0: 'Yes, I want some fries too.' does not remove any of the 4 pizzas already in the cart, even when PROPOSE hallucinates removes for all four", () => {
  const cart = pizzaCart();
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "fries", quantity: 1, choices: [] }],
    removes: [{ line_key: "line-a" }, { line_key: "line-b" }, { line_key: "line-c" }, { line_key: "line-d" }],
    modifies: [],
  };
  const result = decide(proposal, cart, MENU, LEXICON, () => "fries-line", "Yes, I want some fries too.");

  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_A_ID).length, 1, "Pepperoni must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_B_ID).length, 1, "Plain must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_C_ID).length, 1, "Hawaiian must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIZZA_D_ID).length, 1, "Meat Lovers must survive");
  assertEquals(result.cart.filter(l => l.menu_item_id === FRIES_ID).length, 1, "fries must be added");
  assertEquals(result.cart.length, 5);
  assertEquals(result.guardDroppedRemoves.length, 4, "all four hallucinated removes must be recorded as guard-dropped");
  assert(!result.declines.some(d => d.reason.includes("wasn't in your order")), "hallucinated removes must be silent, not a customer-facing decline");

  const totalCents = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(totalCents, 1895 + 1795 + 1995 + 2295 + 499, "must total the 4 distinct pizzas + fries, not a collapsed duplicate");
});

Deno.test("regression: 'scratch the fries' removes fries (single fries line in cart)", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: FRIES_ID, name: "French Fries", quantity: 1, price_cents: 499, modifiers: [], line_key: "fries-line" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [{ line_key: "fries-line" }], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, undefined, "scratch the fries");
  assertEquals(result.cart.length, 0);
  assertEquals(result.guardDroppedRemoves.length, 0);
});

Deno.test("regression: 'no onion rings, give me fries instead' removes onion rings and adds fries", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: ONION_RINGS_ID, name: "Onion Rings", quantity: 1, price_cents: 599, modifiers: [], line_key: "rings-line" },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "fries", quantity: 1, choices: [] }],
    removes: [{ line_key: "rings-line" }],
    modifies: [],
  };
  const result = decide(proposal, cart, MENU, LEXICON, () => "fries-line", "no onion rings, give me fries instead");
  assertEquals(result.cart.filter(l => l.menu_item_id === ONION_RINGS_ID).length, 0, "onion rings must be removed");
  assertEquals(result.cart.filter(l => l.menu_item_id === FRIES_ID).length, 1, "fries must be added");
  assertEquals(result.guardDroppedRemoves.length, 0);
});

Deno.test("regression: 'remove the pizza' removes the pizza when it is the only real line in the cart (category-word match, real stored name never contains the word 'pizza')", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: PIZZA_A_ID, name: "Pepperoni - Large (16\")", quantity: 1, price_cents: 1895, modifiers: [], line_key: "line-a" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [{ line_key: "line-a" }], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, undefined, "remove the pizza");
  assertEquals(result.cart.length, 0);
  assertEquals(result.guardDroppedRemoves.length, 0);
});

Deno.test("hallucinated remove against a single-line cart is still blocked when the message names neither the item nor uses it/that", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: FRIES_ID, name: "French Fries", quantity: 1, price_cents: 499, modifiers: [], line_key: "fries-line" },
  ];
  const proposal: Proposal = { intent: "order", adds: [], removes: [{ line_key: "fries-line" }], modifies: [] };
  const result = decide(proposal, cart, MENU, LEXICON, undefined, "Yes, I want some fries too.");
  assertEquals(result.cart.length, 1, "fries must survive — the message has no removal verb at all");
  assertEquals(result.guardDroppedRemoves.length, 1);
});
