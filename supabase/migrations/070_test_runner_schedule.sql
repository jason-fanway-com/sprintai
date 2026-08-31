-- Migration 070: test_run_queue — add batch-progress columns + pg_cron schedule for server-side test-runner
--
-- The server-side test-runner edge function processes cases in batches
-- (4 per tick). It needs columns to track progress across invocations:
--   case_index   — how many cases have been run so far (0 = just started)
--   total_cases  — how many cases total (set when generation completes)
--   cases_json   — serialized test cases (generated once, replayed across ticks)
--   scored_json  — accumulated results (built incrementally)
--   shop_name    — denormalized for logging (set when generation completes)
--
-- Also creates the pg_cron schedule that triggers the function every 60s.
--
-- IDEMPOTENT / REVERSIBLE. No data loss — adding nullable columns.

ALTER TABLE test_run_queue
  ADD COLUMN IF NOT EXISTS case_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cases integer,
  ADD COLUMN IF NOT EXISTS cases_json jsonb,
  ADD COLUMN IF NOT EXISTS scored_json jsonb,
  ADD COLUMN IF NOT EXISTS shop_name text;

COMMENT ON COLUMN test_run_queue.case_index IS 'Number of cases processed so far (0 = generation not yet complete)';
COMMENT ON COLUMN test_run_queue.total_cases IS 'Total number of test cases for this job';
COMMENT ON COLUMN test_run_queue.cases_json IS 'Serialized test case array, generated once on first tick';
COMMENT ON COLUMN test_run_queue.scored_json IS 'Accumulated ScoredCase[] results, checkpointed after each case';
COMMENT ON COLUMN test_run_queue.shop_name IS 'Denormalized shop name for logging';

-- ── pg_cron schedule ───────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: remove any prior job of the same name
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'test-runner-tick') THEN
    PERFORM cron.unschedule('test-runner-tick');
  END IF;
END
$do$;

-- Schedule: every 60 seconds
SELECT cron.schedule(
  'test-runner-tick',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/test-runner',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'eval_sweep_bearer' LIMIT 1) || '"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $job$
);