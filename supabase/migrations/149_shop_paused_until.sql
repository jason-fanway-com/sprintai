-- 149_shop_paused_until.sql — a text-ordering pause can end on its own (Jason 2026-10-05: "close the shop for the
-- rest of the day" from shop chat). is_paused + paused_until: paused while is_paused and (paused_until is null or in
-- the future). Null keeps today's meaning: paused until turned back on.
alter table public.shops add column if not exists paused_until timestamptz;
comment on column public.shops.paused_until is 'When a text-ordering pause (is_paused) ends by itself; null = until turned back on.';
