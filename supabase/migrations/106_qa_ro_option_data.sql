-- 106: expose option_groups / option_choices to qa_ro.
--
-- FOURTH time a read-only view has been too narrow to verify a claim (074, 082,
-- 105, now this). The reviewer could see menu_items but not the option data that
-- decides whether an item is actually ORDERABLE — so "the menu imported fine" was
-- unfalsifiable from outside. A pizza with no toppings group is not a usable menu
-- row, and nothing in qa_ro could show that.
--
-- Standing rule, restated: when a migration adds a column or table a reviewer
-- would need to check a claim, widening qa_ro is part of THAT migration.
--
-- Same row scoping as every other qa_ro view (is_test shops + the two NJB slugs),
-- reached through menu_items -> menus -> shops. No PII: these tables hold menu
-- configuration only.

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
    JOIN menus       m  ON m.id  = mi.menu_id
   WHERE m.shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         );

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
    JOIN option_groups og ON og.id  = oc.option_group_id
    JOIN menu_items    mi ON mi.id  = og.menu_item_id
    JOIN menus         m  ON m.id   = mi.menu_id
   WHERE m.shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         );

-- The view that makes the gap visible without writing a join: every active item
-- and how many option groups / choices it actually has. "0 groups" on a pizza is
-- the defect, and it should take one SELECT to see it, not a reconstruction.
CREATE OR REPLACE VIEW qa_ro.menu_item_option_coverage AS
  SELECT mi.id AS menu_item_id,
         m.shop_id,
         mi.menu_id,
         mi.name,
         mi.category,
         mi.active,
         mi.prompt_for,
         count(DISTINCT og.id) AS group_count,
         count(oc.id)          AS choice_count
    FROM menu_items mi
    JOIN menus m           ON m.id  = mi.menu_id
    LEFT JOIN option_groups og  ON og.menu_item_id = mi.id
    LEFT JOIN option_choices oc ON oc.option_group_id = og.id
   WHERE m.shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         )
   GROUP BY mi.id, m.shop_id, mi.menu_id, mi.name, mi.category, mi.active, mi.prompt_for;

GRANT USAGE ON SCHEMA qa_ro TO qa_readonly;
GRANT SELECT ON qa_ro.option_groups              TO qa_readonly;
GRANT SELECT ON qa_ro.option_choices             TO qa_readonly;
GRANT SELECT ON qa_ro.menu_item_option_coverage  TO qa_readonly;
