-- 096: public tester link — public_tester_sessions, app_config, test_transcripts extensions
--
-- Spec:  docs/specs/2026-09-05-public-tester.md (Jason, 2026-09-05)
-- Build: docs/specs/2026-09-05-public-tester-BUILD.md
--
-- WHY
-- ---
-- Jason's human test orders find real defects automated testing misses. This
-- lets him text a link to friends/family so their transcripts land in
-- test_transcripts too, tagged source='public-tester'. The public page never
-- talks to chat-sms directly — everything routes through the public-tester
-- edge function, which is the only thing with a service-role hop and the only
-- thing that enforces the guard rails below. This migration adds the tables
-- that function needs and extends test_transcripts to carry a tester name.
--
-- DESIGN NOTES
-- ------------
--   * public_tester_sessions is service-role only. No user JWT ever reads or
--     writes it except a super-admin SELECT (so Jason can see volume in the
--     dashboard without a service-role tool). Anon and authenticated both lose
--     base table privileges; the super-admin policy gets its GRANT back
--     explicitly, same pattern as test_transcripts' own super-admin SELECT.
--   * app_config is the kill switch. It's a DB row, not an env var, on
--     purpose: Jason can flip public_tester_enabled to false without a
--     deploy. Same RLS shape as public_tester_sessions — service role only
--     grants full access; super-admins get full access through their own
--     policy+grant.
--   * public_tester_shop_id seeds to the Vito's Pizza (QA) id. The edge
--     function still HARD-GATES this per request (is_test = true AND
--     phone_number_e164 IS NULL) — the seed value being correct today does
--     not mean the config row stays correct; a misconfigured id must fail
--     closed, not trust the seed.
--   * public_tester_enabled seeds to false. This ships OFF. Jason turns it on.

-- ── test_transcripts extensions ─────────────────────────────────────────────

ALTER TABLE test_transcripts ADD COLUMN IF NOT EXISTS tester_name text;

COMMENT ON COLUMN test_transcripts.tester_name IS
  'Optional first name a public tester gave when submitting for review. Null for simulator/field sources.';

ALTER TABLE test_transcripts DROP CONSTRAINT IF EXISTS test_transcripts_source_check;
ALTER TABLE test_transcripts ADD CONSTRAINT test_transcripts_source_check
  CHECK (source IN ('simulator', 'field', 'public-tester'));

-- REVOKE ALL ON test_transcripts FROM anon (set in 095) stays in force —
-- nothing here relaxes it. The public-tester edge function writes through
-- the service role, which bypasses RLS and table grants alike.

-- DROP then CREATE, not CREATE OR REPLACE: Postgres cannot add a column to the
-- middle of an existing view's column list ("cannot change name of view column").
-- tester_name lands before created_at to keep the column order readable.
DROP VIEW IF EXISTS qa_ro.test_transcripts;

CREATE VIEW qa_ro.test_transcripts AS
  SELECT id,
    shop_id,
    shop_name,
    model,
    messages,
    final_cart,
    reporter_note,
    source,
    tester_name,
    created_at
  FROM test_transcripts;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_readonly') THEN
    GRANT SELECT ON qa_ro.test_transcripts TO qa_readonly;
    RAISE NOTICE '096: re-granted qa_readonly SELECT on qa_ro.test_transcripts (view rebuilt)';
  ELSE
    RAISE NOTICE '096: role qa_readonly absent — skipped grant';
  END IF;
END $$;

-- ── public_tester_sessions ───────────────────────────────────────────────────
-- One row per conversation started through /try. Tracks turn count for the
-- cap, submitted state, and enough to rate-limit by IP and by browser.

CREATE TABLE IF NOT EXISTS public_tester_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text NOT NULL,
  ip_hash     text NOT NULL,
  shop_id     uuid,
  turns       int NOT NULL DEFAULT 0,
  submitted   boolean NOT NULL DEFAULT false,
  -- The transcript is accumulated SERVER-SIDE, one turn at a time, from what
  -- the tester actually sent and what chat-sms actually replied. It is NOT
  -- taken from the browser at submit time. Two reasons, both load-bearing:
  --   1. "Verbatim" has to be structurally true, not a promise the client
  --      keeps. A browser-supplied transcript is verbatim only if the browser
  --      says so, and the entire value of this corpus is that it is exact.
  --   2. This is a public endpoint. A client-supplied transcript means anyone
  --      who can reach it can write arbitrary content into the regression
  --      corpus we intend to trust.
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_tester_sessions_session_id_idx
  ON public_tester_sessions (session_id);
CREATE INDEX IF NOT EXISTS public_tester_sessions_ip_hash_created_at_idx
  ON public_tester_sessions (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS public_tester_sessions_created_at_idx
  ON public_tester_sessions (created_at DESC);

COMMENT ON TABLE public_tester_sessions IS
  'One row per conversation started through the public /try tester link. Service-role only; the public-tester edge function is the sole writer. See docs/specs/2026-09-05-public-tester-BUILD.md.';
COMMENT ON COLUMN public_tester_sessions.ip_hash IS
  'sha256(client ip + PUBLIC_TESTER_SALT). Raw IP is never stored — minimum PII is a hard rule.';

ALTER TABLE public_tester_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_tester_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public_tester_sessions FROM anon;
REVOKE ALL ON public_tester_sessions FROM authenticated;

GRANT SELECT ON public_tester_sessions TO authenticated;

DROP POLICY IF EXISTS "Super admins read public tester sessions" ON public_tester_sessions;
CREATE POLICY "Super admins read public tester sessions" ON public_tester_sessions
  FOR SELECT TO authenticated
  USING (public.is_super_admin());

-- ── app_config ────────────────────────────────────────────────────────────
-- Generic key/value config table. First use is the public-tester kill switch
-- and target shop id, both editable without a deploy.

CREATE TABLE IF NOT EXISTS app_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_config IS
  'Small generic key/value config store for flags that must flip without a deploy (e.g. public_tester_enabled). Service role writes; super-admins can read/write through the dashboard.';

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config FORCE ROW LEVEL SECURITY;

REVOKE ALL ON app_config FROM anon;
REVOKE ALL ON app_config FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON app_config TO authenticated;

DROP POLICY IF EXISTS "Super admins full access to app_config" ON app_config;
CREATE POLICY "Super admins full access to app_config" ON app_config
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

INSERT INTO app_config (key, value) VALUES
  ('public_tester_enabled', 'false'::jsonb),
  ('public_tester_shop_id', '"22ed2761-a3f2-5bde-9012-916a93c521cd"'::jsonb)
ON CONFLICT (key) DO NOTHING;
