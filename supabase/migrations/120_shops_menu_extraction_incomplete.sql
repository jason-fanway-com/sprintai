-- Migration 120: additive honesty signal for scrape-shop's menu extraction
--
-- extractMenuItems() (supabase/functions/scrape-shop/index.ts) splits a
-- shop's page text into concurrent chunks and merges the per-chunk LLM
-- results. Until now a chunk that errored/timed out came back as null and
-- was silently skipped, and a merge over the 300-item cap was silently
-- sliced -- either way the caller could still end up with menuHasUsableItems
-- = true and report crawl_status = "done" over a menu that's missing items.
-- Same class of dishonesty as the false-done bug already fixed elsewhere in
-- this crawl path.
--
-- These two columns are a separate, non-blocking signal only. They do NOT
-- change the meaning of crawl_status/crawl_error -- other code (the
-- already-crawled skip check, retry logic) depends on those exactly as they
-- are today. Both default to their "nothing wrong" values, so a shop with
-- no incomplete extraction never has these columns touched.
alter table shops
  add column if not exists menu_extraction_incomplete boolean not null default false;

alter table shops
  add column if not exists menu_extraction_note text;

comment on column shops.menu_extraction_incomplete is
  'Additive, non-blocking honesty signal (item ef07866d): true when a scrape-shop run ended with usable menu items (crawl_status=done) but the rung-1 website extraction dropped at least one failed/timed-out chunk or exceeded the 300-item merge cap. Does not affect crawl_status/crawl_error or retry/skip logic.';

comment on column shops.menu_extraction_note is
  'Human-readable detail set alongside menu_extraction_incomplete=true, e.g. "1/4 extraction chunk(s) failed". Null whenever menu_extraction_incomplete is false.';
