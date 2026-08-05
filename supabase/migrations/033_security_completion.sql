-- 033: Security Foundation — helper functions + admin policies + shop_owner
-- tenant-scoped policies.  All idempotent (CREATE OR REPLACE / DROP IF EXISTS).

-- ============================================================
-- PART 0: HELPER FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ BEGIN RETURN COALESCE(
  auth.jwt()->'app_metadata'->>'role' = 'super_admin',
  COALESCE((auth.jwt()->'user_metadata'->>'is_admin')::boolean, false)
); END; $$;

CREATE OR REPLACE FUNCTION current_user_tenant_id()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ BEGIN
  RETURN auth.jwt()->'app_metadata'->>'tenant_id';
END; $$;

CREATE OR REPLACE FUNCTION is_shop_owner_for(target_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ BEGIN RETURN COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
  AND target_tenant_id::text = current_user_tenant_id(); END; $$;

-- ============================================================
-- PART 1: SHOP INSERT HOLE (migration-005)
-- ============================================================
DROP POLICY IF EXISTS "Super admins can insert shops" ON shops;
CREATE POLICY "Super admins can insert shops" ON shops FOR INSERT
  WITH CHECK (is_super_admin());

-- ============================================================
-- PART 2: ADMIN POLICIES — DROP OLD, CREATE WITH is_super_admin()
-- ============================================================

-- tenants
DROP POLICY IF EXISTS "Admins have full access to tenants" ON tenants;
CREATE POLICY "Admins have full access to tenants" ON tenants FOR ALL USING (is_super_admin());

-- knowledge_base
DROP POLICY IF EXISTS "Admins have full access to knowledge_base" ON knowledge_base;
CREATE POLICY "Admins have full access to knowledge_base" ON knowledge_base FOR ALL USING (is_super_admin());

-- conversations
DROP POLICY IF EXISTS "Admins have full access to conversations" ON conversations;
CREATE POLICY "Admins have full access to conversations" ON conversations FOR ALL USING (is_super_admin());

-- messages
DROP POLICY IF EXISTS "Admins have full access to messages" ON messages;
CREATE POLICY "Admins have full access to messages" ON messages FOR ALL USING (is_super_admin());

-- integrations
DROP POLICY IF EXISTS "Admins have full access to integrations" ON integrations;
CREATE POLICY "Admins have full access to integrations" ON integrations FOR ALL USING (is_super_admin());

-- orders
DROP POLICY IF EXISTS "Admins have full access to orders" ON orders;
CREATE POLICY "Admins have full access to orders" ON orders FOR ALL USING (is_super_admin());

-- usage_events
DROP POLICY IF EXISTS "Admins have full access to usage_events" ON usage_events;
CREATE POLICY "Admins have full access to usage_events" ON usage_events FOR ALL USING (is_super_admin());

-- shops
DROP POLICY IF EXISTS "Admins have full access to shops" ON shops;
CREATE POLICY "Admins have full access to shops" ON shops FOR ALL USING (is_super_admin());

-- menus
DROP POLICY IF EXISTS "Admins have full access to menus" ON menus;
CREATE POLICY "Admins have full access to menus" ON menus FOR ALL USING (is_super_admin());

-- menu_items
DROP POLICY IF EXISTS "Admins have full access to menu_items" ON menu_items;
CREATE POLICY "Admins have full access to menu_items" ON menu_items FOR ALL USING (is_super_admin());

-- availability_overrides
DROP POLICY IF EXISTS "Admins have full access to availability_overrides" ON availability_overrides;
CREATE POLICY "Admins have full access to availability_overrides" ON availability_overrides FOR ALL USING (is_super_admin());

-- order_carts
DROP POLICY IF EXISTS "Admins have full access to order_carts" ON order_carts;
CREATE POLICY "Admins have full access to order_carts" ON order_carts FOR ALL USING (is_super_admin());

-- audit_log
DROP POLICY IF EXISTS "Admins have full access to audit_log" ON audit_log;
CREATE POLICY "Admins have full access to audit_log" ON audit_log FOR ALL USING (is_super_admin());

-- option_groups
DROP POLICY IF EXISTS "Admins have full access to option_groups" ON option_groups;
CREATE POLICY "Admins have full access to option_groups" ON option_groups FOR ALL USING (is_super_admin());

-- option_choices
DROP POLICY IF EXISTS "Admins have full access to option_choices" ON option_choices;
CREATE POLICY "Admins have full access to option_choices" ON option_choices FOR ALL USING (is_super_admin());

-- conversation_evals
DROP POLICY IF EXISTS "Admins have full access to conversation_evals" ON conversation_evals;
CREATE POLICY "Admins have full access to conversation_evals" ON conversation_evals FOR ALL USING (is_super_admin());

-- program_items
DROP POLICY IF EXISTS "Admins have full access to program_items" ON program_items;
CREATE POLICY "Admins have full access to program_items" ON program_items FOR ALL USING (is_super_admin());

-- program_* tables
DO $$
DECLARE _tbl text;
BEGIN FOREACH _tbl IN ARRAY ARRAY[
  'program_epics','program_tasks','program_milestones','program_launch_path',
  'program_risks','program_decisions','program_compliance','program_team',
  'program_activity','program_series_a','program_meta'
] LOOP
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Admins have full access to '||_tbl, _tbl);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (is_super_admin())',
    'Admins have full access to '||_tbl, _tbl);
