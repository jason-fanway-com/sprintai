import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { computeDeliveryOffer } from "./delivery-memory-offer.ts";

const address = { street: "412 Main St", city: "Phoenixville", state: "PA", zip: "19460", formatted: "412 Main St, Phoenixville, PA 19460" };

Deno.test("offers delivery again when last order was delivery and the shop still delivers", () => {
  const offer = computeDeliveryOffer("delivery", address, { deliveryEnabled: true, deliveryPausedNow: false, deliveryRadiusMi: 5 });
  assertEquals(offer, { type: "delivery", address });
});

Deno.test("downgrades to pickup when delivery is now disabled", () => {
  const offer = computeDeliveryOffer("delivery", address, { deliveryEnabled: false, deliveryPausedNow: false, deliveryRadiusMi: 5 });
  assertEquals(offer, { type: "pickup" });
});

Deno.test("downgrades to pickup when delivery is currently paused", () => {
  const offer = computeDeliveryOffer("delivery", address, { deliveryEnabled: true, deliveryPausedNow: true, deliveryRadiusMi: 5 });
  assertEquals(offer, { type: "pickup" });
});

Deno.test("downgrades to pickup when delivery radius is zero/unset", () => {
  const offer = computeDeliveryOffer("delivery", address, { deliveryEnabled: true, deliveryPausedNow: false, deliveryRadiusMi: 0 });
  assertEquals(offer, { type: "pickup" });
});

Deno.test("downgrades to pickup when last order says delivery but no address is on file", () => {
  const offer = computeDeliveryOffer("delivery", null, { deliveryEnabled: true, deliveryPausedNow: false, deliveryRadiusMi: 5 });
  assertEquals(offer, { type: "pickup" });
});

Deno.test("offers pickup again when last order was pickup", () => {
  const offer = computeDeliveryOffer("pickup", null, { deliveryEnabled: true, deliveryPausedNow: false, deliveryRadiusMi: 5 });
  assertEquals(offer, { type: "pickup" });
});

Deno.test("offers nothing when there is no last-order fact on file", () => {
  const offer = computeDeliveryOffer(null, null, { deliveryEnabled: true, deliveryPausedNow: false, deliveryRadiusMi: 5 });
  assertEquals(offer, null);
});
