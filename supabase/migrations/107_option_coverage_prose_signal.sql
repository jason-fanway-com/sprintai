-- 107: menu_item_option_coverage read ZERO items needing options on a shop that
-- cannot sell a pepperoni pizza. It keyed on prompt_for alone; the pizza-topping
-- evidence lives in the upsell column ("add extra toppings; add gourmet toppings").
-- A metric that reads zero while the shop is broken is worse than no metric,
-- because someone will trust it. Replaced here.
--
-- Now: an item NEEDS options if ANY of prompt_for, description or upsell contains
-- option-implying prose, and `signal_source` names which column fired so the
-- signal is auditable rather than a black box.
--
-- READ THIS BEFORE TRUSTING THE NUMBER: on menus imported by the CURRENT importer,
-- prompt_for and upsell are NULL for every row — the importer drops both columns
-- rather than storing them. So the prose signal is blind on existing data through
-- no fault of this view, and `source_columns_present` reports that per shop.
-- Preserving prompt_for/upsell/description verbatim at import is an acceptance
-- criterion of the importer fix; this view starts telling the truth the moment it is.

DROP VIEW IF EXISTS qa_ro.menu_item_option_coverage;
CREATE VIEW qa_ro.menu_item_option_coverage AS
WITH sig AS (
  SELECT mi.id,
         m.shop_id,
         mi.menu_id,
         mi.name,
         mi.category,
         mi.active,
         mi.prompt_for,
         mi.description,
         mi.upsell,
         -- Conservative option-implying prose. Deliberately not a catch-all:
         -- every token here means "the customer picks or adds something".
         (mi.prompt_for  ~* '(choose|choice|which |pick |select |topping|dressing|flavou?r|sauce|substitut|add-?on|side)') AS s_prompt,
         (mi.description ~* '(choose|choice of|your choice|pick |select |extra topping|gourmet topping|topping|dressing|flavou?r|substitut|add-?on|comes with a choice)') AS s_desc,
         (mi.upsell      ~* '(add (extra|gourmet|a |your)|extra topping|gourmet topping|topping|dressing|flavou?r|substitut|add-?on|upgrade)') AS s_upsell
    FROM menu_items mi
    JOIN menus m ON m.id = mi.menu_id
   WHERE m.shop_id IN (
           SELECT shops.id FROM shops
            WHERE shops.is_test = true
               OR shops.slug = ANY (ARRAY['not-just-bagels'::text, 'njb-test-clone-11353'::text])
         )
)
SELECT sig.id AS menu_item_id,
       sig.shop_id,
       sig.menu_id,
       sig.name,
       sig.category,
       sig.active,
       count(DISTINCT og.id) AS group_count,
       count(oc.id)          AS choice_count,
       (sig.s_prompt OR sig.s_desc OR sig.s_upsell) AS needs_options,
       -- Which column produced the signal. NULL when nothing fired.
       NULLIF(concat_ws(',',
         CASE WHEN sig.s_prompt THEN 'prompt_for'  END,
         CASE WHEN sig.s_desc   THEN 'description' END,
         CASE WHEN sig.s_upsell THEN 'upsell'      END), '') AS signal_source,
       -- The defect this view exists to surface.
       ((sig.s_prompt OR sig.s_desc OR sig.s_upsell) AND count(DISTINCT og.id) = 0) AS gap,
       -- Honesty about blindness: which source columns survived import at all.
       NULLIF(concat_ws(',',
         CASE WHEN sig.prompt_for  IS NOT NULL THEN 'prompt_for'  END,
         CASE WHEN sig.description IS NOT NULL THEN 'description' END,
         CASE WHEN sig.upsell      IS NOT NULL THEN 'upsell'      END), '') AS source_columns_present
  FROM sig
  LEFT JOIN option_groups  og ON og.menu_item_id    = sig.id
  LEFT JOIN option_choices oc ON oc.option_group_id = og.id
 GROUP BY sig.id, sig.shop_id, sig.menu_id, sig.name, sig.category, sig.active,
          sig.s_prompt, sig.s_desc, sig.s_upsell, sig.prompt_for, sig.description, sig.upsell;

GRANT SELECT ON qa_ro.menu_item_option_coverage TO qa_readonly;
