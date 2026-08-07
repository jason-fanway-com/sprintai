-- 041: Lock ops tables — outbound_queue + number_provision_log
-- 
-- PROBLEM
-- -------
-- outbound_queue and number_provision_log had NO RLS. Anon key could read,
-- insert, and delete rows. outbound_queue contains real customer phone numbers
-- and SMS message bodies. number_provision_log contains Twilio phone numbers
-- and SIDs.
--
-- THE FIX
-- -------
-- 1. ENABLE ROW LEVEL SECURITY on both tables (FORCE to block the table owner
--    bypass, matching existing repo convention).
-- 2. REVOKE all privileges from anon and authenticated roles on both tables.
-- 3. NO permissive policies — these are server-only tables. Edge functions use
--    the service role which bypasses RLS entirely.
--
-- IDEMPOTENT. No down migration needed (reverting would re-expose PII).

-- ============================================================
-- PHASE 1: outbound_queue
-- ============================================================

ALTER TABLE outbound_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_queue FORCE ROW LEVEL SECURITY;

REVOKE ALL ON outbound_queue FROM anon;
REVOKE ALL ON outbound_queue FROM authenticated;

-- Drop any existing policies on outbound_queue (in case any were
-- auto-created or added by other migrations)
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outbound_queue'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON outbound_queue', _r.policyname);
    RAISE NOTICE '041: dropped policy "%" ON outbound_queue', _r.policyname;
  END LOOP;
END $$;

-- ============================================================
-- PHASE 2: number_provision_log
-- ============================================================

ALTER TABLE number_provision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_provision_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON number_provision_log FROM anon;
REVOKE ALL ON number_provision_log FROM authenticated;

-- Drop any existing policies on number_provision_log
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'number_provision_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON number_provision_log', _r.policyname);
    RAISE NOTICE '041: dropped policy "%" ON number_provision_log', _r.policyname;
  END LOOP;
END $$;

-- ============================================================
-- VERIFICATION QUERY (run after applying this migration)
-- ============================================================
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('outbound_queue', 'number_provision_log');
--
-- Expected result:
--   outbound_queue         | t
--   number_provision_log   | t
--
-- SELECT tablename, count(*) AS policy_count
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('outbound_queue', 'number_provision_log')
-- GROUP BY tablename;
--
-- Expected result: 0 rows (no policies on either table).