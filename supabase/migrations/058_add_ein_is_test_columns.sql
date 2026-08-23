-- 058_add_ein_is_test_columns.sql
-- Phase 2: EIN + Stripe payout gate with test bypass.
-- ein: owner's EIN for tax reporting (non-test shops MUST provide)
-- is_test: false by default; auto-set true via server-side email allowlist

ALTER TABLE shops ADD COLUMN IF NOT EXISTS ein TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;