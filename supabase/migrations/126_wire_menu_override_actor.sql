-- 126: Wire real callers to migration 114's capture_menu_override() trigger (§9, §11 item 7)
--
-- 114 shipped the trigger as a deliberate no-op: it only captures an override once
-- something sets `app.actor`, and nothing did. This migration is the "something."
--
-- Why RPC wrappers instead of a plain UPDATE from the client: every existing owner-edit
-- call site (admin-dashboard/ShopDetail.tsx, admin-chat/index.ts) writes via supabase-js,
-- i.e. one PostgREST request = one statement = one transaction. There is no way to run
-- `SET LOCAL app.actor = ...` ahead of that statement from the client. A single-purpose
-- SQL function that does `PERFORM set_config('app.actor', ..., true)` and then the write,
-- in one call, is one transaction — the trigger fires inside that same transaction and
-- sees the GUC. This is the smallest change that makes the existing UPDATE/DELETE
-- carry an actor, without touching PostgREST's global config (a project-wide
-- db-pre-request hook would run on every request in the system, including the live
-- order/payment path — out of proportion to an admin-only menu-edit feature).
--
-- SECURITY INVOKER (the default — stated explicitly for clarity), not DEFINER: the
-- actual UPDATE/DELETE below still runs as the calling role. For the `authenticated`
-- role (ShopDetail.tsx, direct owner session) this means the existing RLS policies from
-- 033/036/104 ("Shop owners can update/insert their own menu_items") continue to gate
-- the write exactly as they do today for the plain .update() call this replaces — the
-- wrapper adds the actor GUC, it does not widen who can write what. For `service_role`
-- (admin-chat, which already bypasses RLS today) nothing about the write's scope
-- changes either.
--
-- Actor derivation: when the caller is an authenticated user (auth.uid() resolves),
-- the actor is always 'owner:' || auth.uid() — derived from the verified JWT, not from
-- p_actor, so an authenticated caller cannot forge a different user's attribution in
-- the audit trail. Only when there is no JWT (auth.uid() is null — the service_role
-- case, e.g. admin-chat, which validates the acting user itself before ever calling
-- this function) does p_actor apply. Compiler writes never call these functions, so
-- app.actor stays unset for them and the trigger's existing default-safe check
-- (NULL/''/'compiler' → capture nothing) is untouched.

-- ============================================================
-- owner_update_menu_item(): wraps an UPDATE on menu_items with the actor GUC.
-- p_fields is a jsonb allowlist patch — a key's ABSENCE leaves the column untouched;
-- a key present with value null explicitly clears that column (COALESCE would not
-- support that distinction, hence the `?` key-exists checks below).
-- ============================================================
CREATE OR REPLACE FUNCTION owner_update_menu_item(
  p_item_id uuid,
  p_fields jsonb,
  p_actor text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_actor   text := COALESCE('owner:' || auth.uid()::text, p_actor);
  v_allowed text[] := ARRAY['name','description','price_cents','category','display_order',
                             'active','display_name','product_key','archetype',
                             'flag_review','flag_reason','prompt_for'];
  v_key     text;
BEGIN
  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'owner_update_menu_item: field "%" is not owner-editable', v_key;
    END IF;
  END LOOP;

  IF v_actor IS NOT NULL AND v_actor <> '' THEN
    PERFORM set_config('app.actor', v_actor, true);
  END IF;

  UPDATE menu_items SET
    name          = CASE WHEN p_fields ? 'name'          THEN p_fields->>'name'                    ELSE name END,
    description   = CASE WHEN p_fields ? 'description'   THEN p_fields->>'description'             ELSE description END,
    price_cents   = CASE WHEN p_fields ? 'price_cents'    THEN (p_fields->>'price_cents')::int      ELSE price_cents END,
    category      = CASE WHEN p_fields ? 'category'       THEN p_fields->>'category'                ELSE category END,
    display_order = CASE WHEN p_fields ? 'display_order'  THEN (p_fields->>'display_order')::int    ELSE display_order END,
    active        = CASE WHEN p_fields ? 'active'         THEN (p_fields->>'active')::boolean       ELSE active END,
    display_name  = CASE WHEN p_fields ? 'display_name'   THEN p_fields->>'display_name'            ELSE display_name END,
    product_key   = CASE WHEN p_fields ? 'product_key'    THEN p_fields->>'product_key'             ELSE product_key END,
    archetype     = CASE WHEN p_fields ? 'archetype'      THEN p_fields->>'archetype'               ELSE archetype END,
    flag_review   = CASE WHEN p_fields ? 'flag_review'    THEN (p_fields->>'flag_review')::boolean  ELSE flag_review END,
    flag_reason   = CASE WHEN p_fields ? 'flag_reason'    THEN p_fields->>'flag_reason'              ELSE flag_reason END,
    prompt_for    = CASE WHEN p_fields ? 'prompt_for'     THEN p_fields->>'prompt_for'               ELSE prompt_for END,
    owner_edited  = true,
    updated_at    = now()
  WHERE id = p_item_id;
END;
$$;

-- ============================================================
-- owner_delete_menu_item(): wraps a DELETE on menu_items with the actor GUC. The
-- trigger's DELETE branch writes the field='*'/value=NULL suppression row (§9).
-- ============================================================
CREATE OR REPLACE FUNCTION owner_delete_menu_item(
  p_item_id uuid,
  p_actor text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_actor text := COALESCE('owner:' || auth.uid()::text, p_actor);
BEGIN
  IF v_actor IS NOT NULL AND v_actor <> '' THEN
    PERFORM set_config('app.actor', v_actor, true);
  END IF;
  DELETE FROM menu_items WHERE id = p_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION owner_update_menu_item(uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION owner_delete_menu_item(uuid, text) TO authenticated, service_role;
