-- Migration 147: Proof scheduled auto-trigger — enqueue a Proof run for every
-- live (non-paused) shop every 4 hours, so regressions are caught automatically
-- instead of only when someone remembers to run Proof by hand.
--
-- Decision (Jason, 2026-09-22): cadence = every 4 hours, hardcoded. Not
-- configurable in this build; making it configurable later is a separate
-- change.
--
-- Design: this does NOT touch the test-runner edge function or its
-- 60s-tick queue-drain loop (migration 070) at all. It only ADDS an
-- enqueue step on top: every 4 hours, insert one test_run_queue row per
-- live shop, reusing the exact same enqueue-guard already used everywhere
-- else in this codebase (skip a shop if a non-terminal queue row already
-- exists for it — see docs "Enqueue guard" note, memory
-- enqueue-guard-before-run.md). The already-running test-runner cron then
-- drains these rows exactly like it drains manual/onboarding rows.
--
-- "Live shop" = shops.is_paused = false. No shop id/name is hardcoded here;
-- a new shop that finishes onboarding (and is not paused) is automatically
-- picked up next tick, and a paused shop is automatically skipped — this
-- generalizes rather than special-casing today's 3 shops.
--
-- Runs entirely as a plain SQL statement inside the pg_cron job body (no
-- edge function, no HTTP call, no vault secret/bearer dependency) — this
-- sidesteps the known fragility documented for the test-runner-tick job
-- (empty `eval_sweep_bearer` vault secret broke its Authorization header,
-- 2026-09-01, verify_jwt disabled as a workaround). An in-database SQL cron
-- job has no auth header to break.
--
-- IDEMPOTENT / REVERSIBLE. No data loss — adding one nullable column and one
-- cron job.

-- ── notified_at — lets a regression-detector query "have we already alerted
--    on this run" without a parallel results store (test_runs stays the only
--    source of truth for Proof results, per memory proof-results-authoritative-source.md).
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

COMMENT ON COLUMN test_runs.notified_at IS
  'Set when a human/agent has been alerted about this run failing the proof+critical gate (scheduled runs only). NULL = not yet triaged.';

-- ── pg_cron schedule ───────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-scheduled-trigger') THEN
    PERFORM cron.unschedule('proof-scheduled-trigger');
  END IF;
END
$do$;

-- Every 4 hours, at the top of the hour.
SELECT cron.schedule(
  'proof-scheduled-trigger',
  '0 */4 * * *',
  $job$
  INSERT INTO test_run_queue (shop_id, tenant_id, status, reason, requested_at)
  SELECT s.id, s.tenant_id, 'pending', 'scheduled', now()
  FROM shops s
  WHERE s.is_paused = false
    AND NOT EXISTS (
      SELECT 1 FROM test_run_queue q
      WHERE q.shop_id = s.id
        AND q.status IN ('pending', 'running')
    );
  $job$
);
