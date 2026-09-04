-- 091 — Ticket delivery truth (INSTRUCTION-10 item H).
--
-- PROBLEM
-- -------
-- We record that a kitchen-ticket email was HANDED to Resend (ticket_send_log +
-- ticket_emailed_at), but not whether Resend actually DELIVERED it. A wrong
-- recipient address accepts the send (HTTP 200) and then bounces asynchronously —
-- invisibly. The shop never learns the order never arrived.
--
-- THE FIX
-- -------
-- Resend delivery webhooks (email.delivered / email.bounced / email.complained /
-- email.delivery_delayed) are matched back to the send by resend_message_id and
-- written to ticket_send_log (the audit record). The latest outcome per order is
-- ALSO mirrored onto order_carts so the Expo Screen — which the owner can read
-- (SELECT-only RLS) and which is already on Realtime — surfaces a bounce live,
-- per order. ticket_send_log stays service-role-only; order_carts is the
-- owner-visible surface.

BEGIN;

-- Audit record: the true delivery outcome per send attempt.
ALTER TABLE ticket_send_log
  ADD COLUMN IF NOT EXISTS delivery_status   text,        -- delivered|bounced|complained|delivery_delayed
  ADD COLUMN IF NOT EXISTS delivery_detail   text,        -- bounce reason / complaint feedback, when present
  ADD COLUMN IF NOT EXISTS delivery_event_at timestamptz; -- when Resend emitted the event

-- The webhook looks up the send row(s) by Resend message id — index it.
CREATE INDEX IF NOT EXISTS idx_ticket_send_log_resend_message_id
  ON ticket_send_log (resend_message_id);

-- Owner-visible mirror on the order itself (Expo Screen reads order_carts).
ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS ticket_delivery_status text,        -- delivered|bounced|complained|delivery_delayed
  ADD COLUMN IF NOT EXISTS ticket_delivery_detail text,
  ADD COLUMN IF NOT EXISTS ticket_delivery_at     timestamptz;

COMMENT ON COLUMN order_carts.ticket_delivery_status IS
  'Latest Resend delivery outcome for this order''s kitchen ticket: delivered|bounced|complained|delivery_delayed. Null = no delivery event yet. Written by resend-webhook (item H).';

COMMIT;
