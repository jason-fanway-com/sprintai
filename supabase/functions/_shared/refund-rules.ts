// refund-rules.ts — who gets what back when a paid order is cancelled or refunded (Jason 2026-10-05/06). Pure: no I/O.
//
// The charge is split three ways: food + tax (the shop's), and OrderFare's share — its fee, plus on an Uber order the
// delivery fee and tip, which OrderFare owes Uber. Only the shop starts a refund; OrderFare never decides one.
//  - Before a driver picks up, the courier is cancelled first. Uber charges nothing before a driver accepts, and a
//    cancellation fee after (UBER_CANCEL_AFTER_ASSIGN_CENTS unless Uber reports its own figure).
//  - Shop-caused (the shop can't make it): the customer gets everything back; any Uber fee goes on the shop's balance
//    and comes out of its next orders.
//  - Customer-caused: the shop decides how much of the food to refund; OrderFare's share comes back less what Uber
//    charges. After pickup the food is on its way: delivery and tip are owed to Uber and OrderFare's fee stays.
//  - On a shop that uses its own drivers, OrderFare's share is just its fee: refunded when the whole order is refunded.

export const UBER_CANCEL_AFTER_ASSIGN_CENTS = 500;

export type CourierStage = "none" | "requested" | "assigned" | "picked_up";

export interface RefundInput {
  foodTaxCents: number;          // subtotal + tax: the shop's part of the charge
  feeCents: number;              // OrderFare's per-order fee
  courier: boolean;              // Uber delivers (delivery fee and tip are OrderFare's to pay Uber)
  deliveryCents: number;
  tipCents: number;
  stage: CourierStage;           // where the courier is right now
  initiatedBy: "shop" | "customer";
  foodRefundCents: number;       // the shop's choice, 0..foodTaxCents (ignored and taken as full when the shop caused it)
  uberReportedFeeCents?: number | null; // what Uber said the cancellation cost, when it says
}

export interface RefundPlan {
  cancelCourier: boolean;        // ask Uber to cancel before refunding
  foodRefundCents: number;       // out of the shop's part
  platformRefundCents: number;   // out of OrderFare's share
  customerRefundCents: number;   // what the customer gets back in total
  uberChargeCents: number;       // what Uber will bill OrderFare for this order after the cancel
  shopOwesCents: number;         // added to the shop's balance (shop-caused Uber fees)
  explain: string[];             // plain-English lines for the preview and the customer text
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function planRefund(i: RefundInput): RefundPlan {
  const shopCaused = i.initiatedBy === "shop";
  const food = shopCaused ? i.foodTaxCents : Math.max(0, Math.min(i.foodTaxCents, Math.round(i.foodRefundCents)));
  const share = i.feeCents + (i.courier ? i.deliveryCents + i.tipCents : 0);
  const explain: string[] = [];

  if (!i.courier || i.stage === "none") {
    const whole = food === i.foodTaxCents;
    const platform = shopCaused || whole ? share : 0;
    if (platform === 0 && i.feeCents > 0) explain.push(`The ${money(i.feeCents)} OrderFare fee is kept on a partial refund.`);
    return { cancelCourier: false, foodRefundCents: food, platformRefundCents: platform, customerRefundCents: food + platform, uberChargeCents: 0, shopOwesCents: 0, explain };
  }

  if (i.stage === "picked_up") {
    explain.push(`The driver already has the food, so the ${money(i.deliveryCents)} delivery fee${i.tipCents ? ` and ${money(i.tipCents)} tip` : ""} go to the driver and can't be refunded.`);
    return { cancelCourier: false, foodRefundCents: food, platformRefundCents: 0, customerRefundCents: food, uberChargeCents: i.deliveryCents + i.tipCents, shopOwesCents: 0, explain };
  }

  const uber = i.uberReportedFeeCents ?? (i.stage === "assigned" ? UBER_CANCEL_AFTER_ASSIGN_CENTS : 0);
  if (shopCaused) {
    if (uber > 0) explain.push(`Uber charges ${money(uber)} to cancel a driver who already accepted; it comes out of your next orders.`);
    return { cancelCourier: true, foodRefundCents: food, platformRefundCents: share, customerRefundCents: food + share, uberChargeCents: uber, shopOwesCents: uber, explain };
  }
  const platform = Math.max(0, share - uber);
  if (uber > 0) explain.push(`A driver had already accepted, so Uber's ${money(uber)} cancellation fee is kept from the refund.`);
  return { cancelCourier: true, foodRefundCents: food, platformRefundCents: platform, customerRefundCents: food + platform, uberChargeCents: uber, shopOwesCents: 0, explain };
}

/** The part of OrderFare's application fee to hand back to the shop's account for a platform refund: proportional, so
 *  the card fee Stripe keeps on the refunded amount stays where it fell (a refunded order's card fees are the shop's). */
export function applicationFeeRefundCents(applicationFeeCents: number, shareCents: number, platformRefundCents: number): number {
  if (shareCents <= 0 || platformRefundCents <= 0) return 0;
  return Math.min(applicationFeeCents, Math.round((applicationFeeCents * platformRefundCents) / shareCents));
}
