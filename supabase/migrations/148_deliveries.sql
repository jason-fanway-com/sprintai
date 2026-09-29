-- 148: third-party delivery (Uber Direct now, DoorDash Drive later)
--
-- deliveries: one row per booked courier delivery, keyed by cart. Written by
-- stripe-webhook (create on payment), delivery-webhook (status), refund-order
-- (cancel). Service role only; the admin reads through admin-api.
--
-- shops.delivery_provider: "own" keeps today's behavior (the shop's driver,
-- flat delivery_fee_cents). "uber" / "doordash" quote the fee per address and
-- book a courier after payment. Default "own" for every shop; flipped per
-- shop by the PO.
--
-- shops.prep_minutes: the pickup-ready time handed to the courier.
-- order_carts.delivery_status: mirror of deliveries.status for the admin list.
--
-- ADDITIVE ONLY. Reversible (drop the table and the three columns).

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS delivery_provider TEXT NOT NULL DEFAULT 'own'
    CHECK (delivery_provider IN ('own', 'uber', 'doordash'));
COMMENT ON COLUMN shops.delivery_provider IS
  'own = shop driver and flat delivery_fee_cents; uber/doordash = per-address quote and a booked courier (_shared/delivery.ts).';

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS prep_minutes INTEGER NOT NULL DEFAULT 20
    CHECK (prep_minutes BETWEEN 0 AND 240);
COMMENT ON COLUMN shops.prep_minutes IS
  'Minutes from payment until the food is ready; the courier pickup time.';

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS delivery_status TEXT;
COMMENT ON COLUMN order_carts.delivery_status IS
  'Mirror of deliveries.status (DeliveryStatus in _shared/delivery.ts). NULL = no courier delivery.';

CREATE TABLE IF NOT EXISTS deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id          UUID NOT NULL REFERENCES order_carts(id) ON DELETE CASCADE,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('uber', 'doordash')),
  test_mode        BOOLEAN NOT NULL DEFAULT false,
  quote_id         TEXT,
  delivery_id      TEXT,
  fee_cents        INTEGER,
  tip_cents        INTEGER NOT NULL DEFAULT 0,
  cancel_fee_cents INTEGER,
  status           TEXT NOT NULL DEFAULT 'quoted',
  tracking_url     TEXT,
  courier_name     TEXT,
  courier_phone    TEXT,
  pickup_ready_at  TIMESTAMPTZ,
  error            TEXT,
  events           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_up_at     TIMESTAMPTZ,
  dropped_off_at   TIMESTAMPTZ,
  canceled_at      TIMESTAMPTZ
);
-- one courier delivery per cart: a replayed checkout.session.completed cannot book twice
CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_cart ON deliveries (cart_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_provider_id ON deliveries (provider, delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_shop ON deliveries (shop_id, created_at DESC);
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
