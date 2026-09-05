-- 094: Item K — document the new "partial" crawl_status state.
--
-- shops.crawl_status is a free-text column (no CHECK constraint at time of
-- writing — confirmed via `supabase db dump`). scrape-shop now writes
-- "partial" when the site was read successfully but zero menu items landed,
-- instead of falsely reporting "done". This migration only refreshes the
-- column comment; no schema change is needed since nothing constrains the
-- value today.
COMMENT ON COLUMN shops.crawl_status IS 'Crawl state: pending, running, done, partial, failed. "partial" = site read OK but no menu items extracted (see crawl_error for the owner-facing reason).';
