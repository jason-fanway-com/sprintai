-- 029_admin_chat_observability.sql
-- Log every admin-chat turn for debugging & observability.
-- Captures raw messages, LLM responses, proposals, outcomes, and errors.

CREATE TABLE IF NOT EXISTS admin_chat_transcripts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID        REFERENCES shops(id) ON DELETE CASCADE,
  user_id         TEXT,
  session_id      TEXT,         -- conversation turn grouping
  turn_type       TEXT        NOT NULL,  -- 'message' | 'confirmation' | 'undo'
  raw_message     TEXT,         -- what the user typed/said
  message_history JSONB,        -- the message_history array sent to LLM
  llm_raw_response JSONB,       -- full raw LLM API response
  parsed_intent   TEXT,         -- the intent name (EIGHTYSIX_ITEM, etc.) or NULL
  parsed_proposal JSONB,        -- the parsed proposal object
  outcome         TEXT        NOT NULL,  -- see docs below
  response_sent   JSONB,        -- the exact JSON response returned to the client
  error_message   TEXT,         -- if outcome is error
  latency_ms      INTEGER,      -- time from request received to response sent
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- outcome values:
--   confirmation_card  — proposal validated, confirmation card returned
--   clarification      — needs_clarification, clarification card returned
--   executed           — action was executed (confirm or undo)
--   query_status       — status query answered
--   out_of_scope       — UNKNOWN_OR_OUT_OF_SCOPE
--   no_tool_call       — LLM returned text without a tool call
--   validation_error   — proposal failed validation
--   api_error          — LLM API call failed
--   error              — any other error (auth, bad request, etc.)

CREATE INDEX IF NOT EXISTS idx_admin_chat_transcripts_shop_id ON admin_chat_transcripts(shop_id);
CREATE INDEX IF NOT EXISTS idx_admin_chat_transcripts_created ON admin_chat_transcripts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_chat_transcripts_outcome ON admin_chat_transcripts(outcome);
CREATE INDEX IF NOT EXISTS idx_admin_chat_transcripts_user_id ON admin_chat_transcripts(user_id);

ALTER TABLE admin_chat_transcripts ENABLE ROW LEVEL SECURITY;

-- Platform admins have full access
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admins have full access to admin_chat_transcripts') THEN
    CREATE POLICY "Admins have full access to admin_chat_transcripts"
      ON admin_chat_transcripts FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- Tenants can view their own transcripts
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can view their own chat transcripts') THEN
    CREATE POLICY "Tenants can view their own chat transcripts"
      ON admin_chat_transcripts FOR SELECT
      USING (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

-- Service role (edge function) can insert
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service can insert chat transcripts') THEN
    CREATE POLICY "Service can insert chat transcripts"
      ON admin_chat_transcripts FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;
