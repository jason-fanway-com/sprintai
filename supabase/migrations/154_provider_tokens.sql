-- 154: one courier OAuth token shared by every function instance.
-- Uber Direct rate-limits its token endpoint (HTTP 429). Each edge-function isolate kept its own in-memory
-- token, so every deploy and cold start asked for a new one; on 2026-10-10 a day of deploys plus parallel
-- test conversations hit the limit and every delivery quote failed. Tokens live 30 days; one row per client id.
-- Service role only: RLS on, no policies.
create table if not exists provider_tokens (
  provider text not null,
  client_id text not null,
  token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (provider, client_id)
);
alter table provider_tokens enable row level security;
revoke all on provider_tokens from anon, authenticated;
