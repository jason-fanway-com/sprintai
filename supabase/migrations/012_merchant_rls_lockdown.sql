-- SprintAI Ordering Platform — Merchant RLS Lockdown (security fix)
-- Run after 011_onboarding.sql.
--
-- PURPOSE
-- -------
-- Close the open anon read/write hole created by 004_merchant_pin.sql. That
-- migration added three wide-open `anon` policies that let anyone holding the
-- public anon key (a) read shops.merchant_pin, and (b) mutate
-- availability_overrides and shops.is_paused for ANY shop, with no PIN check.
--
-- WHAT THIS DOES
-- --------------
--   1. Drops the three wide-open anon policies from 004.
--   2. Revokes anon table privileges on `shops` and `availability_overrides`
--      (defense in depth: even a future accidental permissive policy can't
--      expose these to anon).
--   3. Leaves the merchant write/read path to the `merchant-auth` edge function
--      (service-role, server-side PIN verification). The diner bot (chat-sms),
--      the wizard (onboarding-save), and every other edge function already use
--      the service-role key and BYPASS RLS — they are unaffected. The admin
--      dashboard uses an authenticated admin JWT and is satisfied by the
--      pre-existing 003/005 policies — also unaffected.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ----------------------------------
--   - Does NOT drop tables, columns, or data. Additive/reversible in spirit.
--   - Does NOT touch the anon read policies on `menus` / `menu_items`
--     (non-sensitive menu data; out of scope — see SECURITY-012 inventory).
--   - Does NOT build user accounts or the SprintAdmin console (future spec).
--
-- ROLLBACK / DOWN
-- ---------------
-- This migration is intentionally NOT auto-reversed (rolling back would
-- re-open the security hole). To restore the OLD insecure behavior for an
-- emergency, re-run the relevant CREATE POLICY blocks from 004_merchant_pin.sql
-- and re-grant anon privileges:
--
--     GRANT SELECT, UPDATE ON shops TO anon;
--     GRANT ALL ON availability_overrides TO anon;
--     CREATE POLICY "Public can read shops" ON shops FOR SELECT TO anon USING (true);
--     CREATE POLICY "Public can update shop pause status" ON shops FOR UPDATE TO anon USING (true) WITH CHECK (true);
--     CREATE POLICY "Public can manage availability overrides" ON availability_overrides FOR ALL TO anon USING (true) WITH CHECK (true);
--
-- Do NOT do that in production. The correct path is the merchant-auth edge function.

-- ============================================================
-- 1. DROP THE WIDE-OPEN ANON POLICIES FROM 004 (idempotent)
-- ============================================================
DROP POLICY IF EXISTS "Public can read shops"                    ON shops;
DROP POLICY IF EXISTS "Public can update shop pause status"      ON shops;
DROP POLICY IF EXISTS "Public can manage availability overrides" ON availability_overrides;

-- ============================================================
-- 2. REVOKE ANON TABLE PRIVILEGES (defense in depth)
-- ------------------------------------------------------------
-- Supabase grants anon blanket DML on public tables by default; RLS gates it.
-- With the permissive policies gone, RLS already denies anon. We additionally
-- revoke the table grants so anon has no privilege path to these tables at all.
-- The diner bot, wizard, and merchant-auth all use the service-role key, which
-- is unaffected by these REVOKEs. The admin dashboard uses the `authenticated`
-- role, also unaffected.
-- ============================================================
REVOKE ALL    ON shops                  FROM anon;
REVOKE ALL    ON availability_overrides FROM anon;

-- Note: we intentionally KEEP anon SELECT on menus / menu_items (non-sensitive
-- menu data still rendered by merchant-ui). Those grants/policies are untouched.

-- ============================================================
-- 3. VERIFICATION NOTES (for QA)
-- ------------------------------------------------------------
-- After this migration, against the project DB:
--   - anon SELECT on shops              -> permission denied / 0 rows (no policy, no grant)
--   - anon UPDATE on shops              -> permission denied
--   - anon INSERT/UPDATE/DELETE on
--     availability_overrides            -> permission denied
--   - service-role reads/writes (edge
--     functions)                        -> unaffected (bypass RLS)
--   - authenticated admin JWT           -> unaffected (003/005 policies)
-- See SECURITY-012-merchant-rls-inventory.md for the full caller list and the
-- exact psql checks Melvin should run.
-- ============================================================
