-- 073: Add applied_invariants column to test_case_results
--
-- The server-side test-runner edge function accumulates applied invariants
-- per case (e.g. "cartops:total:FAIL", "stated-total:PASS"). This column
-- stores them for UI rendering alongside the judge-provided reason.
--
-- nullable jsonb; no default. NULL = no invariants were applied (legacy rows
-- or cases where no deterministic invariants were relevant).

ALTER TABLE test_case_results ADD COLUMN IF NOT EXISTS applied_invariants jsonb;