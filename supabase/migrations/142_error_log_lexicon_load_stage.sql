-- 142: error_log.stage — add 'lexicon_load' as an allowed value.
--
-- Follow-up to b2440886 (loadItemLexicon paging past PostgREST's silent
-- 1000-row cap). Two gaps found on review: (1) a real PostgREST error on
-- page N>0 of that paginated fetch was silently treated the same as a
-- clean short-page finish, handing back an incomplete lexicon as if it
-- were complete; (2) there was no independent count check to catch a
-- fetch that "completes" cleanly (no error, ends on a short page) but
-- still disagrees with the table. Both cases now write an error_log row
-- so they stop being unfalsifiable, same reasoning migration 140 already
-- established for propose_call: none of ('tool_loop', 'render',
-- 'outbound_send', 'guard_deny', 'propose_call') honestly describes a
-- lexicon-load failure, so this adds a real value instead of mislabeling
-- the row under one of them.
--
-- ADDITIVE ONLY. Widens an existing CHECK constraint — no drop, no data
-- loss, no change to any existing row or any other allowed value.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '142';

ALTER TABLE error_log DROP CONSTRAINT IF EXISTS error_log_stage_check;
ALTER TABLE error_log ADD CONSTRAINT error_log_stage_check
  CHECK (stage IN ('tool_loop', 'render', 'outbound_send', 'guard_deny', 'propose_call', 'lexicon_load'));
