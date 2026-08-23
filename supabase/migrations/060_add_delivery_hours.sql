-- 060_add_delivery_hours
-- Phase 4d: delivery_hours JSON column parallel to open_hours for delivery-specific hours.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS delivery_hours JSONB DEFAULT '{}'::jsonb;
COMMENT ON COLUMN shops.delivery_hours IS 'Delivery-specific hours per day, same shape as open_hours: { "monday": [{open:"HH:MM",close:"HH:MM"}], ... }';