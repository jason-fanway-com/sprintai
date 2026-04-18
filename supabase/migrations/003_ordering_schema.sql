-- SprintAI Ordering Platform — Ordering Schema Extension
-- Adds shop, menu, cart, and audit tables on top of the base schema.
-- Run after 001_initial_schema.sql and 002_add_custom_sources.sql.

-- ============================================================
-- SHOPS
-- ============================================================
CREATE TABLE shops (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     TEXT        NOT NULL,
  slug                     TEXT        UNIQUE NOT NULL,
  phone_number_e164        TEXT,
  twilio_number_sid        TEXT,
  open_hours               JSONB       DEFAULT '{}',
  -- open_hours: { mon: [{open:"09:00", close:"21:00"}], tue: [...], ... }
  timezone                 TEXT        NOT NULL DEFAULT 'America/New_York',
  email_ticket_recipient   TEXT,
  stripe_connect_account_id TEXT,
  is_paused                BOOLEAN     NOT NULL DEFAULT false,
  pause_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shops_tenant_id ON shops(tenant_id);
CREATE INDEX idx_shops_slug      ON shops(slug);

-- ============================================================
-- MENUS
-- ============================================================
CREATE TABLE menus (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  source         TEXT        NOT NULL CHECK (source IN ('toast', 'manual', 'pdf')),
  raw_json       JSONB       DEFAULT '[]',
  effective_from TIMESTAMPTZ,
  effective_until TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menus_shop_id ON menus(shop_id);

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE menu_items (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id        UUID        NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  external_id    TEXT,
  name           TEXT        NOT NULL,
  description    TEXT,
  price_cents    INTEGER     NOT NULL,
  category       TEXT,
  modifiers_json JSONB,
  -- modifiers_json: [{ name: string, price_cents: integer }]
  display_order  INTEGER,
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menu_items_menu_active ON menu_items(menu_id, active);
CREATE INDEX idx_menu_items_menu_id     ON menu_items(menu_id);

-- ============================================================
-- AVAILABILITY OVERRIDES
-- ============================================================
CREATE TABLE availability_overrides (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_item_id  UUID        NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  set_by        TEXT,
  set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_date DATE        NOT NULL,
  expires_at    TIMESTAMPTZ,
  source        TEXT,
  notes         TEXT
);

CREATE INDEX idx_avail_overrides_shop_date ON availability_overrides(shop_id, business_date);

-- ============================================================
-- ORDER CARTS
-- ============================================================
CREATE TABLE order_carts (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                    UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  conversation_id            UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  phase                      TEXT        NOT NULL DEFAULT 'greeting'
    CHECK (phase IN ('greeting', 'building', 'review', 'checkout', 'payment', 'confirmed', 'expired')),
  cart_json                  JSONB       NOT NULL DEFAULT '[]',
  -- cart_json: [{ menu_item_id, name, quantity, price_cents, modifiers }]
  pickup_name                TEXT,
  pickup_time                TIMESTAMPTZ,
  subtotal_cents             INTEGER,
  tax_cents                  INTEGER,
  total_cents                INTEGER,
  stripe_checkout_session_id TEXT,
  payment_status             TEXT        NOT NULL DEFAULT 'pending',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_carts_conversation_id ON order_carts(conversation_id);
CREATE INDEX idx_order_carts_shop_id         ON order_carts(shop_id);
CREATE INDEX idx_order_carts_phase           ON order_carts(phase);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        TEXT,
  action       TEXT,
  target_type  TEXT,
  target_id    TEXT,
  payload_json JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_target    ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_log_created   ON audit_log(created_at DESC);

-- ============================================================
-- UPDATED_AT triggers
-- (update_updated_at_column already defined in 001_initial_schema.sql)
-- ============================================================
CREATE TRIGGER update_shops_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_order_carts_updated_at
  BEFORE UPDATE ON order_carts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
ALTER TABLE shops                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE menus                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_carts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;

-- Admin policies: platform admins can see everything
CREATE POLICY "Admins have full access to shops"
  ON shops FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to menus"
  ON menus FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to menu_items"
  ON menu_items FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to availability_overrides"
  ON availability_overrides FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to order_carts"
  ON order_carts FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

CREATE POLICY "Admins have full access to audit_log"
  ON audit_log FOR ALL
  USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');

-- Tenant-scoped policies: tenants can view their own shop data
CREATE POLICY "Tenants can view their own shops"
  ON shops FOR SELECT
  USING (
    tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

CREATE POLICY "Tenants can view their own menus"
  ON menus FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM shops
      WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
    )
  );

CREATE POLICY "Tenants can view their own menu_items"
  ON menu_items FOR SELECT
  USING (
    menu_id IN (
      SELECT m.id FROM menus m
      JOIN shops s ON s.id = m.shop_id
      WHERE s.tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
    )
  );

CREATE POLICY "Tenants can view their own order_carts"
  ON order_carts FOR SELECT
  USING (
    shop_id IN (
      SELECT id FROM shops
      WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
    )
  );
