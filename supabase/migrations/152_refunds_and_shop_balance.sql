-- 152_refunds_and_shop_balance.sql — refunds by the agreed rules (Jason 2026-10-05/06).
-- A shop-caused Uber charge (e.g. cancelling after a driver accepted) goes on the shop's balance and comes out of its
-- next orders (OrderFare's application fee takes it). Every movement is one row in shop_balance_entries.
alter table public.shops add column if not exists balance_owed_cents integer not null default 0;
create table if not exists public.shop_balance_entries (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  cart_id     uuid references public.order_carts(id) on delete set null,
  cents       integer not null,            -- positive: the shop owes more; negative: recovered from an order
  reason      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists shop_balance_entries_shop on public.shop_balance_entries (shop_id, created_at desc);
alter table public.shop_balance_entries enable row level security;
-- order: how much of the shop's balance this order's fee recovers, and the plain-English note sent with a refund
alter table public.order_carts add column if not exists balance_recovered_cents integer not null default 0;
alter table public.order_carts add column if not exists refund_note text;
