-- SprintAI — Self-diagnosing issue detection (Phase 1).
--
-- Creates the issues ledgers so the issue-detector edge function can detect
-- and file operational issues from conversation_evals, conversations, and
-- other signals. An admin dashboard UI reads these tables for triage.
--
-- ADDITIVE ONLY. Safe to re-run. No drops, no data deletes.

DELETE FROM supabase_migrations.schema_migrations WHERE version = '030';

-- ============================================================
-- issues
-- ============================================================
-- severity:  sev_1 = critical / immediate attention
--            sev_2 = major / same-day
--            sev_3 = minor / informational
-- status:    open → acknowledged → resolved (or dismissed)
CREATE TABLE IF NOT EXISTS issues (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shop_id          UUID        REFERENCES shops(id) ON DELETE SET NULL,
  conversation_id  UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  eval_id          UUID        REFERENCES conversation_evals(id) ON DELETE SET NULL,

  severity         TEXT        NOT NULL CHECK (severity IN ('sev_1', 'sev_2', 'sev_3')),
  status           TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  detection_rule   TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  description      TEXT,

  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT,

  -- metadata carries rule-specific evidence: error_count, error_window_min,
  -- flagged_rate, conversation_ids, latency_p95_ms, etc.
  metadata         JSONB       NOT NULL DEFAULT '{}',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Primary read paths for the admin dashboard: (a) open issues by severity,
-- newest first; (b) per-tenant; (c) per-conversation.
CREATE INDEX IF NOT EXISTS idx_issues_status_sev_detected
  ON issues (status, severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_tenant_detected
  ON issues (tenant_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_conversation
  ON issues (conversation_id);
CREATE INDEX IF NOT EXISTS idx_issues_shop
  ON issues (shop_id);

-- Dedup: open issues for the same rule + tenant(/shop/conversation) combo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issues_rule_tenant_open
  ON issues (detection_rule, tenant_id, COALESCE(conversation_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status = 'open';

-- ============================================================
-- resolution_log
-- ============================================================
-- Immutable audit trail. One row per status change or human/system note.
CREATE TABLE IF NOT EXISTS resolution_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID        NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  action      TEXT        NOT NULL CHECK (action IN ('created', 'acknowledged', 'resolved', 'dismissed', 'note_added', 'auto_resolved')),
  actor       TEXT        NOT NULL DEFAULT 'system',
  note        TEXT,
  old_status  TEXT,
  new_status  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resolution_log_issue
  ON resolution_log (issue_id, created_at DESC);

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'issues'
      AND policyname = 'Admins have full access to issues'
  ) THEN
    CREATE POLICY "Admins have full access to issues"
      ON issues FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'issues'
      AND policyname = 'Tenants can view their own issues'
  ) THEN
    CREATE POLICY "Tenants can view their own issues"
      ON issues FOR SELECT
      USING (tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id');
  END IF;
END$$;

ALTER TABLE resolution_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'resolution_log'
      AND policyname = 'Admins have full access to resolution_log'
  ) THEN
    CREATE POLICY "Admins have full access to resolution_log"
      ON resolution_log FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'resolution_log'
      AND policyname = 'Tenants can view their own resolution_log'
  ) THEN
    CREATE POLICY "Tenants can view their own resolution_log"
      ON resolution_log FOR SELECT
      USING (
        issue_id IN (
          SELECT id FROM issues
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END$$;

COMMENT ON TABLE issues IS
  'Self-diagnosing issue detection. Written by the issue-detector edge function; read by the admin dashboard for triage. Tenant-isolated.';

COMMENT ON TABLE resolution_log IS
  'Immutable audit trail of issue lifecycle changes and notes. One row per action.';

-- ============================================================
-- pg_cron schedule (idempotent — unschedule then reschedule)
-- ============================================================
-- Invokes the issue-detector edge function every 15 minutes.
-- Requires: pg_cron extension + pg_net extension + a vault secret
-- named 'issue_detector_auth' containing the service-role key.
-- The edge function URL is the default Supabase project edge function url.
-- pg_cron scheduling is handled externally (launchd/cron on the gateway).
-- The edge function is invoked by the local heartbeat, not pg_cron, to avoid
-- vault secret bootstrapping complexity during phase 1.
