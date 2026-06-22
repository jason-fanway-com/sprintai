-- SprintAI — Conversation Judge eval store (Spec 06).
--
-- An async, READ-ONLY LLM judge writes one row here per judged conversation.
-- This table is NEVER read or written by the live order path (chat-sms). It is
-- populated out-of-band by the scheduled judge worker (eval-sweep edge fn) and
-- read by the admin Command Center "Conversation Quality" panel + Telegram
-- digest. Tenant-aware from day one (NJB is just the first tenant).
--
-- ADDITIVE ONLY. No drops, no destructive mutation, no data deletes. Idempotent
-- (safe to re-run: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, indexes
-- IF NOT EXISTS, policy guards). Reversible: see DOWN script at the bottom
-- (014_conversation_evals.down.sql).

-- ============================================================
-- conversation_evals
-- ============================================================
-- verdict:      'clean'   = nothing fired (quiet)
--               'flagged' = >=1 rubric check fired
--               'errored' = judge could not complete (LLM down / parse fail);
--                           safe-degrade marker, never blocks the sweep
-- max_severity: worst severity present in flags ('critical'|'major'|'minor'),
--               NULL when verdict is 'clean' or 'errored'.
-- flags:        jsonb array of { check, severity, evidence_message_ids[],
--               explanation } — empty array when clean/errored.
CREATE TABLE IF NOT EXISTS conversation_evals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shop_id          UUID        REFERENCES shops(id) ON DELETE SET NULL,
  conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  judged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transcript_hash  TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  verdict          TEXT        NOT NULL DEFAULT 'clean'
                     CHECK (verdict IN ('clean', 'flagged', 'errored')),
  max_severity     TEXT        CHECK (max_severity IN ('critical', 'major', 'minor')),
  flags            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  raw_judge_output TEXT,
  cost_cents       NUMERIC(10,4),
  -- notify bookkeeping: when this eval's flags were pushed to the digest, so we
  -- never re-ping the same flag set. NULL = not yet notified.
  notified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defensive re-adds (in case table pre-existed from a partial baseline). All
-- IF NOT EXISTS so re-running this whole file is a no-op.
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS shop_id          UUID REFERENCES shops(id) ON DELETE SET NULL;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS transcript_hash  TEXT;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS model            TEXT;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS max_severity     TEXT;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS flags            JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS raw_judge_output TEXT;
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS cost_cents       NUMERIC(10,4);
ALTER TABLE conversation_evals ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;

-- One live eval per conversation per transcript hash. Re-judging only happens
-- when the transcript content changes (new hash) → new row. This is the
-- idempotency backstop: the worker also checks before judging, but the unique
-- index guarantees we never store duplicate (conversation, hash) evals even
-- under a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_evals_conv_hash
  ON conversation_evals (conversation_id, transcript_hash);

-- Primary read path for the Command Center panel + digest: by tenant, worst
-- severity first, newest first.
CREATE INDEX IF NOT EXISTS idx_conversation_evals_tenant_sev_judged
  ON conversation_evals (tenant_id, max_severity, judged_at DESC);

-- Fast "which conversations already have a live eval?" lookup for the worker.
CREATE INDEX IF NOT EXISTS idx_conversation_evals_conversation
  ON conversation_evals (conversation_id);

-- Digest seam: find un-notified flagged evals quickly.
CREATE INDEX IF NOT EXISTS idx_conversation_evals_pending_notify
  ON conversation_evals (tenant_id, judged_at DESC)
  WHERE verdict = 'flagged' AND notified_at IS NULL;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
-- Service role (the judge worker + admin-api) bypasses RLS. We still enable RLS
-- and grant: (a) platform admins full read, (b) tenants read-only their OWN
-- rows. This mirrors the tenant-isolation policy shape from 003_ordering_schema.
ALTER TABLE conversation_evals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversation_evals'
      AND policyname = 'Admins have full access to conversation_evals'
  ) THEN
    CREATE POLICY "Admins have full access to conversation_evals"
      ON conversation_evals FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'conversation_evals'
      AND policyname = 'Tenants can view their own conversation_evals'
  ) THEN
    CREATE POLICY "Tenants can view their own conversation_evals"
      ON conversation_evals FOR SELECT
      USING (tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id');
  END IF;
END$$;

COMMENT ON TABLE conversation_evals IS
  'Async LLM judge results (Spec 06). One row per judged conversation+transcript_hash. Written ONLY by the out-of-band judge worker (service role); never touched by the live order path (chat-sms). Read by the Command Center Conversation Quality panel + Telegram digest. Tenant-isolated.';

-- ============================================================================
-- ROLLBACK NOTES (see 014_conversation_evals.down.sql for the executable down):
--   This migration is purely additive — it creates a NEW table + indexes +
--   policies and touches no existing table. The down script drops only the
--   objects this file created. No existing data is affected by up or down.
-- ============================================================================
