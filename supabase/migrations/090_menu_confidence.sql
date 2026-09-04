-- 089 — Confidence score per menu item (INSTRUCTION-10 item F).
-- Each extracted item gets a 0.0-1.0 confidence score. Confident items are
-- presented as the "taste"; low-confidence items become specific questions
-- for the owner. This turns the first impression from an audit into a curation
-- experience.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS confidence_score REAL NOT NULL DEFAULT 1.0;

COMMENT ON COLUMN menu_items.confidence_score IS
  '0.0-1.0 extraction confidence. 1.0 = confirmed (3/3 consensus, verified price present in source, LLM self-reports high). 0.0 = needs owner review. Used to sort menu grid: confident first, low-confidence items presented as questions.';

CREATE INDEX IF NOT EXISTS idx_menu_items_confidence
  ON menu_items (menu_id, confidence_score);