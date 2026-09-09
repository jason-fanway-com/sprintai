-- 124_instruction_layers_schema.sql — instruction-layer schema (stream C1).
--
-- Authorized directly by Jason 2026-09-09 ("PM instructions are direct" per
-- AGENTS.md). Companion artifact: docs/specs/2026-09-09-prompt-line-
-- classification.md classifies today's buildSystemPrompt (chat-sms/
-- index.ts) line by line. It found several facts hardcoded into the SHARED
-- prompt template that only apply to ONE real shop but are sent to all of
-- them on every message — e.g. "a dozen means 14" (Not Just Bagels) and the
-- BOBO/SOBO/HOBO sandwich-name aliases (also Not Just Bagels) currently ship
-- to Zio's and Vito's pizzerias too. This migration creates somewhere for
-- the shop_settings-classified facts to live.
--
-- HARD CONSTRAINT: additive, reversible (see .down.sql), and changes NO
-- runtime behaviour. Nothing in chat-sms reads shop_settings/shop_voice/
-- shop_notes/prompt_versions or shops.prompt_version yet — wiring a renderer
-- to actually use them is a separate later task (stream C2).
--
-- RLS follows the idiom already used for menu_overrides/customers (113/121):
-- service-role is the sole writer (bypasses RLS), table privileges revoked
-- from anon/authenticated so a misconfigured client call can't insert/forge
-- rows, and SELECT is policy-gated by role + tenant via
-- current_user_tenant_id() — the same shop-scoping idiom as everywhere else.

CREATE TABLE IF NOT EXISTS shop_settings (
  shop_id               UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  hours_line            TEXT,
  -- fulfilment_modes: subset of {'pickup','delivery','catering'}.
  fulfilment_modes      TEXT[] NOT NULL DEFAULT '{}',
  delivery_radius_miles NUMERIC,
  -- quantity_words: {"dozen": 14, "half dozen": 6} — the shop-specific
  -- replacement for the bagel-count example hardcoded into
  -- buildSystemPrompt's CRITICAL BUNDLE RULE. Empty for shops with no
  -- bundle vocabulary (most shops — nothing here today is a bundle word).
  quantity_words        JSONB NOT NULL DEFAULT '{}',
  upsell_enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_voice (
  shop_id      UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  greeting     TEXT,
  sign_off     TEXT,
  persona      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_notes (
  id           BIGSERIAL PRIMARY KEY,
  shop_id      UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  text         TEXT NOT NULL CHECK (char_length(text) <= 140 AND text NOT LIKE '%$%'),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shop_notes_shop ON shop_notes (shop_id, created_at DESC);

-- Ten-row-per-shop cap. Enforced here as the backstop of record; the editor
-- UI should also check count() before offering "add a note" so an owner
-- gets a normal inline message instead of a trigger exception, but this
-- trigger is what actually stops the row from being written either way.
CREATE OR REPLACE FUNCTION shop_notes_enforce_cap() RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM shop_notes WHERE shop_id = NEW.shop_id) >= 10 THEN
    RAISE EXCEPTION 'shop_notes: shop % already has 10 notes (cap)', NEW.shop_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shop_notes_cap ON shop_notes;
CREATE TRIGGER trg_shop_notes_cap
  BEFORE INSERT ON shop_notes
  FOR EACH ROW EXECUTE FUNCTION shop_notes_enforce_cap();

CREATE TABLE IF NOT EXISTS prompt_versions (
  version      INTEGER PRIMARY KEY,
  template     TEXT NOT NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS prompt_version INTEGER REFERENCES prompt_versions(version);
COMMENT ON COLUMN shops.prompt_version IS
  'NULL = legacy buildSystemPrompt (chat-sms/index.ts, hardcoded template). Not read anywhere yet — set by a future renderer (stream C2).';

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE shop_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_settings   FORCE ROW LEVEL SECURITY;
ALTER TABLE shop_voice      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_voice      FORCE ROW LEVEL SECURITY;
ALTER TABLE shop_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_notes      FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON shop_settings   FROM anon, authenticated;
REVOKE ALL ON shop_voice      FROM anon, authenticated;
REVOKE ALL ON shop_notes      FROM anon, authenticated;
REVOKE ALL ON prompt_versions FROM anon, authenticated;

-- shop_settings: super_admin + the owning shop's owner
DROP POLICY IF EXISTS "Super admins can read shop_settings" ON shop_settings;
CREATE POLICY "Super admins can read shop_settings" ON shop_settings FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own shop_settings" ON shop_settings;
CREATE POLICY "Shop owners can read their own shop_settings" ON shop_settings FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON shop_settings TO authenticated;

-- shop_voice: super_admin + the owning shop's owner
DROP POLICY IF EXISTS "Super admins can read shop_voice" ON shop_voice;
CREATE POLICY "Super admins can read shop_voice" ON shop_voice FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own shop_voice" ON shop_voice;
CREATE POLICY "Shop owners can read their own shop_voice" ON shop_voice FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON shop_voice TO authenticated;

-- shop_notes: super_admin + the owning shop's owner
DROP POLICY IF EXISTS "Super admins can read shop_notes" ON shop_notes;
CREATE POLICY "Super admins can read shop_notes" ON shop_notes FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
DROP POLICY IF EXISTS "Shop owners can read their own shop_notes" ON shop_notes;
CREATE POLICY "Shop owners can read their own shop_notes" ON shop_notes FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND shop_id IN (SELECT s.id FROM shops s WHERE s.tenant_id::text = current_user_tenant_id()));
GRANT SELECT ON shop_notes TO authenticated;

-- prompt_versions: super_admin only — an internal template registry, not
-- per-shop data, so no shop_owner policy.
DROP POLICY IF EXISTS "Super admins can read prompt_versions" ON prompt_versions;
CREATE POLICY "Super admins can read prompt_versions" ON prompt_versions FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');
GRANT SELECT ON prompt_versions TO authenticated;
