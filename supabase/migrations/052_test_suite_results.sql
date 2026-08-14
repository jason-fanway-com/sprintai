-- 052_test_suite_results.sql
-- Persisted results for the shop conversation test suite (docs/specs/2026-08-13-shop-conversation-test-suite.md).
-- Powers the superadmin "Test Suite" console + the shop-owner "Store Readiness" tab.

create table if not exists test_runs (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade,
  tenant_id          uuid,
  started_at         timestamptz not null default now(),
  label              text,
  model_tier         text,
  total              int  not null default 0,
  passed             int  not null default 0,
  failed             int  not null default 0,
  overall_pass_pct   numeric,
  category_subscores jsonb,
  critical_failures  jsonb,
  status             text not null default 'completed',
  notes              text
);

create table if not exists test_case_results (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references test_runs(id) on delete cascade,
  case_id          text not null,
  category         text,
  criticality      text default 'normal',
  transcript       jsonb,
  success_criteria jsonb,
  passed           boolean,
  verdict          text,
  reason           text,
  created_at       timestamptz not null default now()
);

create index if not exists idx_test_runs_shop on test_runs(shop_id, started_at desc);
create index if not exists idx_test_case_results_run on test_case_results(run_id);

-- RLS: enable now, locked to service-role only (no anon/authenticated policies yet).
-- Reporting-UI read policies (super_admin: all; shop_owner: own tenant) get added with the UI,
-- written carefully to preserve tenant isolation. Until then this is safe — no cross-tenant read path exists.
alter table test_runs enable row level security;
alter table test_case_results enable row level security;
