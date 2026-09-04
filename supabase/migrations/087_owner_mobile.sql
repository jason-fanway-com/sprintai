-- 087 — Owner mobile number (INSTRUCTION-09 §4 / INSTRUCTION-10 item D).
-- Collected at signup; stored separately from phone_number_e164 (the shop's
-- SMS ordering number). Used to notify the owner after Erin leaves: onboarding
-- nudge, congratulations, ready-to-launch SMS (Phase B gate all-pass).

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS owner_mobile text;

COMMENT ON COLUMN shops.owner_mobile IS
  'Owner personal mobile for SMS notifications. Distinct from phone_number_e164 (the shop ordering number). Collected at signup.';
