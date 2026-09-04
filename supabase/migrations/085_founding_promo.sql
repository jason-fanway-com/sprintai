-- 085 — Founding-shop promo flag.
-- Set to true by stripe-webhook when a shop's subscription checkout used
-- the founding promo code (STRIPE_FOUNDING_COUPON_ID). Used to trigger the
-- founding-shop thank-you email and success-screen banner.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS founding_promo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.shops.founding_promo IS
  'True when this shop redeemed the founding-cohort Stripe promo code at subscription checkout. Server-written by stripe-webhook only.';
