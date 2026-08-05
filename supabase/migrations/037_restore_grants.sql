-- 037: Restore base grants for anon/authenticated roles
-- Migration 036's hard policy drop may have disrupted schema grants.
-- Error 42501 means the role doesn't even have SELECT privilege — not an RLS issue.

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Grant SELECT on all tables in public schema
DO $$
DECLARE
  _tbl text;
BEGIN
  FOR _tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.%I TO anon, authenticated', 'public', _tbl);
  END LOOP;
END $$;

-- Grant INSERT/UPDATE/DELETE where PUBLIC access is needed
GRANT INSERT, UPDATE, DELETE ON TABLE availability_overrides TO anon;

-- Grant full DML to authenticated (still gated by RLS)
DO $$
DECLARE
  _tbl text;
BEGIN
  FOR _tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE %I.%I TO authenticated', 'public', _tbl);
  END LOOP;
END $$;

-- Verify
SELECT tablename, tableowner 
FROM pg_tables 
WHERE schemaname = 'public' AND tablename IN ('shops','menus','menu_items','availability_overrides');