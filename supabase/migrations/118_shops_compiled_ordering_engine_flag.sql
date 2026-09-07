-- 118: per-shop feature flag for the compiled ordering engine (item 8, spec
-- docs/specs/2026-09-07-conversation-ready-menu-design.md §7/§11 item 8).
--
-- The new sequencer/resolver path in chat-sms/index.ts is gated on this flag
-- AND on the item actually having a non-null ask_plan (i.e. the compiler has
-- run for it). Default false everywhere, including Vito's — this migration
-- does not enable the flag for any shop. Enabling it is a separate, explicit
-- data change, made only after sign-off, never bundled into a schema change.
alter table shops
  add column if not exists compiled_ordering_engine_enabled boolean not null default false;

comment on column shops.compiled_ordering_engine_enabled is
  'Item 8: when true AND a menu_items row has a non-null ask_plan, chat-sms uses the deterministic ask_plan-driven sequencer/resolver instead of the legacy LLM-guessed option path. Default false. Vito''s must never be set true — it is the canary shop and must run the legacy path byte-for-byte.';
