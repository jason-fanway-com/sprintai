-- Migration 083: schedule campaign-status-reader via pg_cron.
--
-- Migration 081 added `shops.campaign_assignment_status` and made go-live gate
-- #13 refuse non-test shops unless the status is 'approved'. The
-- `campaign-status-reader` edge function was deployed to advance
-- 'submitted' → 'approved' (Telnyx GET-only poll of phone_number_campaigns
-- mapping status), but nothing ever invoked it. Result: for a real merchant,
-- campaign_assignment_status could never auto-advance past 'submitted', so the
-- go-live gate was permanently unsatisfiable without a manual DB edit.
--
-- This migration closes that gap using the same pg_cron pattern as 047
-- (issue-detector) and 070 (test-runner).
--
-- Cadence: hourly. Telnyx campaign→number mapping approval is an hours-to-days
-- process, so an hourly poll is snappy enough while placing near-zero read load
-- on Telnyx (one GET per shop currently in 'submitted').
--
-- AUTH: the reader authenticates the request against its own DAILY_RESET_SECRET
-- env var (Bearer <DAILY_RESET_SECRET>), NOT a Supabase JWT (verify_jwt=false).
-- The cron POST must therefore present that same shared secret. It is read from
-- a Vault secret named 'daily_reset_secret'. If that Vault secret is absent the
-- COALESCE yields '' and the reader returns 401/500 (Not configured) — the job
-- degrades gracefully and does nothing harmful until the secret is populated.
--
-- ⚠️ OUT-OF-BAND, JASON-ONLY (credentials — see HANDOFF §campaign_assignment):
--   1. Set function env secrets in Supabase (Dashboard → Edge Functions →
--      Secrets): DAILY_RESET_SECRET=<value>, TELNYX_API_KEY=<value>.
--   2. Set the Vault secret used by this cron job to the SAME value as (1):
--        select vault.create_secret('<value>', 'daily_reset_secret');
--      (Both must match or the reader returns 401.) Until then this job is inert.
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE (drop with
-- 083_campaign_status_reader_schedule.down.sql). Touches no table, no live
-- order-path object. Unschedules any existing job of the same name first.
-- Requires pg_cron + pg_net (installed by 017).

DELETE FROM supabase_migrations.schema_migrations WHERE version = '083';

-- ── Ensure extensions ─────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Idempotently unschedule ───────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'campaign-status-reader') THEN
    PERFORM cron.unschedule('campaign-status-reader');
  END IF;
END
$do$;

-- ── (Re)schedule hourly ────────────────────────────────────────────────────
SELECT cron.schedule(
  'campaign-status-reader',
  '0 * * * *',  -- top of every hour
  $job$
  SELECT net.http_post(
    url     := 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/campaign-status-reader',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
        'Bearer ' || COALESCE(
          (SELECT decrypted_secret
             FROM vault.decrypted_secrets
            WHERE name = 'daily_reset_secret'
            LIMIT 1),
          ''
        )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $job$
);
