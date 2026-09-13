-- Down for 139_order_carts_checkout_intent_confirmed.sql. Reversible, idempotent.
-- Drops only the column this migration added. Leaves everything else untouched.

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS checkout_intent_confirmed_at;
