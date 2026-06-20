-- SprintAI Menu Import Migration (Build Spec 04 — Menu Intake Pipeline)
-- Supports CSV->DB import (Stage B): idempotent / diff-based, not delete-all.
--
-- Adds:
--   menus.source 'csv'                       -- distinguish canonical-CSV imports
--   menus.import_hash                         -- content hash of last imported CSV (skip no-op re-imports)
--   menu_items.is_available                   -- owner/agent availability flag (alias of `active` intent;
--                                                kept separate so `active` can mean "exists in current menu"
--                                                while is_available means "sellable right now")
--   menu_items.size_label                     -- the variant size from the CSV (one row per sellable variant)
--   menu_items.import_key                     -- stable natural key (category|name|size) for diff-based upsert
--   menu_items.owner_edited                   -- true once an owner edits a row; protects it from re-import overwrite
--   option_groups.import_key                  -- stable key (menu_item import_key | group name) for diff upsert
--   option_choices.import_key                 -- stable key (group import_key | choice name) for diff upsert
--
-- Idempotency model: re-importing the SAME confirmed CSV is a no-op (import_hash
-- match). A CHANGED CSV diffs against existing rows by import_key: inserts new,
-- updates changed (unless owner_edited), and DEACTIVATES (active=false) rows no
-- longer present — it never hard-deletes owner data.

-- ---- menus -----------------------------------------------------------------

ALTER TABLE menus DROP CONSTRAINT IF EXISTS menus_source_check;
ALTER TABLE menus
  ADD CONSTRAINT menus_source_check CHECK (source IN ('toast', 'manual', 'pdf', 'csv'));

ALTER TABLE menus ADD COLUMN IF NOT EXISTS import_hash TEXT;

-- ---- menu_items ------------------------------------------------------------

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS size_label   TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS import_key   TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS owner_edited BOOLEAN NOT NULL DEFAULT false;

-- A given menu cannot have two rows with the same natural import key.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_menu_items_import_key
  ON menu_items(menu_id, import_key)
  WHERE import_key IS NOT NULL;

-- ---- option_groups ---------------------------------------------------------

ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS import_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_option_groups_import_key
  ON option_groups(menu_item_id, import_key)
  WHERE import_key IS NOT NULL;

-- ---- option_choices --------------------------------------------------------

ALTER TABLE option_choices ADD COLUMN IF NOT EXISTS import_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_option_choices_import_key
  ON option_choices(option_group_id, import_key)
  WHERE import_key IS NOT NULL;
