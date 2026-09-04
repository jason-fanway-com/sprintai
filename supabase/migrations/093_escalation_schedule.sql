-- 093 — Escalation-only issue-detector schedule, every 2 minutes
-- (INSTRUCTION-10 item I).
--
-- The main issue-detector sweep (047/048) runs every 10 minutes, which is far
-- too slow for a 7-minute unacknowledged-order timer — it would land 7-17
-- minutes after the fact. This schedules a SECOND, lightweight cron that
-- POSTs {"mode":"escalation"} so only detectUnackedOrders runs, every 2
-- minutes. The existing 10-minute job is untouched and still covers this
-- rule too as a backstop.
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE. Mirrors the unschedule-then-create
-- pattern in 047/048, reusing the same Vault bearer secret.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'issue-detector-escalation') THEN
    PERFORM cron.unschedule('issue-detector-escalation');
    RAISE NOTICE 'Unscheduled existing issue-detector-escalation cron job';
  END IF;
END
$do$;

SELECT cron.schedule(
  'issue-detector-escalation',
  '*/2 * * * *',  -- every 2 minutes
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
    body    := '{"mode":"escalation"}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $job$
);
