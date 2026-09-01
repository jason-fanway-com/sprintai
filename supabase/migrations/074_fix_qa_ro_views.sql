-- 074: Fix qa_ro read-only views — add missing columns
--
-- The test_run_queue view was missing max_cases + case_filter (added in 072).
-- The test_case_results view was missing applied_invariants (added in 073).
-- Both views live in the qa_ro schema, which is intentionally read-only.
-- The views are CREATE OR REPLACE so this is safe to re-run.
--
-- qa_ro schema already exists in prod (provisioned with the read-only role).
-- CREATE SCHEMA IF NOT EXISTS is defensive only — makes this migration safe
-- against a clean-DB rebuild where the schema has not been provisioned yet.

CREATE SCHEMA IF NOT EXISTS qa_ro;

-- ── test_run_queue — add max_cases + case_filter ──────────────────────────

CREATE OR REPLACE VIEW qa_ro.test_run_queue AS
  SELECT id,
    shop_id,
    tenant_id,
    status,
    reason,
    error,
    test_run_id,
    requested_at,
    started_at,
    finished_at,
    case_index,
    total_cases,
    cases_json,
    scored_json,
    shop_name,
    max_cases,
    case_filter
  FROM test_run_queue;

-- ── test_case_results — add applied_invariants ────────────────────────────

CREATE OR REPLACE VIEW qa_ro.test_case_results AS
  SELECT id,
    run_id,
    case_id,
    category,
    criticality,
    transcript,
    success_criteria,
    passed,
    verdict,
    reason,
    created_at,
    proposed_fix,
    fix_status,
    root_cause,
    bot_segments,
    reached_checkout,
    applied_invariants
  FROM test_case_results;