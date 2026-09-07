-- Migration 119: expose Phase-0 compiler-output columns/tables through qa_ro
--
-- Applied live 2026-09-07 ahead of running the compiler against Zio's for
-- real, at Jason's explicit request: he needs to independently verify
-- ask_plan/bot_state (and the rest of the compiler output) through qa_ro,
-- not take a report script's word for it. Same lesson as migrations
-- 116/117 one layer down -- a view can pass every row-scoping check and
-- still hide the columns being asked about. See RUNBOOK.md's qa_ro section
-- for the full writeup.
--
-- qa_ro.menu_items previously exposed 25 of the real table's 37 columns and
-- silently dropped every Phase-0 column added by migration 113. This adds
-- the 9 that are compiler output (display_name, product_key, archetype,
-- bot_state, bot_state_reason, ask_plan, name_provenance, price_provenance,
-- source_span). confidence_score/source/source_ref are still not exposed --
-- pre-existing gap, unrelated to this spec, not touched here.
CREATE OR REPLACE VIEW qa_ro.menu_items AS
SELECT id,
    menu_id,
    external_id,
    name,
    description,
    price_cents,
    category,
    modifiers_json,
    display_order,
    active,
    created_at,
    updated_at,
    is_available,
    size_label,
    import_key,
    owner_edited,
    flag_review,
    row_type,
    modifier_choice_group,
    image_url,
    upsell_text,
    prompt_for,
    meta,
    source_extract_key,
    upsell,
    flag_reason,
    display_name,
    product_key,
    archetype,
    bot_state,
    bot_state_reason,
    ask_plan,
    name_provenance,
    price_provenance,
    source_span
   FROM menu_items;

-- qa_ro.option_groups / qa_ro.option_choices: same gap, extended with their
-- own missing Phase-0 columns. Still scoped via qa_ro.visible_shop_ids()
-- per migration 117 -- only the column list changes here.
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
    og.import_key,
    og.kind,
    og.slot_key,
    og.kitchen_critical,
    og.price_critical,
    og.default_choice_id,
    og.ask_mode,
    og.provenance,
    og.source_span,
    og.created_at
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
    oc.import_key,
    oc.display_name,
    oc.is_default,
    oc.provenance,
    oc.source_span,
    oc.created_at
   FROM option_choices oc
     JOIN option_groups og ON og.id = oc.option_group_id
     JOIN menu_items mi ON mi.id = og.menu_item_id
     JOIN menus m ON m.id = mi.menu_id
  WHERE m.shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

-- qa_ro.lexicon / qa_ro.owner_questions: had NO qa_ro view at all before
-- this -- the owner-question list and lexicon terms were only ever
-- reachable through a report script, never independently verifiable.
-- Both tables carry shop_id directly (no join needed), scoped the same way.
CREATE VIEW qa_ro.lexicon AS
SELECT id, shop_id, menu_id, term, target_type, target_id, provenance, weight, active, evidence, created_at
   FROM lexicon
  WHERE shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

CREATE VIEW qa_ro.owner_questions AS
SELECT id, shop_id, menu_id, scope_type, scope_id, slot_key, kind, question_text, proposal,
    blocking, priority, items_affected, status, answer, asked_via, asked_at, answered_at, created_at
   FROM owner_questions
  WHERE shop_id IN (SELECT id FROM qa_ro.visible_shop_ids());

GRANT SELECT ON qa_ro.lexicon TO qa_readonly;
GRANT SELECT ON qa_ro.owner_questions TO qa_readonly;
