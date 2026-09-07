-- Migration 117: qa_ro.option_groups / qa_ro.option_choices actually reference
-- qa_ro.visible_shop_ids() instead of duplicating its filter inline.
--
-- Migration 116 added Zio's to visible_shop_ids(), but qa_ro.option_groups
-- and qa_ro.option_choices had their OWN independent copy of the old filter
-- baked directly into the view definition (WHERE shops.is_test = true OR
-- shops.slug = ANY (...)) rather than calling the function -- so updating
-- the function had zero effect on these two views. That's the second half
-- of 2026-09-07's qa_ro visibility incident: fixing 116 alone left these
-- two views still blind to Zio's, discovered when Jason's exact proof query
-- (select ... from qa_ro.option_groups where id = '<a real just-written
-- row>') returned 0 rows even though visible_shop_ids() itself correctly
-- included Zio's by then.
--
-- Root cause of the whole incident: one filter, copy-pasted into multiple
-- view definitions instead of centralized in visible_shop_ids(). This
-- migration removes the duplication for these two views. See RUNBOOK.md's
-- qa_ro scoping section for the full inventory of which views still have
-- their own inline copy vs which now reference the function.
CREATE OR REPLACE VIEW qa_ro.option_groups AS
SELECT og.id,
    og.menu_item_id,
    mi.menu_id,
    m.shop_id,
    og.name,
    og.required,
    og.min_select,
    og.max_select,
    og.display_order,
    og.owner_edited,
    og.import_key
   FROM option_groups og
     JOIN menu_items mi ON mi.id = og.menu_item_id
     JOIN menus m ON m.id = mi.menu_id
  WHERE m.shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

CREATE OR REPLACE VIEW qa_ro.option_choices AS
SELECT oc.id,
    oc.option_group_id,
    og.menu_item_id,
    m.shop_id,
    oc.name,
    oc.price_cents,
    oc.display_order,
    oc.owner_edited,
    oc.import_key
   FROM option_choices oc
     JOIN option_groups og ON og.id = oc.option_group_id
     JOIN menu_items mi ON mi.id = og.menu_item_id
     JOIN menus m ON m.id = mi.menu_id
  WHERE m.shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());
