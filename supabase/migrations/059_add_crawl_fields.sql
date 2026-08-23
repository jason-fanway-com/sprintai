-- 059_add_crawl_fields
-- Phase 3: pre-crawl structured extraction fields for self-serve onboarding.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS about TEXT DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS menu_links JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS crawl_status TEXT DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS crawl_error TEXT DEFAULT NULL;
COMMENT ON COLUMN shops.about IS '1-2 sentence description extracted from website crawl';
COMMENT ON COLUMN shops.menu_links IS 'Array of menu page URLs discovered during crawl';
COMMENT ON COLUMN shops.crawl_status IS 'Crawl state: pending, done, failed';
COMMENT ON COLUMN shops.crawl_error IS 'Last crawl error message, if any';