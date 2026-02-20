-- SprintAI Social Media Engine — Supabase Schema
-- Run this in the Supabase SQL editor (or via psql) to initialize tables.
-- All tables are prefixed with `sprintai_` to avoid conflicts.

-- ============================================================
-- Clients
-- ============================================================
CREATE TABLE IF NOT EXISTS sprintai_clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    plan            TEXT NOT NULL DEFAULT 'starter',   -- starter | growth | pro
    stripe_customer_id TEXT,
    status          TEXT NOT NULL DEFAULT 'active',    -- active | paused | cancelled
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Social Connections (OAuth tokens per platform page)
-- ============================================================
CREATE TABLE IF NOT EXISTS sprintai_social_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id           UUID NOT NULL REFERENCES sprintai_clients(id) ON DELETE CASCADE,
    platform            TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'google_business')),
    page_id             TEXT NOT NULL,                 -- FB page ID, IG user ID, or GBP location name
    page_name           TEXT,
    access_token        TEXT NOT NULL,                 -- encrypted in production via Vault
    token_expires_at    TIMESTAMPTZ,                   -- NULL = non-expiring (Google refresh token)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (client_id, platform, page_id)
);

-- ============================================================
-- Content Calendar (scheduled posts)
-- ============================================================
CREATE TABLE IF NOT EXISTS sprintai_content_calendar (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES sprintai_clients(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'google_business')),
    post_text       TEXT NOT NULL,
    image_url       TEXT,
    scheduled_at    TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'posted', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_calendar_scheduled
    ON sprintai_content_calendar (scheduled_at, status);

CREATE INDEX IF NOT EXISTS idx_content_calendar_client
    ON sprintai_content_calendar (client_id);

-- ============================================================
-- Posts (delivery receipts / error log)
-- ============================================================
CREATE TABLE IF NOT EXISTS sprintai_posts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id         UUID NOT NULL REFERENCES sprintai_content_calendar(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES sprintai_clients(id) ON DELETE CASCADE,
    platform            TEXT NOT NULL,
    external_post_id    TEXT,                          -- ID returned by the platform API
    posted_at           TIMESTAMPTZ,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posts_client
    ON sprintai_posts (client_id);

-- ============================================================
-- Row Level Security — Client Portal
-- Clients authenticated via Supabase Auth can only see their
-- own data. The admin dashboard bypasses RLS via service role key.
-- ============================================================

-- Enable RLS on client-facing tables
ALTER TABLE sprintai_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprintai_content_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprintai_posts ENABLE ROW LEVEL SECURITY;

-- Clients can only read their own record (matched by auth email)
CREATE POLICY "Clients see own record"
  ON sprintai_clients
  FOR SELECT
  USING (email = auth.jwt()->>'email');

-- Clients can only read their own calendar entries
CREATE POLICY "Clients see own calendar"
  ON sprintai_content_calendar
  FOR SELECT
  USING (client_id IN (
    SELECT id FROM sprintai_clients WHERE email = auth.jwt()->>'email'
  ));

-- Clients can only read their own posts
CREATE POLICY "Clients see own posts"
  ON sprintai_posts
  FOR SELECT
  USING (client_id IN (
    SELECT id FROM sprintai_clients WHERE email = auth.jwt()->>'email'
  ));

-- ============================================================
-- Content QA — added by content_qa.py pipeline
-- ============================================================

-- Add QA tracking fields to the content calendar
ALTER TABLE sprintai_content_calendar ADD COLUMN IF NOT EXISTS status_prev VARCHAR(20);
ALTER TABLE sprintai_content_calendar ADD COLUMN IF NOT EXISTS qa_score DECIMAL(3,1);
ALTER TABLE sprintai_content_calendar ADD COLUMN IF NOT EXISTS qa_rewritten BOOLEAN DEFAULT FALSE;

-- QA audit log — one row per post reviewed
CREATE TABLE IF NOT EXISTS sprintai_qa_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID REFERENCES sprintai_clients(id),
  calendar_id       UUID REFERENCES sprintai_content_calendar(id),
  platform          VARCHAR(20),
  score_hook        DECIMAL(3,1),
  score_local       DECIMAL(3,1),
  score_value       DECIMAL(3,1),
  score_cta         DECIMAL(3,1),
  score_platform    DECIMAL(3,1),
  score_authenticity DECIMAL(3,1),
  score_average     DECIMAL(3,1),
  verdict           VARCHAR(10),
  issues            TEXT[],
  was_rewritten     BOOLEAN,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_log_client
    ON sprintai_qa_log (client_id);

CREATE INDEX IF NOT EXISTS idx_qa_log_calendar
    ON sprintai_qa_log (calendar_id);
