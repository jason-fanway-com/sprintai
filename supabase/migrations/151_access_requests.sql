-- 151_access_requests.sql — someone who signed in but has no role asks for access; the approver gets an email with a
-- one-time link and approves or denies on the admin site (Jason 2026-10-05: "Erin should be added via the site ... an
-- email to me to approve her"). Only the access-request edge function (service role) reads or writes this table.
create table if not exists public.access_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null,
  name        text,
  kind        text not null default 'team' check (kind in ('team')),
  note        text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  decided_at  timestamptz
);
create unique index if not exists access_requests_one_pending on public.access_requests (user_id) where status = 'pending';
alter table public.access_requests enable row level security;  -- no policies: users never touch it directly
