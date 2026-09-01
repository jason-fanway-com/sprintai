-- 072: Add max_cases + case_filter columns to test_run_queue
--
-- The test-runner reads job.max_cases and job.case_filter from these columns
-- to cap/slice generated cases (e.g. smoke runs). Without the columns, both
-- properties are undefined, the cap is silently skipped, and the runner
-- always runs the full 128-case suite — wasting time and credits.
--
-- Both columns are nullable with no default. When NULL, behavior is unchanged
-- (full run, no filter). The test-runner logs loudly when a cap or filter is
-- present but cannot be honored.

ALTER TABLE test_run_queue ADD COLUMN IF NOT EXISTS max_cases integer;
ALTER TABLE test_run_queue ADD COLUMN IF NOT EXISTS case_filter jsonb;