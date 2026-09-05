-- Down for 100_order_carts_fee_disclosed.sql. Reversible, idempotent.
-- Drops only the column this migration added. Leaves everything else untouched.

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS fee_disclosed_at;
