-- 081: campaign_assignment_gate — track assignment state, gate go-live, escalate 10036
--
-- Replaces the write-only boolean pending_campaign_assignment with a truthful
-- status column on shops so go-live can gate on it and chat-sms can escalate
-- 10036 errors for structurally undeliverable shops.
--
-- Columns added to shops:
--   campaign_assignment_status  — not_started | submitted | approved | rejected
--   campaign_assignment_checked_at — when the status reader last checked
--   campaign_id                — the Telnyx campaign the number is mapped to
--
-- Backfill: demo number +16107358315 rides the SprintAI shared brand with demo
-- disclosure — it is NOT individually campaign-approved. Set it 'not_started'.
-- is_test shops are exempt from the gate anyway.

DO $$ BEGIN
  ALTER TABLE shops ADD COLUMN campaign_assignment_status TEXT NOT NULL DEFAULT 'not_started';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE shops ADD COLUMN campaign_assignment_checked_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE shops ADD COLUMN campaign_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Constraint: only valid status values
DO $$ BEGIN
  ALTER TABLE shops ADD CONSTRAINT chk_campaign_assignment_status
    CHECK (campaign_assignment_status IN ('not_started', 'submitted', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Index for the status reader: find all shops awaiting mapping poll
CREATE INDEX IF NOT EXISTS idx_shops_campaign_status
  ON shops (campaign_assignment_status)
  WHERE campaign_assignment_status = 'submitted';

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Demo number +16107358315: rides SprintAI shared brand with demo disclosure,
-- NOT individually campaign-approved. Set to 'not_started' truthfully.
-- is_test = true so it is exempt from the go-live gate anyway.
UPDATE shops
   SET campaign_assignment_status = 'not_started',
       campaign_id = 'CSMB9HG'
 WHERE phone_number_e164 = '+16107358315';

-- All other numbers with a phone_number_e164 that aren't the demo: also
-- default to 'not_started' (the column default handles new rows). Existing
-- rows already get 'not_started' from the DEFAULT above.

-- ── Down migration ─────────────────────────────────────────────────────────
-- ALTER TABLE shops DROP COLUMN IF EXISTS campaign_assignment_status;
-- ALTER TABLE shops DROP COLUMN IF EXISTS campaign_assignment_checked_at;
-- ALTER TABLE shops DROP COLUMN IF EXISTS campaign_id;
-- DROP INDEX IF EXISTS idx_shops_campaign_status;