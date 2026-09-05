-- 101 — Menu source priority ladder + aggregator provenance
-- Spec: docs/specs/2026-09-05-menu-source-priority.md
--
-- Extends the source vocabulary (additive — nothing removed, nothing renamed)
-- so the ladder's rungs (website / owner_upload / google / aggregator) can be
-- named without breaking existing 'toast' | 'manual' | 'pdf' | 'csv' rows.
-- Adds menu-level `source_detail` (which rung, which URL, every rung tried)
-- and item-level `source` / `source_ref` so a corrected aggregator price can
-- still be told apart from one nobody has looked at yet.

ALTER TABLE menus DROP CONSTRAINT IF EXISTS menus_source_check;
ALTER TABLE menus ADD CONSTRAINT menus_source_check
  CHECK (source IN ('toast', 'manual', 'pdf', 'csv', 'website', 'owner_upload', 'google', 'aggregator'));

ALTER TABLE menus ADD COLUMN IF NOT EXISTS source_detail JSONB;
COMMENT ON COLUMN menus.source_detail IS
  'Provenance for the source priority ladder: { rung, platform, url, fetched_at, rungs_tried: [{rung,source,result,items?}] }. Written by scrape-shop when it runs the ladder. See docs/specs/2026-09-05-menu-source-priority.md.';

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS source_ref TEXT;
COMMENT ON COLUMN menu_items.source IS
  'Same vocabulary as menus.source. Set explicitly by the importer; falls back to the parent menu''s source via trigger when omitted.';
COMMENT ON COLUMN menu_items.source_ref IS
  'The exact URL or file this row was imported from — the aggregator storefront link, the PDF, the website page.';

-- Backfill: every existing row inherits its parent menu's source.
UPDATE menu_items mi SET source = m.source
FROM menus m
WHERE mi.menu_id = m.id AND mi.source IS NULL;

-- Default new rows (from any importer, including ones this migration doesn't
-- touch) to the parent menu's source unless the importer sets it explicitly.
CREATE OR REPLACE FUNCTION menu_items_default_source() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source IS NULL THEN
    SELECT source INTO NEW.source FROM menus WHERE id = NEW.menu_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_menu_items_default_source ON menu_items;
CREATE TRIGGER trg_menu_items_default_source
  BEFORE INSERT ON menu_items
  FOR EACH ROW EXECUTE FUNCTION menu_items_default_source();

-- "Show me every shop still quoting aggregator prices" needs to be an index
-- scan, not a JSON scan.
CREATE INDEX IF NOT EXISTS idx_menu_items_source_aggregator
  ON menu_items (menu_id)
  WHERE source = 'aggregator';
