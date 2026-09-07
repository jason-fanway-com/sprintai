-- Migration 115: Full unique constraints on import_key columns
-- Replaces the partial unique indexes from migration 010 with proper UNIQUE
-- constraints so PostgREST's on_conflict resolution works.
--
-- Background: migration 010 added partial unique indexes
-- (uniq_option_groups_import_key on option_groups(menu_item_id, import_key)
-- WHERE import_key IS NOT NULL, same pattern for option_choices).  PostgreSQL
-- treats these as unique for INSERT/UPDATE enforcement, but PostgREST
-- requires a full UNIQUE constraint (not a partial index) for
-- ?on_conflict=col1,col2 resolution — returning 42P10 "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" when the
-- script attempts upsert.
--
-- Standard PostgreSQL UNIQUE constraints still allow multiple NULLs (NULLs
-- are not considered equal for uniqueness), so the existing data with null
-- import_keys is safe.

-- === option_groups ===
ALTER TABLE option_groups
  ADD CONSTRAINT uniq_option_groups_menu_item_import_key
  UNIQUE (menu_item_id, import_key);

-- Drop the now-redundant partial index (not strictly required, but avoids
-- having two unique structures enforcing the same rule).
DROP INDEX IF EXISTS uniq_option_groups_import_key;

-- === option_choices ===
ALTER TABLE option_choices
  ADD CONSTRAINT uniq_option_choices_option_group_import_key
  UNIQUE (option_group_id, import_key);

DROP INDEX IF EXISTS uniq_option_choices_import_key;