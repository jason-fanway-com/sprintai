-- 069: Merchant registration state machine
-- Tracks per-shop progress through the Telnyx 10DLC registration pipeline.
-- This is the persistence layer for Phase 2 self-serve automation.

CREATE TABLE IF NOT EXISTS merchant_registration (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           UUID        NOT NULL UNIQUE REFERENCES shops(id) ON DELETE CASCADE,
  tenant_id         UUID        NOT NULL,

  -- Stage tracking (linear pipeline with retry capability)
  -- Stages: collecting -> brand_registration -> campaign_registration ->
  --         number_provision -> campaign_assignment -> mapping_verification -> complete
  -- On failure: stage resets to the failed step for retry.
  stage             TEXT        NOT NULL DEFAULT 'collecting',

  -- Telnyx entity IDs, populated as each stage succeeds
  telnyx_brand_id   TEXT,
  telnyx_campaign_id TEXT,
  telnyx_number_id  TEXT,
  telnyx_profile_id TEXT,

  -- Status per stage: pending | in_progress | complete | failed
  brand_status      TEXT        NOT NULL DEFAULT 'pending',
  campaign_status   TEXT        NOT NULL DEFAULT 'pending',
  number_status     TEXT        NOT NULL DEFAULT 'pending',
  assignment_status TEXT        NOT NULL DEFAULT 'pending',
  mapping_status    TEXT        NOT NULL DEFAULT 'pending',

  -- Mapping verification (gate before "complete")
  -- Both must be "ADDED" before the shop goes live.
  tmobile_mapping_status    TEXT,
  non_tmobile_mapping_status TEXT,
  mapping_checked_at        TIMESTAMPTZ,

  -- Failure tracking
  last_error        TEXT,
  last_error_at     TIMESTAMPTZ,
  retry_count       INTEGER     NOT NULL DEFAULT 0,
  max_retries       INTEGER     NOT NULL DEFAULT 5,

  -- Business info collected during onboarding (RFC 10DLC requirements)
  legal_business_name   TEXT,
  ein                   TEXT,
  business_address_line1 TEXT,
  business_address_city  TEXT,
  business_address_state TEXT,
  business_address_zip   TEXT,
  business_type         TEXT,  -- corporation, llc, sole_proprietor, etc.
  website_url           TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_reg_shop     ON merchant_registration(shop_id);
CREATE INDEX IF NOT EXISTS idx_merchant_reg_tenant   ON merchant_registration(tenant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_reg_stage    ON merchant_registration(stage);

COMMENT ON TABLE merchant_registration IS
  'State machine for per-merchant Telnyx 10DLC registration. One row per shop.
  Stages: collecting → brand_registration → campaign_registration →
  number_provision → campaign_assignment → mapping_verification → complete.
  Each stage auto-retries up to max_retries on transient failures.';

-- ── Business info collected during onboarding ──────────────────────────────
CREATE TABLE IF NOT EXISTS merchant_business_info (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID        NOT NULL UNIQUE REFERENCES shops(id) ON DELETE CASCADE,
  legal_business_name TEXT        NOT NULL,
  ein                 TEXT,         -- EIN (9 digits, no dashes). Required for brand registration.
  business_type       TEXT,         -- corporation, llc, sole_proprietor, partnership, non_profit
  address_line1       TEXT,
  address_city        TEXT,
  address_state       TEXT,
  address_zip         TEXT,
  website_url         TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  verified            BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_biz_shop ON merchant_business_info(shop_id);

COMMENT ON TABLE merchant_business_info IS
  'Verified business info collected during onboarding. Used as source-of-truth
  for Telnyx brand/campaign registration. EIN is required — no sole-proprietor
  path without it. Separate from merchant_registration so business info
  survives registration retries independently.';

-- Enable RLS on both tables
ALTER TABLE merchant_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_business_info ENABLE ROW LEVEL SECURITY;

-- Service role only — no anon/authenticated access
REVOKE ALL ON merchant_registration FROM anon, authenticated;
REVOKE ALL ON merchant_business_info FROM anon, authenticated;