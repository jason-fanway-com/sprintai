-- 039: Delivery flow — down migration
-- Reverts additive delivery columns added by 039_delivery_flow.sql.

ALTER TABLE order_carts DROP COLUMN IF EXISTS order_type;
ALTER TABLE order_carts DROP COLUMN IF EXISTS delivery_address;
ALTER TABLE order_carts DROP COLUMN IF EXISTS delivery_fee_cents;
ALTER TABLE order_carts DROP COLUMN IF EXISTS driver_tip_cents;
ALTER TABLE shops      DROP COLUMN IF EXISTS delivery_fee_cents;