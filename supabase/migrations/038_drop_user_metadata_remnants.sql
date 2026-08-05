-- 038: Drop remaining user_metadata-based "Tenants can..." policies
-- Migration 036's DROP ALL loop targeted 13 tables but missed:
--   admin_action_log, knowledge_base, option_choices, option_groups, specials
-- These tables had legacy "Tenants can..." policies referencing
-- auth.jwt() -> 'user_metadata' ->> 'tenant_id' — a user-controlled field.
-- Shop owners already have properly scoped app_metadata policies on these tables.

-- admin_action_log
DROP POLICY IF EXISTS "Tenants can insert their own action log" ON admin_action_log;
DROP POLICY IF EXISTS "Tenants can view their own action log" ON admin_action_log;

-- knowledge_base
DROP POLICY IF EXISTS "Tenants can view their own knowledge_base" ON knowledge_base;

-- option_choices
DROP POLICY IF EXISTS "Tenants can view their own option_choices" ON option_choices;

-- option_groups
DROP POLICY IF EXISTS "Tenants can view their own option_groups" ON option_groups;

-- specials
DROP POLICY IF EXISTS "Tenants can delete their own specials" ON specials;
DROP POLICY IF EXISTS "Tenants can manage their own specials" ON specials;
DROP POLICY IF EXISTS "Tenants can update their own specials" ON specials;
DROP POLICY IF EXISTS "Tenants can view their own specials" ON specials;

-- Verify: zero user_metadata-based policies remain
DO $$
DECLARE
  _r record;
  _count int := 0;
BEGIN
  FOR _r IN SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual LIKE '%user_metadata%' OR with_check LIKE '%user_metadata%')
  LOOP
    _count := _count + 1;
    RAISE WARNING '038: SURVIVING user_metadata policy: %.%', _r.tablename, _r.policyname;
  END LOOP;

  IF _count > 0 THEN
    RAISE EXCEPTION '038: % user_metadata-based policies SURVIVED — this should be zero', _count;
  END IF;

  RAISE NOTICE '038: All user_metadata-based policies cleared (0 remain)';
END $$;