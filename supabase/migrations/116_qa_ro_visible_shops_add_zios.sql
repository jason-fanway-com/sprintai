-- Migration 116: add Zio's Pizzeria to qa_ro.visible_shop_ids()
--
-- Applied live 2026-09-07 (ahead of this file landing in git, via the
-- Management API SQL endpoint) after Jason's independent verification of
-- the Slice-sourced option_groups/option_choices for Zio's returned 0 rows
-- through qa_ro even though 140 groups / 889 choices genuinely existed
-- (confirmed via a direct service-role query). Root cause: Zio's is a real
-- shop (is_test = false) and wasn't in visible_shop_ids()'s allowlist, so
-- qa_ro.option_groups / qa_ro.option_choices (which ARE scoped by this
-- function) silently returned zero for it — while qa_ro.shops_all and
-- qa_ro.menu_items (which are NOT scoped by this function at all) showed
-- the shop and its items fine. That inconsistency is what made a real
-- empty-looking result look identical to a genuine bug. See RUNBOOK.md's
-- qa_ro section for the full scoping inventory across all qa_ro views.
CREATE OR REPLACE FUNCTION qa_ro.visible_shop_ids()
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT shops.id FROM shops
   WHERE shops.is_test = true
      -- Not Just Bagels: the only real restaurant onboarded before Zio's, is_test = false, and the
      -- reviewer needs to see it to qualify a launch. Retired clones do not
      -- need naming here -- retirement sets is_test = true.
      OR shops.slug = 'not-just-bagels'
      -- Zio's Pizzeria: second real design-partner shop (Phase 0, conversation-ready-menu
      -- spec, 2026-09-07), is_test = false. Added 2026-09-07 after its option_groups/
      -- option_choices were invisible to qa_ro during independent verification even
      -- though shops_all/menu_items already showed it (see RUNBOOK.md scoping note).
      OR shops.slug = 'zio-s-pizzeria';
$function$
