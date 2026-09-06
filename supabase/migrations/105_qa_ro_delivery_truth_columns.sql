-- 105: qa_ro views must expose delivery TRUTH, not just "Resend accepted it".
--
-- Why this exists: the outside product owner could see ticket_send_log_ro.http_status
-- = 200 and nothing else. http_status 200 means Resend ACCEPTED the message — which is
-- exactly the distinction item H was built to remove. A ticket that is accepted and
-- then hard-bounces is the single failure a design partner will not forgive, and the
-- reviewer had no column that could tell those two states apart.
--
-- This is the THIRD time a qa_ro view has been too narrow to verify a "built" claim
-- (see 074, 082). Treat the column list as part of the contract: when a migration adds
-- a column that a reviewer would need to check a claim, widening the matching qa_ro
-- view is part of that same migration, not a follow-up.
--
-- Columns added here were introduced by migration 091 (ticket delivery truth) and 080
-- (attempt_number). Row filters are UNCHANGED — same is_test/NJB scoping as before.
-- No PII is added: delivery_detail is Resend's bounce reason text, not customer data.

-- ═══ qa_ro.ticket_send_log_ro — per-send audit, now with the delivery outcome ═══
CREATE OR REPLACE VIEW qa_ro.ticket_send_log_ro AS
  SELECT id,
         cart_id,
         shop_id,
         order_number,
         recipient,
         resend_message_id,
         http_status,
         sent_at,
         attempt_number,      -- 080: which retry produced this row
         delivery_status,     -- 091: delivered | bounced | complained | delivery_delayed
         delivery_detail,     -- 091: Resend's reason text on bounce/complaint
         delivery_event_at    -- 091: when the webhook event landed
    FROM ticket_send_log
   WHERE shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         );

-- ═══ qa_ro.order_carts_ro — the latest delivery outcome per ORDER ═══════════════
-- ticket_emailed_at alone says "we handed it to Resend". These three say what
-- actually happened to it, and are what the Expo Screen renders its badge from.
CREATE OR REPLACE VIEW qa_ro.order_carts_ro AS
  SELECT id,
         shop_id,
         phase,
         payment_status,
         order_type,
         order_number,
         subtotal_cents,
         tax_cents,
         service_fee_cents,
         delivery_fee_cents,
         driver_tip_cents,
         total_cents,
         refunded_cents,
         refund_status,
         dispute_status,
         stripe_checkout_session_id,
         test_mode,
         created_at,
         updated_at,
         ticket_emailed_at,
         ticket_delivery_status,  -- 091
         ticket_delivery_detail,  -- 091
         ticket_delivery_at       -- 091
    FROM order_carts
   WHERE shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         );

-- CREATE OR REPLACE VIEW preserves existing grants; re-stated so a fresh environment
-- provisions identically rather than silently leaving the reviewer with no access.
GRANT USAGE ON SCHEMA qa_ro TO qa_readonly;
GRANT SELECT ON qa_ro.ticket_send_log_ro TO qa_readonly;
GRANT SELECT ON qa_ro.order_carts_ro     TO qa_readonly;
