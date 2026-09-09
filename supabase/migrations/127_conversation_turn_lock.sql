-- 127: per-conversation turn lock, closing the double-text race.
--
-- DEFECT (found in real SMS order #6, 2026-09-09): nothing previously
-- serialized two inbound messages for the SAME conversation. Each inbound
-- SMS is its own independent invocation of the chat-sms edge function, and
-- a customer who double-texts quickly (very common on SMS) can have both
-- invocations run concurrently, both reading the same starting cart state.
-- Observed: "Yes" / "Jason" sent seconds apart, but the bot's "What's your
-- name for the order?" prompt was replied to by the SECOND message before
-- the reply asking for it was even sent -- i.e. the two turns raced and
-- were not processed in receipt order.
--
-- FIX: a short-lived claim column on conversations, exactly the same
-- claim-with-staleness idiom already used for order_carts.ticket_send_attempt_at
-- (see chat-sms/index.ts's payment_confirmed ticket-email serialization).
-- The edge function claims this column atomically before processing a turn
-- and clears it when done; a second concurrent invocation for the same
-- conversation polls until the first releases (or the claim goes stale)
-- before reading cart/conversation state, so it always acts on the FIRST
-- message's settled outcome rather than a stale snapshot.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.processing_claimed_at IS
  'Short-lived turn lock (see migration 127). Set to now() while chat-sms is processing an inbound message for this conversation; cleared on completion. A claim older than 30s is treated as stale (crashed caller) and may be reclaimed. NULL when no turn is in flight.';
