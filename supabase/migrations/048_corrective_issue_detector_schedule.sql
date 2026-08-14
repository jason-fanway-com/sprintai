-- SprintAI — Issue Detector: corrective schedule + Vault auth (Spec 06).
--
-- The issue-detector edge function + issues table were created in 030 but
-- never deployed or scheduled. Migration 047 scheduled it but was never
-- applied. This migration is self-contained — it does NOT depend on 047.
-- It (re)creates the Vault secret and schedules the detector every 10
-- minutes. Idempotent: rerunning safely re-creates the same job+secret.
--
-- PRE-REQUISITES (the lead applies before this migration):
--   1. Deploy the edge function: `supabase functions deploy issue-detector`
--   2. Run this migration (select all + execute in Supabase SQL Editor)
--   3. Verify with: SELECT jobid, jobname, active FROM cron.job;
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE (run 048...down.sql to unschedule).
--
-- SECRET HANDLING: The service-role JWT is loaded from the environment by
-- the edge function itself (env SUPABASE_SERVICE_ROLE_KEY). The Vault
-- secret 'issue_detector_bearer' is an additional Bearer header sent by
-- the cron caller. The edge runs verify_jwt=false so a missing Bearer
-- degrades gracefully — it still accepts and runs. This secret is a
-- best-practice belt-and-suspenders, not a hard gate.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '048';

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Create the Vault secret for the cron job to use as Bearer ───────────
-- Uses the same service-role JWT that the edge function itself uses for DB access.
-- The secret value is injected out-of-band by the lead:
--
--   SELECT vault.create_secret('<SERVICE_ROLE_JWT>', 'issue_detector_bearer',
--     'Bearer token for issue-detector cron to auth against the edge function');
--
-- The migration only creates the secret if it does NOT already exist.

DO $do$
DECLARE
  _secret_exists boolean;
  _svc_key text;
BEGIN
  -- Check if Vault is installed (requires supabase_vault extension)
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault'
  ) INTO _secret_exists;

  IF NOT _secret_exists THEN
    RAISE WARNING 'supabase_vault is not installed; issue-detector cron will use empty bearer (harmless — edge runs verify_jwt=false)';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'issue_detector_bearer'
  ) INTO _secret_exists;

  IF NOT _secret_exists THEN
    -- NOTE: This reads the existing eval_sweep_bearer and reuses it.
    -- If the TWO edge functions use the same service-role JWT, this is correct.
    -- If they diverge, inject separately via the lead's out-of-band step above.
    SELECT decrypted_secret INTO _svc_key
      FROM vault.decrypted_secrets
     WHERE name = 'eval_sweep_bearer'
     LIMIT 1;

    IF _svc_key IS NOT NULL AND _svc_key != '' THEN
      PERFORM vault.create_secret(_svc_key, 'issue_detector_bearer',
        'Bearer token for issue-detector cron → edge function auth');
      RAISE NOTICE 'Created issue_detector_bearer from existing eval_sweep_bearer';
    ELSE
      RAISE WARNING 'eval_sweep_bearer not found or empty; issue-detector cron will use empty bearer (harmless — edge runs verify_jwt=false)';
    END IF;
  ELSE
    RAISE NOTICE 'issue_detector_bearer already exists, skipping creation';
  END IF;
END
$do$;

-- ── Idempotently (re)schedule the cron job every 10 minutes ─────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'issue-detector') THEN
    PERFORM cron.unschedule('issue-detector');
    RAISE NOTICE 'Unscheduled existing issue-detector cron job';
  END IF;
END
$do$;

SELECT cron.schedule(
  'issue-detector',
  '*/10 * * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/issue-detector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
        'Bearer ' || COALESCE(
          (SELECT decrypted_secret
             FROM vault.decrypted_secrets
            WHERE name = 'issue_detector_bearer'
            LIMIT 1),
          ''
        )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $job$
);