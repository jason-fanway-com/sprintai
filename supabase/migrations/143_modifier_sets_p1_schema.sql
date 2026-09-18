-- 143: Conversation-Ready Menu — Phase 1 modifier_sets schema (data layer only)
--
-- Spec: docs/specs/2026-09-07-conversation-ready-menu-design.md §2.3 (lines
-- 198-210), §11 Phase 1 ("modifier_sets + bindings; extractor emits shared
-- lists with spans; compiler materialises per-item groups from sets").
--
-- Purely additive, same idempotent style as 113_conversation_ready_menu_p0_schema.sql:
-- two new tables, plus two new NULLable FK columns on option_groups/
-- option_choices that nothing reads yet. No existing column is altered or
-- dropped. option_groups.set_id and option_choices.set_choice_id are already
-- named in 114_menu_overrides_trigger.sql's capture_menu_override()
-- v_excluded arrays (written in anticipation of this migration), so the
-- override trigger needs no change here — a compiler/importer write to
-- either column was already going to be excluded from override capture.
--
-- Idempotent — safe to re-run: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT
-- EXISTS, DROP POLICY IF EXISTS + CREATE.

-- ============================================================
-- modifier_sets (new, P1) — a menu-level shared list (Toppings, Breads,
-- Dressings) that per-item option_groups bind to via option_groups.set_id.
-- ============================================================
CREATE TABLE IF NOT EXISTS modifier_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_id     UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        group_kind NOT NULL,
  import_key  TEXT,
  provenance  provenance NOT NULL,
  source_span TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (menu_id, name)
);
CREATE INDEX IF NOT EXISTS idx_modifier_sets_menu ON modifier_sets (menu_id);

-- ============================================================
-- modifier_set_choices (new, P1) — the shared list's own choices. A per-item
-- option_choices row binds to one of these via option_choices.set_choice_id.
-- ============================================================
CREATE TABLE IF NOT EXISTS modifier_set_choices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id        UUID REFERENCES modifier_sets(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  display_name  TEXT,
  price_cents   INT NOT NULL DEFAULT 0,
  price_by_size JSONB,
  display_order INT,
  is_default    BOOLEAN DEFAULT false,
  provenance    provenance NOT NULL,
  source_span   TEXT,
  import_key    TEXT,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_modifier_set_choices_set ON modifier_set_choices (set_id);

-- ============================================================
-- option_groups / option_choices — the two P1 linkage columns from §2.3.
-- NULLable, no default: unset (NULL) is the correct state for every row
-- until something positively identifies it as belonging to a shared set —
-- per the design doc's §4.3 "never invent" rule, a low-confidence match
-- must leave these NULL rather than guess.
-- ============================================================
ALTER TABLE option_groups
  ADD COLUMN IF NOT EXISTS set_id UUID REFERENCES modifier_sets(id);

ALTER TABLE option_choices
  ADD COLUMN IF NOT EXISTS set_choice_id UUID REFERENCES modifier_set_choices(id);

-- ============================================================
-- RLS — same idiom as 113's owner_questions/menu_overrides: service-role is
-- the sole writer (bypasses RLS); anon/authenticated get no table privileges
-- at all beyond the explicit SELECT grant below, so a misconfigured
-- client-side call can't insert/forge rows; SELECT is policy-gated by role +
-- tenant. Shop owners can read their own shop's sets (this is the "owner
-- edits one price, all items follow" data Phase 1 exists to enable — no
-- write path from the client yet, but no reason to hide it from super_admin
-- + the owning shop's owner the way lexicon is).
-- ============================================================
ALTER TABLE modifier_sets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_set_choices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON modifier_sets        FROM anon, authenticated;
REVOKE ALL ON modifier_set_choices FROM anon, authenticated;

DROP POLICY IF EXISTS "Super admins can read modifier_sets" ON modifier_sets;
CREATE POLICY "Super admins can read modifier_sets" ON modifier_sets FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own modifier_sets" ON modifier_sets;
CREATE POLICY "Shop owners can read their own modifier_sets" ON modifier_sets FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON modifier_sets TO authenticated;

DROP POLICY IF EXISTS "Super admins can read modifier_set_choices" ON modifier_set_choices;
CREATE POLICY "Super admins can read modifier_set_choices" ON modifier_set_choices FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own modifier_set_choices" ON modifier_set_choices;
CREATE POLICY "Shop owners can read their own modifier_set_choices" ON modifier_set_choices FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND set_id IN (
      SELECT ms.id FROM modifier_sets ms
      JOIN shops s ON s.id = ms.shop_id
      WHERE s.tenant_id::text = current_user_tenant_id()
    ));
GRANT SELECT ON modifier_set_choices TO authenticated;
