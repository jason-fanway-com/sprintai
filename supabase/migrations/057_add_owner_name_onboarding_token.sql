-- 057_add_owner_name_onboarding_token.sql
-- Add owner_name + onboarding_token to shops for trimmed self-serve onboarding.
-- onboarding_token is a 128+ bit unguessable value used in setup links.
-- Existing rows get NULL values (backfill not needed).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarding_token TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_shops_onboarding_token ON shops(onboarding_token);