-- 146: error_log.stage — add 'propose_success' as an allowed value.
--
-- 2026-09-18 PO dispatch (two-regressions item c): propose.ts's own
-- successful path (commit 3070a9ce, logProposeSuccess) has been writing
-- ZERO rows since it shipped — every insert has been silently rejected by
-- this table's own CHECK constraint, which never learned about the new
-- stage value. logError/logProposeSuccess are both deliberately FAIL-OPEN
-- (never throw, only console.error), so the rejection never surfaced
-- anywhere a human would see it — confirmed live via a direct insert
-- probe with the service-role key: Postgres error 23514,
-- "new row for relation \"error_log\" violates check constraint
-- \"error_log_stage_check\"". Same root cause and same fix shape as 140
-- (propose_call) and 142 (lexicon_load) before it.
--
-- ADDITIVE ONLY. Widens an existing CHECK constraint — no drop, no data
-- loss, no change to any existing row or any other allowed value.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '146';

ALTER TABLE error_log DROP CONSTRAINT IF EXISTS error_log_stage_check;
ALTER TABLE error_log ADD CONSTRAINT error_log_stage_check
  CHECK (stage IN ('tool_loop', 'render', 'outbound_send', 'guard_deny', 'propose_call', 'lexicon_load', 'propose_success'));
