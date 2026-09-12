-- Down for 136_order_carts_delivery_offer_made.sql. Reversible, idempotent.
-- Drops only the column this migration added. Leaves everything else untouched.

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS delivery_offer_made_at;
