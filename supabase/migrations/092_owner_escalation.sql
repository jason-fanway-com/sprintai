-- 092 — Owner escalation claim column (INSTRUCTION-10 item I).
-- Exactly-once claim for the 7-minute unacknowledged-order escalation SMS.
-- The claim itself is a conditional UPDATE (WHERE owner_escalated_at IS NULL
-- RETURNING id) done by issue-detector's detectUnackedOrders — never gated
-- on the issues table, which can be deduped/closed/reopened independently.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS owner_escalated_at timestamptz;

COMMENT ON COLUMN order_carts.owner_escalated_at IS
  'When the 7-minute unacknowledged-order escalation SMS was claimed for this order. Non-null = already escalated; the claim is a conditional UPDATE so an order can escalate at most once (INSTRUCTION-10 item I).';

CREATE INDEX IF NOT EXISTS idx_order_carts_escalation_scan
  ON order_carts (shop_id, expo_status)
  WHERE owner_escalated_at IS NULL;
