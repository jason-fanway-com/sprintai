// Bug 4 pin: "buffalo chicken pizza with pepperoni" silently dropped the
// topping and its $3.00 price because the legacy add_item/modify_item path
// had no deterministic fallback when the LLM's tool call omitted it.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchReactiveExtras, type ReactiveCandidate } from "./reactive-modifier-match.ts";

const PIZZA_TOPPINGS: ReactiveCandidate[] = [
  { groupName: "Add Toppings", name: "Pepperoni", price_cents: 300 },
  { groupName: "Add Toppings", name: "Mushrooms", price_cents: 300 },
  { groupName: "Add Toppings", name: "Extra Cheese", price_cents: 400 },
  { groupName: "Add Toppings", name: "Sausage", price_cents: 300 },
];

Deno.test("TEST 2 phrasing: same-sentence, no size at all — pepperoni matches", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "buffalo chicken pizza with pepperoni", new Set());
  assertEquals(matches, [{ groupName: "Add Toppings", name: "Pepperoni", price_cents: 300 }]);
});

Deno.test("same-sentence WITH size: 'large pepperoni pizza' still matches pepperoni", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "large pepperoni pizza", new Set());
  assertEquals(matches.length, 1);
  assertEquals(matches[0].name, "Pepperoni");
});

Deno.test("TEST 3 phrasing: separate-turn 'add pepperoni' matches on its own", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "add pepperoni", new Set());
  assertEquals(matches, [{ groupName: "Add Toppings", name: "Pepperoni", price_cents: 300 }]);
});

Deno.test("multiple toppings in one sentence all match independently", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "with pepperoni and mushrooms please", new Set());
  const names = matches.map(m => m.name).sort();
  assertEquals(names, ["Mushrooms", "Pepperoni"]);
});

Deno.test("already-named candidate is not re-matched (no double charge)", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "with pepperoni", new Set(["pepperoni"]));
  assertEquals(matches, []);
});

Deno.test("negation: 'no pepperoni' never auto-applies pepperoni", () => {
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "no pepperoni please", new Set()), []);
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "without pepperoni", new Set()), []);
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "hold the pepperoni", new Set()), []);
});

Deno.test("negation on one topping does not suppress an unrelated one", () => {
  const matches = matchReactiveExtras(PIZZA_TOPPINGS, "no pepperoni but add mushrooms", new Set());
  assertEquals(matches, [{ groupName: "Add Toppings", name: "Mushrooms", price_cents: 300 }]);
});

Deno.test("no false match: unrelated text matches nothing", () => {
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "just the plain pizza please", new Set()), []);
});

Deno.test("ambiguous partial stem does not over-match: 'extra' alone does not match Extra Cheese", () => {
  // "Extra Cheese" contributes stems {extra, cheese} (cheese >= 3 chars,
  // "extra" >= 3 chars) — both must be present, so bare "extra sauce please"
  // must not match "Extra Cheese".
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "extra sauce please", new Set()), []);
});

Deno.test("empty text matches nothing", () => {
  assertEquals(matchReactiveExtras(PIZZA_TOPPINGS, "", new Set()), []);
});
