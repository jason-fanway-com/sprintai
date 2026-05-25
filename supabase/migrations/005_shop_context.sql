-- SprintAI Ordering Platform -- Shop Context + Website URL
-- Adds shop_context and website_url to shops table.
-- Run after 004_merchant_pin.sql.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_context TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS website_url TEXT;

-- Allow authenticated admin dashboard users to insert new shops
CREATE POLICY "Authenticated users can insert shops"
  ON shops FOR INSERT
  TO authenticated
  WITH CHECK (true);
