-- 078: Add first_delivery_test columns to shops (go-live gate: delivery_test)
--
-- first_delivery_test_passed_at: when the 8-step handset script was completed.
-- first_delivery_test_recorded_by: operator identity (email or user id).
-- Both nullable — null means the test has not been completed.
-- is_test shops skip this gate (same pattern as ein).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS first_delivery_test_passed_at timestamptz;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS first_delivery_test_recorded_by text;