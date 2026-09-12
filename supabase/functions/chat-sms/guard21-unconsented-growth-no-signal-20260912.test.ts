// P0 (2026-09-12, live money defect on Vito's, conv ce84c64b): pins GUARD 21,
// the general backstop for cart growth on a turn that names nothing and
// states no quantity — the gap GUARD 9 (bare affirmation only), GUARD 13
// (pending-option turns only), and GUARD 19 (quantity-only messages only)
// all leave open. See guard21-unconsented-growth-no-signal-20260912.ts for
// the full incident writeup.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeGuard21, type Guard21CartLine } from "./guard21-unconsented-growth-no-signal-20260912.ts";

const PIZZA_LINE_BEFORE: Guard21CartLine = {
  menu_item_id: "8857b40a-e53b-44fa-8bf0-6fdafb7efa45",
  name: "Large Cheese Pizza",
  quantity: 1,
  options: { Toppings: ["Pepperoni (Whole pizza)"] },
};

Deno.test("GUARD 21: reproduces the live incident — 'You already know my name.' names nothing, cart qty 1->2 is reverted", () => {
  const before = [PIZZA_LINE_BEFORE];
  const after = [{ ...PIZZA_LINE_BEFORE, quantity: 2 }];
  const result = computeGuard21(before, after, /* hasAnyOrderingSignal */ false);
  assertEquals(result.tripped, true);
  assertEquals(result.qtyReverts.length, 1);
  assertEquals(result.qtyReverts[0].priorQty, 1);
});

Deno.test("GUARD 21: brand-new ungrounded line (phantom add) with zero signal is fully reverted", () => {
  const before: Guard21CartLine[] = [];
  const after = [{ menu_item_id: "abc", name: "Garlic Knots", quantity: 1 }];
  const result = computeGuard21(before, after, false);
  assertEquals(result.tripped, true);
  assertEquals(result.phantomAdds.length, 1);
  assertEquals(result.phantomAdds[0].name, "Garlic Knots");
});

Deno.test("GUARD 21: no-op when the cart didn't grow", () => {
  const before = [PIZZA_LINE_BEFORE];
  const after = [{ ...PIZZA_LINE_BEFORE }];
  const result = computeGuard21(before, after, false);
  assertEquals(result.tripped, false);
});

Deno.test("GUARD 21: no-op when the caller signals the turn named an item or stated a quantity, even if the cart grew", () => {
  const before = [PIZZA_LINE_BEFORE];
  const after = [{ ...PIZZA_LINE_BEFORE, quantity: 2 }];
  // e.g. "make it 2" (quantity signal) or "another pepperoni pizza" (named) —
  // legitimate growth that some OTHER guard's own named-item check governs.
  const result = computeGuard21(before, after, /* hasAnyOrderingSignal */ true);
  assertEquals(result.tripped, false);
});

Deno.test("GUARD 21: a genuinely new, different item added alongside the existing line is untouched (no false revert on an unrelated line)", () => {
  const before = [PIZZA_LINE_BEFORE];
  const after = [
    PIZZA_LINE_BEFORE,
    { menu_item_id: "soda-1", name: "Coke", quantity: 1 },
  ];
  // Even with zero signal, this scenario shouldn't occur in practice (the
  // soda line itself would only exist if named), but the guard must still
  // only touch menu_item_ids whose OWN quantity grew — the untouched pizza
  // line (still qty 1, unchanged) must not appear in qtyReverts/phantomAdds.
  const result = computeGuard21(before, after, false);
  assertEquals(result.tripped, true);
  assertEquals(result.phantomAdds.length, 1);
  assertEquals(result.phantomAdds[0].name, "Coke");
  assertEquals(result.qtyReverts.length, 0);
});
