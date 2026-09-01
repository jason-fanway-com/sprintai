-- 071: Fix order_type default — null for delivery shops, code-sets pickup-only
-- Root cause of the mis-fulfillment bug (2026-09-01).
-- 039 set DEFAULT 'pickup' + NOT NULL → every cart born as pickup → Guard 2b
-- never fires for delivery shops → delivery customers silently get pickup.
-- Fix: drop NOT NULL, default NULL. Code sets 'pickup' at cart creation for
-- pickup-only shops (delivery_enabled=false); delivery shops start null so
-- Guard 2b injects the pickup/delivery question.
-- Existing rows are NOT backfilled — they keep their current order_type.
-- CHECK constraint (IN ('pickup','delivery')) remains; null bypasses it.

ALTER TABLE order_carts ALTER COLUMN order_type DROP NOT NULL;
ALTER TABLE order_carts ALTER COLUMN order_type SET DEFAULT NULL;