-- 145: has_merchant_pin generated column
--
-- Same bug class as 144 (has_toast_secret): the admin dashboard's shop-detail
-- page fetched `merchant_pin`'s real plaintext value into the browser via
-- SHOP_SELECT_COLUMNS, and SettingsTab.tsx rendered it directly — no masking
-- at all, unlike the Toast secret which was at least visually masked before
-- its fix. Any shop owner or super-admin with devtools open could read any
-- shop's merchant PIN straight off the network response.
--
-- The client only ever needed to know WHETHER a PIN is configured, not what
-- it is (same as Toast). This generated column answers that without
-- exposing the value: the client selects has_merchant_pin and never
-- receives merchant_pin itself.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS has_merchant_pin boolean
  GENERATED ALWAYS AS (merchant_pin IS NOT NULL) STORED;
