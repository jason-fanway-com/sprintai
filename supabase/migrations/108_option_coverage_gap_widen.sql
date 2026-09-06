-- 108: qa_ro.menu_item_option_coverage's `gap` column used
-- `(needs_options AND group_count = 0)`, where needs_options is
-- `s_prompt OR s_desc OR s_upsell` — three-valued OR over columns that are
-- NULL (not false) whenever the importer left prompt_for/upsell NULL, which
-- it does on nearly every row. NULL OR NULL OR false-or-NULL stays NULL, so
-- `needs_options` (and therefore `gap`, since AND with NULL also propagates
-- NULL) came out NULL rather than FALSE for any zero-group item whose
-- description also didn't match — and `WHERE gap` / `count(*) FILTER (WHERE
-- gap)` silently drop NULL rows instead of counting them. Jason found 82 real
-- gaps across six categories where the view surfaced only 53; the missing 29
-- were exactly this — zero-group items the view couldn't rule out, that it
-- then quietly excluded instead of flagging for a human to check.
--
-- Fix: an item with zero option groups counts as a gap unless the signal is a
-- CONFIRMED false — i.e. all three source columns are present (not NULL) and
-- none of them matched the option-implying prose pattern. An unknown
-- (textless, NULL) zero-group item is exactly the case that needs a human
-- to look, not the case that gets to hide. needs_options itself is untouched
-- — it still means "text says so" narrowly.

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
       -- The defect this view exists to surface. Widened (108): a zero-group
       -- item counts as a gap UNLESS the signal is a confirmed false (all
       -- three source columns present and none matched) — "unknown" no
       -- longer gets excluded, it gets flagged.
       (((sig.s_prompt OR sig.s_desc OR sig.s_upsell) IS NOT FALSE) AND count(DISTINCT og.id) = 0) AS gap,
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
