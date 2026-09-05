-- Down for 103_judge_panel.sql. Reversible, idempotent.
-- Restores qa_ro.test_transcripts to its 095 shape and drops only the
-- columns this migration added. Leaves everything else untouched.

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
    created_at
  FROM test_transcripts;

ALTER TABLE test_transcripts
  DROP CONSTRAINT IF EXISTS test_transcripts_judge_score_range;

ALTER TABLE test_transcripts
  DROP COLUMN IF EXISTS judge_summary,
  DROP COLUMN IF EXISTS judge_score,
  DROP COLUMN IF EXISTS judge_proposals,
  DROP COLUMN IF EXISTS judged_at;
