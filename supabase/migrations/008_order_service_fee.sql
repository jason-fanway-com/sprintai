-- ============================================================
-- 008_order_service_fee.sql
-- Order checkout as a DIRECT charge + flat $0.99 service fee (Spec 02)
--
-- Records the $0.99 SprintAI platform service fee on each order cart so the
-- confirmation SMS / ticket email can reconcile to the Stripe charge to the
-- cent. The fee rides on top of food+tax as `application_fee_amount=99` on a
-- DIRECT charge created on the connected (restaurant) account.
-- ============================================================

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS service_fee_cents INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN order_carts.service_fee_cents IS
  'SprintAI flat platform service fee in cents (constant 99). Charged to the diner on top of food+tax; collected as application_fee_amount on the direct charge.';

-- Existing carts predate the fee; leave them at 0. New carts set 99 at checkout.
