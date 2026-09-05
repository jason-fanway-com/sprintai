-- 099: build_status_* — machine-derived Command Center backing tables
--
-- Spec: docs/specs/2026-09-05-command-center-live.md (Jason, 2026-09-05).
--
-- WHY
-- ---
-- The Command Center's "Progress by epic" / "Task board" / "Risk register" tiles
-- read `program_items` — 3 hand-typed rows, 68 days stale at time of writing. The
-- "Phase timeline" tile is a labelled "Illustrative plan — editable". Jason's
-- rule: every tile reads from a source that cannot drift. If a number cannot be
-- derived from real data, it does not get a tile.
--
-- These four tables hold ONLY machine-derived state, written exclusively by
-- `scripts/publish-build-status.sh` running on the build machine (never by a
-- human, never by the browser). The browser cannot read the repo or run git, so
-- a publisher derives the data and writes it here; the dashboard reads it back.
--
--   build_status_items     — one row per docs/specs/2026-09-03-READINESS.md
--                             table row, parsed verbatim (never hand-typed).
--   build_status_commits   — `git log` since local midnight America/New_York.
--   build_status_functions — deployed edge-function versions (Mgmt API).
--   build_status_meta      — single row: generated_at + publisher_ok. The
--                             freshness gate the dashboard checks before it
--                             trusts anything in the other three tables.
--
-- Writes happen through SECURITY INVOKER RPC functions granted to service_role
-- ONLY (never to authenticated/anon) — the publisher calls these with the
-- service-role key; the admin dashboard's user JWT cannot write to any of this.
-- Each RPC does a full delete+insert of its table in one statement/transaction,
-- so a board row that disappears from READINESS.md disappears here too, rather
-- than lingering.
--
-- ADDITIVE ONLY. Idempotent (CREATE ... IF NOT EXISTS, guarded policies,
-- CREATE OR REPLACE FUNCTION). Reversible: see 099_build_status.down.sql.

-- ============================================================
-- tables
-- ============================================================

