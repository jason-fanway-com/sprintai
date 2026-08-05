-- 039: Delivery flow — order_type, delivery_address, driver_tip
-- Additive, idempotent. Up migration.

-- ── order_carts additions ──────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN order_type        TEXT NOT NULL DEFAULT 'pickup' CHECK (order_type IN ('pickup', 'delivery'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN delivery_address  JSONB;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN driver_tip_cents  INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Shops additions ────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE shops ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Down migration ─────────────────────────────────────────────────────────
-- Run this manually to revert:
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS order_type;
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS delivery_address;
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS delivery_fee_cents;
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS driver_tip_cents;
-- ALTER TABLE shops      DROP COLUMN IF EXISTS delivery_fee_cents;