// Returning-customer delivery memory — greeting-offer decision core.
// Spec: docs/specs/2026-09-12-returning-customer-delivery-memory.md.
//
// Pure decision function so the "is this offer still deliverable" logic is
// unit-testable without a live database, matching this repo's guard9/
// guard20/pending-disambiguation precedent.
//
// Design note (spec item 3): this is a CHEAP re-validation using data already
// on the loaded shop row — it never re-geocodes the stored address against
// the shop's radius, which would require a live Maps API call on every
// greeting (ruled out by the spec's own "one cheap read" cost constraint).
// A customer who moved out of range still gets an honest "outside delivery
// area" answer — just one turn later, at the moment set_delivery_address
// actually runs (unchanged, fail-closed) instead of at greeting time.

export interface DeliveryOfferShopContext {
  deliveryEnabled: boolean;
  /** True when the shop's delivery pause window is currently in effect. */
  deliveryPausedNow: boolean;
  deliveryRadiusMi: number | null;
}

export interface DeliveryOfferAddress {
  formatted: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  unit?: string;
}

export type DeliveryOffer =
  | { type: "delivery"; address: DeliveryOfferAddress }
  | { type: "pickup"; downgradeReason?: string }
  | null;

function toAddress(raw: Record<string, unknown>): DeliveryOfferAddress {
  const unit = raw.unit != null ? String(raw.unit) : undefined;
  return {
    formatted: String(raw.formatted ?? ""),
    street:    String(raw.street ?? ""),
    city:      String(raw.city ?? ""),
    state:     String(raw.state ?? ""),
    zip:       String(raw.zip ?? ""),
    ...(unit ? { unit } : {}),
  };
}

/**
 * Computes the greeting's delivery/pickup-again offer from the customer's
 * last order and the shop's CURRENT delivery settings. Returns null when
 * there is nothing to offer (no last-order fact on file at all — e.g. a
 * customer row that predates this feature).
 */
export function computeDeliveryOffer(
  lastOrderType:      "pickup" | "delivery" | null,
  lastDeliveryAddress: Record<string, unknown> | null,
  shop:               DeliveryOfferShopContext,
): DeliveryOffer {
  if (lastOrderType === "delivery") {
    if (lastDeliveryAddress == null) return { type: "pickup" };
    if (shop.deliveryEnabled !== true) {
      return { type: "pickup", downgradeReason: "we're not doing delivery right now" };
    }
    if (shop.deliveryPausedNow) {
      return { type: "pickup", downgradeReason: "delivery is paused right now" };
    }
    if ((shop.deliveryRadiusMi ?? 0) <= 0) {
      return { type: "pickup", downgradeReason: "we're not doing delivery right now" };
    }
    return { type: "delivery", address: toAddress(lastDeliveryAddress) };
  }
  if (lastOrderType === "pickup") return { type: "pickup" };
  return null;
}
