// GUARD 2b pure decision core (2026-09-11 P0, commit 66232fa).
//
// P0 INCIDENT: a delivery order could be written to the kitchen as pickup,
// or with no fulfilment type at all, after the customer had said "Delivery"
// and given a valid in-zone address. Sequence, observed live on Vito's
// (orders #11 and #12, 2026-09-11):
//   turn n:   customer says "Delivery"        -> gate satisfied
//   turn n+1: customer sends the address only -> set_delivery_address writes
//             order_type "delivery" + the geocoded address
//   same turn: GUARD 2b reverted order_type to null here
//   later:     the phantom-link recovery found order_type null and defaulted
//              it to "pickup" so submit_order's C1 gate would pass
//   result:    ticket said pickup, row still held the delivery address, and
//              the confirmation told the customer to come and collect it
//
// Cause: the old guard reverted whenever the customer's message THIS TURN
// didn't contain the word "pickup"/"delivery", which is true for an address-
// only turn — so it treated a legitimate, positively-qualified write
// (set_delivery_address only writes order_type+address after an in-zone
// geocode) as if it were the model silently setting state unasked.
//
// Extracted into its own importable module (matching guard9-unconsented-
// affirmation.ts / guard20-regular-offer-confirmation.ts precedent) so a
// test can import and exercise the REAL decision function, not a
// hand-copied mirror.

export interface Guard2bInputs {
  /**
   * True when the turn otherwise looks like an unasked, silently-set
   * order_type (computed in index.ts from delivery availability, checkout
   * state, cart contents, and whether the reply/message already resolved
   * pickup-vs-delivery this turn) — everything upstream of the address
   * check this module owns.
   */
  needsDeliveryGate: boolean;
  /** `order_carts.delivery_address` AFTER this turn's tool calls. */
  deliveryAddressAfter: unknown;
  /** `order_carts.order_type` AFTER this turn's tool calls. */
  orderTypeAfter: string | null;
}

/**
 * A delivery address captured THIS TURN is not a silent set — it is the most
 * explicit statement of intent a customer can make, and set_delivery_address
 * only writes it after a positively-qualified, in-zone geocode.
 */
export function guardAddressSetThisTurn(
  deliveryAddressAfter: unknown,
  orderTypeAfter: string | null,
): boolean {
  return deliveryAddressAfter != null && orderTypeAfter === "delivery";
}

/** Whether GUARD 2b should revert the just-written order_type to null. */
export function shouldRevertOrderType(inputs: Guard2bInputs): boolean {
  return inputs.needsDeliveryGate &&
    !guardAddressSetThisTurn(inputs.deliveryAddressAfter, inputs.orderTypeAfter);
}
