-- 035: Final fix — public policies and tenant_id fallback hardening

-- 1. FORCE-RECREATE public policies (034 may conflict with stale 031/032 remnants)
-- Drop ALL public-facing policies on shops/menu_items/availability_overrides,
-- then recreate with clean names.
DROP POLICY IF EXISTS "Public can read shops" ON shops;
DROP POLICY IF EXISTS "Public can read menus" ON menus;
DROP POLICY IF EXISTS "Public can read active menu items" ON menu_items;
DROP POLICY IF EXISTS "Public can manage availability overrides" ON availability_overrides;
-- Drop any stale variants
DROP POLICY IF EXISTS "Public can read menus" ON menus;
DROP POLICY IF EXISTS "Public can read active menu items" ON menu_items;

-- Recreate
CREATE POLICY "Public can read shops" ON shops FOR SELECT TO anon USING (true);
CREATE POLICY "Public can read menus" ON menus FOR SELECT TO anon USING (true);
CREATE POLICY "Public can read active menu items" ON menu_items FOR SELECT TO anon USING (active = true);
CREATE POLICY "Public can manage availability overrides" ON availability_overrides
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2. Tighten current_user_tenant_id() — remove user_metadata fallback
--    This closes the forged user_metadata.tenant_id bypass.
--    After all users have app_metadata set (via set-app-metadata edge function),
--    the user_metadata fallback is no longer needed.
--    Keeping the fallback for is_super_admin for now since Jason may not have
--    app_metadata set yet.
CREATE OR REPLACE FUNCTION public.current_user_tenant_id()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN auth.jwt()->'app_metadata'->>'tenant_id';
END;
$$;

-- 3. Re-declare is_super_admin — keep user_metadata fallback for Jason transition
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

-- 4. Re-declare is_shop_owner_for  
CREATE OR REPLACE FUNCTION public.is_shop_owner_for(target_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN COALESCE(auth.jwt()->'app_metadata'->>'role', '') = 'shop_owner'
    AND target_tenant_id::text = current_user_tenant_id();
END;
$$;