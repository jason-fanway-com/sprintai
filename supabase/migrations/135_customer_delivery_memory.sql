-- 135_customer_delivery_memory.sql — returning-customer delivery memory
-- Spec: docs/specs/2026-09-12-returning-customer-delivery-memory.md
--
-- Denormalises the last order's fulfilment type + address onto `customers`
-- so the greeting can read them in the SAME single indexed query
-- lookupCustomerContext already makes (AC7 of the customer-CRM spec this
-- table belongs to) — no join through last_order_id, per this spec's own
-- cost constraint (the greeting must stay one cheap read).
--
-- Additive/idempotent, same DO $$ ... EXCEPTION WHEN duplicate_column
-- pattern as 039_delivery_flow.sql.

DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN last_order_type TEXT CHECK (last_order_type IN ('pickup', 'delivery'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE customers ADD COLUMN last_delivery_address JSONB;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

COMMENT ON COLUMN customers.last_order_type IS
  'Fulfilment type of this customer''s most recent PAID order (pickup|delivery), denormalised from order_carts.order_type by upsertCustomerProfile at paid-order time. Always overwritten with the latest order''s value — no merge logic, unlike favorite_items. Used to offer "delivery/pickup again" on the customer''s next conversation (see docs/specs/2026-09-12-returning-customer-delivery-memory.md). Re-validated against the shop''s CURRENT delivery settings before ever being offered — a stored value here does not mean delivery is still available or in range today.';
COMMENT ON COLUMN customers.last_delivery_address IS
  'Delivery address of this customer''s most recent PAID delivery order, denormalised from order_carts.delivery_address, mirroring that column''s shape ({ street, city, state, zip, formatted, unit? }). Null when the last order was pickup. PII — echoed back only to the same (tenant_id, customer_phone) it came from, never cross-tenant or cross-phone (same isolation as the rest of this table).';

-- ── Down migration ─────────────────────────────────────────────────────────
-- Run this manually to revert:
-- ALTER TABLE customers DROP COLUMN IF EXISTS last_order_type;
-- ALTER TABLE customers DROP COLUMN IF EXISTS last_delivery_address;
