// FIX A (2026-09-12 follow-up to docs/specs/2026-09-12-returning-customer-
// delivery-memory.md): the returning-customer delivery/pickup-again offer
// used to be gated on isFirstMessage — the literal first message of the
// conversation. Confirmed live by both PO and Jason: a customer who opens
// with "hi", "you open?", "Testmode", "menu?" — anything other than the
// order itself — closes that window before they ever say what they want.
// That's the common case, not an edge case.
//
// Fix: the offer now fires on whichever turn cart.order_type is still unset
// (the turn the ordering flow is about to ask pickup-or-delivery), gated by
// isDeliveryOfferEligible() in delivery-memory-offer.ts, and stays a
// one-shot via order_carts.delivery_offer_made_at (index.ts persists it the
// instant eligibility is computed true).
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSystemPromptV2 } from "./index.ts";
import { isDeliveryOfferEligible } from "./delivery-memory-offer.ts";

const address = { street: "412 Main St", city: "Phoenixville", state: "PA", zip: "19460", formatted: "412 Main St, Phoenixville, PA 19460" };
const deliveryOffer = { type: "delivery" as const, address };

// ── isDeliveryOfferEligible: the core decision function ─────────────────────

Deno.test("isDeliveryOfferEligible: eligible when order_type is unset and the offer has never been made — regardless of turn number", () => {
  assert(isDeliveryOfferEligible(deliveryOffer, null, null));
});

Deno.test("isDeliveryOfferEligible: NOT eligible once delivery_offer_made_at is set, even though order_type is still null (fires only once)", () => {
  assertFalse(isDeliveryOfferEligible(deliveryOffer, null, "2026-09-12T18:00:00.000Z"));
});

Deno.test("isDeliveryOfferEligible: NOT eligible once order_type has been resolved (nothing left to offer)", () => {
  assertFalse(isDeliveryOfferEligible(deliveryOffer, "pickup", null));
});

Deno.test("isDeliveryOfferEligible: NOT eligible when there is no offer to make", () => {
  assertFalse(isDeliveryOfferEligible(null, null, null));
});

Deno.test("isDeliveryOfferEligible: re-fires if order_type is later nulled out again but delivery_offer_made_at is NOT cleared (never re-fires once made)", () => {
  // GUARD 2b (index.ts) reverts a silently-set order_type back to null on
  // some turns. delivery_offer_made_at must be the only source of truth for
  // "already offered" so this can never look eligible again once it's fired.
  assertFalse(isDeliveryOfferEligible(deliveryOffer, null, "2026-09-12T18:00:00.000Z"));
});

// ── buildSystemPromptV2: the actual prompt text the model sees ─────────────

function minimalShop(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "shop-1", name: "Test Shop", slug: "test-shop",
    wing_flavors_included: null, wing_mix_extra: null,
    tenant_id: "tenant-1", phone_number_e164: null, sms_provider: null, reply_from_e164: null,
    open_hours: {}, timezone: "America/New_York",
    email_ticket_recipient: null, is_paused: false, pause_message: null,
    delivery_enabled: true, delivery_paused_until: null, delivery_pause_reason: null,
    delivery_fee_cents: null, shop_context: null, ai_instructions: null,
    latitude: null, longitude: null, delivery_radius_mi: 5,
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function customerContextWith(isFirstMessage: boolean, deliveryOfferEligible: boolean) {
  return {
    name: "Jason",
    regularItem: null,
    isFirstMessage,
    deliveryOffer,
    deliveryOfferEligible,
  };
}

function renderedPrompt(isFirstMessage: boolean, deliveryOfferEligible: boolean): string {
  return buildSystemPromptV2(
    minimalShop(), "building", [], [], "2:00 PM", isFirstMessage,
    null, false, [], null, null, null, null, true, false, true,
    customerContextWith(isFirstMessage, deliveryOfferEligible),
  );
}

Deno.test("DIRECT CASE (regression guard): first message IS the order — isFirstMessage true, deliveryOfferEligible true — still produces the offer", () => {
  const prompt = renderedPrompt(true, true);
  assert(prompt.includes(`Delivery again to ${address.formatted}?`), "expected the delivery-again offer in the prompt on the direct first-message case");
});

Deno.test("DEFERRED CASE (the actual fix): opens with 'Testmode' then 'need to order' — isFirstMessage FALSE, deliveryOfferEligible true (order_type still unset) — STILL produces the offer", () => {
  // This is the exact repro: by the time the customer gets to "need to
  // order" it is message two or later, so isFirstMessage is false. Under the
  // old isFirstMessage-only gate this prompt would have been silent. It must
  // not be, now that eligibility is driven by order_type/delivery_offer_made_at.
  const prompt = renderedPrompt(false, true);
  assert(prompt.includes(`Delivery again to ${address.formatted}?`), "expected the delivery-again offer in the prompt even though this is not the conversation's literal first message");
});

Deno.test("Offer must NOT repeat once already made this conversation, even on an otherwise-eligible-looking turn", () => {
  const prompt = renderedPrompt(false, false);
  assertFalse(prompt.includes(`Delivery again to ${address.formatted}?`), "the offer must not be re-injected once delivery_offer_made_at is already set");
});
