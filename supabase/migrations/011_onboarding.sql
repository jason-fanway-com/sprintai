-- SprintAI Onboarding Wizard Migration (Build Spec 05 — Self-Serve Onboarding Wizard)
-- ADDITIVE ONLY. No drops, no destructive mutation, no data deletes.
-- Adds the columns the wizard persists for save-and-resume + the fields the
-- ordering agent / checkout / fulfillment paths read, plus a per-day number
-- provisioning audit table for the 25/day auto-buy cap guardrail.

-- ---- shops: onboarding + ops fields ----------------------------------------

ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarding_step          TEXT;
-- onboarding_step: 'account' | 'subscription' | 'connect' | 'scrape' | 'menu'
--                | 'instructions' | 'fulfillment' | 'number' | 'review' | 'done'

ALTER TABLE shops ADD COLUMN IF NOT EXISTS ai_instructions          TEXT;
-- Owner plain-English do/don't, injected into chat-sms system prompt behind
-- guardrails (cannot override safety/compliance/opt-out).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS display_name             TEXT;
-- Name used in customer-facing texts (may differ from legal `name`).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS reply_from_e164          TEXT;
-- Already read by chat-sms; ensure column exists for the wizard to set it.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS tax_rate_bps             INTEGER NOT NULL DEFAULT 0;
-- Sales tax in basis points (e.g. 600 = 6.00%). 0 = no tax applied.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS cash_discount_mode       TEXT
  CHECK (cash_discount_mode IN ('none', 'in_store_cash_only', 'applies_to_sms'))
  DEFAULT 'none';
-- Resolves the Jack's "Cash Discount Available" Open Question so checkout
-- pricing never misleads the diner.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS catering_mode            TEXT
  CHECK (catering_mode IN ('offline', 'sms_orderable'))
  DEFAULT 'offline';
-- Jack's advertises a separate catering menu — is it SMS-orderable now?

ALTER TABLE shops ADD COLUMN IF NOT EXISTS wing_flavors_included    INTEGER;
-- How many wing flavors included per 10-piece (Jack's Open Question).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS wing_mix_extra           BOOLEAN NOT NULL DEFAULT false;
-- Whether mixing wing flavors costs extra.

-- ---- subscription wiring (spec 03; PAY-NOW $49/mo, no trial) ----------------

ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_status      TEXT
  CHECK (subscription_status IN ('none', 'payment_method_set', 'active', 'past_due', 'canceled'))
  DEFAULT 'none';

ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_pm_set      BOOLEAN NOT NULL DEFAULT false;
-- Subscription-first guardrail reads this: never buy a number until true.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_subscription_id   TEXT;

-- ---- compliance capture (A2P/TCPA) -----------------------------------------

ALTER TABLE shops ADD COLUMN IF NOT EXISTS optin_language           TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stop_help_wording        TEXT;

-- ---- daily number-provision audit (25/day auto-buy cap) --------------------

CREATE TABLE IF NOT EXISTS number_provision_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      UUID        REFERENCES shops(id) ON DELETE SET NULL,
  phone_e164   TEXT,
  twilio_sid   TEXT,
  test_mode    BOOLEAN     NOT NULL DEFAULT true,
  provisioned_on DATE      NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_number_provision_log_day
  ON number_provision_log(provisioned_on);

COMMENT ON TABLE number_provision_log IS
  'Audit of auto-provisioned Twilio numbers. Used to enforce MAX_NEW_NUMBERS_PER_DAY (default 25) self-serve guardrail. Never deleted.';
