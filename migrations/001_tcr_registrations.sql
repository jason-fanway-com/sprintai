-- 001_tcr_registrations: merchant 10DLC registration data model
--
-- Each shop gets its own TCR brand + campaign + messaging profile.
-- Telnyx opt-out block rules are profile-scoped, so a shared profile
-- would opt a customer out of every shop at once. One profile per shop.
--
-- Run via: supabase db push (local) or Supabase Mgmt API (prod)

-- ─── State machine ───────────────────────────────────────────────────────
-- draft             → initial, awaiting merchant input
-- data_collected    → legal name + EIN + address collected, awaiting EIN verify
-- verifying_ein     → EIN verification in flight (calling IRS TIN matching or 3rd-party API)
-- ein_verified      → tax info confirmed
-- ein_failed        → EIN verification failed, merchant must correct
-- creating_brand    → creating TCR brand via Telnyx API
-- brand_created     → brand registered with TCR
-- brand_failed      → brand creation failed (manual review / TCR rejection)
-- creating_campaign → creating 10DLC campaign via Telnyx API
-- campaign_created  → campaign approved and live
-- campaign_failed   → campaign rejected or stuck
-- creating_profile  → creating per-shop messaging profile
-- profile_created   → messaging profile active
-- profile_failed    → messaging profile creation error
-- provisioning_number → buying a phone number
-- number_provisioned  → number assigned and attached to profile
-- number_failed     → number purchase or assignment failed
-- live              → fully provisioned, ready to send
-- suspended         → TCR/telnyx suspension, do not send

CREATE TYPE tcr_registration_status AS ENUM (
    'draft',
    'data_collected',
    'verifying_ein',
    'ein_verified',
    'ein_failed',
    'creating_brand',
    'brand_created',
    'brand_failed',
    'creating_campaign',
    'campaign_created',
    'campaign_failed',
    'creating_profile',
    'profile_created',
    'profile_failed',
    'provisioning_number',
    'number_provisioned',
    'number_failed',
    'live',
    'suspended'
);

CREATE TABLE tcr_registrations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES tenants(id),

    -- merchant data
    legal_name      text,
    ein             text,            -- stored encrypted/sealed; never logged
    registered_address jsonb,        -- { street, city, state, zip, country }
    
    -- Telnyx asset IDs (populated as registration progresses)
    brand_id        text,            -- Telnyx brand ID
    campaign_id     text,            -- Telnyx campaign ID (CSMB9HG-style)
    messaging_profile_id text,       -- per-shop messaging profile
    phone_number    text,             -- provisioned E.164

    -- state machine
    status          tcr_registration_status NOT NULL DEFAULT 'draft',
    status_history  jsonb NOT NULL DEFAULT '[]',  -- [{ status, at, detail }]
    
    -- failure tracking
    failure_reason  text,
    retry_count     integer NOT NULL DEFAULT 0,
    max_retries     integer NOT NULL DEFAULT 3,
    last_error_at   timestamptz,
    last_error_body jsonb,

    -- IRS EIN
    ein_status          text,        -- matched / unmatched / pending / api_error
    ein_verified_at     timestamptz,
    ein_verified_by     text,        -- provider: irs_tin_match / ein_verification_service
    ein_match_data      jsonb,       -- sanitized match response (NO SSN, NO full EIN)

    -- timestamps
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT one_registration_per_shop UNIQUE(shop_id)
);

-- Index for queries by shop (most common lookup)
CREATE INDEX idx_tcr_registrations_shop ON tcr_registrations(shop_id);
CREATE INDEX idx_tcr_registrations_status ON tcr_registrations(status);
CREATE INDEX idx_tcr_registrations_tenant ON tcr_registrations(tenant_id);

-- ─── Opt-out state: per (consumer_phone, shop) ──────────────────────────
CREATE TABLE sms_opt_outs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number    text NOT NULL,                   -- E.164 consumer number
    shop_id         uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    direction       text NOT NULL DEFAULT 'out',     -- 'out' = consumer opted out / we blocked
    opted_out_at    timestamptz NOT NULL DEFAULT now(),
    source          text,                            -- 'telnyx_webhook' | 'manual' | 'import'
    resumed_at      timestamptz,                     -- null if still opted out

    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT one_opt_out_per_phone_shop UNIQUE(phone_number, shop_id)
);

CREATE INDEX idx_sms_opt_outs_phone ON sms_opt_outs(phone_number, shop_id);

-- ─── Audit log ──────────────────────────────────────────────────────────
CREATE TABLE tcr_registration_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid NOT NULL REFERENCES tcr_registrations(id) ON DELETE CASCADE,
    event           text NOT NULL,       -- 'status_change' | 'ein_check' | 'brand_create' | 'campaign_create' | 'profile_create' | 'number_buy' | 'error' | 'retry'
    detail          jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tcr_events_registration ON tcr_registration_events(registration_id);