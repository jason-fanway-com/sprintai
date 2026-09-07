-- 113: Conversation-Ready Menu — Phase 0 schema (P0 columns + tables)
--
-- Spec: docs/specs/2026-09-07-conversation-ready-menu-design.md §2.3, §11 item 1.
-- Additive only. No existing chat-sms/cart/checkout/pricing code reads or
-- writes any column or table added here — the compiler (item 4), the
-- normalizer (item 2), the resolver (item 8), and the owner-question writer
-- (item 3) are separate, later work. This migration's job is schema +
-- one-time backfill of derivable values only.
--
-- Idempotent — safe to re-run. Enum creation is guarded by exception trap
-- (Postgres has no CREATE TYPE IF NOT EXISTS); columns use ADD COLUMN IF NOT
-- EXISTS; tables/indexes use IF NOT EXISTS; policies are DROP + CREATE.
-- Backfill UPDATEs are predicated so a second run touches zero rows.

-- ============================================================
-- ENUMS
-- ============================================================
DO $$ BEGIN
  CREATE TYPE provenance AS ENUM ('stated','inferred','owner_confirmed','learned','defaulted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE group_kind AS ENUM ('slot','modifier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ask_mode AS ENUM ('ask','apply_default','auto_single','offer_once','on_request');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bot_state AS ENUM ('orderable','blocked','display_only','stale');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- menu_items — P0 columns
-- ============================================================
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS display_name         TEXT,
  ADD COLUMN IF NOT EXISTS product_key          TEXT,
  ADD COLUMN IF NOT EXISTS archetype            TEXT,
  ADD COLUMN IF NOT EXISTS bot_state            bot_state NOT NULL DEFAULT 'blocked',
  ADD COLUMN IF NOT EXISTS bot_state_reason     TEXT,
  ADD COLUMN IF NOT EXISTS ask_plan             JSONB,
  ADD COLUMN IF NOT EXISTS name_provenance      provenance NOT NULL DEFAULT 'stated',
  ADD COLUMN IF NOT EXISTS price_provenance     provenance NOT NULL DEFAULT 'stated',
  ADD COLUMN IF NOT EXISTS source_span          TEXT;

-- ============================================================
-- option_groups — P0 columns
-- ============================================================
ALTER TABLE option_groups
  ADD COLUMN IF NOT EXISTS kind               group_kind NOT NULL DEFAULT 'slot',
  ADD COLUMN IF NOT EXISTS slot_key           TEXT,
  ADD COLUMN IF NOT EXISTS kitchen_critical   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_critical     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_choice_id  UUID REFERENCES option_choices(id),
  ADD COLUMN IF NOT EXISTS ask_mode           ask_mode,
  ADD COLUMN IF NOT EXISTS provenance         provenance NOT NULL DEFAULT 'stated',
  ADD COLUMN IF NOT EXISTS source_span        TEXT;

-- ============================================================
-- option_choices — P0 columns
-- (is_default already exists from 006_option_groups.sql; IF NOT EXISTS no-ops it)
-- ============================================================
ALTER TABLE option_choices
  ADD COLUMN IF NOT EXISTS display_name  TEXT,
  ADD COLUMN IF NOT EXISTS is_default    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provenance    provenance NOT NULL DEFAULT 'stated',
  ADD COLUMN IF NOT EXISTS source_span   TEXT;

-- ============================================================
-- lexicon (new, P0) — customer vocabulary, compiler/resolver internal.
-- No owner-facing UI in Phase 0 (§6) — service-role + super_admin only.
-- ============================================================
CREATE TABLE IF NOT EXISTS lexicon (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_id      UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  term         TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('item','choice','category','product')),
  target_id    TEXT NOT NULL,
  provenance   provenance NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  active       BOOLEAN NOT NULL DEFAULT true,
  evidence     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (menu_id, term, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_lexicon_menu_term ON lexicon (menu_id, term) WHERE active;

-- ============================================================
-- owner_questions (new, P0) — the web-editor blocking-question queue (§5).
-- Owner reads/answers their own shop's questions; writes go through the
-- edge function's service-role client, not a client-side UPDATE policy.
-- ============================================================
CREATE TABLE IF NOT EXISTS owner_questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_id        UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('category','item','set','group','choice')),
  scope_id       TEXT NOT NULL,
  slot_key       TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('exists','choices','price','still_sold','confirm_alias','default')),
  question_text  TEXT NOT NULL,
  proposal       JSONB NOT NULL,
  blocking       BOOLEAN NOT NULL,
  priority       INTEGER NOT NULL,
  items_affected INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','asked','answered','dismissed','expired')),
  answer         JSONB,
  asked_via      TEXT,
  asked_at       TIMESTAMPTZ,
  answered_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_questions_menu_status ON owner_questions (menu_id, status);
CREATE INDEX IF NOT EXISTS idx_owner_questions_shop        ON owner_questions (shop_id);

