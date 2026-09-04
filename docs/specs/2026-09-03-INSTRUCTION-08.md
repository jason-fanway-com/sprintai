# INSTRUCTION 08 — Build the subscription code path

**Date:** 2026-09-03 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-03: *"you need to fix the subscription code path. There
should be one subscription tier. $99/month. And a coupon code that Erin can use to make
that $0 for the first 6 months. Both of those things need to exist."*

**Sequencing:** finish rehearsal leg 1 first. Leg 1 (signup → `onboarding-save` → resume
email) does not touch subscription. Build this next, then leg 2 walks the wizard and
exercises it for real. Do not abandon leg 1 to start this.

---

## Verified current state

Do not re-derive this; it is confirmed:

- **Nothing creates a subscription.** Zero hits across all 29 edge functions for
  `subscriptions.create` or Checkout `mode: 'subscription'`.
- **The receiving half already exists.** `stripe-webhook/index.ts:23-25` maps three price
  IDs — `starter` $99, `pro` $247, `enterprise` $497. It has never received a
  subscription event, because nothing produces one.
- **The client writes the status.** `signup-page/wizard.js:181` writes
  `subscription_status: "active"` and `subscription_pm_set: true` on a button press.
  `go-live/index.ts:280` gates on exactly that string. This is BREAK #1 in the rehearsal
  report — the gate is satisfiable without money moving.

Stripe stays in **test mode**. That is intentional and correct until the first real
customer. This work is built and proven with test cards; the code path is identical in
live mode. Test mode is not a blocker and is not to be reported as one.

---

## What to build

### 1. One tier, one price

`$99/month` is the only tier. Creation code must reference exactly one price, read from a
single env var (`STRIPE_PRICE_SUBSCRIPTION`). No code path may create `pro` or
`enterprise`. Leave the existing webhook price map intact — it only reads inbound events
and removing entries risks mis-tagging historical rows — but nothing may *create* those.

### 2. Real Checkout Session, subscription mode

Create the session server-side in an edge function (extend `create-checkout` or add
`create-subscription` — your call, state which and why). `mode: 'subscription'`, one line
item at the single price, `client_reference_id` = shop id, success/cancel URLs returning
into the wizard.

### 3. The wizard stops writing status

`wizard.js` subscription step calls the new endpoint and redirects to Stripe. It **must
no longer write `subscription_status` or `subscription_pm_set`.** Delete that write.

### 4. The webhook becomes the only writer

`stripe-webhook` sets `subscription_status` from real Stripe events
(`checkout.session.completed`, `customer.subscription.updated|deleted`). After this
change, **the only way a shop reaches `subscription_status = 'active'` is that Stripe
said so.** That is what closes BREAK #1 — the go-live gate is unchanged and untouched.

### 5. Erin's coupon — 100% off, 6 months

Stripe coupon `percent_off = 100`, `duration = repeating`, `duration_in_months = 6`, with
a customer-facing **promo code** Erin can read aloud. Set `max_redemptions` (~15) and an
expiry so a leaked code cannot run indefinitely. Enable `allow_promotion_codes` on the
Checkout Session.

Design already exists in `docs/specs/2026-09-03-founding-shop-promo.md` (commit
`129b640`) — build on it rather than redesigning.

### 6. CRITICAL — collect the card even at 100% off

With a 100%-off coupon Stripe Checkout will, by default, **not collect a payment method**
because the first invoice is $0. Month 7 then fails and the shop silently churns at
exactly the moment it becomes a paying customer.

Set `payment_method_collection: 'always'`. Prove it: a shop that redeems Erin's code must
still end up with a payment method on the Stripe customer. This is the single most likely
way this ships broken.

### 7. The order fee is untouched

The $99/mo subscription and the $0.99/order fee are structurally separate charges, so a
subscription coupon cannot reach the order fee by construction. Keep it that way — do not
implement the discount anywhere that could touch per-order pricing. A founding shop pays
$0/month and still pays $0.99/order.

---

## Acceptance criteria

Deterministic and provable. For each, run the query or command that would prove it false:

1. `grep` shows no remaining write of `subscription_status` in `signup-page/wizard.js`.
2. A test shop walked through the real wizard reaches `subscription_status = 'active'`
   **only** after a Stripe test-card checkout completes — and shows `none` immediately
   before it.
3. The same shop has a non-null Stripe subscription id and customer id persisted.
4. A shop that redeems the promo code shows a $0 first invoice **and** a payment method
   attached to the customer.
5. `go-live` for that shop returns the subscription gate as satisfied, with all 13 gates
   still evaluated and none weakened.
6. No code path can create the `pro` or `enterprise` price.

---

## Rules — unchanged

1. Never weaken a gate or check to make something pass. The go-live gate count stays 13.
2. Commit → Melvin verifies → deploy → verify.
3. Verify before claiming. Run the query that would prove your claim false.
4. Change one thing at a time.
5. Escalate rather than work around.
6. Do not touch the Telnyx campaign, the safety gates, or Vito's / NJB / Zio's.
7. Harness stays closed — no 128-case runs.
8. Do not bundle the uncommitted `chat-sms` quantity-reduction change with this work.
9. Do not pull backlog items while this is in progress.

## Reporting

Short dispatches to `agent:main:po:claude`. Append results to
`docs/specs/2026-09-03-rehearsal-report.md` and keep
`docs/specs/2026-09-03-STATUS.md` current — it still does not exist.
