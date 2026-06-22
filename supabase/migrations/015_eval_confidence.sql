-- SprintAI — Conversation Judge eval CONFIDENCE annotation (Spec 06 follow-up).
--
-- ADDITIVE ONLY. Touches no existing column's data; only adds one new nullable-
-- defaulted column + one supporting index to conversation_evals. Idempotent
-- (ADD COLUMN IF NOT EXISTS, index IF NOT EXISTS, guarded CHECK add). Reversible:
-- see 015_eval_confidence.down.sql.
--
-- WHY: many old/test conversations have no cart → no resolvable shop → NO menu
-- ground truth. The judge still runs, but its menu-dependent checks (e.g.
-- invented_item) fire against absent ground truth, producing a flood of
-- LOW-TRUST criticals that drown out real signal. `confidence` lets the panel
-- (and digest, later) treat ground-truth-less evals as advisory:
--   'high' = the judge had real menu ground truth for this conversation.
--   'low'  = no resolvable shop/menu ground truth (shopId null or no menu).
-- Confidence is ORTHOGONAL to severity. It never suppresses, deletes, or
-- downgrades a flag — a real invented_item on a real menu stays CRITICAL/high.

-- ── confidence column ────────────────────────────────────────────────────────
ALTER TABLE conversation_evals
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'high';

-- Guarded CHECK add (constraints have no IF NOT EXISTS in older PG; guard via
-- catalog lookup so re-running this whole file is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_evals_confidence_check'
      AND conrelid = 'conversation_evals'::regclass
  ) THEN
    ALTER TABLE conversation_evals
      ADD CONSTRAINT conversation_evals_confidence_check
      CHECK (confidence IN ('high', 'low'));
  END IF;
END$$;

-- ── sorting index ────────────────────────────────────────────────────────────
-- Primary panel read path becomes: by tenant, HIGH-confidence first, worst
-- severity first, newest first. A btree on (tenant_id, confidence, max_severity,
-- judged_at DESC) supports that ordering cheaply. NOTE: text sort puts 'high'
-- before 'low' alphabetically, which is the order we want (high first).
CREATE INDEX IF NOT EXISTS idx_conversation_evals_tenant_conf_sev_judged
  ON conversation_evals (tenant_id, confidence, max_severity, judged_at DESC);

COMMENT ON COLUMN conversation_evals.confidence IS
  'Judge ground-truth confidence: high = real menu ground truth was loaded for this conversation; low = no resolvable shop/menu (shopId null or no menu items). Orthogonal to severity; never suppresses or downgrades a flag. Used by the Conversation Quality panel to sort high-confidence first and render low-confidence evals as advisory.';

-- ============================================================================
-- ROLLBACK NOTES (see 015_eval_confidence.down.sql for the executable down):
--   Purely additive — adds one column + one index + one CHECK to an existing
--   table and writes no data. The down script drops only those objects. Default
--   'high' backfills existing rows non-destructively; the down removes the
--   column entirely. No source data (conversations/menus) is touched.
-- ============================================================================
