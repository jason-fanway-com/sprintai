-- SprintAI — Shop Operating Hours (launch-critical for the diner bot's
-- "are we open?" logic and the signup wizard's hours-capture step).
--
-- ADDITIVE ONLY. No drops, no destructive mutation, no data deletes. Idempotent
-- (safe to re-run). Reversible: see the rollback notes at the bottom.
--
-- Storage already exists from 003_ordering_schema.sql:
--     shops.open_hours JSONB DEFAULT '{}'
--     shops.timezone   TEXT  NOT NULL DEFAULT 'America/New_York'
-- This migration is DEFENSIVE + DOCUMENTING: it guarantees the columns exist
-- (in case a DB was provisioned from a partial baseline), pins the canonical
-- shape as a comment, and ensures sane defaults. It deliberately does NOT add a
-- JSONB CHECK constraint: the shape is validated in the server-side write path
-- (onboarding-save) and a strict DB constraint risks rejecting legitimate future
-- shapes (e.g. multi-window days) without a clear rollback win.

-- ---- shops.open_hours: per-day open/close windows --------------------------
-- Canonical shape (keys are the shop's LOCAL day-of-week; closed days are
-- OMITTED, never present with an empty array required):
--   {
--     "mon": [{ "open": "11:00", "close": "21:00" }],
--     "tue": [{ "open": "11:00", "close": "14:00" },        -- multi-window
--             { "open": "17:00", "close": "22:00" }],        -- (lunch + dinner)
--     "sun": []  -- (or absent) => CLOSED
--   }
-- Times are 24h "HH:MM" strings in the shop's local timezone (shops.timezone),
-- NOT UTC. The diner bot (chat-sms) compares against the shop-local day + time.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS open_hours JSONB DEFAULT '{}'::jsonb;

-- Backfill any NULLs to an empty object so reads never hit NULL.
UPDATE shops SET open_hours = '{}'::jsonb WHERE open_hours IS NULL;

COMMENT ON COLUMN shops.open_hours IS
  'Per-day operating hours in the shop''s LOCAL timezone. Shape: { "mon": [{"open":"11:00","close":"21:00"}], ... }. Closed days are omitted. Times are 24h HH:MM, never UTC. Written only via the server-side onboarding-save (service role); read by chat-sms for the "are we open?" check.';

-- ---- shops.timezone: IANA timezone the hours are interpreted in ------------
ALTER TABLE shops ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

COMMENT ON COLUMN shops.timezone IS
  'IANA timezone (e.g. America/New_York) used to interpret open_hours and to compute the local day/time for the diner bot. Defaults to America/New_York.';

-- ============================================================================
-- ROLLBACK NOTES (manual; this migration is additive/idempotent and normally
-- needs no rollback):
--   open_hours and timezone are pre-existing columns from 003; do NOT drop them
--   here. To revert ONLY the documentation added by this file:
--       COMMENT ON COLUMN shops.open_hours IS NULL;
--       COMMENT ON COLUMN shops.timezone   IS NULL;
--   The data backfill (NULL -> '{}') is non-destructive and not reverted.
-- ============================================================================
