-- 129: DB-level backstop — availability_overrides.menu_item_id and
-- specials.linked_item_id must belong to the SAME shop as the row's own shop_id.
--
-- PROBLEM
-- -------
-- Both columns are plain FKs to menu_items(id) — REFERENCES menu_items(id) proves
-- the id exists somewhere, never that it belongs to the row's own shop. Neither
-- table's RLS INSERT/UPDATE policy (migrations 033/036, availability_overrides;
-- 033, specials) checks the item id at all — both only check
-- "shop_id IN (shops WHERE tenant_id = current_user_tenant_id())". Contrast
-- option_groups/option_choices's INSERT policies (097), which DO join through
-- menu_item_id/option_group_id to verify tenant ownership.
--
-- admin-chat's confirmed_action_id flow (supabase/functions/admin-chat/index.ts)
-- re-parses whatever proposal JSON the client echoes back at confirm time and
-- executes it directly — validateProposal() (which checks item/shop ownership)
-- only ever ran once, at proposal-creation time. A tampered confirm payload could
-- carry EIGHTYSIX_ITEM's item_ids or ADD_SPECIAL's linked_item_id pointing at
-- another tenant's menu_item, and nothing between the client and the INSERT
-- would catch it. The app-level fix (re-running validateProposal at confirm time,
-- same change) closes this for the RLS-scoped shop_owner path; this migration is
-- the DB-level backstop so the same is true regardless of client, role
-- (service-role bypasses RLS entirely), or future code path that writes to
-- these two tables.
--
-- Plain LANGUAGE plpgsql (invoker rights, no SECURITY DEFINER) — the check is an
-- explicit join comparing the item's resolved shop_id to NEW.shop_id, so it's
-- correct regardless of which role/RLS-visibility the calling session has; it
-- doesn't rely on RLS to hide cross-shop rows from the check.

CREATE OR REPLACE FUNCTION enforce_availability_override_item_shop_match() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM menu_items mi JOIN menus m ON m.id = mi.menu_id
    WHERE mi.id = NEW.menu_item_id AND m.shop_id = NEW.shop_id
  ) THEN
    RAISE EXCEPTION 'availability_overrides: menu_item % does not belong to shop %', NEW.menu_item_id, NEW.shop_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_availability_overrides_item_shop_match ON availability_overrides;
CREATE TRIGGER trg_availability_overrides_item_shop_match
  BEFORE INSERT OR UPDATE ON availability_overrides
  FOR EACH ROW EXECUTE FUNCTION enforce_availability_override_item_shop_match();

CREATE OR REPLACE FUNCTION enforce_special_linked_item_shop_match() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.linked_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM menu_items mi JOIN menus m ON m.id = mi.menu_id
    WHERE mi.id = NEW.linked_item_id AND m.shop_id = NEW.shop_id
  ) THEN
    RAISE EXCEPTION 'specials: linked_item_id % does not belong to shop %', NEW.linked_item_id, NEW.shop_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_specials_linked_item_shop_match ON specials;
CREATE TRIGGER trg_specials_linked_item_shop_match
  BEFORE INSERT OR UPDATE ON specials
  FOR EACH ROW EXECUTE FUNCTION enforce_special_linked_item_shop_match();
