-- 111: widen qa_ro for the product owner — non-PII only.
--
-- The read-only schema has been too narrow to answer a question five separate
-- times, and every one of those cost a round trip through an agent. This closes
-- the gap for everything that carries no consumer PII, and routes every view
-- through qa_ro.visible_shop_ids() so scope has ONE definition.
--
-- RETIRED SHOPS STAY VISIBLE HERE. Retirement sets is_test = true precisely so
-- the row remains auditable; hiding a shop from the owner-portal picker and
-- hiding it from the auditor are different jobs. You must be able to audit a
-- thing after it has been retired — that is when you most need to.
--
-- DELIBERATELY NOT GRANTED (needs Jason's direct yes, see below):
--   conversations.customer_phone, messages.content, orders.customer_phone,
--   order_carts.pickup_name / delivery_address.
-- Those are diner PII. The 2026-09-01 authorisation narrowed this role down
-- from a full-table grant for exactly that reason and said "anything more, ask
-- again with a reason".

-- ═══ shops — full config, still no owner contact details ════════════════════
CREATE OR REPLACE VIEW qa_ro.shops_all AS
  SELECT id, slug, name, display_name, tenant_id, timezone, is_test, protected,
         is_paused, pause_message, onboarding_step, onboarding_complete,
         delivery_enabled, delivery_radius_mi, delivery_fee_cents, tax_rate_bps,
         catering_mode, cash_discount_mode, subscription_status, founding_promo,
         charges_enabled, payouts_enabled, connect_status,
         google_rating, google_review_count, business_status,
         formatted_address, website_url, crawl_status, crawl_error,
         (phone_number_e164 IS NOT NULL)      AS has_phone,
         (email_ticket_recipient IS NOT NULL) AS has_ticket_recipient,
         ticket_destination_type,
         created_at, updated_at
    FROM shops;

-- ═══ carts — money, state and delivery truth. No pickup_name, no address ════
DROP VIEW IF EXISTS qa_ro.order_carts_ro;
CREATE VIEW qa_ro.order_carts_ro AS
  SELECT id, shop_id, conversation_id, phase, payment_status, order_type,
         order_number, subtotal_cents, tax_cents, service_fee_cents,
         delivery_fee_cents, driver_tip_cents, total_cents, refunded_cents,
         refund_status, dispute_status, stripe_checkout_session_id, test_mode,
         created_at, updated_at, ticket_emailed_at,
         ticket_delivery_status, ticket_delivery_detail, ticket_delivery_at,
         expo_status, expo_acknowledged_at, owner_escalated_at,
         jsonb_array_length(COALESCE(cart_json, '[]'::jsonb)) AS line_count
    FROM order_carts
   WHERE shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

-- ═══ cart LINES — what was actually ordered, exploded, still no PII ═════════
-- cart_json holds item name, quantity, price and selected options. Notes and
-- names live on the cart row, not here, so this is safe to expose whole.
CREATE OR REPLACE VIEW qa_ro.order_cart_lines AS
  SELECT oc.id AS cart_id, oc.shop_id, oc.order_number, oc.created_at,
         (line ->> 'name')                      AS item_name,
         (line ->> 'menu_item_id')::uuid        AS menu_item_id,
         COALESCE((line ->> 'quantity')::int, 1) AS quantity,
         (line ->> 'price_cents')::int          AS price_cents,
         line -> 'options'                      AS options,
         line -> 'modifiers'                    AS modifiers,
         line -> 'pending_options'              AS pending_options
    FROM order_carts oc
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(oc.cart_json, '[]'::jsonb)) AS line
   WHERE oc.shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

-- ═══ migration / deploy history ════════════════════════════════════════════
CREATE OR REPLACE VIEW qa_ro.schema_migrations AS
  SELECT version, name FROM supabase_migrations.schema_migrations;

GRANT USAGE ON SCHEMA qa_ro TO qa_readonly;
GRANT SELECT ON qa_ro.shops_all         TO qa_readonly;
GRANT SELECT ON qa_ro.order_carts_ro    TO qa_readonly;
GRANT SELECT ON qa_ro.order_cart_lines  TO qa_readonly;
GRANT SELECT ON qa_ro.schema_migrations TO qa_readonly;
