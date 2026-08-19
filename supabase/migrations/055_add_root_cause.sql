-- 055_add_root_cause.sql
-- Add root_cause text column to test_case_results so the fix loop can capture
-- WHY a case failed (derived from transcript + judge findings).
-- Also tighten fix_status defaults.
-- Additive, backward-compatible.

alter table test_case_results
  add column if not exists root_cause text;

-- Ensure existing rows with null fix_status get 'open'
update test_case_results
  set fix_status = 'open'
  where fix_status is null;

alter table test_case_results
  alter column fix_status set default 'open';