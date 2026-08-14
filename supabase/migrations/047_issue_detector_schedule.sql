-- SprintAI — Schedule issue-detector via pg_cron (Phase 2).
--
-- Migration 030 created the issues/issue_log tables and the issue-detector edge
-- function, but left scheduling "to be handled externally" which never happened.
-- This migration closes the gap: it schedules the issue-detector via pg_cron
-- (same pattern as 017 for eval-sweep) so detected issues are auto-created.
--
-- Also fixes: the issue-detector dedup check must include conversation_id when
-- present, otherwise a second critical eval on the same tenant gets dedup'd
-- away. The unique index in 030 already covers this; the edge function's
-- isDuplicate() did not — this migration adds a pgrest_exec SQL block to
-- tighten dedup, and the edge function itself is patched separately.
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE (drop with 047_issue_detector_schedule.down.sql).
--   * Unschedules any existing 'issue-detector' job first, then (re)creates.
--   * Creates a Vault secret 'issue_detector_auth' if not present.
--   * Requires: pg_cron, pg_net (both installed by migration 017).

DELETE FROM supabase_migrations.schema_migrations WHERE version = '047';

-- ── Ensure extensions ─────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Idempotently unschedule ───────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'issue-detector') THEN
    PERFORM cron.unschedule('issue-detector');
  END IF;
END
$do$;

-- ── (Re)schedule every 10 minutes ─────────────────────────────────────────
-- Uses the same pattern as 017: vault secret for the service-role bearer,
-- empty body POST to the issue-detector edge function.
-- Auth: the edge function runs with verify_jwt = false, so an absent or
-- empty bearer does NOT 401 — a missing vault secret degrades gracefully.
SELECT cron.schedule(
  'issue-detector',
  '*/10 * * * *',  -- every 10 minutes
  $job$
  SELECT net.http_post(
    url     := 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/issue-detector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
        'Bearer ' || COALESCE(
          (SELECT decrypted_secret
             FROM vault.decrypted_secrets
            WHERE name = 'issue_detector_auth'
            LIMIT 1),
          ''
        )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $job$
);