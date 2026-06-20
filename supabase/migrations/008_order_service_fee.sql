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

-- Direct-charge identifiers + refund/dispute state on the order.
-- On a DIRECT charge the PaymentIntent/Charge live on the CONNECTED account, so
-- we store the connected account id alongside the charge for webhook routing.
ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id    TEXT,
  ADD COLUMN IF NOT EXISTS stripe_charge_id            TEXT,
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_status               TEXT
    CHECK (refund_status IN ('none', 'partial', 'full')) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS refunded_cents              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispute_status              TEXT;

CREATE INDEX IF NOT EXISTS idx_order_carts_payment_intent ON order_carts (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_order_carts_charge_id      ON order_carts (stripe_charge_id);

COMMENT ON COLUMN order_carts.stripe_connected_account_id IS
  'Connected account the DIRECT charge was created on. Used to route charge.refunded / charge.dispute.created webhooks that arrive with event.account set.';
COMMENT ON COLUMN order_carts.dispute_status IS
  'Latest Stripe dispute status for this order (e.g. needs_response, won, lost). Restaurant owns dispute liability; the dispute debits the connected account.';

-- Existing carts predate the fee; leave them at 0. New carts set 99 at checkout.
