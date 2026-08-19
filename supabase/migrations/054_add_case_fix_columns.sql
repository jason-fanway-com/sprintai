-- 054_add_case_fix_columns.sql
-- Add proposed_fix (text nullable) and fix_status (enum-ish text, default 'open') to
-- test_case_results so the QA console can track remediation per case.
-- Additive, backward-compatible.

alter table test_case_results
  add column if not exists proposed_fix text,
  add column if not exists fix_status text default 'open';