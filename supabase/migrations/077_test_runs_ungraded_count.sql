-- 077: Add ungraded_count column to test_runs + expose in qa_ro view
--
-- scorecard.proofUngraded counts adversarial/compliance/refuse-correctly cases
-- where no deterministic invariant was materially applied. This column makes
-- that count persistent so dashboards can show coverage gaps without querying
-- test_case_results.proof_passed IS NULL on every load.

-- ═══ test_runs: add ungraded_count ═══════════════════════════════════════════

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS ungraded_count integer;

-- ═══ qa_ro.test_runs — expose ungraded_count ════════════════════════════════

CREATE OR REPLACE VIEW qa_ro.test_runs AS
  SELECT id,
    shop_id,
    tenant_id,
    started_at,
    label,
    model_tier,
    total,
    passed,
    failed,
    overall_pass_pct,
    category_subscores,
    critical_failures,
    status,
    notes,
    scorer_version,
    proof_pass_pct,
    quality_pass_pct,
    ungraded_count
  FROM test_runs;

-- ═══ qa_ro.test_case_results — refresh to include latest columns ════════════

CREATE OR REPLACE VIEW qa_ro.test_case_results AS
  SELECT id,
    run_id,
    case_id,
    category,
    criticality,
    transcript,
    success_criteria,
    passed,
    proof_passed,
    quality_passed,
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

-- ═══ qa_ro.test_run_queue — refresh ══════════════════════════════════════════

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