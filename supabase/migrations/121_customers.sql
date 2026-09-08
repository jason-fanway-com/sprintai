-- 121_customers.sql — Customer CRM: materialized per-tenant diner profile
-- for personalized greetings and "the regular" offers.
--
-- Spec: docs/specs/2026-09-03-customer-crm.md ("BUILD GATED ON JASON GO" —
-- gate opened 2026-09-08). Identity is strictly (tenant_id, customer_phone),
-- never cross-tenant (AC2) — same convention as sms_opt_outs.
--
-- Q2 (retention): 24 months, but CONFIGURABLE via app_config
-- ('customer_retention_months') rather than hardcoded, so the window can
-- change without a deploy. The purge job itself is NOT built here — see
-- BLOCKED.txt for the follow-up. This migration only makes the config value
-- exist so nothing downstream is blocked on it later.
--
-- Q3 (name source of truth): resolved in application code
-- (_shared/customer-profile.ts) — latest PAID pickup_name wins over
-- conversations.metadata.customer_name. No schema implication.

-- NOTE (live-schema check before applying, 2026-09-08): shops.tenant_id has
-- NO unique constraint on the live database (confirmed via pg_constraint) —
-- the same reason sms_opt_outs' own tenant_id column (migration 056) has no
-- FK live despite its forward-migration file saying `REFERENCES shops
-- (tenant_id)`. References tenants(id) directly instead, which IS the real
-- primary key every tenant_id column in this schema conceptually points at
-- (conversations.tenant_id and shops.tenant_id both already do this).
CREATE TABLE IF NOT EXISTS customers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone     text        NOT NULL,
  name               text,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  order_count        integer     NOT NULL DEFAULT 0,
  total_spent_cents  integer     NOT NULL DEFAULT 0,
  favorite_items     jsonb       NOT NULL DEFAULT '[]',
  -- favorite_items: [{ "name": "Large Cheese Pizza", "count": 5 }, ...],
  -- ranked desc by count. "count" is the number of distinct PAID ORDERS
  -- containing that item name, not summed quantity. "The regular" (AC6) is
  -- only ever asserted when favorite_items[0].count >= 3 — see
  -- _shared/customer-profile.ts's regularEligibility().
  last_order_id      uuid REFERENCES order_carts(id) ON DELETE SET NULL,
  last_order_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_customers_tenant_phone UNIQUE (tenant_id, customer_phone)
);

-- AC7: conversation-start personalization must be a single indexed query on
-- (tenant_id, customer_phone) — no join-scan of order_carts per message. The
-- UNIQUE constraint above already creates a supporting index; this named
-- index documents the intent explicitly and is a no-op if the constraint's
-- own index already satisfies it.
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone
  ON customers (tenant_id, customer_phone);

COMMENT ON TABLE customers IS
  'Materialized per-(tenant_id, customer_phone) diner profile powering chat-sms personalization (greet by name, "the regular" offer). Service-role only — never cross-tenant (AC2). Upserted from stripe-webhook on paid order. See docs/specs/2026-09-03-customer-crm.md.';
COMMENT ON COLUMN customers.favorite_items IS
  'Top items by paid-order count (not unit count), e.g. [{"name":"Large Cheese Pizza","count":5}]. "The regular" is only offered when the top entry has count >= 3 (AC6) — below that, chat-sms asks instead of guessing.';
COMMENT ON COLUMN customers.name IS
  'Latest PAID order pickup_name wins over conversations.metadata.customer_name when they disagree (spec open question 3, resolved by Jason: money-attached names are more reliable than passing mentions).';

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

REVOKE ALL ON customers FROM anon;
REVOKE ALL ON customers FROM authenticated;
-- Service-role only for tonight's build (backend + chat personalization —
-- spec open question 1). An owner-facing CRM UI is an explicit later
-- follow-up (spec "Out of scope") and will add a scoped SELECT policy for
-- authenticated shop owners when it ships.

-- Q2: configurable retention window, in months. Read by the (not-yet-built)
-- purge job — see BLOCKED.txt for that follow-up item.
INSERT INTO app_config (key, value) VALUES
  ('customer_retention_months', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Owner-level toggle to disable personalization entirely (spec "Consent/
-- taste" decision — default on). Additive, nullable-safe default.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS customer_personalization_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN shops.customer_personalization_enabled IS
  'Owner-level kill switch for customer-recognition personalization (greet by name, offer "the regular"). Default true. See docs/specs/2026-09-03-customer-crm.md.';