CREATE TABLE IF NOT EXISTS build_status_items (
  item              TEXT PRIMARY KEY,
  what              TEXT NOT NULL,
  status            TEXT NOT NULL,
  blockers          TEXT,
  blocked_on_jason  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS build_status_commits (
  sha           TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  committed_at  TIMESTAMPTZ NOT NULL,
  author        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_status_commits_committed_at
  ON build_status_commits (committed_at DESC);

CREATE TABLE IF NOT EXISTS build_status_functions (
  slug         TEXT PRIMARY KEY,
  version      INTEGER NOT NULL,
  deployed_at  TIMESTAMPTZ
);

-- Singleton row (id always 1) — the freshness gate.
CREATE TABLE IF NOT EXISTS build_status_meta (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  head_sha           TEXT,
  readiness_mtime    TIMESTAMPTZ,
  publisher_ok       BOOLEAN NOT NULL DEFAULT FALSE,
  publisher_error    TEXT
);

COMMENT ON TABLE build_status_items IS
  'One row per docs/specs/2026-09-03-READINESS.md table row, parsed by scripts/publish-build-status.sh. Never hand-typed. blocked_on_jason is derived by regex over the board''s own Blockers/Validated-how text.';
COMMENT ON TABLE build_status_commits IS
  'git log since local midnight America/New_York, written by scripts/publish-build-status.sh. Full-replace every run.';
COMMENT ON TABLE build_status_functions IS
  'Deployed Supabase edge function slug/version/deployed_at from the Management API, written by scripts/publish-build-status.sh.';
COMMENT ON TABLE build_status_meta IS
  'Singleton freshness gate for the Command Center. If generated_at is older than 15 minutes or publisher_ok is false, the dashboard must show a "not updating" banner instead of numbers from the other three build_status_* tables.';

-- ============================================================
-- RLS — super-admin SELECT only; no write policy for authenticated at all
-- ============================================================

ALTER TABLE build_status_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_status_commits   ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_status_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_status_meta      ENABLE ROW LEVEL SECURITY;

ALTER TABLE build_status_items     FORCE ROW LEVEL SECURITY;
ALTER TABLE build_status_commits   FORCE ROW LEVEL SECURITY;
ALTER TABLE build_status_functions FORCE ROW LEVEL SECURITY;
ALTER TABLE build_status_meta      FORCE ROW LEVEL SECURITY;

REVOKE ALL ON build_status_items     FROM anon, authenticated;
REVOKE ALL ON build_status_commits   FROM anon, authenticated;
REVOKE ALL ON build_status_functions FROM anon, authenticated;
REVOKE ALL ON build_status_meta      FROM anon, authenticated;

DROP POLICY IF EXISTS "Super admins read build_status_items" ON build_status_items;
CREATE POLICY "Super admins read build_status_items" ON build_status_items
  FOR SELECT TO authenticated USING (public.is_super_admin());

DROP POLICY IF EXISTS "Super admins read build_status_commits" ON build_status_commits;
CREATE POLICY "Super admins read build_status_commits" ON build_status_commits
  FOR SELECT TO authenticated USING (public.is_super_admin());

DROP POLICY IF EXISTS "Super admins read build_status_functions" ON build_status_functions;
CREATE POLICY "Super admins read build_status_functions" ON build_status_functions
  FOR SELECT TO authenticated USING (public.is_super_admin());

DROP POLICY IF EXISTS "Super admins read build_status_meta" ON build_status_meta;
CREATE POLICY "Super admins read build_status_meta" ON build_status_meta
  FOR SELECT TO authenticated USING (public.is_super_admin());

GRANT SELECT ON build_status_items, build_status_commits, build_status_functions, build_status_meta TO authenticated;

-- ============================================================
-- write RPCs — service_role ONLY (never authenticated, never anon)
-- ============================================================
-- SECURITY INVOKER is correct here (not DEFINER): the publisher calls these
-- with the service-role key, and the service_role Postgres role already
-- bypasses RLS on every table. No elevation is needed or granted.

CREATE OR REPLACE FUNCTION public.publish_build_status_items(p_items JSONB)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM build_status_items WHERE TRUE;
  INSERT INTO build_status_items (item, what, status, blockers, blocked_on_jason, sort_order)
  SELECT
    r->>'item',
    r->>'what',
    r->>'status',
    r->>'blockers',
    COALESCE((r->>'blocked_on_jason')::boolean, FALSE),
    COALESCE((r->>'sort_order')::integer, 0)
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS r;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_build_status_commits(p_commits JSONB)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM build_status_commits WHERE TRUE;
  INSERT INTO build_status_commits (sha, subject, committed_at, author)
  SELECT
    r->>'sha',
    r->>'subject',
    (r->>'committed_at')::timestamptz,
    r->>'author'
  FROM jsonb_array_elements(COALESCE(p_commits, '[]'::jsonb)) AS r;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_build_status_functions(p_functions JSONB)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM build_status_functions WHERE TRUE;
  INSERT INTO build_status_functions (slug, version, deployed_at)
  SELECT
    r->>'slug',
    (r->>'version')::integer,
    (r->>'deployed_at')::timestamptz
  FROM jsonb_array_elements(COALESCE(p_functions, '[]'::jsonb)) AS r;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_build_status_meta(
  p_head_sha        TEXT,
  p_readiness_mtime TIMESTAMPTZ,
  p_publisher_ok    BOOLEAN,
  p_publisher_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO build_status_meta (id, generated_at, head_sha, readiness_mtime, publisher_ok, publisher_error)
  VALUES (TRUE, NOW(), p_head_sha, p_readiness_mtime, p_publisher_ok, p_publisher_error)
  ON CONFLICT (id) DO UPDATE SET
    generated_at    = NOW(),
    head_sha        = EXCLUDED.head_sha,
    readiness_mtime = EXCLUDED.readiness_mtime,
    publisher_ok    = EXCLUDED.publisher_ok,
    publisher_error = EXCLUDED.publisher_error;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_build_status_items(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_build_status_commits(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_build_status_functions(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_build_status_meta(TEXT, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.publish_build_status_items(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_build_status_commits(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_build_status_functions(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_build_status_meta(TEXT, TIMESTAMPTZ, BOOLEAN, TEXT) TO service_role;

COMMENT ON FUNCTION public.publish_build_status_items IS
  'Full delete+insert of build_status_items. service_role only — called by scripts/publish-build-status.sh, never by the browser.';
COMMENT ON FUNCTION public.publish_build_status_commits IS
  'Full delete+insert of build_status_commits. service_role only — called by scripts/publish-build-status.sh, never by the browser.';
COMMENT ON FUNCTION public.publish_build_status_functions IS
  'Full delete+insert of build_status_functions. service_role only — called by scripts/publish-build-status.sh, never by the browser.';
COMMENT ON FUNCTION public.publish_build_status_meta IS
  'Upserts the singleton build_status_meta row. Written LAST every publisher run, and on failure with publisher_ok=false, so the dashboard never shows a green board with a dead publisher. service_role only.';

-- ============================================================================
-- ROLLBACK NOTES (see 099_build_status.down.sql for the executable down):
--   Purely additive — creates four NEW tables + four NEW RPC functions. Touches
--   no existing table's data. The down script drops only what this file created.
-- ============================================================================
