-- DISABLE the eval-sweep cron job. The sweep burned $15 because it re-judges
-- the same 259 conversations every 5 minutes with no idempotency gate (the
-- conversation_evals table was missing). This kills the cron job so it won't
-- start burning immediately when a new Anthropic key is deployed.
--
-- SELF-HEALING: remove stale schema_migrations record.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '023';

-- Unschedule the cron job. cron.unschedule is idempotent per modern pg_cron;
-- does NOT error if the job doesn't exist.
SELECT cron.unschedule('judge-eval-sweep');
