-- 040: Fix test_mode on order_carts + backfill delivery_enabled
-- Additive, idempotent. Up migration.

-- ── 1. Add test_mode to order_carts (should have been with 011 or 039) ─────

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN test_mode BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- The column may already exist with no default from an earlier migration
-- attempt; set the default for any future rows regardless.
ALTER TABLE order_carts ALTER COLUMN test_mode SET DEFAULT false;

-- Backfill any existing rows where test_mode is NULL
UPDATE order_carts SET test_mode = false WHERE test_mode IS NULL;

-- ── 2. Backfill delivery_enabled for legacy shops ────────────────────────────

UPDATE shops SET delivery_enabled = true WHERE delivery_enabled IS NULL;