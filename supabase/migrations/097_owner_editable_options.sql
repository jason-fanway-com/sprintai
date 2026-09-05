-- 097: Owner-editable option groups/choices — owner_edited protection + INSERT/DELETE RLS
--
-- Shop owners can currently SELECT and UPDATE option_groups/option_choices (033) but have
-- no INSERT or DELETE policy, so adding a new option group (e.g. wing flavors) or removing
-- a stale choice fails against RLS today. Also: option rows have no owner_edited flag, so
-- import-menu-csv unconditionally deletes/rebuilds "stale" groups and overwrites existing
-- ones on every re-import, destroying anything the owner hand-added or hand-edited.

-- ============================================================
-- owner_edited columns
-- ============================================================
ALTER TABLE option_groups  ADD COLUMN IF NOT EXISTS owner_edited BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE option_choices ADD COLUMN IF NOT EXISTS owner_edited BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- option_groups — INSERT + DELETE (mirrors the existing SELECT/UPDATE tenant predicate
-- from migration 033 exactly; do not widen it)
-- ============================================================
DROP POLICY IF EXISTS "Shop owners can insert their own option_groups" ON option_groups;
CREATE POLICY "Shop owners can insert their own option_groups" ON option_groups FOR INSERT
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_item_id IN (SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can delete their own option_groups" ON option_groups;
CREATE POLICY "Shop owners can delete their own option_groups" ON option_groups FOR DELETE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND menu_item_id IN (SELECT mi.id FROM menu_items mi
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

-- ============================================================
-- option_choices — INSERT + DELETE (mirrors the existing SELECT/UPDATE tenant predicate
-- from migration 033 exactly; do not widen it)
-- ============================================================
DROP POLICY IF EXISTS "Shop owners can insert their own option_choices" ON option_choices;
CREATE POLICY "Shop owners can insert their own option_choices" ON option_choices FOR INSERT
  WITH CHECK (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND option_group_id IN (SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id=og.menu_item_id
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));

DROP POLICY IF EXISTS "Shop owners can delete their own option_choices" ON option_choices;
CREATE POLICY "Shop owners can delete their own option_choices" ON option_choices FOR DELETE
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','')='shop_owner'
    AND option_group_id IN (SELECT og.id FROM option_groups og
      JOIN menu_items mi ON mi.id=og.menu_item_id
      JOIN menus m ON m.id=mi.menu_id JOIN shops s ON s.id=m.shop_id
      WHERE s.tenant_id::text=current_user_tenant_id()));
