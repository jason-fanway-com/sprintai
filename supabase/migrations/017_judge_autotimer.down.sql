-- DOWN / rollback for 017_judge_autotimer.sql.
--
-- Reversible: removes ONLY the cron job this migration created. Idempotent
-- (guarded so re-running after a partial up is clean). Touches no table, no
-- existing data, and no live order-path object.
--
-- EXTENSIONS ARE LEFT ENABLED ON PURPOSE. pg_cron / pg_net are shared, project-
-- wide extensions that other features (and Supabase itself) may rely on. Dropping
-- a shared extension can cascade-drop unrelated jobs/objects, so the safe and
-- conventional rollback is to remove our job and leave the extensions in place.
-- Re-enabling later is a no-op (CREATE EXTENSION IF NOT EXISTS).
--
-- THE VAULT SECRET ('eval_sweep_bearer') IS NOT TOUCHED HERE. This migration
-- never created it (the lead injects it out-of-band), so this DOWN does not
-- presume to own or delete it. If you want to also revoke the secret, the lead
-- runs, out-of-band:
--     delete from vault.secrets where name = 'eval_sweep_bearer';

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'judge-eval-sweep') THEN
    PERFORM cron.unschedule('judge-eval-sweep');
  END IF;
END
$do$;
