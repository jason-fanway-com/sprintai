# Founding-Shop Promo (Erin's first ~10-15 shops)
Date: 2026-09-03
Status: draft — BUILD GATED ON JASON APPROVAL (touches billing/checkout)

## Problem
Erin needs a code to give the first ~10-15 restaurants that waives the $99/mo
subscription for 6 months as a founding-shop incentive. Today there is no promo
mechanism: every shop pays full price from month one. The waiver must cover ONLY
the $99/mo subscription — NEVER the $0.99/order service fee, which is how Sprint
earns on every transaction and must keep flowing from day one.

## Key architecture facts (why this is safe)
- $99/mo subscription = Stripe **Subscription** on price `price_1TG8GsFPm1l8Fm1TSaLhOIaL`
  ("starter"), started via a subscription-mode Checkout Session; `stripe-webhook`
  `checkout.session.completed` -> creates tenant, sets `subscription_status=active`.
- $0.99/order fee = `application_fee_amount = SERVICE_FEE_CENTS (99)` on the diner's
  per-order Connect direct charge in `create-checkout`. Entirely separate function,
  separate charge, separate Stripe object.
- => A Stripe **Coupon** applied to the subscription Checkout Session CANNOT reach
  the per-order fee. The safety property holds by construction, not by a flag.

## User stories
- As Erin, I want one promo code to give founding shops so the $99/mo line is $0
  for 6 months, without touching their per-order economics.
- As a founding shop owner, I want to see $0.00 for the subscription at signup and
  a thank-you note, so I feel the founding-shop deal is real.
- As Jason, I want the waiver capped (~15 redemptions) and auto-expiring after 6
  months so full billing resumes with no manual cleanup.

## Module decisions
- Stripe **Coupon**: `percent_off=100`, `duration=repeating`, `duration_in_months=6`,
  `applies_to.products=[<starter subscription product>]` (restrict to the sub product
  so it can never apply elsewhere). Created once (script or Stripe dashboard).
- Stripe **Promotion Code** bound to that coupon: human code (e.g. `FOUNDING`),
  `max_redemptions≈15`, `active=true`. Erin hands out the string.
- Subscription Checkout Session: set `allow_promotion_codes: true` (owner types the
  code) OR pre-apply `discounts:[{coupon}]` via a tokenized link. Decision pending
  on where that session is created (see Open questions).
- Thank-you note: welcome email (Resend, existing onboarding path) + success screen,
  shown when the redeemed session/subscription carries the founding coupon. Detect
  via `subscription.discount.coupon.id` in `stripe-webhook`.
- No new DB column strictly required; optionally stamp `shops.founding_promo=true`
  from the webhook for reporting. Keep out of the go-live gate (waiver ≠ go-live).

## Pre-mortem (why it fails -> mitigation)
1. Coupon accidentally waives the $0.99/order fee. -> Impossible by construction
   (different function/charge); additionally scope coupon `applies_to` to the sub
   product. Acceptance test AC5 proves an order still charges $0.99.
2. Waiver never ends -> free forever. -> `duration_in_months=6` auto-expires; AC4
   asserts month 7 invoices $99. No cron needed.
3. Code leaks / over-redeemed beyond founding cohort. -> `max_redemptions≈15` +
   `active` toggle; AC6 asserts redemption 16 is rejected.
4. Applied to the wrong (pro/enterprise legacy) price. -> `applies_to.products`
   scoped to starter; legacy prices unaffected.
5. Test vs live Stripe mode mismatch (project runs Stripe test mode). -> Create the
   coupon/promo code in the SAME mode the live subscription checkout uses; AC1 names
   the mode explicitly. Do not assume.
6. Owner pays, then the waiver silently no-shows on the invoice. -> AC2/AC3 verify
   the $0.00 line on the first subscription invoice with the code applied.

## Acceptance criteria
1. A coupon exists in the correct Stripe mode: `percent_off=100`,
   `duration=repeating`, `duration_in_months=6`, restricted to the starter
   subscription product. Verifiable via Stripe API `coupons.retrieve`.
2. A promotion code bound to that coupon exists, `active=true`,
   `max_redemptions` set (~15). Verifiable via `promotionCodes.list`.
3. Starting a subscription checkout with the code applied shows a $0.00 amount due
   for the subscription line on the first invoice. Verifiable in a test-mode run.
4. The subscription's 7th monthly invoice (after 6 waived) is $99.00. Verifiable by
   inspecting the Stripe subscription schedule / coupon end.
5. A diner order placed for a founding shop still charges `application_fee_amount=99`
   ($0.99) — the waiver does NOT reduce it. Verifiable via the PaymentIntent on a
   test order.
6. Redemption beyond `max_redemptions` is rejected by Stripe (no 16th free shop).
   Verifiable by exhausting redemptions in test mode.
7. A shop that redeemed the code receives the thank-you note (welcome email +
   success screen copy) referencing the founding-shop waiver. Verifiable by
   inspecting the sent email / rendered screen.

## Out of scope
- Waiving or discounting the $0.99/order service fee (explicitly forbidden).
- Any change to pro/enterprise legacy prices.
- Multi-tier or per-shop custom pricing.
- Automated distribution of the code (Erin hands it out manually).
- Go-live gating on promo status.

## Open questions
1. Where is the REAL subscription Checkout Session / Payment Link created today?
   The signup wizard step is a test-mode preview stub (`subscription_status:active`
   with no charge). If it's a static Stripe Payment Link, `allow_promotion_codes`
   is a dashboard toggle + coupon/code creation (near-zero code). If it's a
   function, add the param there. Resolve before build.
2. Auto-apply via tokenized founding link vs owner types the code — Jason's call.