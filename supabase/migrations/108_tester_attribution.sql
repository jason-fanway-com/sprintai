-- 108: make testers distinguishable.
--
-- All 22 public-tester sessions carried one identical ip_hash. My first read was
-- that the hash input was constant. The edge logs say otherwise: x-real-ip and
-- cf-connecting-ip are populated on every request and every request so far
-- genuinely came from 71.185.100.243 — one household/office NAT. The hash is
-- doing its job; the IP simply cannot separate people on one network, and it
-- never will. Nothing gates on ip_hash (the daily cap counts rows, not IPs), so
-- no limiter was misbehaving.
--
-- What DOES separate them is already arriving and being thrown away: the edge
-- logs show curl/8.7.1, iPhone OS 26_6_1, Pixel 8 (Android 14) and Mac Chrome
-- across the same window. We just never stored the User-Agent. Feedback we
-- cannot attribute is feedback we cannot act on, and this blocks sending the
-- Test Kitchen link to anyone.

ALTER TABLE public_tester_sessions
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  -- First time this browser (client_hint) was ever seen. Lets a returning
  -- tester be recognised across sessions without any per-person identifier.
  ADD COLUMN IF NOT EXISTS client_first_seen_at TIMESTAMPTZ;

ALTER TABLE test_transcripts
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

COMMENT ON COLUMN public_tester_sessions.user_agent IS
  'Raw User-Agent. The only field that separates testers behind one NAT — ip_hash cannot.';
COMMENT ON COLUMN public_tester_sessions.client_first_seen_at IS
  'Earliest session for this client_hint. NULL = first ever session for this browser.';

CREATE OR REPLACE VIEW qa_ro.test_transcripts AS
  SELECT id, shop_id, shop_name, model, messages, final_cart,
         reporter_note, source, tester_name, created_at,
         judge_summary, judge_score, judge_proposals, judged_at,
         user_agent
    FROM test_transcripts;

-- Who is actually testing, in one query, without a join.
CREATE OR REPLACE VIEW qa_ro.public_tester_sessions AS
  SELECT s.id, s.session_id, s.client_hint, s.shop_id, s.turns, s.submitted,
         s.model, s.created_at, s.ip_hash, s.user_agent, s.client_first_seen_at,
         CASE
           WHEN s.user_agent IS NULL                       THEN 'unknown'
           WHEN s.user_agent ILIKE '%curl%'
             OR s.user_agent ILIKE '%python%'              THEN 'script'
           WHEN s.user_agent ILIKE '%iPhone%'              THEN 'iPhone'
           WHEN s.user_agent ILIKE '%iPad%'                THEN 'iPad'
           WHEN s.user_agent ILIKE '%Android%'             THEN 'Android'
           WHEN s.user_agent ILIKE '%Macintosh%'           THEN 'Mac'
           WHEN s.user_agent ILIKE '%Windows%'             THEN 'Windows'
           ELSE 'other'
         END AS device,
         (s.client_first_seen_at IS NULL
          OR s.client_first_seen_at >= s.created_at) AS is_first_session
    FROM public_tester_sessions s;

GRANT SELECT ON qa_ro.test_transcripts        TO qa_readonly;
GRANT SELECT ON qa_ro.public_tester_sessions  TO qa_readonly;
