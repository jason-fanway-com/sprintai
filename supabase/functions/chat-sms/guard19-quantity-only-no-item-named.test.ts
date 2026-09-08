import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeGuard19, statesQuantity } from "./guard19-quantity-only-no-item-named.ts";

Deno.test("statesQuantity: recognizes digits and number words", () => {
  assertEquals(statesQuantity("I want four large pizzas"), true);
  assertEquals(statesQuantity("give me 4"), true);
  assertEquals(statesQuantity("a couple of those"), true);
  assertEquals(statesQuantity("the usual"), false);
});

// NAMED REGRESSION TEST — models the real 2026-09-08 incident (commit
// b865d3a): "reset" then "I want four large pizzas" (zero pizza TYPES named)
// let the bot fill the cart with pizza types inherited from an earlier
// conversation, priced at $89.95. This CRM build injects prior-order
// context on purpose (favorite items, "the regular"), which is the SAME
// shape of risk the incident exposed — so this exact scenario, run again
// against a RETURNING customer whose order history is now deliberately in
// context, must still add ZERO items. Named explicitly (not folded into a
// generic never-auto-add test) so it is never mistaken for redundant and
// deleted later — this is the one case Jason named directly.
Deno.test("regression_2026-09-08_reset_inherited_pizzas: quantity-only message from a RETURNING customer with order history adds ZERO items", () => {
  const cartSnapshotBeforeTurn: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  // Simulates the model reading injected favorite-item context (e.g. "Large
  // Pepperoni Pizza" x3 orders) and inventing four cart lines from it even
  // though the customer named no pizza type this turn.
  const guardCartAfterModelTurn = [
    { menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 1 },
    { menu_item_id: "mush-large", name: "Large Mushroom Pizza", quantity: 1 },
    { menu_item_id: "sausage-large", name: "Large Sausage Pizza", quantity: 1 },
    { menu_item_id: "cheese-large", name: "Large Cheese Pizza", quantity: 1 },
  ];

  const namedItemCount = 0; // customer said "four large pizzas" — no specific TYPE named
  const result = computeGuard19(
    "I want four large pizzas",
    cartSnapshotBeforeTurn,
    guardCartAfterModelTurn,
    namedItemCount,
  );

  assertEquals(result.tripped, true);
  assertEquals(result.revertedCart, []); // ZERO items reach the cart
});

Deno.test("regression_2026-09-08_reset_inherited_pizzas variant: 'the usual amount' also names zero items and is reverted", () => {
  const cartSnapshotBeforeTurn: Array<{ menu_item_id: string; name: string; quantity: number }> = [
    { menu_item_id: "existing", name: "Garlic Knots", quantity: 1 },
  ];
  const guardCartAfterModelTurn = [
    { menu_item_id: "existing", name: "Garlic Knots", quantity: 1 },
    { menu_item_id: "pep-large", name: "Large Pepperoni Pizza", quantity: 4 },
  ];
  // A differently-worded vague quantity phrase ("four of the usual amount")
  // that still names zero specific menu items — same shape, different words.
  const result = computeGuard19(
    "just give me four of the usual amount",
    cartSnapshotBeforeTurn,
    guardCartAfterModelTurn,
    0,
  );
  assertEquals(result.tripped, true);
  assertEquals(result.revertedCart, cartSnapshotBeforeTurn);
});

Deno.test("computeGuard19: does NOT trip when the customer names a specific item alongside a quantity", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "cheese-large", name: "Large Cheese Pizza", quantity: 4 }];
  const result = computeGuard19("I want four large cheese pizzas", before, after, 1);
  assertEquals(result.tripped, false);
  assertEquals(result.revertedCart, after);
});

Deno.test("computeGuard19: does NOT trip when the cart did not grow", () => {
  const before = [{ menu_item_id: "x", name: "Soda", quantity: 1 }];
  const after = [{ menu_item_id: "x", name: "Soda", quantity: 1 }];
  const result = computeGuard19("four of them sound good", before, after, 0);
  assertEquals(result.tripped, false);
});

Deno.test("computeGuard19: does NOT trip on a message with no quantity at all", () => {
  const before: Array<{ menu_item_id: string; name: string; quantity: number }> = [];
  const after = [{ menu_item_id: "x", name: "Soda", quantity: 1 }];
  const result = computeGuard19("sounds good", before, after, 0);
  assertEquals(result.tripped, false);
});
