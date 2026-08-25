-- Migration 064: test_run_queue — async worker queue for onboarding test runs
-- Worker polls for oldest pending row, runs the test suite pipeline,
-- and persists a real test_runs row.
--
-- RLS: service-role only (same posture as other ops tables).
-- No anon/authenticated access — the worker and edge functions use the
-- service_role key internally.

CREATE TABLE IF NOT EXISTS test_run_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  reason text,                              -- 'onboarding' | 'manual' | ...
  error text,
  test_run_id uuid,                         -- FK to test_runs once complete (nullable)
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_test_run_queue_status ON test_run_queue(status, requested_at);

-- Service-role only: no anon/authenticated access.
ALTER TABLE test_run_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do all" ON test_run_queue;
CREATE POLICY "Service role can do all" ON test_run_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE test_run_queue IS 'Async worker queue for onboarding/manual test runs. Polled by scripts/test-suite/worker.ts.';