-- ============================================================
-- menu_overrides (new, P0) — replaces owner_edited (§9).
-- Owner reads their own override history; writes are service-role only.
-- ============================================================
CREATE TABLE IF NOT EXISTS menu_overrides (
  id           BIGSERIAL PRIMARY KEY,
  shop_id      UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_id      UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_key   TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        JSONB,
  actor        TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_menu_overrides_menu_entity ON menu_overrides (menu_id, entity_type, entity_key);

-- ============================================================
-- import_runs (new, P0 stores raw extraction jsonb; full snapshot/diff
-- model is P1). Pipeline-internal — service-role + super_admin only.
-- ============================================================
CREATE TABLE IF NOT EXISTS import_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id     UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  sources     JSONB,
  extract     JSONB,
  stats       JSONB,
  status      TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_runs_menu ON import_runs (menu_id, started_at DESC);

-- ============================================================
-- RLS — mirrors 101_menu_edit_log.sql: service-role is the sole writer
-- (bypasses RLS); table privileges revoked from anon/authenticated so a
-- misconfigured client-side call can't insert/forge rows; SELECT is
-- policy-gated by role + tenant, same shop-scoping idiom as everywhere else.
-- ============================================================
ALTER TABLE lexicon         ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_overrides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON lexicon         FROM anon, authenticated;
REVOKE ALL ON owner_questions FROM anon, authenticated;
REVOKE ALL ON menu_overrides  FROM anon, authenticated;
REVOKE ALL ON import_runs     FROM anon, authenticated;

-- lexicon: super_admin only (no owner-facing UI in Phase 0)
DROP POLICY IF EXISTS "Super admins can read lexicon" ON lexicon;
CREATE POLICY "Super admins can read lexicon" ON lexicon FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
GRANT SELECT ON lexicon TO authenticated;

-- owner_questions: super_admin + the owning shop's owner
DROP POLICY IF EXISTS "Super admins can read owner_questions" ON owner_questions;
CREATE POLICY "Super admins can read owner_questions" ON owner_questions FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own owner_questions" ON owner_questions;
CREATE POLICY "Shop owners can read their own owner_questions" ON owner_questions FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON owner_questions TO authenticated;

-- menu_overrides: super_admin + the owning shop's owner
DROP POLICY IF EXISTS "Super admins can read menu_overrides" ON menu_overrides;
CREATE POLICY "Super admins can read menu_overrides" ON menu_overrides FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own menu_overrides" ON menu_overrides;
CREATE POLICY "Shop owners can read their own menu_overrides" ON menu_overrides FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON menu_overrides TO authenticated;

-- import_runs: super_admin only (pipeline-internal)
DROP POLICY IF EXISTS "Super admins can read import_runs" ON import_runs;
CREATE POLICY "Super admins can read import_runs" ON import_runs FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
GRANT SELECT ON import_runs TO authenticated;

-- ============================================================
-- BACKFILL — derivable values only, per §11 item 1. Every predicate below
-- is written so a second run of this migration touches zero rows.
-- ============================================================

-- kind: derived from the existing `required` column, all shops. Column
-- default is already 'slot' (correct for required=true); only the
-- required=false rows need to move to 'modifier'.
UPDATE option_groups
   SET kind = 'modifier'
 WHERE required = false
   AND kind = 'slot';

-- display_name: naive starting copy of name, all shops. Item 2's normalizer
-- (separate work) refines this later; this just ensures the column is never
-- null once compiled, per §2.3's comment on menu_items.display_name.
UPDATE menu_items
   SET display_name = name
 WHERE display_name IS NULL;

UPDATE option_choices
   SET display_name = name
 WHERE display_name IS NULL;

-- provenance = 'owner_confirmed' for Vito's Pizza's existing hand-built rows
-- only (shop_id e0000000-0000-0000-0000-000000000001): these were built by
-- a human directly in the DB, so there is no source_span to quote — 'stated'
-- would be a false claim of extraction provenance. Corrected per spec §11
-- item 1 (originally 'stated' in an earlier draft). Scoped narrowly to this
-- one shop's menus; every other shop's rows keep the 'stated' column default
-- until their own import/compile sets it for real.
UPDATE menu_items
   SET name_provenance = 'owner_confirmed',
       price_provenance = 'owner_confirmed'
 WHERE name_provenance = 'stated'
   AND menu_id IN (SELECT id FROM menus WHERE shop_id = 'e0000000-0000-0000-0000-000000000001');

UPDATE option_groups
   SET provenance = 'owner_confirmed'
 WHERE provenance = 'stated'
   AND menu_item_id IN (
     SELECT mi.id FROM menu_items mi
     JOIN menus m ON m.id = mi.menu_id
     WHERE m.shop_id = 'e0000000-0000-0000-0000-000000000001'
   );

UPDATE option_choices
   SET provenance = 'owner_confirmed'
 WHERE provenance = 'stated'
   AND option_group_id IN (
     SELECT og.id FROM option_groups og
     JOIN menu_items mi ON mi.id = og.menu_item_id
     JOIN menus m ON m.id = mi.menu_id
     WHERE m.shop_id = 'e0000000-0000-0000-0000-000000000001'
   );

-- bot_state is deliberately left at its 'blocked' default for every row —
-- the compiler (§11 item 4, later work) is the only thing allowed to set it
-- for real, so nothing here can be mistaken for a readiness signal.
