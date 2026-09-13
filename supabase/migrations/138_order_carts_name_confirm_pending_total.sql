-- 138: order_carts.name_confirm_pending_total_cents — persist the cart item
--      subtotal (in cents; cheap, sufficient signature of "did the cart
--      change") at the moment the "Putting this in for X, right?" name
--      confirm was last issued, so it is never re-sent verbatim for a state
--      the customer has already been asked about.
--
-- docs/specs/2026-09-13-checkout-mode-insulation.md. Incident B (conv
-- fdf5ec8e, Vito's, a real paid order) showed "Putting this in for Jason,
-- right?" sent FOUR times in one conversation: once as the initial ask, once
-- after a compound "yes but add fries" turn (a legitimate re-ask — the total
-- changed), and twice more purely because the customer asked to see the
-- order (a read-only request that changes nothing) and the C2b-name shortcut
-- re-appended the identical question both times with no new reason to.
--
-- Nothing tracked "this exact question, for this exact total, was already
-- asked" — so a read-only turn could not distinguish "nothing changed, don't
-- repeat yourself" from "the cart changed, re-confirm before payment." This
-- column is that memory: NULL means not yet asked (or already
-- resolved/reset). Set to the real total the turn the confirm is issued;
-- read back and compared against the CURRENT real total to decide whether
-- repeating the question would be for a new reason or none at all. Once
-- pickup_name is set, this column is moot (no code path re-consults it), so
-- no separate clear-on-confirm step is needed — it is still reset alongside
-- pickup_name at the test-mode reset points for the same reason
-- delivery_offer_made_at (migration 136) is.
--
-- ADDITIVE ONLY. Nullable, no default backfill needed (existing in-flight
-- carts simply remain eligible for one full, unsuppressed ask on their next
-- turn, same as before this migration). Reversible.

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS name_confirm_pending_total_cents INTEGER;

COMMENT ON COLUMN order_carts.name_confirm_pending_total_cents IS
  'Cart item subtotal (cents) at the moment the pickup-name ask/confirm was last issued for this cart. NULL means not yet asked (or moot — pickup_name already set). Read by chat-sms/index.ts to avoid re-sending the identical "Putting this in for X, right?" question on a turn that changed nothing (e.g. a read-only "show me the order" request).';
