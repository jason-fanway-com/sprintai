-- 134: test_runs provenance — trigger_type, change_set_ref, initiated_by
--
-- Overnight 2026-09-10/11, test_runs accumulated 9 full 151-case acceptance
-- suite runs against Vito's Pizza with zero label distinguishing them — every
-- row's notes column just said "Test suite run against Vito's Pizza". Several
-- were pure re-runs with no code change between them (model-variance noise),
-- not per-fix verification, and the product owner had to reconstruct intent
-- from commit timestamps. A run whose cause isn't in the row can't be
-- questioned or stopped.
--
-- Nullable at the DB level — historical rows stay untouched, no backfill.
-- The enforcement point is the app layer: persist.ts's assertValidProvenance
-- refuses to insert a new row missing any of the three fields (same
-- fail-loud-before-insert discipline already established by
-- assertValidProofData for proofPassed).

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS trigger_type text,
  ADD COLUMN IF NOT EXISTS change_set_ref text,
  ADD COLUMN IF NOT EXISTS initiated_by text;

COMMENT ON COLUMN test_runs.trigger_type IS 'Why this run happened: fix-verification | change-set-batch | onboarding | manual-investigation. Enforced non-null at the app layer (persist.ts assertValidProvenance); nullable here so historical rows are untouched.';
COMMENT ON COLUMN test_runs.change_set_ref IS 'What was being verified — a commit SHA, fix/case id, or an explicit literal (e.g. queue-onboarding) when no code ref applies. Enforced non-empty at the app layer.';
COMMENT ON COLUMN test_runs.initiated_by IS 'Who/what triggered this run — a person''s name/handle, or queue-worker:<reason> / queue-test-runner:<reason> for automated runs. Enforced non-empty at the app layer.';

-- ═══ qa_ro.test_runs — expose the new provenance columns ═══════════════════

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
    ungraded_count,
    trigger_type,
    change_set_ref,
    initiated_by
  FROM test_runs;
