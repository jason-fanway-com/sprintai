// BUG (2026-09-08, P0, Jason live on Zio's Test Kitchen, 16:27-16:28 UTC,
// real money): "reset" then "I want four large pizzas" (naming zero types)
// -> bot silently added pepperoni, plain cheese, Hawaiian, and meat lovers
// pizzas -- $89.95 total -- read out of this same conversation's own turns
// from ~5 hours earlier. index.ts's RESET handler fix (reset now closes the
// conversation so the next turn starts with zero history) is the fix that
// actually shipped and closes this incident on its own.
//
// GUARD 18 was built as a BROADER, independent-of-reset backstop for the
// same failure class, but is NOT wired into index.ts -- pulled before
// shipping after two live regressions surfaced in testing:
//
//   1. (fixed, then superseded) "cheeseburger" (no space) never matched the
//      registered key "cheese burger" (real item "Cheese Burger") under an
//      exact space-sensitive substring check -- an ordinary order reverted.
//      Fixed by adding compactForGrounding() (space/punctuation-insensitive
//      compare) as a second grounding signal.
//
//   2. (fatal, not fixed) "I want a large pepperoni pizza" on Zio's also
//      reverted. Zio's pizzas are a BASE item + a Toppings OPTION GROUP:
//      "pepperoni" resolves to selecting the "Pepperoni" choice on a base
//      item literally named e.g. "Neapolitan Cheese Pizza" -- the cart
//      line's own `name` never contains "pepperoni" at all, so no grounding
//      signal checked against `item.name` can ever see it. This is Zio's
//      PRIMARY ordering path (base item + toppings), not an edge case, so
//      the false-positive rate on real orders was unacceptable. Guard 18 was
//      removed from index.ts's wiring rather than shipped broken.
//
// Kept here, unwired, as a pinned record of both regressions and a starting
// point for a future rework that grounds against an item's resolved
// options/modifiers too, not just its base name. Do NOT re-wire into
// index.ts without a passing test for the option-group case above.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeGuard18, compactForGrounding, type Guard18CartLine } from "./guard18-zero-grounding-item-invention.ts";

const PEPPERONI: Guard18CartLine = { menu_item_id: "pep-1", name: "Pepperoni Pizza", quantity: 1 };
const PLAIN: Guard18CartLine = { menu_item_id: "plain-1", name: "Plain Cheese Pizza", quantity: 1 };
const HAWAIIAN: Guard18CartLine = { menu_item_id: "haw-1", name: "Hawaiian Pizza", quantity: 1 };
const MEAT_LOVERS: Guard18CartLine = { menu_item_id: "ml-1", name: "Meat Lover's Pizza", quantity: 1 };
const CHEESE_BURGER: Guard18CartLine = { menu_item_id: "cb-1", name: "Cheese Burger", quantity: 1 };
// The real Zio's shape behind regression #2: the cart line is the BASE item;
// "pepperoni" lives in `options`, never in `name`.
const NEAPOLITAN_CHEESE_WITH_PEPPERONI_TOPPING: Guard18CartLine = { menu_item_id: "ncp-1", name: "Neapolitan Cheese Pizza", quantity: 1 };

// Test-only helper mirroring the (now unwired) index.ts predicate: substring-
// both-directions match on a pre-supplied "named" set, OR compacted-message
// containment of the compacted item name.
function groundedPredicate(message: string, namedItems: string[] = []): (itemName: string) => boolean {
  const compactMessage = compactForGrounding(message);
  const namedLower = namedItems.map(n => n.toLowerCase());
  return (itemName: string): boolean => {
    if (!itemName) return false;
    const itemLower = itemName.toLowerCase();
    if (namedLower.some(n => n.includes(itemLower) || itemLower.includes(n))) return true;
    const compactItem = compactForGrounding(itemName);
    return compactItem.length > 0 && compactMessage.includes(compactItem);
  };
}

Deno.test("computeGuard18: the exact repro -- 4 brand-new lines, message names nothing -> all 4 revert", () => {
  const before: Guard18CartLine[] = [];
  const after = [{ ...PEPPERONI }, { ...PLAIN }, { ...HAWAIIAN }, { ...MEAT_LOVERS }];
  const grounded = groundedPredicate("I want four large pizzas");
  const result = computeGuard18(grounded, before, after);
  assertEquals(result.tripped, true);
  assertEquals(result.phantomAdds.length, 4);
});

