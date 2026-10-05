-- 150_delivery_provider_default_uber.sql — new shops deliver with Uber unless OrderFare deliberately sets shop delivery
-- at onboarding (Jason 2026-10-05). Existing shops keep their current value.
alter table public.shops alter column delivery_provider set default 'uber';
