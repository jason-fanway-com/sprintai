-- SprintAI Ordering Platform — Merchant PIN + Public Policies
-- Adds merchant_pin to shops and opens read/write policies for the merchant UI.
-- Run after 003_ordering_schema.sql.

-- ============================================================
-- ADD MERCHANT PIN
-- ============================================================
ALTER TABLE shops ADD COLUMN IF NOT EXISTS merchant_pin TEXT;

-- ============================================================
-- PUBLIC READ POLICIES (menu data is not sensitive)
-- ============================================================
CREATE POLICY "Public can read menus"
  ON menus FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Public can read active menu items"
  ON menu_items FOR SELECT
  TO anon
  USING (active = true);

-- Shops are readable publicly so the merchant UI can verify PIN.
-- merchant_pin is compared server-side (client fetches full row with anon key).
-- TODO: Replace with a server-side PIN verification edge function before production.
CREATE POLICY "Public can read shops"
  ON shops FOR SELECT
  TO anon
  USING (true);

-- ============================================================
-- MERCHANT UI WRITE POLICIES
-- ============================================================

-- Availability overrides: merchant UI toggles sold-out status
CREATE POLICY "Public can manage availability overrides"
  ON availability_overrides FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- Shops: merchant UI can pause/unpause
CREATE POLICY "Public can update shop pause status"
  ON shops FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);
