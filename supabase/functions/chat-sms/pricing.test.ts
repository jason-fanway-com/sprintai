// Item 2 (2026-09-09, module extraction): unit tests for pricing.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cartTotalFragment, claimsTotal, computeCartSubtotalCents, extractDollarCents, type PricedCartLine } from "./pricing.ts";

Deno.test("computeCartSubtotalCents: sums plain line items by quantity", () => {
  const cart: PricedCartLine[] = [{ price_cents: 1000, quantity: 2 }, { price_cents: 500, quantity: 1 }];
  assertEquals(computeCartSubtotalCents(cart), 2500);
});

Deno.test("computeCartSubtotalCents: an incomplete bundle contributes its committed price (P0 fix 2026-09-09)", () => {
  // Bundle price is fixed at start_bundle time — `complete` gates flavor
  // selection, not the dollar amount. An incomplete bundle is real money.
  const cart: PricedCartLine[] = [{ type: "bundle", price_cents: 1999, complete: false }];
  assertEquals(computeCartSubtotalCents(cart), 1999);
});

Deno.test("computeCartSubtotalCents: a complete bundle contributes its flat price", () => {
  const cart: PricedCartLine[] = [{ type: "bundle", price_cents: 1999, complete: true }];
  assertEquals(computeCartSubtotalCents(cart), 1999);
});

Deno.test("computeCartSubtotalCents: empty cart is $0", () => {
  assertEquals(computeCartSubtotalCents([]), 0);
});

Deno.test("claimsTotal: a total claim is detected", () => {
  assertEquals(claimsTotal("That comes to $21.49"), true);
});

Deno.test("claimsTotal: ordinary text is not a total claim", () => {
  assertEquals(claimsTotal("What would you like to order?"), false);
});

Deno.test("extractDollarCents: parses multiple dollar amounts to cents", () => {
  assertEquals(extractDollarCents("Pizza is $12.99, wings are $8"), [1299, 800]);
});

Deno.test("extractDollarCents: no dollar amounts returns empty array", () => {
  assertEquals(extractDollarCents("no prices here"), []);
});

Deno.test("cartTotalFragment: a real positive total renders the fragment", () => {
  assertEquals(cartTotalFragment(2149), " — $21.49 total");
});

Deno.test("cartTotalFragment: null/undefined/non-finite/zero totals render nothing", () => {
  assertEquals(cartTotalFragment(null), "");
  assertEquals(cartTotalFragment(undefined), "");
  assertEquals(cartTotalFragment(0), "");
  assertEquals(cartTotalFragment(NaN), "");
});
