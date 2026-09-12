-- 136: order_carts.delivery_offer_made_at — persist "have we already made
--      the returning-customer delivery/pickup-again offer this cart" so it
--      fires exactly once per conversation.
--
-- FIX A, docs/specs/2026-09-12-returning-customer-delivery-memory.md
-- follow-up (2026-09-12). The offer used to be gated on isFirstMessage (the
-- literal first message of the conversation), which meant it could only ever
-- fire if the customer's very first message WAS the order. In practice a
-- customer routinely opens with "hi" / "you open?" / "menu?" before actually
-- ordering, by which point isFirstMessage is already false and the offer
-- window has closed for good — reported by both PO and Jason.
--
-- The offer now fires on whichever turn cart.order_type is still unset (the
-- turn the ordering flow is about to ask pickup-or-delivery), which can be
-- any turn, not just the first. That means isFirstMessage can no longer
-- double as the "have we already made this offer" guard — a real column is
-- needed, same one-shot-flag pattern as order_carts.fee_disclosed_at
-- (migration 100).
--
-- ADDITIVE ONLY. Nullable, no default backfill needed (existing in-flight
-- carts simply remain eligible for the offer once on their next turn, same
-- as before this migration). Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS delivery_offer_made_at TIMESTAMPTZ;

COMMENT ON COLUMN order_carts.delivery_offer_made_at IS
  'Set the turn the returning-customer delivery/pickup-again offer was injected into the system prompt. NULL means not yet offered this cart. Read by chat-sms/index.ts to fire the offer exactly once per conversation, independent of which turn number that falls on.';
