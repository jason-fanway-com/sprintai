-- 125: D1 compile-time derived rows schema
-- (docs/specs/2026-09-07-conversation-ready-menu-design.md §11 item 4, stream D1)
--
-- Adds support for compiler-generated (base pizza × topping) rows: one menu_items
-- row per (base item × single composable choice). Idempotent — safe to re-run.

-- ============================================================
-- provenance enum — add 'derived' (Postgres 12+ IF NOT EXISTS syntax)
-- ============================================================
DO $$ BEGIN
  ALTER TYPE provenance ADD VALUE 'derived' AFTER 'defaulted';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- menu_items — derived-row columns
-- ============================================================
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_derived   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS derived_from JSONB;

-- ============================================================
-- option_choices — not_composable flag
-- Choices flagged not_composable are skipped when generating derived rows
-- (e.g. "Extra Cheese", "Half and Half", "Light Sauce").
-- ============================================================
ALTER TABLE option_choices
  ADD COLUMN IF NOT EXISTS not_composable BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- Unique index so the compiler can upsert derived items by (menu_id, import_key).
-- The derived entity key ("derived:<base>#<choice>#<size>") is stored in import_key.
-- Applies to all menu_items with a non-null import_key (not just derived rows),
-- so this also guards against accidental duplicate import keys in general.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_menu_import_key
  ON menu_items (menu_id, import_key)
  WHERE import_key IS NOT NULL;

-- ============================================================
-- Pattern-backfill for known not_composable choices. Conservative: only names
-- that are definitively ineligible as composition bases. Tunable via admin UI
-- once owner-facing controls exist.
-- ============================================================
UPDATE option_choices
  SET not_composable = true
 WHERE not_composable = false
   AND lower(name) SIMILAR TO
     '%(extra cheese|extra chz|half and half|half.and.half|light sauce)%';

-- ============================================================
-- RLS: is_derived / derived_from / not_composable are internal compiler
-- columns — existing RLS policies on menu_items and option_choices already
-- cover them. No new policies needed.
-- ============================================================
