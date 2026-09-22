-- DOWN / rollback for 147_proof_scheduled_trigger.sql.
--
-- Reversible: removes ONLY the cron job this migration created and the
-- notified_at column it added. Idempotent. Touches no other table and no
-- live order-path object. Does not drop pg_cron (shared, project-wide).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-scheduled-trigger') THEN
    PERFORM cron.unschedule('proof-scheduled-trigger');
  END IF;
END
$do$;

ALTER TABLE test_runs DROP COLUMN IF EXISTS notified_at;
