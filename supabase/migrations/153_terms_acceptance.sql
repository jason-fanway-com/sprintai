-- 153_terms_acceptance.sql — the shop agrees to OrderFare's terms at sign-up (Jason 2026-10-06). The server stamps
-- the time; the client only says which version was shown. Accepting the current version is an owner go-live step.
alter table public.shops add column if not exists terms_version text;
alter table public.shops add column if not exists terms_accepted_at timestamptz;
alter table public.shops add column if not exists terms_accepted_by text;
