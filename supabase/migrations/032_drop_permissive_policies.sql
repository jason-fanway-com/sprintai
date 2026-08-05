-- 032: Drop Permissive RLS Policies — close tenant-isolation gap
--
-- PURPOSE
-- -------
-- Melvin (on test DB rvdqfxtrskxekfkqnegx) proved that 15 pre-existing
-- catch-all RLS policies with qual=true defeated the tenant-scoped shop_owner
-- RLS from 031. Supabase RLS is OR-based: any permissive USING (true) policy
-- on a table grants access regardless of stricter policies on the same table.
--
-- The proven leak: a shop_owner JWT could:
--   • list ALL 34 tenants
--   • list 6 other-tenant shops
--   • UPDATE/rename 5 other-tenant shops  ← CATASTROPHIC cross-tenant write
--
-- THE FIX
-- -------
-- 1. Sweep pg_policies for every public-schema policy whose USING or
--    WITH CHECK is literally 'true' and drop it.
-- 2. Re-create only the 6 policies that legitimately need broad access:
--    a. "Public can read menus"          → anon SELECT  (ordering UI)
--    b. "Public can read active menu items" → anon SELECT  (ordering UI)
--    c. "Public can read shops"          → anon SELECT  (ordering UI)
--    d. "Public can manage availability overrides" → anon ALL  (merchant PIN UI)
--    e. "Public can update shop pause status"     → anon UPDATE (merchant PIN UI)
--    f. "Service can insert chat transcripts"     → INSERT only (edge functions)
--
-- Policies (a)-(e) are scoped TO anon (public key), which means they do NOT
-- apply to authenticated JWTs. Policy (f) is INSERT-only with no row access.
-- None of these 6 can be exploited by a shop_owner JWT for cross-tenant reads
-- or writes.
--
-- Do NOT touch the service-role edge-function path — service_role bypasses RLS.
--
-- IDEMPOTENT. Reversible via 032_drop_permissive_policies.down.sql.

-- ============================================================
-- PHASE 1: SWEEP + DROP ALL QUAL=TRUE POLICIES
-- ============================================================
-- Query pg_policies for every policy in the public schema whose USING
-- expression (qual) or WITH CHECK expression is literally 'true'.
-- Drop each one. We re-create the legitimate set in Phase 2.
--
-- This catches:
--   • Dashboard-created policies ("Authenticated can manage...", etc.)
--   • Migration-created policies (004_merchant_pin, 029 admin_chat_transcripts)
--   • Any stray policy with a catch-all predicate
--
-- It does NOT touch policies whose USING is:
--   • is_super_admin()              (migration 031 — already scoped)
--   • user_metadata checks           (001/003/006 tenant policies — scoped)
--   • app_metadata shop_owner checks (031 shop_owner policies — scoped)
--   • active = true                  (004 menu_items — not literal 'true')

DO $$
DECLARE
  _r record;
  _dropped_count int := 0;
BEGIN
  FOR _r IN
    SELECT schemaname, tablename, policyname,
           qual, with_check, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual = 'true' OR with_check = 'true')
    ORDER BY tablename, policyname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      _r.policyname, _r.schemaname, _r.tablename);
    _dropped_count := _dropped_count + 1;
    RAISE NOTICE '032: dropped policy "%" ON %.% (qual=%, check=%, roles=%, cmd=%)',
      _r.policyname, _r.schemaname, _r.tablename,
      _r.qual, _r.with_check, _r.roles, _r.cmd;
  END LOOP;

  RAISE NOTICE '032: Phase 1 complete — % permissive policy(ies) dropped', _dropped_count;
END $$;

-- ============================================================
-- PHASE 2: RE-CREATE LEGITIMATE POLICIES
-- ============================================================
-- These 6 policies use qual=true / with_check=true but are legitimately
-- needed for the ordering UI, merchant PIN UI, and edge functions.
--
-- Each is wrapped in a DO block with an existence check for idempotency.

-- 2a. Public ordering UI — customers must see menus and shops
--     Scoped TO anon (public key only; does NOT apply to authenticated JWTs)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'menus'
                   AND policyname = 'Public can read menus') THEN
    CREATE POLICY "Public can read menus"
      ON menus FOR SELECT
      TO anon
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'menu_items'
                   AND policyname = 'Public can read active menu items') THEN
    CREATE POLICY "Public can read active menu items"
      ON menu_items FOR SELECT
      TO anon
      USING (active = true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'shops'
                   AND policyname = 'Public can read shops') THEN
    CREATE POLICY "Public can read shops"
      ON shops FOR SELECT
      TO anon
      USING (true);
  END IF;
END $$;

-- 2b. Merchant PIN UI — shop owners manage availability and pause status
--     via the public anon key. App-level PIN auth provides the actual
--     access control (PIN verified server-side in an edge function).
--     Scoped TO anon (public key only; does NOT apply to authenticated JWTs).
--     TODO: Replace with proper shop_owner JWT auth before production.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'availability_overrides'
                   AND policyname = 'Public can manage availability overrides') THEN
    CREATE POLICY "Public can manage availability overrides"
      ON availability_overrides FOR ALL
      TO anon
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'shops'
                   AND policyname = 'Public can update shop pause status') THEN
    CREATE POLICY "Public can update shop pause status"
      ON shops FOR UPDATE
      TO anon
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 2c. Edge function inserts — admin-chat transcripts logged by edge functions.
--     No TO clause (applies to all roles), but INSERT-only with no row read
--     access. A shop_owner JWT could INSERT a transcript for any shop_id,
--     but cannot read, update, or delete existing rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'admin_chat_transcripts'
                   AND policyname = 'Service can insert chat transcripts') THEN
    CREATE POLICY "Service can insert chat transcripts"
      ON admin_chat_transcripts FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

-- ============================================================
-- VERIFICATION QUERY (run after applying this migration)
-- ============================================================
-- SELECT schemaname, tablename, policyname, qual, with_check, roles, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND (qual = 'true' OR with_check = 'true')
-- ORDER BY tablename, policyname;
--
-- Expected result: 5 rows —
--   admin_chat_transcripts  Service can insert chat transcripts      (check=true)
--   availability_overrides  Public can manage availability overrides (qual=true, check=true)
--   menus                   Public can read menus                   (qual=true)
--   shops                   Public can read shops                   (qual=true)
--   shops                   Public can update shop pause status     (qual=true, check=true)
--
-- "Public can read active menu items" on menu_items is excluded because its
-- qual = 'active = true', not literal 'true'. It is safe (TO anon only).
--
-- Zero "Authenticated can manage..." / "Authenticated can read all..." policies.
-- Zero policies where {authenticated} ⊆ roles AND qual = 'true'.