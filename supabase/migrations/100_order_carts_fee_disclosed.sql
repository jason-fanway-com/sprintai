-- 100: order_carts.fee_disclosed_at — persist "have we told this customer
--      about the service fee breakdown yet" so the ledger footer states it
--      once instead of every turn.
--
-- Spec: docs/specs/2026-09-05-testkitchen-defects.md, DEFECT 3 (Jason's
-- product call). NOTE: the spec named this migration 099, but 099 was
-- concurrently claimed by another builder's build_status_* work
-- (docs/specs/2026-09-05-command-center-live.md) before this one landed.
-- Using 100 instead to avoid a numbering collision; no functional relation.
--
-- WHY
-- ---
-- renderLedgerFooter() in chat-sms/index.ts repeated the
-- "(subtotal $X + $0.99 service fee)" line on every single turn once the cart
-- had items. Jason: state the breakdown once, the first turn the fee applies,
-- and again at checkout — never inferred from message history, since that's
-- fragile across retries/edits. A real column is the only durable signal.
--
-- The fee itself is still always disclosed before payment: the checkout path
-- (chat-sms/index.ts, the checkoutUrl branch) states
-- "includes a $0.99 service fee" unconditionally and does not read this
-- column. This column only gates the mid-conversation footer's line 2.
--
-- ADDITIVE ONLY. Nullable, no default backfill needed (existing in-flight
-- carts simply see the breakdown once more on their next turn). Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS fee_disclosed_at TIMESTAMPTZ;

COMMENT ON COLUMN order_carts.fee_disclosed_at IS
  'Set the first turn the Ledger footer disclosed the subtotal+service-fee breakdown to the customer. NULL means not yet disclosed this cart. Read by chat-sms/index.ts renderLedgerFooter() to show the breakdown once instead of every turn. Never gates the unconditional checkout-time fee disclosure.';
