-- 044: ticket_send_log — per-send audit log for kitchen-ticket emails
--
-- PROBLEM
-- -------
-- The only proof a kitchen ticket email was sent is the single ticket_emailed_at
-- flag on order_carts. We cannot inspect send history — no record of recipient,
-- Resend message ID, HTTP status, or timestamp per send. If a restaurant says
-- they didn't get a ticket, we have no determinism proof.
--
-- THE FIX
-- -------
-- ticket_send_log captures one row per send attempt (both success and failure)
-- inside the idempotency-guarded block. The chat-sms edge function inserts via
-- service role. RLS is enabled with no anon/authenticated policies — same
-- service-role-only posture as outbound_queue per migration 041.

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_send_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id           uuid NOT NULL,
  shop_id           uuid,
  order_number      integer,
  recipient         text,
  resend_message_id text,
  http_status       integer,
  sent_at           timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_ticket_send_log_cart_id   ON ticket_send_log (cart_id);
CREATE INDEX IF NOT EXISTS idx_ticket_send_log_sent_at   ON ticket_send_log (sent_at DESC);

-- RLS: service-role only — no anon or authenticated access
ALTER TABLE ticket_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_send_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ticket_send_log FROM anon;
REVOKE ALL ON ticket_send_log FROM authenticated;

-- Drop any stray policies (idempotent)
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ticket_send_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON ticket_send_log', _r.policyname);
    RAISE NOTICE '044: dropped policy "%" ON ticket_send_log', _r.policyname;
  END LOOP;
END $$;

COMMIT;