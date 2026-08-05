-- 034: Fix tenant isolation — ensure is_shop_owner_for function and public
-- policies are present.  These were lost during the 031–033 deployment cycle.

-- 1. ENSURE is_shop_owner_for EXISTS
CREATE OR REPLACE FUNCTION public.is_shop_owner_for(target_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN COALESCE(auth.jwt()->'app_metadata'->>'role', '') = 'shop_owner'
    AND target_tenant_id::text = current_user_tenant_id();
END;
$$;

-- 2. RESTORE PUBLIC-FACING POLICIES (lost when 032 dropped qual=true policies)
-- Public ordering UI: menus (confirmed working via anon)
DROP POLICY IF EXISTS "Public can read shops" ON shops;
CREATE POLICY "Public can read shops" ON shops FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public can read active menu items" ON menu_items;
CREATE POLICY "Public can read active menu items" ON menu_items FOR SELECT
  TO anon USING (active = true);

DROP POLICY IF EXISTS "Public can manage availability overrides" ON availability_overrides;
CREATE POLICY "Public can manage availability overrides" ON availability_overrides
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 3. ENSURE is_super_admin + current_user_tenant_id have public schema set
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN COALESCE(
    auth.jwt()->'app_metadata'->>'role' = 'super_admin',
    COALESCE((auth.jwt()->'user_metadata'->>'is_admin')::boolean, false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_tenant_id()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN COALESCE(
    auth.jwt()->'app_metadata'->>'tenant_id',
    auth.jwt()->'user_metadata'->>'tenant_id'
  );
END;
$$;