-- 114: Overrides trigger + migration from owner_edited (§9, §11 item 7)
--
-- Spec: docs/specs/2026-09-07-conversation-ready-menu-design.md §9
-- "Re-import and the merge model", §11 item 7.
--
-- Depends on 113 (menu_overrides table, option_groups.slot_key and the rest
-- of the §2.3 P0 columns). PL/pgSQL does not validate table/column
-- references inside a function body at CREATE FUNCTION time — only at
-- execution — so this migration applies cleanly even if run before 113.
-- It is a safe no-op either way today: the trigger only writes anything
-- once something sets `app.actor`, and nothing in the codebase does that
-- yet (grep the repo for "app.actor" — the only hits are this file and the
-- session-scoped-GUC precedent it follows, migration 051's
-- `app.allow_protected_delete`). Wiring a real caller (admin-chat, the
-- compiler, the owner-question answer path) to set it is later work.
--
-- Entity-key formula lives in ONE place for non-SQL callers: TypeScript
-- module supabase/functions/_shared/menu-entity-key.ts (the compiler, item 4,
-- must import it rather than re-deriving the formula). This migration
-- reimplements the same formula in SQL because a trigger can't call into
-- Deno. Keep the two byte-identical for the same input — that module
-- deliberately skips Unicode accent-folding for exactly this reason (an
-- extension-free SQL mirror can't cheaply match NFKD), so don't add it
-- back to one side without adding it to the other.
--
-- Known limitation, deliberately not fixed here: a group/choice without
-- `slot_key` populated yet keys off its normalised NAME (see
-- menu-entity-key.ts's module doc). Renaming such a row changes its
-- entity_key going forward but does not re-key its prior menu_overrides
-- rows, which then silently stop applying at compile time. Once the
-- compiler (item 4) has run and populated slot_key, this stops applying —
-- the fallback is only live during the window before a group has gone
-- through the pipeline, or for an owner-created group that never will.

-- ============================================================
-- menu_override_normalise_term(): mirrors menu-entity-key.ts's
-- normaliseEntityTerm — lowercase, trim, collapse whitespace, drop
-- punctuation that doesn't change meaning.
-- ============================================================
CREATE OR REPLACE FUNCTION menu_override_normalise_term(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(regexp_replace(regexp_replace(lower(raw), '[.,''"()]', '', 'g'), '\s+', ' ', 'g'));
$$;

-- ============================================================
-- capture_menu_override(): AFTER UPDATE OR DELETE trigger on menu_items /
-- option_groups / option_choices (sets are P1 per §9 — skipped here).
--
-- Writes one menu_overrides row per changed column on UPDATE, or a single
-- field='*'/value=NULL suppression row on DELETE (§9: "A deleted override
-- (field='*', value null) suppresses the entity" — the owner-delete path
-- through admin-dashboard/ShopDetail.tsx and admin-chat/index.ts hard-
-- deletes these rows directly, so this is a real, not theoretical, path).
-- Only when the session actor (`current_setting('app.actor', true)`) is an
-- owner edit or an answered owner_question (actor = 'question:<id>') —
-- never for no actor set, and never for the compiler's own writes (§1 P6
-- "one writer per table"; §9: "The compiler sets the actor to compiler and
-- the trigger ignores it. Nothing else needs to remember to set
-- owner_edited.").
--
-- SECURITY DEFINER with a pinned, empty search_path (same convention as
-- 018_conversation_last_message_at.sql's bump_conversation_last_message_at):
-- menu_items/option_groups/option_choices already carry owner-facing RLS
-- UPDATE/DELETE policies for the `authenticated` role, so a real owner
-- session — not just a service-role edge function — can reach this trigger.
-- Without SECURITY DEFINER, that owner's own role would need direct INSERT
-- on menu_overrides, which 113 deliberately revokes from anon/authenticated;
-- the owner's save would fail outright. Every table reference below is
-- schema-qualified because the empty search_path leaves nothing to resolve
-- unqualified names against.
--
-- Known limitation (not solved here): when a menu_item is hard-deleted and
-- its option_groups/option_choices cascade-delete (ON DELETE CASCADE) in
-- the same statement, a cascaded child's AFTER DELETE firing may find its
-- parent menu_items row already gone. shop_id/menu_id can't be resolved in
-- that case, so — since both are NOT NULL on menu_overrides and erroring
-- there would abort the owner's entire delete — the child row is skipped
-- silently rather than inserted with a wrong/orphaned key (see the
-- v_shop_id/v_menu_id NULL guard below). This is safe: the item's own
-- suppression row (keyed correctly, since it fires off the item's own OLD
-- row) is what actually stops re-import from resurrecting the deleted item;
-- the compiler does not need correctly-keyed child suppressions once the
-- parent entity itself is suppressed.
-- ============================================================
CREATE OR REPLACE FUNCTION capture_menu_override() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor            TEXT := current_setting('app.actor', true);
  v_key_row          JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_new_j            JSONB := to_jsonb(NEW);
  v_old_j            JSONB := to_jsonb(OLD);
  v_entity_type      TEXT;
  v_entity_key       TEXT;
  v_menu_id          UUID;
  v_shop_id          UUID;
  v_item_import_key  TEXT;
  v_item_id          UUID;
  v_item_key         TEXT;
  v_group_slot       TEXT;
  v_group_name       TEXT;
  v_group_id         UUID;
  v_menu_item_id     UUID;
  v_key              TEXT;
  v_excluded         TEXT[];
BEGIN
  -- Default-safe: no actor set, or the compiler's own writes → capture nothing.
  IF v_actor IS NULL OR v_actor = '' OR v_actor = 'compiler' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'menu_items' THEN
    v_entity_type := 'item';
    v_item_import_key := v_key_row ->> 'import_key';
    v_entity_key := COALESCE(v_item_import_key, 'owner:' || (v_key_row ->> 'id'));
    v_menu_id := (v_key_row ->> 'menu_id')::uuid;
    SELECT s.id INTO v_shop_id FROM public.menus m JOIN public.shops s ON s.id = m.shop_id WHERE m.id = v_menu_id;
    v_excluded := ARRAY['id','created_at','updated_at','menu_id','import_key','owner_edited',
      'bot_state','bot_state_reason','ask_plan','name_provenance','price_provenance',
      'source_span','missing_from_source_since',
      'source','source_ref','flag_review','flag_reason','prompt_for','upsell','row_type'];

  ELSIF TG_TABLE_NAME = 'option_groups' THEN
    v_entity_type := 'group';
    v_menu_item_id := (v_key_row ->> 'menu_item_id')::uuid;
    SELECT mi.import_key, mi.id, mi.menu_id INTO v_item_import_key, v_item_id, v_menu_id
      FROM public.menu_items mi WHERE mi.id = v_menu_item_id;
    SELECT s.id INTO v_shop_id FROM public.menus m JOIN public.shops s ON s.id = m.shop_id WHERE m.id = v_menu_id;
    v_item_key := COALESCE(v_item_import_key, 'owner:' || v_item_id::text);
    v_group_slot := v_key_row ->> 'slot_key';
    v_group_name := v_key_row ->> 'name';
    v_entity_key := v_item_key || '#' || COALESCE(v_group_slot, public.menu_override_normalise_term(v_group_name));
    v_excluded := ARRAY['id','created_at','updated_at','menu_item_id','import_key','owner_edited',
      'ask_mode','provenance','source_span','set_id'];

  ELSIF TG_TABLE_NAME = 'option_choices' THEN
    v_entity_type := 'choice';
    v_group_id := (v_key_row ->> 'option_group_id')::uuid;
    SELECT og.slot_key, og.name, og.menu_item_id INTO v_group_slot, v_group_name, v_menu_item_id
      FROM public.option_groups og WHERE og.id = v_group_id;
    SELECT mi.import_key, mi.id, mi.menu_id INTO v_item_import_key, v_item_id, v_menu_id
      FROM public.menu_items mi WHERE mi.id = v_menu_item_id;
    SELECT s.id INTO v_shop_id FROM public.menus m JOIN public.shops s ON s.id = m.shop_id WHERE m.id = v_menu_id;
    v_item_key := COALESCE(v_item_import_key, 'owner:' || v_item_id::text);
    v_entity_key := v_item_key || '#' || COALESCE(v_group_slot, public.menu_override_normalise_term(v_group_name))
      || '#' || public.menu_override_normalise_term(v_key_row ->> 'name');
    v_excluded := ARRAY['id','created_at','updated_at','option_group_id','import_key','owner_edited',
      'provenance','source_span','set_choice_id','ref_item_id','price_by_choice'];

  ELSE
    RETURN COALESCE(NEW, OLD); -- not one of the three tables this trigger is installed on
  END IF;

  -- Parent chain unresolved (e.g. a cascade-deleted option_groups/option_choices
  -- row whose parent menu_items row is already gone in the same statement, per
  -- the header's documented cascade limitation): shop_id/menu_id are NOT NULL on
  -- menu_overrides, so inserting here would raise and abort the whole owner
  -- DELETE. Skip silently — the parent's own suppression row (which resolves
  -- correctly off its own OLD row) is what actually stops re-import from
  -- resurrecting the deleted entity; this child row would be redundant anyway.
  IF v_shop_id IS NULL OR v_menu_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.menu_overrides (shop_id, menu_id, entity_type, entity_key, field, value, actor)
    VALUES (v_shop_id, v_menu_id, v_entity_type, v_entity_key, '*', NULL, v_actor);
    RETURN OLD;
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_new_j) LOOP
    IF v_key = ANY (v_excluded) THEN
      CONTINUE;
    END IF;
    IF (v_new_j -> v_key) IS DISTINCT FROM (v_old_j -> v_key) THEN
      INSERT INTO public.menu_overrides (shop_id, menu_id, entity_type, entity_key, field, value, actor)
      VALUES (v_shop_id, v_menu_id, v_entity_type, v_entity_key, v_key, v_new_j -> v_key, v_actor);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_menu_items_override ON menu_items;
CREATE TRIGGER trg_capture_menu_items_override AFTER UPDATE OR DELETE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION capture_menu_override();

DROP TRIGGER IF EXISTS trg_capture_option_groups_override ON option_groups;
CREATE TRIGGER trg_capture_option_groups_override AFTER UPDATE OR DELETE ON option_groups
  FOR EACH ROW EXECUTE FUNCTION capture_menu_override();

DROP TRIGGER IF EXISTS trg_capture_option_choices_override ON option_choices;
CREATE TRIGGER trg_capture_option_choices_override AFTER UPDATE OR DELETE ON option_choices
  FOR EACH ROW EXECUTE FUNCTION capture_menu_override();

-- ============================================================
-- One-time data migration: every row currently marked owner_edited = true
-- becomes menu_overrides rows for all of that row's non-null fields, actor
-- = 'migration' (§9's closing paragraph). Idempotent: a field already
-- covered by an existing override for the same (entity_type, entity_key,
-- field) is skipped, so a second run inserts zero rows.
--
-- Runs with app.actor unset — outside the capture_menu_override() trigger
-- entirely, since it's writing directly to menu_overrides, not editing the
-- effective tables. It must NOT bump menu_items.updated_at or otherwise
-- touch the source rows; it only reads owner_edited and writes overrides.
-- ============================================================

-- menu_items: name, price_cents, active, description, category, display_order,
-- display_name, product_key, archetype — every column an owner could
-- plausibly hand-edit. Excludes bookkeeping/compiler-owned columns, same
-- list as the trigger's v_excluded for this table.
INSERT INTO menu_overrides (shop_id, menu_id, entity_type, entity_key, field, value, actor)
SELECT s.id, mi.menu_id, 'item',
       COALESCE(mi.import_key, 'owner:' || mi.id::text),
       col.field, col.value, 'migration'
FROM menu_items mi
JOIN menus m ON m.id = mi.menu_id
JOIN shops s ON s.id = m.shop_id
CROSS JOIN LATERAL (
  VALUES
    ('name',          to_jsonb(mi.name)),
    ('description',   to_jsonb(mi.description)),
    ('price_cents',   to_jsonb(mi.price_cents)),
    ('category',      to_jsonb(mi.category)),
    ('display_order', to_jsonb(mi.display_order)),
    ('active',        to_jsonb(mi.active)),
    ('display_name',  to_jsonb(mi.display_name)),
    ('product_key',   to_jsonb(mi.product_key)),
    ('archetype',     to_jsonb(mi.archetype))
) AS col(field, value)
WHERE mi.owner_edited = true
  AND col.value IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM menu_overrides mo
    WHERE mo.menu_id = mi.menu_id
      AND mo.entity_type = 'item'
      AND mo.entity_key = COALESCE(mi.import_key, 'owner:' || mi.id::text)
      AND mo.field = col.field
  );

-- option_groups: name, required, min_select, max_select, display_order,
-- kitchen_critical, price_critical, default_choice_id.
INSERT INTO menu_overrides (shop_id, menu_id, entity_type, entity_key, field, value, actor)
SELECT s.id, mi.menu_id, 'group',
       COALESCE(mi.import_key, 'owner:' || mi.id::text) || '#'
         || COALESCE(og.slot_key, menu_override_normalise_term(og.name)),
       col.field, col.value, 'migration'
FROM option_groups og
JOIN menu_items mi ON mi.id = og.menu_item_id
JOIN menus m ON m.id = mi.menu_id
JOIN shops s ON s.id = m.shop_id
CROSS JOIN LATERAL (
  VALUES
    ('name',              to_jsonb(og.name)),
    ('required',          to_jsonb(og.required)),
    ('min_select',        to_jsonb(og.min_select)),
    ('max_select',        to_jsonb(og.max_select)),
    ('display_order',     to_jsonb(og.display_order)),
    ('kitchen_critical',  to_jsonb(og.kitchen_critical)),
    ('price_critical',    to_jsonb(og.price_critical)),
    ('default_choice_id', to_jsonb(og.default_choice_id))
) AS col(field, value)
WHERE og.owner_edited = true
  AND col.value IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM menu_overrides mo
    WHERE mo.menu_id = mi.menu_id
      AND mo.entity_type = 'group'
      AND mo.entity_key = COALESCE(mi.import_key, 'owner:' || mi.id::text) || '#'
            || COALESCE(og.slot_key, menu_override_normalise_term(og.name))
      AND mo.field = col.field
  );

-- option_choices: name, price_cents, is_default, display_order, display_name.
INSERT INTO menu_overrides (shop_id, menu_id, entity_type, entity_key, field, value, actor)
SELECT s.id, mi.menu_id, 'choice',
       COALESCE(mi.import_key, 'owner:' || mi.id::text) || '#'
         || COALESCE(og.slot_key, menu_override_normalise_term(og.name)) || '#'
         || menu_override_normalise_term(oc.name),
       col.field, col.value, 'migration'
FROM option_choices oc
JOIN option_groups og ON og.id = oc.option_group_id
JOIN menu_items mi ON mi.id = og.menu_item_id
JOIN menus m ON m.id = mi.menu_id
JOIN shops s ON s.id = m.shop_id
CROSS JOIN LATERAL (
  VALUES
    ('name',          to_jsonb(oc.name)),
    ('price_cents',   to_jsonb(oc.price_cents)),
    ('is_default',    to_jsonb(oc.is_default)),
    ('display_order', to_jsonb(oc.display_order)),
    ('display_name',  to_jsonb(oc.display_name))
) AS col(field, value)
WHERE oc.owner_edited = true
  AND col.value IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM menu_overrides mo
    WHERE mo.menu_id = mi.menu_id
      AND mo.entity_type = 'choice'
      AND mo.entity_key = COALESCE(mi.import_key, 'owner:' || mi.id::text) || '#'
            || COALESCE(og.slot_key, menu_override_normalise_term(og.name)) || '#'
            || menu_override_normalise_term(oc.name)
      AND mo.field = col.field
  );
