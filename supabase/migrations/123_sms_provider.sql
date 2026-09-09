-- 123_sms_provider.sql
-- Per-shop SMS provider. A shop's number is provisioned on exactly one provider;
-- resolving the provider per deployment sends from a number the other carrier
-- does not own. Default 'twilio' so every existing shop keeps its current path
-- and enabling TELNYX_API_KEY cannot silently re-route them.
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS sms_provider text NOT NULL DEFAULT 'twilio';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shops_sms_provider_check'
  ) THEN
    ALTER TABLE shops
      ADD CONSTRAINT shops_sms_provider_check
      CHECK (sms_provider IN ('twilio','telnyx'));
  END IF;
END $$;