END LOOP; END $$;

-- specials
DROP POLICY IF EXISTS "Admins have full access to specials" ON specials;
CREATE POLICY "Admins have full access to specials" ON specials FOR ALL USING (is_super_admin());

-- admin_action_log
DROP POLICY IF EXISTS "Admins have full access to admin_action_log" ON admin_action_log;
CREATE POLICY "Admins have full access to admin_action_log" ON admin_action_log FOR ALL USING (is_super_admin());

-- admin_chat_transcripts
DROP POLICY IF EXISTS "Admins have full access to admin_chat_transcripts" ON admin_chat_transcripts;
CREATE POLICY "Admins have full access to admin_chat_transcripts" ON admin_chat_transcripts FOR ALL USING (is_super_admin());

-- issues
DROP POLICY IF EXISTS "Admins have full access to issues" ON issues;
CREATE POLICY "Admins have full access to issues" ON issues FOR ALL USING (is_super_admin());

-- resolution_log
DROP POLICY IF EXISTS "Admins have full access to resolution_log" ON resolution_log;
CREATE POLICY "Admins have full access to resolution_log" ON resolution_log FOR ALL USING (is_super_admin());

-- ============================================================
-- PART 3: SHOP_OWNER TENANT-SCOPED POLICIES
-- ============================================================

-- tenants
DROP POLICY IF EXISTS "Shop owners can view their own tenant" ON tenants;
CREATE POLICY "Shop owners can view their own tenant" ON tenants FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND id::text = current_user_tenant_id());

-- knowledge_base
DROP POLICY IF EXISTS "Shop owners can view their own knowledge_base" ON knowledge_base;
CREATE POLICY "Shop owners can view their own knowledge_base" ON knowledge_base FOR SELECT
  USING (is_shop_owner_for(tenant_id));

-- conversations
DROP POLICY IF EXISTS "Shop owners can view their own conversations" ON conversations;
CREATE POLICY "Shop owners can view their own conversations" ON conversations FOR SELECT
  USING (is_shop_owner_for(tenant_id));

-- messages
DROP POLICY IF EXISTS "Shop owners can view their own messages" ON messages;
CREATE POLICY "Shop owners can view their own messages" ON messages FOR SELECT
  USING (is_shop_owner_for(tenant_id));

-- orders
DROP POLICY IF EXISTS "Shop owners can view their own orders" ON orders;
CREATE POLICY "Shop owners can view their own orders" ON orders FOR SELECT
  USING (is_shop_owner_for(tenant_id));

-- shops — SELECT + UPDATE
DROP POLICY IF EXISTS "Shop owners can view their own shops" ON shops;
CREATE POLICY "Shop owners can view their own shops" ON shops FOR SELECT
  USING (is_shop_owner_for(tenant_id));

DROP POLICY IF EXISTS "Shop owners can update their own shops" ON shops;
CREATE POLICY "Shop owners can update their own shops" ON shops FOR UPDATE
  USING (is_shop_owner_for(tenant_id)) WITH CHECK (is_shop_owner_for(tenant_id));

