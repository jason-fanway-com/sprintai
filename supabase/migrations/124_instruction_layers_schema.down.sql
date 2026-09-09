-- 124_instruction_layers_schema.down.sql — rollback for 124.
ALTER TABLE shops DROP COLUMN IF EXISTS prompt_version;

DROP TRIGGER IF EXISTS trg_shop_notes_cap ON shop_notes;
DROP FUNCTION IF EXISTS shop_notes_enforce_cap();

DROP TABLE IF EXISTS shop_notes;
DROP TABLE IF EXISTS shop_voice;
DROP TABLE IF EXISTS shop_settings;
DROP TABLE IF EXISTS prompt_versions;
