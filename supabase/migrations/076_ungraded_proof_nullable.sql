-- 076: Allow null proof_passed and passed for ungraded cases
--
-- When no invariants are materially applied (refuse-correctly, adversarial,
-- compliance, off-menu), proof_passed is null — not trivially true.
-- passed (boolean) becomes nullable to distinguish "ungraded" from "passed".

-- ═══ test_case_results: make passed nullable ════════════════════════════════

ALTER TABLE test_case_results
  ALTER COLUMN passed DROP NOT NULL;

-- ═══ qa_ro view — expose nullable passed ═══════════════════════════════════

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