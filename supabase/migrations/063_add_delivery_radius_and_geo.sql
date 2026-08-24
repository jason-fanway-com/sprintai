-- Migration 063: Delivery radius zone
-- Adds shop location + delivery radius for zone checking in chat-sms.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS delivery_radius_mi numeric(5,2);

COMMENT ON COLUMN shops.latitude IS 'Shop latitude from Google Places API';
COMMENT ON COLUMN shops.longitude IS 'Shop longitude from Google Places API';
COMMENT ON COLUMN shops.delivery_radius_mi IS 'Delivery radius in miles (null = no zone check)';