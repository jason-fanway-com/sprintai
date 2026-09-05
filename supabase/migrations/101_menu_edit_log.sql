-- 101: menu_edit_log — who changed a shop's menu/config, and when.
--
-- Spec: docs/specs/2026-09-05-shop-editor.md ("New menu_edit_log ... A bulk editor
-- that fifty owners touch needs 'who changed this and when' to be answerable.")
--
-- Written by the admin-chat operations registry on every write to menu_items,
-- option_groups, option_choices, or shops config columns — one row per
-- affected table+row, whether the write came from the owner's chat or the
-- owner's structured form. Both paths call the same apply(), so both produce
-- an identical log entry shape.
--
-- Service-role only for writes (the edge function is the sole writer, same
-- pattern as public_tester_sessions in 096). Readable by super-admins in
-- full, and by shop owners for their own tenant only.

CREATE TABLE IF NOT EXISTS menu_edit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor UUID,                    -- auth.users.id; null only for system-initiated writes
  actor_label TEXT,               -- 'chat' | 'form' — which surface issued the write
  op_id TEXT NOT NULL,            -- e.g. SET_ITEM_OPTIONS, SET_ITEM_FIELDS
  table_name TEXT NOT NULL,       -- menu_items | option_groups | option_choices | shops
  row_id UUID,
  before JSONB,
  after JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_edit_log_shop_at ON menu_edit_log(shop_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_menu_edit_log_tenant ON menu_edit_log(tenant_id);

ALTER TABLE menu_edit_log ENABLE ROW LEVEL SECURITY;

-- No INSERT/UPDATE/DELETE policy for anon/authenticated on purpose: the edge
-- function is the only writer and uses the service-role client, which
-- bypasses RLS entirely. Base-table privileges are revoked below so a
-- misconfigured client-side call can't insert forged log rows.
REVOKE ALL ON menu_edit_log FROM anon, authenticated;

DROP POLICY IF EXISTS "Super admins can read menu_edit_log" ON menu_edit_log;
CREATE POLICY "Super admins can read menu_edit_log" ON menu_edit_log FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'super_admin');

DROP POLICY IF EXISTS "Shop owners can read their own menu_edit_log" ON menu_edit_log;
CREATE POLICY "Shop owners can read their own menu_edit_log" ON menu_edit_log FOR SELECT
  USING (COALESCE(auth.jwt()->'app_metadata'->>'role','') = 'shop_owner'
    AND tenant_id::text = current_user_tenant_id());

GRANT SELECT ON menu_edit_log TO authenticated;

-- qa_ro exposure, same pattern as qa_ro.test_transcripts (096).
CREATE VIEW qa_ro.menu_edit_log AS
  SELECT id, shop_id, tenant_id, actor, actor_label, op_id, table_name, row_id, before, after, at
  FROM menu_edit_log;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_readonly') THEN
    GRANT SELECT ON qa_ro.menu_edit_log TO qa_readonly;
    RAISE NOTICE '101: granted qa_readonly SELECT on qa_ro.menu_edit_log';
  ELSE
    RAISE NOTICE '101: role qa_readonly absent — skipped grant';
  END IF;
END $$;
