// Regression test for the P0 fixed in commit 66232fa: GUARD 2b must not
// revert an order_type that was just backed by a captured delivery address.
//
// Repro sequence from the incident (Vito's orders #11/#12, 2026-09-11):
//   turn n:   customer says "Delivery"        -> gate satisfied
//   turn n+1: customer sends the address only -> set_delivery_address writes
//             order_type "delivery" + the geocoded address
//   same turn: [bug] GUARD 2b used to revert order_type to null here
//
// This test exercises the REAL decision function extracted in
// guard2b-order-type-revert.ts, not a hand-copied mirror — see that file's
// header for why (same precedent as guard9-unconsented-affirmation.ts).

import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { shouldRevertOrderType } from "./guard2b-order-type-revert.ts";

Deno.test("GUARD 2b does NOT revert order_type when a delivery address was captured this turn (66232fa repro)", () => {
  const tripped = shouldRevertOrderType({
    // The address-only turn contains neither "pickup" nor "delivery", so the
    // upstream needsDeliveryGate computation in index.ts evaluates true here
    // — this is the exact "looks silent" false-positive the P0 hit.
    needsDeliveryGate: true,
    deliveryAddressAfter: {
      street: "5620 Cetronia Rd",
      city: "Allentown",
      state: "PA",
      zip: "18106",
      formatted: "5620 Cetronia Rd, Allentown, PA 18106",
    },
    orderTypeAfter: "delivery",
  });
  assertEquals(tripped, false, "GUARD 2b must not revert order_type backed by a captured delivery address");
});

Deno.test("GUARD 2b STILL reverts a genuinely silent order_type set (no address, the Luca-shape case it exists for)", () => {
  const tripped = shouldRevertOrderType({
    needsDeliveryGate: true,
    deliveryAddressAfter: null,
    orderTypeAfter: "delivery",
  });
  assertEquals(tripped, true, "GUARD 2b must still revert an order_type the model set with no backing address");
});

Deno.test("GUARD 2b is a no-op when the upstream gate does not need to fire at all", () => {
  const tripped = shouldRevertOrderType({
    needsDeliveryGate: false,
    deliveryAddressAfter: null,
    orderTypeAfter: "delivery",
  });
  assertEquals(tripped, false);
});
