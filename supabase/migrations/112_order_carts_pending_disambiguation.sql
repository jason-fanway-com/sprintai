-- 112: order_carts.pending_disambiguation — persist the candidates GUARD 7
--      offered so the NEXT inbound message can be resolved deterministically
--      instead of falling into the LLM tool loop with no memory of which two
--      items were on the table.
--
-- Spec: docs/specs/2026-09-06-disambiguation-and-menu-gaps.md, BLOCKER 1.
-- GUARD 7 (chat-sms/index.ts, "ambiguous same-name match") asks a clarifying
-- question when two active menu items share a name — e.g. "BLT" exists as
-- both a Cold Sandwich ($7.99) and a Homemade Panini ($10.99) — but persisted
-- no state. The customer's next message ("the panini one", "the first one",
-- "the 10.99 one") had nothing to resolve against, so it either re-asked the
-- identical question or produced "I got mixed up" on a perfectly reasonable
-- answer.
--
-- Shape written by index.ts: { query_name: string, candidates: [{
-- menu_item_id, name, category, price_cents }] }. Cleared (set NULL) on
-- RESET, on TESTMODE/RESTART cart resets, and the instant any resolution
-- succeeds — see chat-sms/pending-disambiguation.ts for the resolver.
--
-- ADDITIVE ONLY. Nullable, no default backfill needed (existing in-flight
-- carts simply have nothing pending). Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS pending_disambiguation JSONB;

COMMENT ON COLUMN order_carts.pending_disambiguation IS
  'Candidates GUARD 7 offered when two active menu items shared a name ({ query_name, candidates: [{menu_item_id, name, category, price_cents}] }). NULL means nothing pending. Read by chat-sms/index.ts BEFORE the LLM/tool loop runs on the next inbound message, resolved via chat-sms/pending-disambiguation.ts. Cleared on RESET, cart reset, or successful resolution.';
