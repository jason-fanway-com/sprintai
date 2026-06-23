-- SprintAI — Command Center live-state backing objects (feat/command-center-live).
--
-- Powers the internal, super-admin "Command Center" page in the admin-dashboard.
-- The page derives ALL of its content from live sources at view-time so it can
-- never go stale. This migration adds the two backing objects the page needs
-- that are NOT already readable client-side:
--
--   1. public.program_items  — the ONE editorial slice (known open items /
--      blockers). Storing these as ROWS (not hand-edited HTML) means updating an
--      item is a row write, not a redeploy. Admin-readable via RLS; the live
--      order path never touches it.
--
--   2. public.command_center_deploy_status() — a SECURITY DEFINER function that
--      returns NON-SENSITIVE deploy state (which DB migrations are applied, read
--      from supabase_migrations.schema_migrations). PostgREST does not expose the
--      supabase_migrations schema, so a normal client (even service role over
--      REST) cannot read the ledger. A SECURITY DEFINER function owned by the
--      migration runner CAN read it and return only version + applied flag. The
--      function is admin-gated INSIDE the function body (checks the caller JWT),
--      so it leaks nothing to non-admins and embeds NO secret. The browser calls
--      it with the admin user's JWT via supabase.rpc(); no service-role key or
--      access token ever enters the client bundle.
--
-- ADDITIVE ONLY. No drops, no destructive mutation, no data deletes on existing
-- tables. Idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, guarded
-- policies, CREATE OR REPLACE FUNCTION, seed via WHERE NOT EXISTS). Reversible:
-- see 016_command_center.down.sql.

-- ============================================================
-- program_items — editorial "known open items / blockers"
-- ============================================================
CREATE TABLE IF NOT EXISTS program_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'done', 'blocked')),
  severity    TEXT        NOT NULL DEFAULT 'minor'
                CHECK (severity IN ('critical', 'major', 'minor')),
  note        TEXT,
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  -- stable de-dupe / upsert key for idempotent seeding (slug of the item)
  item_key    TEXT        UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defensive re-adds in case the table pre-existed from a partial baseline.
ALTER TABLE program_items ADD COLUMN IF NOT EXISTS severity   TEXT NOT NULL DEFAULT 'minor';
ALTER TABLE program_items ADD COLUMN IF NOT EXISTS note       TEXT;
ALTER TABLE program_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 100;
ALTER TABLE program_items ADD COLUMN IF NOT EXISTS item_key   TEXT;

CREATE INDEX IF NOT EXISTS idx_program_items_status_sort
  ON program_items (status, sort_order, updated_at DESC);

-- keep updated_at fresh on row writes
CREATE OR REPLACE FUNCTION set_program_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_program_items_updated_at ON program_items;
CREATE TRIGGER trg_program_items_updated_at
  BEFORE UPDATE ON program_items
  FOR EACH ROW EXECUTE FUNCTION set_program_items_updated_at();

-- ---- RLS: platform admins only (this is an internal operator table) ----------
ALTER TABLE program_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'program_items'
      AND policyname = 'Admins have full access to program_items'
  ) THEN
    CREATE POLICY "Admins have full access to program_items"
      ON program_items FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END$$;

-- ---- seed current known open items (idempotent: WHERE NOT EXISTS by item_key)-
INSERT INTO program_items (item_key, title, status, severity, note, sort_order)
SELECT v.item_key, v.title, v.status, v.severity, v.note, v.sort_order
FROM (VALUES
  ('judge-auto-timer',
   'Conversation judge auto-timer not enabled',
   'open', 'major',
   'The eval-sweep judge worker exists and runs on demand, but no scheduled/cron auto-timer is enabled yet, so sweeps are manual.',
   10),
  ('welcome-index-zero-byte',
   'welcome/index.html is a 0-byte page and is the live Stripe success target',
   'open', 'critical',
   'Stripe checkout success redirects to welcome/index.html, which is currently 0 bytes — diners hit a blank page after paying.',
   20),
  ('subscription-billing-spec-03',
   'Subscription billing (spec 03) not built',
   'open', 'major',
   'PAY-NOW $49/mo subscription wiring from Build Spec 03 is specified but not yet implemented; shops.subscription_status stays "none".',
   30)
) AS v(item_key, title, status, severity, note, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM program_items p WHERE p.item_key = v.item_key
);

COMMENT ON TABLE program_items IS
  'Internal operator "known open items / blockers" for the Command Center page. Editorial rows (open|done|blocked) so updates are row writes, not redeploys. Admin-only via RLS. Never touched by the live order path.';

-- ============================================================
-- command_center_deploy_status() — non-sensitive deploy state
-- ============================================================
-- Returns applied DB migrations from supabase_migrations.schema_migrations.
-- SECURITY DEFINER so it can read the (PostgREST-unexposed) migrations ledger;
-- admin-gated inside the body so non-admins get nothing. Returns ONLY version +
-- name — no secrets, no connection info, no env. Safe to call from the browser
-- with the admin user's JWT.
CREATE OR REPLACE FUNCTION public.command_center_deploy_status()
RETURNS TABLE (version TEXT, name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, supabase_migrations
AS $$
BEGIN
  -- Admin gate: only platform admins may read deploy state.
  IF coalesce(auth.jwt()->'user_metadata'->>'is_admin', '') <> 'true' THEN
    RAISE EXCEPTION 'forbidden: admin access required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT m.version::text, coalesce(m.name, '')::text
    FROM supabase_migrations.schema_migrations m
    ORDER BY m.version;
EXCEPTION
  -- If the ledger schema/table is absent (e.g. a non-Supabase DB), degrade to
  -- an empty set rather than erroring the whole Command Center page.
  WHEN undefined_table OR invalid_schema_name THEN
    RETURN;
END;
$$;

-- Lock down execute: only authenticated callers (the admin gate above is the
-- real check; this just removes anon/public execute).
REVOKE ALL ON FUNCTION public.command_center_deploy_status() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.command_center_deploy_status() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.command_center_deploy_status() TO service_role;
  END IF;
END$$;

COMMENT ON FUNCTION public.command_center_deploy_status() IS
  'Read-only, admin-gated, SECURITY DEFINER. Returns applied DB migration versions/names from supabase_migrations.schema_migrations for the Command Center deploy panel. Leaks no secrets; callable from the browser with the admin JWT.';

-- ============================================================================
-- ROLLBACK NOTES (see 016_command_center.down.sql for the executable down):
--   Purely additive — creates one NEW table + index + trigger + RLS policy and
--   one NEW function, and seeds three rows keyed by item_key. Touches no
--   existing table's data. The down script drops only what this file created.
-- ============================================================================
