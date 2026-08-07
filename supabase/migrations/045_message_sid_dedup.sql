-- 045: Inbound-message idempotency — dedup on external message_sid
--
-- PROBLEM
-- -------
-- saveMessage() inserts every inbound message unconditionally. A retransmitted
-- SMS (Twilio retry, same MessageSid) or duplicate webhook creates a duplicate
-- customer message. The LLM re-processes it as a new request and can re-add
-- items to the cart → double-order / double-charge.
--
-- THE FIX
-- -------
-- Add message_sid TEXT column + partial unique index (WHERE message_sid IS NOT NULL).
-- The chat-sms edge function does an atomic insert-with-message_sid before
-- processing. ON CONFLICT (message_sid) → unique violation → skip LLM, skip
-- cart mutation, return no-op. Two concurrent retransmits cannot both proceed
-- because the unique constraint is enforced atomically by Postgres.
--
-- Partial index (not full-column UNIQUE constraint) so that NULL message_sid
-- rows (web test harness, legacy messages, assistant messages) don't collide.

BEGIN;

DO $$ BEGIN
  ALTER TABLE messages ADD COLUMN message_sid TEXT DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_sid
  ON messages (message_sid)
  WHERE message_sid IS NOT NULL;

COMMIT;