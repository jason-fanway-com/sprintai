-- 082: Restore qa_ro.shops_config columns narrowed by the 081-era view rebuild.
--
-- The read-only monitoring view lost the onboarding/gate diagnostic columns.
-- The outside product owner (qa_readonly role) cannot diagnose onboarding or
-- verify go-live gates without them. Restore the full config column set.
--
-- CONTRACT: qa_ro.shops_config exposes ALL config/status columns needed to
-- reason about onboarding + go-live. Config only, no consumer PII. When you
-- rebuild this view, keep this column list — do not silently narrow it.
--
-- Note: first_delivery_test_passed_at does NOT exist on shops (or anywhere);
-- the delivery_test go-live gate uses a different signal. Not exposed here.
-- onboarding_token is a secret (resume-link auth) — exposed as a boolean
-- "present" flag only, never the raw token.

DROP VIEW IF EXISTS qa_ro.shops_config;

CREATE VIEW qa_ro.shops_config AS
  SELECT
    id,
    tenant_id,
    slug,
    name,
    is_test,
    protected,
    is_paused,
    -- onboarding / lifecycle
    onboarding_step,
    (onboarding_token IS NOT NULL) AS onboarding_token_present,
    -- subscription / billing
    subscription_status,
    subscription_pm_set,
    -- stripe connect
    connect_status,
    connect_account_type,
    charges_enabled,
    payouts_enabled,
    -- geo / delivery
    latitude,
    longitude,
    formatted_address,
    google_place_id,
    delivery_enabled,
    delivery_radius_mi,
    -- menu crawl
    crawl_status,
    crawl_error,
    -- hours
    open_hours,
    -- ticket destination (presence only, not the address)
    (email_ticket_recipient IS NOT NULL) AS email_ticket_recipient_present,
    -- campaign / A2P
    campaign_assignment_status,
    campaign_assignment_checked_at,
    campaign_id,
    -- number provisioning (presence only)
    (phone_number_e164 IS NOT NULL) AS phone_number_present,
    created_at,
    updated_at
  FROM shops;
