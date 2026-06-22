-- DOWN / rollback for 015_eval_confidence.sql (Spec 06 follow-up).
--
-- Reversible: drops ONLY the objects 015 created (the confidence index, the
-- confidence CHECK constraint, the confidence column). Touches no pre-existing
-- column's data. Idempotent (IF EXISTS everywhere) so it is safe to re-run.
--
-- Dropping the confidence column discards a derived annotation only; it is
-- regenerable (the judge re-derives confidence on the next sweep). No source
-- data is affected. Per the destructive-ops guardrail, running this in any
-- shared DB still requires explicit human approval.

DROP INDEX IF EXISTS idx_conversation_evals_tenant_conf_sev_judged;

ALTER TABLE conversation_evals
  DROP CONSTRAINT IF EXISTS conversation_evals_confidence_check;

ALTER TABLE conversation_evals
  DROP COLUMN IF EXISTS confidence;
