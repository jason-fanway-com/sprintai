-- 079: ticket_send_attempt_at — short-lived serialization claim for kitchen-ticket sends
--
-- PROBLEM
-- -------
-- ticket_emailed_at is used as both the idempotency guard AND the success
-- marker, but it's claimed BEFORE the Resend call. If Resend returns non-2xx or
-- throws, the slot is already claimed and nothing will ever retry — a paid
-- order with no ticket and no alarm.
--
-- THE FIX
-- -------
-- Add ticket_send_attempt_at as a SHORT-LIVED serialization claim that is
-- separate from ticket_emailed_at (the success marker). The chat-sms edge
-- function claims attempt_at (if NULL or older than ~30s) to serialize
-- concurrent callers, then sets ticket_emailed_at only AFTER a confirmed 2xx
-- from Resend. On failure, attempt_at is cleared so a re-drive is possible.

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN ticket_send_attempt_at TIMESTAMPTZ DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Down migration ─────────────────────────────────────────────────────────
-- Run this manually to revert:
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS ticket_send_attempt_at;