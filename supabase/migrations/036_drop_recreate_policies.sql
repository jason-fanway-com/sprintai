-- 036: Hard policy rebuild — drop all tenant-scoped policies then recreate

-- ============ DIAGNOSTIC: list current policies ============
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN SELECT tablename, policyname, roles FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN
    ('tenants','shops','menus','menu_items','availability_overrides')
    ORDER BY tablename, policyname
  LOOP
    RAISE NOTICE '036-DIAG: table=% policy=% roles=%',
      _r.tablename, _r.policyname, COALESCE(_r.roles::text, 'NULL');
  END LOOP;
END $$;

-- ============ DROP ALL POLICIES on target tables ============
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN
    ('tenants','shops','menus','menu_items','availability_overrides',
     'order_carts','orders','conversations','messages','conversation_evals',
     'issues','resolution_log','admin_chat_transcripts')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', _r.policyname, 'public', _r.tablename);
  END LOOP;
  RAISE NOTICE '036: All policies dropped';
END $$;

-- ============ TENANTS ============
CREATE POLICY "Super admins have full access to tenants" ON tenants FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own tenant" ON tenants FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND id::text = current_user_tenant_id());

-- ============ SHOPS ============
CREATE POLICY "Super admins can insert shops" ON shops FOR INSERT WITH CHECK (is_super_admin());
CREATE POLICY "Admins have full access to shops" ON shops FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own shops" ON shops FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND tenant_id::text = current_user_tenant_id());
CREATE POLICY "Shop owners can update their own shops" ON shops FOR UPDATE
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND tenant_id::text = current_user_tenant_id())
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND tenant_id::text = current_user_tenant_id());
CREATE POLICY "Public can read shops" ON shops FOR SELECT TO anon USING (true);

-- ============ MENUS ============
CREATE POLICY "Admins have full access to menus" ON menus FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own menus" ON menus FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));
CREATE POLICY "Shop owners can update their own menus" ON menus FOR UPDATE
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));
CREATE POLICY "Public can read menus" ON menus FOR SELECT TO anon USING (true);

-- ============ MENU_ITEMS ============
CREATE POLICY "Admins have full access to menu_items" ON menu_items FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own menu_items" ON menu_items FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND menu_id IN (
      SELECT m.id FROM menus m
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = current_user_tenant_id()
    ));
CREATE POLICY "Shop owners can update their own menu_items" ON menu_items FOR UPDATE
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND menu_id IN (
      SELECT m.id FROM menus m
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = current_user_tenant_id()
    ))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND menu_id IN (
      SELECT m.id FROM menus m
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = current_user_tenant_id()
    ));
CREATE POLICY "Public can read active menu items" ON menu_items FOR SELECT TO anon USING (active = true);

-- ============ AVAILABILITY_OVERRIDES ============
CREATE POLICY "Admins have full access to availability_overrides" ON availability_overrides FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own availability_overrides" ON availability_overrides FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));
CREATE POLICY "Shop owners can insert their own availability_overrides" ON availability_overrides FOR INSERT
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));
CREATE POLICY "Shop owners can delete their own availability_overrides" ON availability_overrides FOR DELETE
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));
CREATE POLICY "Public can manage availability overrides" ON availability_overrides FOR ALL TO anon USING (true) WITH CHECK (true);

-- ============ REMAINING TABLES ============
CREATE POLICY "Admins have full access to order_carts" ON order_carts FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own order_carts" ON order_carts FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));

CREATE POLICY "Admins have full access to orders" ON orders FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own orders" ON orders FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND tenant_id::text = current_user_tenant_id());

CREATE POLICY "Admins have full access to conversations" ON conversations FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own conversations" ON conversations FOR SELECT
  USING (is_shop_owner_for(tenant_id));

CREATE POLICY "Admins have full access to messages" ON messages FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own messages" ON messages FOR SELECT
  USING (is_shop_owner_for(tenant_id));

CREATE POLICY "Admins have full access to conversation_evals" ON conversation_evals FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own conversation_evals" ON conversation_evals FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND conversation_id IN (
      SELECT id FROM conversations WHERE tenant_id::text = current_user_tenant_id()
    ));

CREATE POLICY "Admins have full access to issues" ON issues FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own issues" ON issues FOR SELECT
  USING (is_shop_owner_for(tenant_id));

CREATE POLICY "Admins have full access to resolution_log" ON resolution_log FOR ALL USING (is_super_admin());
CREATE POLICY "Shop owners can view their own resolution_log" ON resolution_log FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND issue_id IN (
      SELECT id FROM issues WHERE tenant_id::text = current_user_tenant_id()
    ));

CREATE POLICY "Admins have full access to admin_chat_transcripts" ON admin_chat_transcripts FOR ALL USING (is_super_admin());
CREATE POLICY "Service can insert chat transcripts" ON admin_chat_transcripts FOR INSERT WITH CHECK (true);
CREATE POLICY "Shop owners can view their own chat transcripts" ON admin_chat_transcripts FOR SELECT
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND shop_id IN (SELECT id FROM shops WHERE tenant_id::text = current_user_tenant_id()));

-- ============ VERIFY ============
DO $$
DECLARE
  _r record;
BEGIN
  FOR _r IN SELECT tablename, policyname, roles FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN
    ('tenants','shops','menus','menu_items','availability_overrides')
    ORDER BY tablename, policyname
  LOOP
    RAISE NOTICE '036-RESULT: table=% policy=% roles=%',
      _r.tablename, _r.policyname, COALESCE(_r.roles::text, 'NULL');
  END LOOP;
END $$;