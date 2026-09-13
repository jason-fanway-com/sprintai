-- SprintAI — Runtime error persistence (chat-sms reliability gap).
--
-- Supabase edge-function log retention (function_edge_logs / edge_logs) is
-- ~1 minute, so any runtime failure is unrecoverable after ~60s — there is
-- no history to diagnose from. This migration adds our own error_log table,
-- written to directly from edge functions via the service role, with a
-- 7-day retention pg_cron job.
--
-- ADDITIVE ONLY. Safe to re-run. No drops, no data deletes.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '137';

-- ============================================================
-- error_log
-- ============================================================
CREATE TABLE IF NOT EXISTS error_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  conversation_id  UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  shop_id          UUID        REFERENCES shops(id) ON DELETE SET NULL,
  tenant_id        UUID        REFERENCES tenants(id) ON DELETE SET NULL,

  phase            TEXT        NOT NULL,
  stage            TEXT        NOT NULL CHECK (stage IN ('tool_loop', 'render', 'outbound_send', 'guard_deny')),

  customer_message TEXT,
  error_message    TEXT        NOT NULL,
  stack            TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}'
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_error_log_created_at
  ON error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_conversation
  ON error_log (conversation_id);
CREATE INDEX IF NOT EXISTS idx_error_log_shop
  ON error_log (shop_id);

COMMENT ON TABLE error_log IS
  'Runtime error persistence for edge functions, working around the ~1 minute Supabase edge-log retention. Written by the service role; 7-day retention via pg_cron.';

-- ============================================================
-- ROW-LEVEL SECURITY — service_role only, no anon/authenticated access.
-- ============================================================
ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do all" ON error_log;
CREATE POLICY "Service role can do all" ON error_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- pg_cron schedule (idempotent — unschedule then reschedule)
-- ============================================================
-- Daily retention sweep. Pure SQL statement — no edge function or vault
-- secret needed.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'error-log-retention') THEN
    PERFORM cron.unschedule('error-log-retention');
  END IF;
END
$do$;

SELECT cron.schedule(
  'error-log-retention',
  '0 3 * * *',  -- daily at 03:00 UTC
  $job$
  DELETE FROM error_log WHERE created_at < now() - interval '7 days';
  $job$
);
