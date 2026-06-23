-- SprintAI — Conversation Judge AUTO-TIMER (Spec 06, scheduling layer).
--
-- Makes the eval-sweep edge function run on a SCHEDULE instead of by hand. The
-- judge is async / read-only / out-of-band (see 014_conversation_evals.sql and
-- supabase/functions/eval-sweep/index.ts): it reads completed/idle conversations
-- after the fact and writes ONLY to conversation_evals. This migration adds NO
-- new behavior to the order path — it only causes the existing sweep to fire
-- every 5 minutes via pg_cron + pg_net.
--
-- PATTERN (verified against Supabase docs, 2026-06):
--   docs.supabase.com/guides/functions/schedule-functions  → pg_cron + pg_net
--     net.http_post invoking /functions/v1/<fn>, auth pulled from Supabase Vault.
--   docs.supabase.com/guides/cron                           → pg_cron lives in the
--     `cron` schema; jobs are rows in cron.job; runs in cron.job_run_details.
--   docs.supabase.com/guides/database/vault                 → vault.create_secret /
--     vault.decrypted_secrets for encrypted secret storage.
--
-- ADDITIVE / IDEMPOTENT / REVERSIBLE.
--   * CREATE EXTENSION IF NOT EXISTS (no-op if already present on the project).
--   * cron.schedule() is upsert-by-jobname on modern pg_cron: re-running replaces
--     the same-named job rather than duplicating it (we additionally unschedule
--     first, guarded, so this is safe on every supported pg_cron version).
--   * Touches NO existing table. Creates no table. Only schedules a job + (does
--     NOT) store the secret value (the secret is injected out-of-band by the
--     lead — see BUILD-NOTES, the migration never contains the key).
--   * Reverse with 017_judge_autotimer.down.sql.
--
-- SECRET HANDLING — HARD RULE (do not violate):
--   The sweep's gateway requires a SERVICE-ROLE bearer token. That value is a
--   secret and MUST NOT appear in this file, in cron.job.command, or in any
--   committed artifact. We read it at call time from Supabase Vault by the
--   stable name 'eval_sweep_bearer'. THIS MIGRATION DOES NOT CREATE THAT SECRET.
--   The lead injects it once, out-of-band, with (placeholder shown):
--
--       select vault.create_secret('<SERVICE_ROLE_JWT>', 'eval_sweep_bearer',
--         'Bearer token used by the judge-eval-sweep cron job to invoke eval-sweep');
--
--   Until that secret exists, the cron job POSTs with a NULL/empty bearer. NOTE:
--   eval-sweep currently runs with `verify_jwt = false` (see supabase/config.toml)
--   and its handler never inspects the inbound Authorization header, so a missing
--   or empty bearer does NOT 401 — the tick still returns HTTP 200 and the sweep
--   still runs. The bearer is pulled from Vault for correctness / best-practice,
--   not as an enforced gate. This is safe regardless, because the sweep is:
--     * READ-ONLY w.r.t. customer data (it only writes conversation_evals, using
--       its OWN env service-role key — not the inbound bearer — for DB access);
--     * idempotent via the unique index on (conversation_id, transcript_hash):
--       unchanged re-runs return `skipped_unchanged` at ~0 cost;
--     * spend-capped by JUDGE_DAILY_SPEND_CEILING_CENTS (~200¢/day).
--   So a missing Vault secret degrades to "a free, capped, dedup-gated sweep,"
--   NOT an open or elevated-access hole. (Future option, NOT done here: if a true
--   fail-closed is ever wanted, add an app-level service-role check inside
--   eval-sweep that rejects a missing/empty bearer.)
--
-- The project URL is PUBLIC (not a secret) and is embedded directly. Only the
-- bearer comes from Vault.

-- ── Extensions ────────────────────────────────────────────────────────────────
-- pg_cron: scheduler (installs into schema `cron`, runs in the postgres DB).
-- pg_net : async HTTP from SQL (net.http_post). On Supabase pg_net installs into
-- schema `extensions` and is exposed as `net.*`.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Schedule the sweep every 5 minutes ────────────────────────────────────────
-- Idempotency: unschedule any prior same-named job first (guarded — no error if
-- it does not yet exist), then (re)create it. This keeps re-running the migration
-- clean on every pg_cron version, not only the ones whose cron.schedule upserts.
DO $do$
BEGIN
  -- Remove a pre-existing job of the same name, if present, so we never stack
  -- duplicate 'judge-eval-sweep' jobs.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'judge-eval-sweep') THEN
    PERFORM cron.unschedule('judge-eval-sweep');
  END IF;
END
$do$;

-- (Re)create the job. The job body:
--   * pulls ONLY the bearer from Vault (never a literal),
--   * POSTs an empty JSON body to the public eval-sweep endpoint,
--   * is a pure HTTP call — it performs NO writes itself; all judging/writing
--     happens inside the edge function against conversation_evals only.
SELECT cron.schedule(
  'judge-eval-sweep',
  '*/5 * * * *',  -- every 5 minutes
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
          ''  -- empty bearer if Vault secret absent. NOT an auth gate: eval-sweep
              -- has verify_jwt=false and ignores this header, so the tick still
              -- returns 200 and runs. Safe anyway: read-only, dedup-gated, spend-
              -- capped sweep using its own env service-role key (see header note).
        )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000  -- generous; a full 50-conv sweep finishes well under this
  ) AS request_id;
  $job$
);
