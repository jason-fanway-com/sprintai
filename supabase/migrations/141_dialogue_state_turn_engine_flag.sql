-- 141: order_carts.dialogue_state + shops.turn_engine_enabled — schema-only
--      groundwork for the code-owned turn engine.
--
-- docs/specs/2026-09-14-turn-engine-oversight.md §3a, §4 Phase 3, as amended
-- by docs/specs/2026-09-15-code-owned-resolution.md. This is a SCHEMA-ONLY
-- migration: no routing branch, no reads, no writes to either column exist
-- yet, and turn_engine_enabled defaults false for every shop, Vito's
-- included. Phase 3's routing branch into chat-sms/index.ts is a separate,
-- later dispatch.
--
-- order_carts.dialogue_state: the single code-owned dialogue-state record
-- (phase, open question, upsell_offered, asked_message_id — full shape in
-- §3a). NULL means "fresh conversation", which the engine already treats as
-- the initial state, so no backfill is needed or wanted. The existing
-- fragments this supersedes (pending_options, pending_disambiguation,
-- delivery_offer_made_at, fee_disclosed_at, checkout_intent_confirmed_at)
-- are left untouched — they are migrated into dialogue_state by a later
-- migration, not this one.
--
-- shops.turn_engine_enabled: per-shop flag gating the future routing
-- branch. NOT NULL DEFAULT false so every existing and future shop starts
-- off; nothing is enabled by this migration.
--
-- ADDITIVE ONLY. Both columns nullable/defaulted with no backfill required.
-- Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS dialogue_state JSONB;

COMMENT ON COLUMN order_carts.dialogue_state IS
  'Code-owned dialogue state (phase, open question, upsell_offered, asked_message_id) per docs/specs/2026-09-14-turn-engine-oversight.md §3a. NULL means fresh conversation. Not yet read or written by any code path (schema-only migration 141) — supersedes pending_options/pending_disambiguation/delivery_offer_made_at/fee_disclosed_at/checkout_intent_confirmed_at once a later migration wires the migration of those fragments.';

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS turn_engine_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN shops.turn_engine_enabled IS
  'Gates the code-owned turn engine routing branch (docs/specs/2026-09-14-turn-engine-oversight.md §4 Phase 3). Default false for every shop; this migration does not enable it for any shop, including Vito''s. No routing branch reads this column yet.';
