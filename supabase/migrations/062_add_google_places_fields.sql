-- 062_add_google_places_fields
-- Phase 6: Google Business Profile lookup on signup.
-- Stores authoritative address, phone, rating from Google Maps Places API.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS google_place_id TEXT DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS formatted_address TEXT DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS google_rating NUMERIC(3,1) DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS google_review_count INTEGER DEFAULT NULL;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS business_status TEXT DEFAULT NULL;

COMMENT ON COLUMN shops.google_place_id IS 'Google Maps place_id for idempotent lookup — if set, skip future lookups';
COMMENT ON COLUMN shops.formatted_address IS 'Authoritative formatted address from Google Places API';
COMMENT ON COLUMN shops.google_rating IS 'Google star rating (1.0-5.0) from Places API';
COMMENT ON COLUMN shops.google_review_count IS 'Total Google review count';
COMMENT ON COLUMN shops.business_status IS 'Google business status: OPERATIONAL, CLOSED_TEMPORARILY, CLOSED_PERMANENTLY';