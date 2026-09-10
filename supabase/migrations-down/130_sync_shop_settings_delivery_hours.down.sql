-- Rollback for 130_sync_shop_settings_delivery_hours.sql. Does not revert
-- the backfill UPDATE (data change, not a schema change) or restore
-- shop_settings rows to their pre-migration values.
DROP TRIGGER IF EXISTS trg_sync_shop_settings_from_shop ON shops;
DROP FUNCTION IF EXISTS sync_shop_settings_from_shop();
DROP FUNCTION IF EXISTS render_hours_line(JSONB);
