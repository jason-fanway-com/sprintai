-- Down for 112_order_carts_pending_disambiguation.sql. Reversible, idempotent.
-- Drops only the column this migration added. Leaves everything else untouched.

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS pending_disambiguation;
