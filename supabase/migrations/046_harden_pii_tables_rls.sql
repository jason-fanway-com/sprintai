-- 046: Harden PII tables RLS — outbound_queue, number_provision_log, admin_chat_transcripts
--
-- PROBLEM
-- -------
-- Security scan found three live PII/data-leak surfaces:
--   1. outbound_queue       — customer phone numbers + SMS bodies; auth'd read = cross-tenant PII leak
--   2. number_provision_log — Twilio numbers + SIDs; auth'd read = provisioning data leak
--   3. admin_chat_transcripts — RLS on, but INSERT policy ("Service can insert chat transcripts")
--      uses WITH CHECK (true), allowing ANY authenticated user to inject transcripts.
--
-- NOTE: Migration 041 already ENABLED RLS + revoked anon/authenticated on outbound_queue and
-- number_provision_log. This migration is IDEMPOTENT — it reinforces those locks and adds the
-- admin_chat_transcripts INSERT fix. Edge functions write these tables using the SERVICE_ROLE
-- key, which BYPASSES RLS entirely — no production code is affected.
--
-- THE FIX
-- -------
--   Phase 1 (idempotent): ENABLE + FORCE RLS on outbound_queue and number_provision_log.
--     REVOKE ALL from anon/authenticated. Drop any residual policies.
--   Phase 2: Tighten admin_chat_transcripts INSERT to require is_super_admin() or service_role.
--     (service_role bypasses RLS unconditionally; the policy gate covers user-JWT inserts only.)
--     Existing SELECT policies for super_admin and shop_owner are left intact — the admin
--     dashboard (ShopChatTranscripts, ShopChatDetail) uses user JWTs and needs these.
--
-- CODE SURFACES CHECKED:
--   - chat-sms/index.ts:1611     → writes outbound_queue via service_role  ✅ unaffected
--   - provision-number/index.ts  → reads/writes number_provision_log via service_role ✅ unaffected
--   - admin-chat/index.ts:736    → inserts admin_chat_transcripts via service_role ✅ unaffected
--   - admin-dashboard ShopChatTranscripts.tsx:68  → SELECT admin_chat_transcripts via user JWT ✅
--     (covered by existing "Admins have full access" / "Shop owners can view" policies)
--   - admin-dashboard ShopChatDetail.tsx:83      → SELECT admin_chat_transcripts via user JWT ✅
--     (same existing policies cover this)
--   - admin-dashboard: no reads of outbound_queue or number_provision_log ✅
--
-- IDEMPOTENT. No down migration needed (reverting would re-expose PII).

-- ============================================================
-- PHASE 1: outbound_queue (idempotent — reinforces 041)
-- ============================================================

ALTER TABLE outbound_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_queue FORCE ROW LEVEL SECURITY;

REVOKE ALL ON outbound_queue FROM anon;
REVOKE ALL ON outbound_queue FROM authenticated;

-- Drop any policies that may have been (re)created on outbound_queue
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outbound_queue'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON outbound_queue', _r.policyname);
    RAISE NOTICE '046: dropped policy "%" ON outbound_queue', _r.policyname;
  END LOOP;
END $$;

-- ============================================================
-- PHASE 2: number_provision_log (idempotent — reinforces 041)
-- ============================================================

ALTER TABLE number_provision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_provision_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON number_provision_log FROM anon;
REVOKE ALL ON number_provision_log FROM authenticated;

-- Drop any policies that may have been (re)created on number_provision_log
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'number_provision_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON number_provision_log', _r.policyname);
    RAISE NOTICE '046: dropped policy "%" ON number_provision_log', _r.policyname;
  END LOOP;
END $$;

-- ============================================================
-- PHASE 3: admin_chat_transcripts — tighten permissive INSERT
-- ============================================================
-- RLS was enabled by migration 029. FORCE is set here for consistency.

ALTER TABLE admin_chat_transcripts FORCE ROW LEVEL SECURITY;

-- Drop the permissive INSERT policy (from 036) that allows ANY authenticated user to insert
DROP POLICY IF EXISTS "Service can insert chat transcripts" ON admin_chat_transcripts;

-- Replace with a policy gated on is_super_admin().
-- The admin-chat edge function INSERTs via service_role (bypasses RLS), so this
-- policy only gates user-JWT-based inserts — which should be super_admin only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'admin_chat_transcripts'
      AND policyname = 'Only super admins can insert chat transcripts'
  ) THEN
    CREATE POLICY "Only super admins can insert chat transcripts"
      ON admin_chat_transcripts FOR INSERT
      TO authenticated
      WITH CHECK (is_super_admin());
  END IF;
END $$;

-- Existing policies LEFT INTACT:
--   "Admins have full access to admin_chat_transcripts" — FOR ALL USING (is_super_admin())
--   "Shop owners can view their own chat transcripts" — FOR SELECT, tenant-scoped
-- These cover the admin dashboard's read path (ShopChatTranscripts, ShopChatDetail).

-- ============================================================
-- VERIFICATION QUERIES (run after applying this migration)
-- ============================================================

-- 1. Confirm RLS is on for all three tables:
-- SELECT tablename, rowsecurity, force_rls
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('outbound_queue', 'number_provision_log', 'admin_chat_transcripts');
--
-- Expected: all three have rowsecurity = t, force_rls = t

-- 2. Confirm no permissive policies remain on outbound_queue or number_provision_log:
-- SELECT tablename, count(*) AS policy_count
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('outbound_queue', 'number_provision_log')
-- GROUP BY tablename;
--
-- Expected: 0 rows

-- 3. Confirm admin_chat_transcripts INSERT is gated:
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename = 'admin_chat_transcripts';
--
-- Expected: "Only super admins can insert chat transcripts" for INSERT,
--           no "Service can insert..." policy