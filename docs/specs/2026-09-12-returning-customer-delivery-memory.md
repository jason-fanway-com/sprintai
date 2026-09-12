# Returning-customer delivery memory

**Status:** QUEUED — starts immediately after all current work is green.
**Requested by:** Jason, 2026-09-12.
**Why:** "That is how I would expect to be treated." The moat is intimacy — a
shop's own number remembering its own customers. This is that, for delivery.

## What the customer should experience

A returning customer texts the shop. If their last order was delivery, the bot
asks whether they want delivery again **and shows the address it has**, so they
can confirm or correct it in one reply.

    "Welcome back, Christine! Delivery again to 412 Main St, Phoenixville?"

If the last order was pickup, it offers pickup the same way. Either way the
customer answers one short question instead of re-entering an address.

## What exists today (verified 2026-09-12)

- `customers`: id, tenant_id, customer_phone, name, first_seen_at, last_seen_at,
  order_count, total_spent_cents, favorite_items, **last_order_id**, last_order_at.
  **No order_type. No address.**
- `order_carts`: **order_type** and **delivery_address** are both here, per cart.
- `_shared/customer-profile.ts` already has the whole returning-customer
  machinery: `lookupCustomerContext`, `upsertCustomerProfile` (runs on paid
  orders), `regularEligibility`, and GUARD 20 already handles offering a
  "regular" and requiring confirmation before adding it.
- `shops.customer_personalization_enabled` is an existing owner-level kill
  switch for personalization (migration 121).

So the data exists per-order and the greeting hook exists. What is missing is
carrying the two facts onto the customer and using them in the opening turn.

## The work

1. **Store it.** Add `last_order_type` and `last_delivery_address` to
   `customers`, written by `upsertCustomerProfile` — which already runs at paid-
   order time, so it is one more field pair in a function that is already there.
   Denormalise rather than joining through `last_order_id`: the greeting runs on
   the first inbound message and must be one cheap read.

2. **Offer, never assume.** The address is a proposal the customer confirms.
   This is the same hard rule as the cart: never auto-apply. Confirming sets
   order_type and the address; a correction replaces it. Silence is not consent.

3. **Re-validate before offering.** A stored address is not automatically still
   deliverable. Before showing it, re-check `delivery_enabled`,
   `delivery_paused_until`, and `delivery_radius_mi` against the shop's current
   settings. A shop that turned delivery off must not be offered as delivery,
   and an address now outside the radius must fall back to pickup with a plain
   explanation. Never promise something the shop cannot do — bar item 3.

4. **One question.** Per the cost spec, the greeting asks one thing. "Delivery
   again to 412 Main St?" is one question and answers two fields. Do not stack
   it with a slot question.

5. **Kill switch.** Gate the whole behaviour on the existing
   `customer_personalization_enabled`. Do not add a second flag.

6. **Correction path.** "no, 88 Bridge St" must replace the stored address in
   the same turn, not ask again. Test the phrasings a person actually uses —
   matrix, not one wording.

## Watch-outs

- **This touches the order_type gate**, which has already produced two P0s
  (GUARD 2b reverting a captured address; a delivery customer told to come and
  collect). Any change here re-runs those repros before deploying.
- **The address is PII.** It is echoed back only to the phone that supplied it.
  Never to a different number, never in a ticket sent anywhere but the kitchen.
- **A stale address is worse than none.** If the customer moved and the bot
  silently delivers to the old address, that is the restaurant's problem with
  their customer. Hence: always show, always confirm.

## Acceptance

- Returning delivery customer is greeted with their address and confirms in one
  reply; order_type and address are both set; the money is unchanged.
- Returning pickup customer is offered pickup, not delivery.
- A correction in the same turn replaces the address and does not re-ask.
- Delivery disabled / outside radius falls back to pickup with an honest reason.
- `customer_personalization_enabled = false` disables all of it.
- The two prior order_type P0 repros still pass.
