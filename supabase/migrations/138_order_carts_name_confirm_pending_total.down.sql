-- Down for 138_order_carts_name_confirm_pending_total.sql. Reversible, idempotent.
-- Drops only the column this migration added. Leaves everything else untouched.

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS name_confirm_pending_total_cents;
