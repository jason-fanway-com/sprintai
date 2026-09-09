-- 122_fix_sms_opt_outs_upsert.sql — fix the live sms_opt_outs write path
--
-- COMPLIANCE-SEVERITY BUG (found 2026-09-08 during Customer CRM build, see
-- BLOCKED.txt "NEW FINDING, UNRELATED TO THIS BUILD"). upsertOptOut() (the
-- write path called by every live STOP-keyword handler in chat-sms and
-- chat-sms-mtest) has been silently failing on every real call since
-- migration 056 shipped:
--
-- ROOT CAUSE: migration 056 assumed sms_opt_outs did not exist yet and used
-- `CREATE TABLE IF NOT EXISTS` with a `(tenant_id, customer_phone)` UNIQUE
-- constraint baked into that CREATE TABLE clause. But the table already
-- existed live (created by migrations/001_tcr_registrations.sql, a legacy
-- per-(phone_number, shop_id) design predating the tenant_id/customer_phone
-- convention). Because the table existed, 056's CREATE TABLE was a no-op —
-- its ALTER TABLE ADD COLUMN IF NOT EXISTS statements ran (adding tenant_id,
-- customer_phone, opted_out_reason, opted_back_at as nullable columns with
-- no FK), but the UNIQUE constraint and the `updated_at` column, both of
-- which only existed in the dead CREATE TABLE clause, never landed.
--
-- Live-confirmed via pg_constraint/information_schema before writing this
-- migration (table has 0 rows — no real opt-out has ever durably persisted
-- since 056 shipped):
--   - No unique constraint on (tenant_id, customer_phone). Only unique
--     constraint present: `one_opt_out_per_phone_shop` UNIQUE(phone_number,
--     shop_id) — the legacy pair, still NOT NULL.
--   - `updated_at` column does not exist at all, even though upsertOptOut
--     writes it unconditionally on every call — a second, independently
--     fatal bug beyond what BLOCKED.txt originally flagged.
--   - `phone_number` (legacy) is NOT NULL and never populated by the
--     current write path.
--   - `shop_id` (legacy) is NOT NULL + FK to shops(id) and never populated
--     by the current write path either — also not previously flagged.
-- Net effect: .upsert(...) fails with 42P10 (no matching unique constraint)
-- AND would still fail on `updated_at` does-not-exist AND on two separate
-- NOT NULL violations (phone_number, shop_id) even if the onConflict target
-- were fixed alone. upsertOptOut's own error handling swallows all of this
-- (logged, non-fatal, "Telnyx has its own enforcement").
--
-- Repo-wide grep confirms nothing else in supabase/functions reads or
-- writes sms_opt_outs.phone_number or .shop_id — the legacy pair is dead
-- code left over from the pre-multi-tenant TCR registration design. Not
-- dropping the columns/constraint here (a compliance-relevant table
-- deserves a conservative migration and there are legitimate reasons a
-- future audit might want the historical column names preserved) — just
-- making them nullable so new rows can insert. phone_number is kept
-- populated by application code below (cheap: chat-sms already has the
-- phone value in scope, so keeping it NOT NULL costs nothing and preserves
-- a redundant human-readable column). shop_id has no equivalent value in
-- scope in upsertOptOut (only tenant_id is available, and looking up
-- shops.id from tenant_id would mean an extra query on every STOP for a
-- column nothing reads) — deprecated to nullable instead.

ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE sms_opt_outs ALTER COLUMN shop_id DROP NOT NULL;

-- 0 live rows (confirmed above) — safe to tighten immediately, no backfill.
ALTER TABLE sms_opt_outs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sms_opt_outs ALTER COLUMN customer_phone SET NOT NULL;

-- shops.tenant_id has no unique constraint live (same finding migration 121
-- already made and worked around) — reference tenants(id) directly instead,
-- the real PK every tenant_id column in this schema conceptually points at.
ALTER TABLE sms_opt_outs
  ADD CONSTRAINT sms_opt_outs_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- The actual fix: the constraint upsertOptOut's onConflict target has
-- always assumed exists.
ALTER TABLE sms_opt_outs
  ADD CONSTRAINT uq_sms_opt_outs_tenant_phone UNIQUE (tenant_id, customer_phone);

COMMENT ON COLUMN sms_opt_outs.phone_number IS
  'Legacy column from the pre-multi-tenant TCR design (migrations/001_tcr_registrations.sql). Still populated by upsertOptOut as a redundant copy of customer_phone, but customer_phone + tenant_id is the canonical key — nothing reads phone_number directly. Do not rely on it alone.';
COMMENT ON COLUMN sms_opt_outs.shop_id IS
  'Legacy column from the pre-multi-tenant TCR design (migrations/001_tcr_registrations.sql), superseded by tenant_id. Made nullable 2026-09-08 (migration 122) — confirmed via repo-wide grep that no current code path reads or writes it. Not dropped: kept for historical-row compatibility in case of an audit need.';
COMMENT ON TABLE sms_opt_outs IS
  'Durable per-(tenant_id, customer_phone) SMS opt-out record, service-role only. Canonical key is (tenant_id, customer_phone) — see uq_sms_opt_outs_tenant_phone. Telnyx also enforces STOP at the messaging-profile level independently (see docs/10dlc-compliance-obligations.md), but this table is the only opt-out record for the web/Test Kitchen channel (which never touches Telnyx) and is the durable compliance audit trail regardless of provider — see BLOCKED.txt 2026-09-08 for the incident that fixed this table.';