-- menus — SELECT + UPDATE
DROP POLICY IF EXISTS "Shop owners can view their own menus" ON menus;
CREATE POLICY "Shop owners can view their own menus" ON menus FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can update their own menus" ON menus;
CREATE POLICY "Shop owners can update their own menus" ON menus FOR UPDATE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- menu_items — SELECT + UPDATE
DROP POLICY IF EXISTS "Shop owners can view their own menu_items" ON menu_items;
CREATE POLICY "Shop owners can view their own menu_items" ON menu_items FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_id IN (SELECT m.id FROM menus m
      JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can update their own menu_items" ON menu_items;
CREATE POLICY "Shop owners can update their own menu_items" ON menu_items FOR UPDATE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_id IN (SELECT m.id FROM menus m
      JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_id IN (SELECT m.id FROM menus m
      JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

-- availability_overrides — SELECT + INSERT + DELETE
DROP POLICY IF EXISTS "Shop owners can view their own availability_overrides" ON availability_overrides;
CREATE POLICY "Shop owners can view their own availability_overrides" ON availability_overrides FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can insert their own availability_overrides" ON availability_overrides;
CREATE POLICY "Shop owners can insert their own availability_overrides" ON availability_overrides FOR INSERT
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can delete their own availability_overrides" ON availability_overrides;
CREATE POLICY "Shop owners can delete their own availability_overrides" ON availability_overrides FOR DELETE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- order_carts
DROP POLICY IF EXISTS "Shop owners can view their own order_carts" ON order_carts;
CREATE POLICY "Shop owners can view their own order_carts" ON order_carts FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- option_groups — SELECT + UPDATE (via menu_items)
DROP POLICY IF EXISTS "Shop owners can view their own option_groups" ON option_groups;
CREATE POLICY "Shop owners can view their own option_groups" ON option_groups FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_item_id IN (SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can update their own option_groups" ON option_groups;
CREATE POLICY "Shop owners can update their own option_groups" ON option_groups FOR UPDATE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_item_id IN (SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_item_id IN (SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

-- option_choices — SELECT + UPDATE (via option_groups)
DROP POLICY IF EXISTS "Shop owners can view their own option_choices" ON option_choices;
CREATE POLICY "Shop owners can view their own option_choices" ON option_choices FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND option_group_id IN (SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id=og.menu_item_id
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can update their own option_choices" ON option_choices;
CREATE POLICY "Shop owners can update their own option_choices" ON option_choices FOR UPDATE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND option_group_id IN (SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id=og.menu_item_id
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND option_group_id IN (SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id=og.menu_item_id
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

-- specials — SELECT + INSERT + UPDATE + DELETE
DROP POLICY IF EXISTS "Shop owners can view their own specials" ON specials;
CREATE POLICY "Shop owners can view their own specials" ON specials FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can insert their own specials" ON specials;
CREATE POLICY "Shop owners can insert their own specials" ON specials FOR INSERT
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can update their own specials" ON specials;
CREATE POLICY "Shop owners can update their own specials" ON specials FOR UPDATE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can delete their own specials" ON specials;
CREATE POLICY "Shop owners can delete their own specials" ON specials FOR DELETE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- admin_action_log — SELECT + INSERT
DROP POLICY IF EXISTS "Shop owners can view their own action log" ON admin_action_log;
CREATE POLICY "Shop owners can view their own action log" ON admin_action_log FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can insert their own action log" ON admin_action_log;
CREATE POLICY "Shop owners can insert their own action log" ON admin_action_log FOR INSERT
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- admin_chat_transcripts
DROP POLICY IF EXISTS "Shop owners can view their own chat transcripts" ON admin_chat_transcripts;
CREATE POLICY "Shop owners can view their own chat transcripts" ON admin_chat_transcripts FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text=current_user_tenant_id()));

-- conversation_evals
DROP POLICY IF EXISTS "Shop owners can view their own conversation_evals" ON conversation_evals;
CREATE POLICY "Shop owners can view their own conversation_evals" ON conversation_evals FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND conversation_id IN (SELECT id FROM conversations
      WHERE tenant_id::text=current_user_tenant_id()));

-- issues
DROP POLICY IF EXISTS "Shop owners can view their own issues" ON issues;
CREATE POLICY "Shop owners can view their own issues" ON issues FOR SELECT
  USING (is_shop_owner_for(tenant_id));

-- resolution_log
DROP POLICY IF EXISTS "Shop owners can view their own resolution_log" ON resolution_log;
CREATE POLICY "Shop owners can view their own resolution_log" ON resolution_log FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND issue_id IN (SELECT id FROM issues WHERE tenant_id::text=current_user_tenant_id()));