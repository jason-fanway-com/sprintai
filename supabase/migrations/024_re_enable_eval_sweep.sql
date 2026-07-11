-- SprintAI — Re-enable the eval-sweep cron job (was disabled by migration 023).
--
-- 023 killed the cron because the sweep was burning API credits by re-judging
-- the same conversations — conversation_evals table didn't exist at deploy
-- time, so the idempotency gate (unique on conversation_id + transcript_hash)
-- couldn't catch duplicates. The table is now live with 52 rows and the unique
-- index is in place. Manual sweep call confirms: 50 scanned, 50 skipped as
-- unchanged, legitimate no-op. Safe to re-enable.
--
-- SELF-HEALING: remove stale schema_migrations record.
DELETE FROM supabase_migrations.schema_migrations WHERE version = '024';

-- Unschedule any leftover job of the same name, then (re)create it.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'judge-eval-sweep') THEN
    PERFORM cron.unschedule('judge-eval-sweep');
  END IF;
END
$do$;

SELECT cron.schedule(
  'judge-eval-sweep',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/eval-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
        'Bearer ' || COALESCE(
          (SELECT decrypted_secret
             FROM vault.decrypted_secrets
            WHERE name = 'eval_sweep_bearer'
            LIMIT 1),
          ''
        )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $job$
);
