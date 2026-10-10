-- 155: a shop's contact card (vCard with its logo) rides on a customer's first paid receipt (MMS).
-- Off per shop until its 10DLC campaign declares embedded phone numbers (the card carries the shop number).
alter table shops add column if not exists logo_path text;                                  -- object in the public shop-logos bucket
alter table shops add column if not exists contact_card_enabled boolean not null default false;
alter table customers add column if not exists contact_card_sent_at timestamptz;          -- sent once per customer, never again
insert into storage.buckets (id, name, public) values ('shop-logos', 'shop-logos', true) on conflict (id) do nothing;
