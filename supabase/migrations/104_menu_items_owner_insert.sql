-- 104: Shop owners can insert their own menu_items (ADD_ITEM in the Menu & Settings editor)
--
-- Shop owners have SELECT + UPDATE on menu_items (036) but no INSERT policy, so the new
-- ADD_ITEM operation (admin-chat) fails with "new row violates row-level security policy"
-- even though the owner is inserting into their own shop's menu. Mirrors the existing
-- UPDATE predicate from 036 exactly; do not widen it.

CREATE POLICY "Shop owners can insert their own menu_items" ON menu_items FOR INSERT
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'shop_owner'
    AND menu_id IN (
      SELECT m.id FROM menus m
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = current_user_tenant_id()
    ));
