-- 103: judge panel — advisory critique columns on test_transcripts
--
-- Spec: docs/specs/2026-09-05-judge-panel.md (Jason, 2026-09-05).
-- Extends 095_test_transcripts.sql.
--
-- WHY
-- ---
-- A restaurant owner plays with the simulator, sends a conversation for
-- review, and gets back a plain-language critique of their own conversation.
-- That critique needs somewhere to live on the transcript it judged.
--
-- DESIGN NOTES
-- ------------
--   * This is the ADVISORY lane, distinct from conversation_evals (the
--     deterministic-gating rubric judge in eval-sweep). Nothing here gates
--     anything. A human reads judge_summary/judge_score/judge_proposals and
--     decides; nothing downstream acts on these columns automatically.
--   * judge_proposals is an array of {title, rationale, target, status}.
--     status starts, and — per the hard constraint in the spec — stays
--     'proposed' from every code path this migration or its function touch.
--     There is no UPDATE policy or code path that flips it to 'applied'.
--   * No FK, no cascade, no new RLS policy needed for the write path: the
--     judge runs under the service-role key (see judge-transcript function),
--     which bypasses RLS regardless of the FORCE ROW LEVEL SECURITY set in
--     095. No policy is added for UPDATE by user JWTs — same invariant 095
--     established: nothing holding a user JWT may rewrite a transcript row.

ALTER TABLE test_transcripts
  ADD COLUMN IF NOT EXISTS judge_summary   text,
  ADD COLUMN IF NOT EXISTS judge_score     int,
  ADD COLUMN IF NOT EXISTS judge_proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS judged_at       timestamptz;

ALTER TABLE test_transcripts
  DROP CONSTRAINT IF EXISTS test_transcripts_judge_score_range;
ALTER TABLE test_transcripts
  ADD CONSTRAINT test_transcripts_judge_score_range
  CHECK (judge_score IS NULL OR (judge_score >= 0 AND judge_score <= 100));

COMMENT ON COLUMN test_transcripts.judge_summary IS
  'Plain-language read of the conversation for a restaurant owner: what went well, what went wrong, naming the specific turn. No jargon, no rule names, no file paths.';
COMMENT ON COLUMN test_transcripts.judge_score IS
  'Advisory only, 0-100. Never gates anything — deterministic scoring (conversation_evals) gates, this lane does not.';
COMMENT ON COLUMN test_transcripts.judge_proposals IS
  'Array of {title, rationale, target, status}. status starts (and, from every code path here, stays) ''proposed''. Never auto-applied to the live engine, a shop''s prompt, or shared config.';
COMMENT ON COLUMN test_transcripts.judged_at IS
  'When the judge produced judge_summary/judge_score/judge_proposals. Null until judged.';

-- ── qa_ro exposure ─────────────────────────────────────────────────────────
-- Same view, now including the judge columns so the product owner can read
-- the proposal queue.

-- NOTE: the live view (past migration 096) also carries `tester_name`, which
-- is not in the 095 file as originally written. Preserve it here so this
-- CREATE OR REPLACE doesn't drop a column another migration already added.
CREATE OR REPLACE VIEW qa_ro.test_transcripts AS
  SELECT id,
    shop_id,
    shop_name,
    model,
    messages,
    final_cart,
    reporter_note,
    source,
    tester_name,
    created_at,
    judge_summary,
    judge_score,
    judge_proposals,
    judged_at
  FROM test_transcripts;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_readonly') THEN
    GRANT SELECT ON qa_ro.test_transcripts TO qa_readonly;
    RAISE NOTICE '103: granted qa_readonly SELECT on qa_ro.test_transcripts (judge columns)';
  ELSE
    RAISE NOTICE '103: role qa_readonly absent — skipped grant';
  END IF;
END $$;
