-- 068: Telnyx provisioning columns for shops + number_provision_log
-- Supports Phase 2 per-merchant registration automation.

-- Add Telnyx tracking columns to shops
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS telnyx_number_id        TEXT,
  ADD COLUMN IF NOT EXISTS telnyx_messaging_profile_id TEXT;

COMMENT ON COLUMN shops.telnyx_number_id IS
  'Telnyx phone number ID (v2 API). Set by provision-number after order succeeds.';
COMMENT ON COLUMN shops.telnyx_messaging_profile_id IS
  'Telnyx messaging profile ID (v2 API). One per shop for inbound webhook routing.';

-- Extend number_provision_log for Telnyx (keep twilio_sid for backwards compat)
ALTER TABLE number_provision_log
  ADD COLUMN IF NOT EXISTS provider         TEXT      NOT NULL DEFAULT 'twilio',
  ADD COLUMN IF NOT EXISTS telnyx_number_id TEXT,
  ADD COLUMN IF NOT EXISTS telnyx_profile_id TEXT;

COMMENT ON COLUMN number_provision_log.provider IS
  'Which provider was used: twilio or telnyx.';
COMMENT ON COLUMN number_provision_log.telnyx_number_id IS
  'Telnyx phone number ID from v2 API. null for Twilio provisions.';
COMMENT ON COLUMN number_provision_log.telnyx_profile_id IS
  'Telnyx messaging profile ID. null for Twilio provisions.';