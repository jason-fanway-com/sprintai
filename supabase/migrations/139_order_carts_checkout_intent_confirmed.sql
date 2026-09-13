-- 139: order_carts.checkout_intent_confirmed_at — persist the moment the
--      customer's checkout intent was actually established for this cart
--      (they affirmatively answered "anything else, or ready to check out?",
--      or used an explicit customer-initiated checkout phrase like "that's
--      it" / "ready to check out" / "send me the link"), so a later turn can
--      tell "the close was properly triggered" apart from "the flow is
--      trying to close on its own, unprompted."
--
-- docs/specs/2026-09-13-checkout-insulation.md. Jason after order #14: "it
-- always rushes to get your name, which is the trigger for checkout. That's
-- unnatural... It should ask the user if they are ready to check out and
-- then ask for their name." The name-ask was the checkout trigger — asking
-- it is how the flow started closing, before any upsell and before the
-- customer ever said they were done.
--
-- The intent-classification half of the fix (migration 138,
-- checkout-intent-gate-20260913.ts) already computes, per turn, whether the
-- customer's message this turn actually authorizes checkout
-- (isExplicitCheckoutIntent). What was still missing was persistence across
-- turns: nothing recorded that this had ALREADY happened earlier in the
-- conversation, so a deterministic gate checked on every turn could not
-- distinguish "intent was established two turns ago, a name-ask now is
-- fine" from "intent was never established, this name-ask is the bug."
-- This column is that memory. NULL means checkout intent has not yet been
-- established for this cart. Set once, the first time
-- isExplicitCheckoutIntent(...) returns true for a turn, and read back by
-- shouldRedirectNameAskToCheckoutGate() (checkout-intent-gate-20260913.ts)
-- to decide whether a name-ask/name-confirm reply — however it was
-- produced, forced by GUARD 2 or authored by the model on its own
-- initiative — may go out this turn.
--
-- ADDITIVE ONLY. Nullable, no default backfill needed (existing in-flight
-- carts simply become eligible for the gate on their next turn, same
-- discipline as migration 138's name_confirm_pending_total_cents). Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS checkout_intent_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN order_carts.checkout_intent_confirmed_at IS
  'Timestamp checkout intent was first established for this cart (customer answered "anything else, or ready to check out?" affirmatively, or used an explicit checkout phrase). NULL means not yet established. Read by chat-sms/index.ts (shouldRedirectNameAskToCheckoutGate, checkout-intent-gate-20260913.ts) to block a name-ask/name-confirm reply from going out before the close was actually triggered by the customer.';
