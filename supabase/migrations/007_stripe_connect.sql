-- ============================================================
-- 007_stripe_connect.sql
-- Stripe Connect onboarding + go-live state machine (Spec 01)
-- DIRECT-CHARGE model (confirmed by Jason 2026-06-20).
--
-- Adds the columns that track each shop's connected Stripe account
-- (Flow 1 / order revenue) and its platform customer (Flow 2 / billing),
-- plus the capability flags that gate go-live.
--
-- NOTE: 003_ordering_schema.sql already declared `stripe_connect_account_id`
-- (singular, unused). The canonical spec uses `stripe_connected_account_id`.
-- We add the spec-named column, backfill from the old one if any data exists,
-- and keep the old column in place (no destructive drop) to avoid breaking
-- anything that may reference it. All new code uses the spec name.
-- ============================================================

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_platform_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS connect_account_type         TEXT
    CHECK (connect_account_type IN ('standard', 'express')),
  ADD COLUMN IF NOT EXISTS charges_enabled              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payouts_enabled              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_requirements_due     JSONB   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS connect_status               TEXT    NOT NULL DEFAULT 'none'
    CHECK (connect_status IN ('none', 'pending', 'enabled', 'disabled'));

-- Backfill the spec-named column from the legacy column where present.
UPDATE shops
   SET stripe_connected_account_id = stripe_connect_account_id
 WHERE stripe_connected_account_id IS NULL
   AND stripe_connect_account_id   IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shops_stripe_connected_account_id
  ON shops (stripe_connected_account_id);

COMMENT ON COLUMN shops.stripe_connected_account_id IS
  'Stripe Connect connected-account id (Flow 1, order revenue). Direct charges run ON this account via the Stripe-Account header.';
COMMENT ON COLUMN shops.stripe_platform_customer_id IS
  'Stripe platform Customer id (Flow 2, SaaS billing — used by spec 03).';
COMMENT ON COLUMN shops.connect_account_type IS
  'express = in-wizard Stripe onboarding (type=express, fees_payer=application_express); standard = OAuth-connected existing Stripe account.';
COMMENT ON COLUMN shops.connect_status IS
  'none → not started; pending → account created/onboarding incomplete; enabled → charges+payouts on & no due items; disabled → Stripe disabled the account.';
COMMENT ON COLUMN shops.connect_requirements_due IS
  'Mirror of Stripe account.requirements.currently_due (array of requirement strings).';
