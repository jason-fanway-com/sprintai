-- 075: Proof / quality score split + orphan-persist guard column
--
-- Decouples the deterministic proof gate from the LLM judge (advisory quality).
-- proof_passed / proof_pass_pct are the GATE values — 100%-or-no-launch.
-- quality_passed / quality_pass_pct are ADVISORY (tone, drift, loops).
--
-- Also adds 'persisting' as a valid queue status for the atomic claim-and-persist
-- pattern that closes the orphan-duplicate window (second cron tick re-entry).

-- ═══ test_runs: add proof_pass_pct + quality_pass_pct ═══════════════════════

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS proof_pass_pct numeric,
  ADD COLUMN IF NOT EXISTS quality_pass_pct numeric;

-- Back-compat: existing overall_pass_pct = proof_pass_pct
-- (overall_pass_pct stays for dashboard display; proof_pass_pct is the split field)
UPDATE test_runs SET proof_pass_pct = overall_pass_pct WHERE proof_pass_pct IS NULL AND overall_pass_pct IS NOT NULL;

-- ═══ test_case_results: add proof_passed + quality_passed ═══════════════════

ALTER TABLE test_case_results
  ADD COLUMN IF NOT EXISTS proof_passed boolean,
  ADD COLUMN IF NOT EXISTS quality_passed boolean;

-- Back-compat: existing passed = proof_passed
UPDATE test_case_results SET proof_passed = passed WHERE proof_passed IS NULL AND passed IS NOT NULL;
UPDATE test_case_results SET quality_passed = passed WHERE quality_passed IS NULL AND passed IS NOT NULL;

-- ═══ qa_ro views — expose split columns ═════════════════════════════════════

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
    quality_pass_pct
  FROM test_runs;

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