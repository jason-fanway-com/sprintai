-- 080: ticket_send_log.attempt_number — track retry attempt count per send
--
-- PROBLEM
-- -------
-- When a kitchen ticket send retries (new send-then-claim pattern in chat-sms),
-- ticket_send_log rows are indistinguishable — we cannot tell which log row
-- belongs to attempt 1 vs attempt 2 vs attempt 3. This also means the
-- issue-detector cannot count consecutive failures accurately.
--
-- THE FIX
-- -------
-- Add a nullable attempt_number integer column. chat-sms sets it on every row.

DO $$ BEGIN
  ALTER TABLE ticket_send_log ADD COLUMN attempt_number INTEGER DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Down migration ─────────────────────────────────────────────────────────
-- ALTER TABLE ticket_send_log DROP COLUMN IF EXISTS attempt_number;