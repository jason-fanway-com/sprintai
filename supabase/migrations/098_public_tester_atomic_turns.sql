-- 098: make the public tester's turn cap a real ceiling, and revive the
--      per-browser rate limit that was silently dead.
--
-- Found by QA on 2026-09-05, both confirmed by reproduction.
--
-- DEFECT 1 (HIGH — cost control). The `send` action did a non-atomic
-- read-check-increment: read `turns`, test `>= 20`, then write `turns + 1`.
-- Three concurrent sends against a session seeded at turns=19 produced TWO real
-- model replies where one was allowed, and the concurrent transcript writes
-- clobbered each other. The cap was therefore not a ceiling at all: a client
-- firing N concurrent requests per turn slot gets N model calls while `turns`
-- advances by one. Since cost is quadratic in turns and this is a PUBLIC
-- endpoint, that is the difference between a $30 testing programme and an
-- unbounded bill.
--
-- Fixed by moving both the claim and the transcript append into the database,
-- where they are single atomic statements.
--
-- DEFECT 2 (MEDIUM — dead control). The 3/hour per-browser limit counted rows
-- WHERE session_id = the client's hint, but every row was inserted with a fresh
-- server-generated UUID and never the hint. The count could therefore never
-- exceed 1 and the limit never fired in real use, leaving per-user throttling
-- entirely on the 5/hour IP limit. The hint now gets its own column and is
-- counted there. It is best-effort by nature — a browser can clear it — which is
-- exactly why the IP limit remains the real guard and neither is relied on alone.

ALTER TABLE public_tester_sessions ADD COLUMN IF NOT EXISTS client_hint text;
CREATE INDEX IF NOT EXISTS public_tester_sessions_client_hint_idx
  ON public_tester_sessions (client_hint, created_at DESC);

COMMENT ON COLUMN public_tester_sessions.client_hint IS
  'The browser-supplied prior session id, used ONLY to count that browser''s recent conversations. Never trusted as an identifier. Best-effort: a cleared browser skips it, which is why the IP limit is the real guard.';

-- ── Atomic turn claim ───────────────────────────────────────────────────────
-- Returns the new turn number, or NULL when the cap is already reached. The
-- WHERE clause does the enforcing, so two concurrent callers cannot both win.
CREATE OR REPLACE FUNCTION public.public_tester_claim_turn(
  p_session_id text,
  p_cap        int
) RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public_tester_sessions
     SET turns = turns + 1
   WHERE session_id = p_session_id
     AND turns < p_cap
  RETURNING turns;
$$;

-- ── Atomic transcript append ────────────────────────────────────────────────
-- `messages = messages || <turn>` in one statement. The previous read-modify-write
-- in the edge function lost turns whenever two requests overlapped.
CREATE OR REPLACE FUNCTION public.public_tester_append_turn(
  p_session_id text,
  p_user_text  text,
  p_bot_text   text,
  p_model      text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public_tester_sessions
     SET messages = messages
                 || jsonb_build_array(
                      jsonb_build_object('role','user',     'text', p_user_text, 'at', now()),
                      jsonb_build_object('role','assistant','text', p_bot_text,  'at', now())
                    ),
         model = COALESCE(p_model, model)
   WHERE session_id = p_session_id;
$$;

-- Only the service role calls these. The public never reaches them directly.
REVOKE ALL ON FUNCTION public.public_tester_claim_turn(text, int)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tester_append_turn(text, text, text, text) FROM PUBLIC, anon, authenticated;
