// fees.ts — the per-order fee, in one place with no dependencies (checkout, refunds, the grader and the test checks
// all read this). Jason, 2026-09-26: $1.49 flat per order (was 99¢); modeled against Telnyx actuals and the apps' service fees.
export const SERVICE_FEE_CENTS = 149;

/** Stripe's standard card percentage, in basis points (2.9%). OrderFare covers this percentage on its own share
 *  (its fee, plus an Uber order's delivery fee and tip); the shop pays the flat 30c and the percentage on food + tax. */
export const CARD_PERCENT_BPS = 290;

/** OrderFare's cut of a charge on the shop's Stripe account (the application fee): its fee, plus the delivery fee and
 *  tip when Uber delivers (OrderFare pays Uber), less the card percentage on that share. Jason 2026-10-06. */
export function platformShareCents(serviceFeeCents: number, courierDelivery: boolean, deliveryFeeCents: number, tipCents: number): number {
  const gross = serviceFeeCents + (courierDelivery ? deliveryFeeCents + tipCents : 0);
  return gross - Math.round((gross * CARD_PERCENT_BPS) / 10_000);
}
