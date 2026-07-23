-- 027: Conversational Admin — specials, delivery controls, action log
-- Additive-only, idempotent. Run alongside existing schema.

-- ============================================================
-- SPECIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS specials (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  price_cents    INTEGER     NOT NULL,
  description    TEXT,
  linked_item_id UUID        REFERENCES menu_items(id) ON DELETE SET NULL,
  active_date    DATE        NOT NULL,
  expires_at     TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_specials_shop_id ON specials(shop_id);
CREATE INDEX IF NOT EXISTS idx_specials_active_date ON specials(active_date);

-- ============================================================
-- SHOPS — ADD DELIVERY CONTROL COLUMNS
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='shops' AND column_name='delivery_enabled') THEN
    ALTER TABLE shops ADD COLUMN delivery_enabled BOOLEAN DEFAULT true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='shops' AND column_name='delivery_paused_until') THEN
    ALTER TABLE shops ADD COLUMN delivery_paused_until TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='shops' AND column_name='delivery_pause_reason') THEN
    ALTER TABLE shops ADD COLUMN delivery_pause_reason TEXT;
  END IF;
END $$;

-- ============================================================
-- ADMIN ACTION LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_action_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID        NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id         TEXT,
  raw_message     TEXT,
  parsed_intent   JSONB,
  action_taken    TEXT,
  before_snapshot JSONB,
  after_snapshot  JSONB,
  undo_token      UUID        DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_shop_id ON admin_action_log(shop_id);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_undo_token ON admin_action_log(undo_token);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at DESC);

-- ============================================================
-- UPDATED_AT TRIGGER ON SPECIALS
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_specials_updated_at'
  ) THEN
    CREATE TRIGGER update_specials_updated_at
      BEFORE UPDATE ON specials
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
ALTER TABLE specials          ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_action_log  ENABLE ROW LEVEL SECURITY;

-- Admin policies: platform admins have full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Admins have full access to specials'
  ) THEN
    CREATE POLICY "Admins have full access to specials"
      ON specials FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Admins have full access to admin_action_log'
  ) THEN
    CREATE POLICY "Admins have full access to admin_action_log"
      ON admin_action_log FOR ALL
      USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- Tenant-scoped read policies for specials
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can view their own specials'
  ) THEN
    CREATE POLICY "Tenants can view their own specials"
      ON specials FOR SELECT
      USING (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

-- Tenant-scoped policies for admin_action_log
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can view their own action log'
  ) THEN
    CREATE POLICY "Tenants can view their own action log"
      ON admin_action_log FOR SELECT
      USING (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

-- Tenant-scoped insert for admin_action_log (allow admin chat to log)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can insert their own action log'
  ) THEN
    CREATE POLICY "Tenants can insert their own action log"
      ON admin_action_log FOR INSERT
      WITH CHECK (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

-- Tenant-scoped write for specials (allow admin chat to manage)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can manage their own specials'
  ) THEN
    CREATE POLICY "Tenants can manage their own specials"
      ON specials FOR INSERT
      WITH CHECK (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can update their own specials'
  ) THEN
    CREATE POLICY "Tenants can update their own specials"
      ON specials FOR UPDATE
      USING (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Tenants can delete their own specials'
  ) THEN
    CREATE POLICY "Tenants can delete their own specials"
      ON specials FOR DELETE
      USING (
        shop_id IN (
          SELECT id FROM shops
          WHERE tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
        )
      );
  END IF;
END $$;