Deno.test("FIXED regression 1 (2026-09-08, Vito's): 'cheeseburger' (no space) grounds 'Cheese Burger' (real item) -> never reverts", () => {
  const before: Guard18CartLine[] = [];
  const after = [{ ...CHEESE_BURGER }];
  const grounded = groundedPredicate("cheeseburger");
  const result = computeGuard18(grounded, before, after);
  assertEquals(result.tripped, false, "an ordinary single-item order must never be reverted by GUARD 18");
});

Deno.test("UNFIXED regression 2 (2026-09-08, Zio's) -- pinned RED, documents why GUARD 18 is not wired into index.ts: 'pepperoni pizza' resolves to a base item + Toppings option, whose own name never contains 'pepperoni' -> name-only grounding wrongly reverts it", () => {
  const before: Guard18CartLine[] = [];
  const after = [{ ...NEAPOLITAN_CHEESE_WITH_PEPPERONI_TOPPING }];
  const grounded = groundedPredicate("I want a large pepperoni pizza");
  const result = computeGuard18(grounded, before, after);
  // This IS the bug: a correctly-resolved, customer-requested order gets
  // reverted because grounding only ever looks at the cart line's base
  // `name`, never its `options`. Asserting the CURRENT (broken) behavior so
  // this test goes RED the moment a future rework actually fixes it --
  // at which point this test should be updated to assertEquals(..., false)
  // and the guard can be reconsidered for re-wiring.
  assertEquals(result.tripped, true, "if this now fails, GUARD 18's grounding has been fixed to check options -- update this test and reconsider re-wiring");
});

Deno.test("computeGuard18: customer named at least one item this turn -> that item never reverts, even as a brand-new line", () => {
  const before: Guard18CartLine[] = [];
  const after = [{ ...PEPPERONI }, { ...PLAIN }];
  const grounded = groundedPredicate("pepperoni pizza and plain cheese pizza please", ["Pepperoni Pizza", "Plain Cheese Pizza"]);
  const result = computeGuard18(grounded, before, after);
  assertEquals(result.tripped, false);
  assertEquals(result.phantomAdds.length, 0);
});

Deno.test("computeGuard18: no new lines this turn -> never trips", () => {
  const before = [{ ...PEPPERONI }];
  const after = [{ ...PEPPERONI }];
  const result = computeGuard18(() => false, before, after);
  assertEquals(result.tripped, false);
});

Deno.test("computeGuard18: existing line's quantity grows (not a brand-new line) -> left alone, this is GUARD 13's territory", () => {
  const before = [{ ...PEPPERONI }];
  const after = [{ ...PEPPERONI, quantity: 2 }];
  const result = computeGuard18(() => false, before, after);
  assertEquals(result.tripped, false, "existing-line quantity growth must not be touched by GUARD 18");
});

Deno.test("computeGuard18: a genuinely different, ungrounded new item still reverts even when another item that turn already existed", () => {
  const before = [{ ...PEPPERONI }];
  const after = [{ ...PEPPERONI }, { ...HAWAIIAN }];
  // Pepperoni already existed before this turn (skipped entirely); only Hawaiian is a new line, and it's ungrounded.
  const grounded = groundedPredicate("I want four large pizzas");
  const result = computeGuard18(grounded, before, after);
  assertEquals(result.tripped, true);
  assertEquals(result.phantomAdds.length, 1);
  assertEquals(result.phantomAdds[0].name, "Hawaiian Pizza");
});

Deno.test("computeGuard18: bundles (no menu_item_id) are skipped, never reverted", () => {
  const before: Guard18CartLine[] = [];
  const after: Guard18CartLine[] = [{ name: "Family Combo" }]; // no menu_item_id -> bundle
  const result = computeGuard18(() => false, before, after);
  assertEquals(result.tripped, false);
});

Deno.test("compactForGrounding: strips case, spaces, and punctuation", () => {
  assertEquals(compactForGrounding("Cheese Burger"), "cheeseburger");
  assertEquals(compactForGrounding("cheeseburger"), "cheeseburger");
  assertEquals(compactForGrounding("Meat Lover's Pizza"), "meatloverspizza");
});
