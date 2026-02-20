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
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
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
