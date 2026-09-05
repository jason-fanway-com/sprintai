-- 095: test_transcripts — capture human test conversations verbatim
--
-- Spec: docs/specs/2026-09-05-test-capture.md (Jason, 2026-09-05).
--
-- WHY
-- ---
-- Two human test orders found eleven real defects that months of AI-to-AI
-- testing missed. Those transcripts existed only in a chat window. This makes
-- capture one tap, and permanent. Over time these become the regression corpus
-- we do not currently have.
--
-- DESIGN NOTES
-- ------------
--   * NO foreign key on shop_id, deliberately. Acceptance #4: "A transcript
--     survives its shop being deleted." An FK would either block the delete or
--     null the id; we want the row untouched. `shop_name` is denormalised for
--     the same reason — it is the durable label once the shop row is gone.
--   * `messages` is stored verbatim, both directions, including the cart footer
--     lines exactly as the bot sent them. Every defect found this week was
--     visible in the exact wording. Nothing summarises or reformats this column.
--   * `tenant_id` is NOT in the spec's column list. It is added here because
--     tenant isolation is a hard rule: without it there is no way to write an
--     INSERT policy that stops one tenant filing transcripts against another's
--     shop. It is captured at insert time and never used for display.
--   * No retention policy and no auto-cleanup, per spec. These accumulate.
--   * No analysis, scoring, or judging columns. Capture only — judgement stays
--     with the product owner.

CREATE TABLE IF NOT EXISTS test_transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid,                      -- intentionally no FK; see above
  tenant_id     uuid,                      -- for RLS only
  shop_name     text NOT NULL,
  model         text,                      -- which model served the conversation
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{role, text, at}] verbatim
  final_cart    jsonb,                     -- items + total at end of conversation
  reporter_note text,                      -- the "what felt wrong" answer; optional
  source        text NOT NULL DEFAULT 'simulator',
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT test_transcripts_source_check CHECK (source IN ('simulator', 'field'))
);

CREATE INDEX IF NOT EXISTS test_transcripts_shop_id_idx    ON test_transcripts (shop_id);
CREATE INDEX IF NOT EXISTS test_transcripts_created_at_idx ON test_transcripts (created_at DESC);

COMMENT ON TABLE  test_transcripts IS
  'Human test conversations captured verbatim from the chat simulator or the field. Capture only — no automatic analysis, scoring, or judging. See docs/specs/2026-09-05-test-capture.md.';
COMMENT ON COLUMN test_transcripts.messages IS
  'Ordered [{role, text, at}] covering BOTH directions, verbatim, including cart footers exactly as sent. Never summarise, truncate, or reformat this column.';
COMMENT ON COLUMN test_transcripts.shop_name IS
  'Denormalised on purpose: shops get deleted, transcripts outlive them.';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Writers are user JWTs from the admin dashboard (super-admin or shop owner),
-- not an edge function, so the policies below are the real gate.
--
--   INSERT — a super-admin, or a shop owner filing against their OWN tenant.
--            Cross-tenant inserts are refused.
--   SELECT — super-admins only. Owners have no reason to read the corpus back,
--            and denying it keeps one tenant's transcripts away from another.
--            The product owner reads through qa_ro (below), not this table.
--   UPDATE/DELETE — no policy at all. These are an append-only record; nothing
--            holding a user JWT may rewrite or erase a captured transcript.

ALTER TABLE test_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_transcripts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON test_transcripts FROM anon;

DROP POLICY IF EXISTS "Insert own-tenant test transcripts" ON test_transcripts;
CREATE POLICY "Insert own-tenant test transcripts" ON test_transcripts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND tenant_id::text = public.current_user_tenant_id())
  );

DROP POLICY IF EXISTS "Super admins read test transcripts" ON test_transcripts;
CREATE POLICY "Super admins read test transcripts" ON test_transcripts
  FOR SELECT TO authenticated
  USING (public.is_super_admin());

GRANT INSERT, SELECT ON test_transcripts TO authenticated;

-- ── qa_ro exposure ─────────────────────────────────────────────────────────
-- The product owner reads the corpus through the read-only schema, same as the
-- other QA surfaces. Every column, since the whole point is reading them.

CREATE SCHEMA IF NOT EXISTS qa_ro;

CREATE OR REPLACE VIEW qa_ro.test_transcripts AS
  SELECT id,
    shop_id,
    shop_name,
    model,
    messages,
    final_cart,
    reporter_note,
    source,
    created_at
  FROM test_transcripts;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_readonly') THEN
    GRANT USAGE ON SCHEMA qa_ro TO qa_readonly;
    GRANT SELECT ON qa_ro.test_transcripts TO qa_readonly;
    RAISE NOTICE '095: granted qa_readonly SELECT on qa_ro.test_transcripts';
  ELSE
    RAISE NOTICE '095: role qa_readonly absent — skipped grant';
  END IF;
END $$;
