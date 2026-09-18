-- 144: has_toast_secret generated column
--
-- The admin dashboard's shop-detail page (ShopDetail.tsx) was loading
-- `toast_client_secret`'s real plaintext value into the browser on every
-- page load via `select('*')`, then holding it in React state. The Settings
-- tab only ever masked it visually (type="password"); the real value sat in
-- the raw network response and JS state, inspectable via devtools by any
-- shop owner (their own shop) or super-admin (any shop).
--
-- The client only ever needed to know WHETHER a Toast secret is configured,
-- not what it is. This generated column answers that without exposing the
-- value: the client can now select has_toast_secret and never receive
-- toast_client_secret itself. Purely additive — no existing column touched,
-- inherits the same RLS policies as the rest of `shops` automatically since
-- it's just another column on the same table.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS has_toast_secret boolean
  GENERATED ALWAYS AS (toast_client_secret IS NOT NULL) STORED;
