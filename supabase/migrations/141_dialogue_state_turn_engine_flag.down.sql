-- Down for 141_dialogue_state_turn_engine_flag.sql. Reversible, idempotent.
-- Drops only the columns this migration added. Leaves everything else untouched.

ALTER TABLE shops
  DROP COLUMN IF EXISTS turn_engine_enabled;

ALTER TABLE order_carts
  DROP COLUMN IF EXISTS dialogue_state;
