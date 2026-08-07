-- 042: Kitchen ticket idempotency guard — prevent duplicate order-ticket emails
--
-- PROBLEM
-- -------
-- payment_confirmed can fire more than once for the same order_cart (double-tap
-- pay link, distinct Stripe events for the same cart). The stripe-webhook is
-- idempotent per Stripe event.id, but that does NOT protect against distinct
-- events for the same cart. Without a cart-level guard, the restaurant gets
-- duplicate kitchen tickets.
--
-- THE FIX
-- --------
-- Add ticket_emailed_at timestamp to order_carts. The chat-sms edge function
-- claims the slot with a conditional UPDATE (WHERE ticket_emailed_at IS NULL)
-- before calling Resend. Only one concurrent caller can claim the slot.
-- If the UPDATE affects 0 rows, the slot was already claimed → skip.

DO $$ BEGIN
  ALTER TABLE order_carts ADD COLUMN ticket_emailed_at TIMESTAMPTZ DEFAULT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Down migration ─────────────────────────────────────────────────────────
-- Run this manually to revert:
-- ALTER TABLE order_carts DROP COLUMN IF EXISTS ticket_emailed_at;