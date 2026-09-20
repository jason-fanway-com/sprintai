-- 147: order_carts.engine_form + shops.clean_engine_enabled
--
-- Clean-sheet ordering engine (supabase/functions/chat-sms/engine/). The
-- engine's state is the order form, one JSONB per cart, owned entirely by
-- code. cart_json continues to be written as a projection of the form so
-- every existing reader (tickets, dashboards, checkout) is unaffected.
--
-- shops.clean_engine_enabled routes a shop's turns to the new engine. Off for
-- every shop by default; flipped per shop by the PO after the acceptance
-- harness passes for that shop. The legacy turn_engine_enabled flag and path
-- are untouched by this migration.
--
-- ADDITIVE ONLY. Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS engine_form JSONB;
COMMENT ON COLUMN order_carts.engine_form IS
  'Clean-sheet engine order form (engine/form.ts OrderForm). NULL = fresh conversation.';

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS clean_engine_enabled BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN shops.clean_engine_enabled IS
  'Route this shop''s ordering turns to the clean-sheet engine (engine/runner.ts).';

-- engine_ledger: append-only record of every move applied and every question
-- asked, per cart and turn. The audit trail behind "why did it do that".
CREATE TABLE IF NOT EXISTS engine_ledger (
  id          BIGSERIAL PRIMARY KEY,
  cart_id     UUID NOT NULL,
  turn_no     INTEGER NOT NULL,
  event       TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engine_ledger_cart ON engine_ledger (cart_id, turn_no);
ALTER TABLE engine_ledger ENABLE ROW LEVEL SECURITY;
