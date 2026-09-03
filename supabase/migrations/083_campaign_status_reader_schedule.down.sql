-- DOWN / rollback for 083_campaign_status_reader_schedule.sql.
--
-- Reversible: removes ONLY the cron job this migration created. Idempotent
-- (guarded so re-running after a partial up is clean). Touches no table, no
-- existing data, and no live order-path object.
--
-- EXTENSIONS ARE LEFT ENABLED ON PURPOSE (pg_cron / pg_net are shared,
-- project-wide; dropping them can cascade-drop unrelated jobs).
--
-- THE VAULT SECRET ('daily_reset_secret') IS NOT TOUCHED HERE. This migration
-- never created it (injected out-of-band by the lead/Jason), so this DOWN does
-- not presume to own or delete it. To also revoke it, run out-of-band:
--     delete from vault.secrets where name = 'daily_reset_secret';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'campaign-status-reader') THEN
    PERFORM cron.unschedule('campaign-status-reader');
  END IF;
END
$do$;
