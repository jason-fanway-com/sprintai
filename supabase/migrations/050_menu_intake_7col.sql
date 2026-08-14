-- 050_menu_intake_7col.sql
-- Additive migration for 7-column canonical menu schema (Menu Intake Standard)
-- Supports: prompt_for, upsell, nullable prices, content_hash, menu_approvals (§C), Open Questions
-- ADDITIVE ONLY. No drops. No data mutation.

-- ---- menu_items: 7-column canonical fields ---------------------------------

-- price_cents → nullable (blank/market-price items per Standard Rule 2)
ALTER TABLE menu_items ALTER COLUMN price_cents DROP NOT NULL;

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS prompt_for TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS upsell     TEXT;

-- Track whether this row is an item or a modifier-block entry
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS row_type TEXT
  CHECK (row_type IN ('item', 'modifier'))
  DEFAULT 'item';

COMMENT ON COLUMN menu_items.prompt_for IS 'Required choices the ordering AI must ask (semicolon-separated). Blank if none.';
COMMENT ON COLUMN menu_items.upsell     IS 'Optional add-ons + cross-sell nudge (semicolon-separated). Blank if none.';
COMMENT ON COLUMN menu_items.row_type   IS 'item = sellable product row; modifier = modifier-block option row.';

-- ---- menus: content hash + extraction metadata + open questions -------------

ALTER TABLE menus ADD COLUMN IF NOT EXISTS content_hash        TEXT;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS open_questions      JSONB DEFAULT '[]';
ALTER TABLE menus ADD COLUMN IF NOT EXISTS extraction_metadata JSONB DEFAULT '{}';
ALTER TABLE menus ADD COLUMN IF NOT EXISTS validated           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ;

COMMENT ON COLUMN menus.content_hash        IS 'SHA-256 of canonical CSV content. Changes invalidate owner approval.';
COMMENT ON COLUMN menus.open_questions      IS 'Array of {item_ref, issue, question} from extraction.';
COMMENT ON COLUMN menus.extraction_metadata IS '{ model, tokens_used, latency_ms, passes, text_extracted_chars, sections_found }';
COMMENT ON COLUMN menus.validated           IS 'true after §A validator passes.';
COMMENT ON COLUMN menus.approved_at         IS 'Timestamp of owner sign-off (§C). NULL = not yet approved.';

-- ---- menu_approvals: owner sign-off gate (§C) -------------------------------

CREATE TABLE IF NOT EXISTS menu_approvals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id      UUID        NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  content_hash TEXT        NOT NULL,
  approved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by  UUID        NOT NULL,
  UNIQUE(menu_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_menu_approvals_menu ON menu_approvals(menu_id, approved_at DESC);

COMMENT ON TABLE menu_approvals IS 'Immutable owner attestation records (§C). A menu cannot go live without a matching approval for its current content_hash.';

-- ---- flag_review: owner-correction surfacing for flagged rows ---------------

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS flag_review   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS flag_reason   TEXT;

COMMENT ON COLUMN menu_items.flag_review IS 'True when price missing, low-confidence, or diff-disagreement — owner must review.';
COMMENT ON COLUMN menu_items.flag_reason IS 'Why this row is flagged for review (e.g. "price disagreement in double-extract diff").';