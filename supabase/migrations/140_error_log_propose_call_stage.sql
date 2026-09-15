-- 140: error_log.stage — add 'propose_call' as an allowed value.
--
-- Turn Engine Phase 2 (docs/specs/2026-09-14-turn-engine-oversight.md §3b
-- step 3/7, §4 Phase 2). propose.ts is the one place left that calls the
-- model; every failure of that call (non-200, timeout, both attempts
-- exhausted, malformed JSON, schema violation) must persist an error_log
-- row with stage: "propose_call" — today's "Sorry, I ran into a problem"
-- fallback leaves no trace at all (conversation b4c80c78, open item E),
-- and that row is the whole point of the phase. Migration 137's CHECK
-- constraint only allowed ('tool_loop', 'render', 'outbound_send',
-- 'guard_deny'); without this, every propose_call insert fails silently
-- (error-log.ts's logError is fail-open by contract) and the instrument
-- the phase exists to add would never actually fire.
--
-- ADDITIVE ONLY. Widens an existing CHECK constraint — no drop, no data
-- loss, no change to any existing row or any other allowed value.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '140';

ALTER TABLE error_log DROP CONSTRAINT IF EXISTS error_log_stage_check;
ALTER TABLE error_log ADD CONSTRAINT error_log_stage_check
  CHECK (stage IN ('tool_loop', 'render', 'outbound_send', 'guard_deny', 'propose_call'));
