-- 130_sync_shop_settings_delivery_hours.sql — sync shops -> shop_settings
-- (stopgap, not the real fix).
--
-- CONFIRMED BUG (2026-09-10 audit): admin-chat's SET_DELIVERY_ENABLED,
-- PAUSE_DELIVERY/RESUME_DELIVERY, and SET_STORE_HOURS actions all write to
-- shops.delivery_enabled / shops.open_hours / shops.delivery_paused_until /
-- shops.delivery_pause_reason (see supabase/functions/admin-chat/index.ts).
-- buildSystemPromptV2 (chat-sms/index.ts, migration 124's prompt_version
-- gate) reads the equivalent facts from shop_settings.fulfilment_modes and
-- shop_settings.hours_line instead, and nothing synced the two tables. No
-- shop currently has prompt_version set, so this has had zero live blast
-- radius so far, but it means the owner console's delivery/hours controls
-- would silently stop working the moment any shop is flipped onto the v1
-- renderer.
--
-- This migration is a STOPGAP: a synchronous trigger that keeps
-- shop_settings.fulfilment_modes/hours_line in step with the shops columns
-- above, plus a one-time backfill for shops that already have a
-- shop_settings row. It intentionally does NOT touch shops.* (additive
-- only — prompt_version:null shops read shops.* directly via the untouched
-- legacy buildSystemPrompt and are unaffected by anything here) and does
-- NOT touch shop_settings.quantity_words/upsell_enabled/delivery_radius_miles
-- (unrelated columns an owner or a future editor may have set directly).
--
-- REAL FIX DIRECTION (not this task): admin-chat should write shop_settings
-- directly as the single source of truth for prompt_version:non-null shops,
-- with shops.delivery_enabled/open_hours becoming the derived/legacy copy
-- instead of the other way around. That is a source-of-truth consolidation,
-- deliberately out of scope here — see docs/specs if one exists for it
-- before touching this trigger again.

-- Renders shops.open_hours (JSONB, keyed by 'mon'..'sun', each value either
-- {closed?, open?, close?} or an array of {open, close} windows) into the
-- same "Mon 9:00-17:00, Tue closed, ..." shape admin-chat's own
-- summarizeHours() already shows the owner after a SET_STORE_HOURS
-- confirmation (index.ts, HOUR_DAY_KEYS) — reusing that convention rather
-- than inventing a new one, since shop_settings.hours_line is free-form
-- display text with no parser anywhere that depends on its exact shape.
CREATE OR REPLACE FUNCTION render_hours_line(p_open_hours JSONB) RETURNS TEXT AS $$
DECLARE
  day_keys   TEXT[]  := ARRAY['mon','tue','wed','thu','fri','sat','sun'];
  day_labels JSONB   := '{"mon":"Mon","tue":"Tue","wed":"Wed","thu":"Thu","fri":"Fri","sat":"Sat","sun":"Sun"}'::jsonb;
  k          TEXT;
  v          JSONB;
  w          JSONB;
  parts      TEXT[]  := '{}';
  windows    TEXT[];
BEGIN
  IF p_open_hours IS NULL THEN
    RETURN 'Hours not set';
  END IF;
  FOREACH k IN ARRAY day_keys LOOP
    v := p_open_hours -> k;
    IF v IS NULL THEN
      parts := array_append(parts, (day_labels ->> k) || ' closed');
    ELSIF jsonb_typeof(v) = 'array' THEN
      IF jsonb_array_length(v) = 0 THEN
        parts := array_append(parts, (day_labels ->> k) || ' closed');
      ELSE
        windows := '{}';
        FOR w IN SELECT * FROM jsonb_array_elements(v) LOOP
          windows := array_append(windows, (w ->> 'open') || '-' || (w ->> 'close'));
        END LOOP;
        parts := array_append(parts, (day_labels ->> k) || ' ' || array_to_string(windows, ' & '));
      END IF;
    ELSIF (v ->> 'closed')::boolean IS TRUE THEN
      parts := array_append(parts, (day_labels ->> k) || ' closed');
    ELSIF (v ->> 'open') IS NOT NULL AND (v ->> 'close') IS NOT NULL THEN
      parts := array_append(parts, (day_labels ->> k) || ' ' || (v ->> 'open') || '-' || (v ->> 'close'));
    ELSE
      parts := array_append(parts, (day_labels ->> k) || ' closed');
    END IF;
  END LOOP;
  RETURN array_to_string(parts, ', ');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Fires synchronously on the same write admin-chat makes (AFTER UPDATE, same
-- transaction) — not a polling/async job, so there is no window where the
-- two tables can be read apart. SECURITY DEFINER so it works regardless of
-- whether the calling role has RLS bypass (service_role does today, but the
-- trigger shouldn't depend on that staying true).
CREATE OR REPLACE FUNCTION sync_shop_settings_from_shop() RETURNS TRIGGER AS $$
DECLARE
  v_hours_line TEXT;
BEGIN
  v_hours_line := render_hours_line(NEW.open_hours);

  INSERT INTO shop_settings (shop_id, hours_line, fulfilment_modes)
  VALUES (
    NEW.id,
    v_hours_line,
    CASE WHEN COALESCE(NEW.delivery_enabled, false) THEN ARRAY['pickup','delivery'] ELSE ARRAY['pickup'] END
  )
  ON CONFLICT (shop_id) DO UPDATE SET
    hours_line = EXCLUDED.hours_line,
    -- Toggle 'delivery' in/out and keep 'pickup' always present, but
    -- preserve any other mode an owner/editor may have set (e.g.
    -- 'catering') rather than clobbering the whole array.
    fulfilment_modes = (
      SELECT ARRAY(
        SELECT DISTINCT m FROM unnest(
          (CASE WHEN COALESCE(NEW.delivery_enabled, false)
             THEN array_append(array_remove(shop_settings.fulfilment_modes, 'delivery'), 'delivery')
             ELSE array_remove(shop_settings.fulfilment_modes, 'delivery')
           END) || ARRAY['pickup']
        ) AS m
      )
    ),
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_shop_settings_from_shop ON shops;
CREATE TRIGGER trg_sync_shop_settings_from_shop
  AFTER UPDATE OF delivery_enabled, open_hours, delivery_paused_until, delivery_pause_reason
  ON shops
  FOR EACH ROW EXECUTE FUNCTION sync_shop_settings_from_shop();

-- One-time backfill: only for shops that already have a shop_settings row
-- (migration 124 predates this trigger, so any such row may already be
-- stale). Shops with no shop_settings row are untouched here — they get one
-- created the first time any of the four tracked columns next changes,
-- same as any other shop.
UPDATE shop_settings ss
SET
  hours_line = render_hours_line(s.open_hours),
  fulfilment_modes = (
    SELECT ARRAY(
      SELECT DISTINCT m FROM unnest(
        (CASE WHEN COALESCE(s.delivery_enabled, false)
           THEN array_append(array_remove(ss.fulfilment_modes, 'delivery'), 'delivery')
           ELSE array_remove(ss.fulfilment_modes, 'delivery')
         END) || ARRAY['pickup']
      ) AS m
    )
  ),
  updated_at = NOW()
FROM shops s
WHERE s.id = ss.shop_id;
