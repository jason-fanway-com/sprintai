-- 066_add_scorer_version_to_test_runs.sql
-- 2026-08-28: Wire SCORER_VERSION so the dashboard can separate runs scored
-- under different scoring rules. Default 0 = pre-freeze (no version recorded).
-- Bumped to 1 on the 2026-08-28 scorer freeze.

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS scorer_version integer NOT NULL DEFAULT 0;