-- 132: Make assign_order_number() self-healing against a stray collision
--
-- INCIDENT (2026-09-10, vigil 684b7165)
-- --------------------------------------
-- cart 8cc9477d-0cb5-471b-99df-13047dba5774 (Not Just Bagels) completed a
-- real Stripe checkout, the webhook fired, found the cart, and its
-- order_carts UPDATE (payment_status -> 'paid', PI, charge id) threw:
--   duplicate key value violates unique constraint "idx_order_carts_shop_order_number"
-- Because assign_order_number() runs BEFORE UPDATE as part of that SAME
-- statement, the trigger's unique-constraint violation rolled back the
-- ENTIRE update — payment_status, stripe_payment_intent_id and
-- stripe_charge_id were never persisted even though Stripe had already
-- taken the payment. The cart was left stuck at payment_status='pending'
-- with no evidence anything happened, discoverable only by reading the
-- edge function's raw logs.
--
-- pg_advisory_xact_lock(hashtext('order_num_' || shop_id)) correctly
-- serializes concurrent transactions for the SAME shop_id under normal
-- operation. It does not protect against a stray already-committed row
-- occupying the number the MAX()+1 computation lands on (e.g. left behind
-- by a manual repro/backfill script writing order_carts directly, as this
-- repo's scripts/tmp-*.ts one-offs regularly do). When that happens today,
-- the trigger has no fallback — it throws, and per stripe-webhook's
-- top-level handler that throw becomes a rolled-back write with an
-- HTTP 200 response, so Stripe never retries either. A payment silently
-- stops existing in our system.
--
-- THE FIX
-- -------
-- assign_order_number() retries the MAX()+1 computation in a bounded loop,
-- re-deriving the next number each pass, until it lands on one the unique
-- index will actually accept. The advisory lock still serializes normal
-- concurrent traffic for a shop; this loop is the backstop for the
-- out-of-band-write case the lock was never meant to cover. Money-critical
-- payment fields must never again be able to roll back because of an
-- order-numbering side effect.

CREATE OR REPLACE FUNCTION assign_order_number()
RETURNS TRIGGER AS $$
DECLARE
  should_assign BOOLEAN := FALSE;
  candidate     INTEGER;
  attempt       INTEGER := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    should_assign := NEW.payment_status = 'paid' AND (OLD.payment_status IS DISTINCT FROM 'paid');
  ELSIF TG_OP = 'INSERT' THEN
    should_assign := NEW.payment_status = 'paid' AND NEW.order_number IS NULL;
  END IF;

  IF should_assign THEN
    PERFORM pg_advisory_xact_lock(hashtext('order_num_' || NEW.shop_id::text));

    -- Preferred starting point: dense numbering among PAID orders only, so
    -- an occasional cancelled/expired cart doesn't visibly gap the
    -- customer-facing sequence in the common case.
    SELECT COALESCE(MAX(order_number), 0) + 1
    INTO candidate
    FROM order_carts
    WHERE shop_id = NEW.shop_id
      AND payment_status = 'paid';

    -- idx_order_carts_shop_order_number spans EVERY row with a non-null
    -- order_number for this shop, regardless of payment_status — a cart
    -- that was numbered while paid and LATER moved to expired/refunded/etc.
    -- still occupies that number forever. Recomputing MAX() from paid rows
    -- only, as the original version of this function did, can get
    -- permanently wedged: it keeps landing on the exact same occupied
    -- number every retry and never advances (this is the actual root cause
    -- behind vigil 684b7165 — shop b0000000-...-0001's order_number=6 is
    -- held by an EXPIRED cart, so paid-only MAX+1 recomputes 6 forever).
    -- Advancing the candidate by increment on each collision, checked
    -- against ALL rows (any status), guarantees forward progress instead.
    LOOP
      attempt := attempt + 1;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM order_carts
        WHERE shop_id = NEW.shop_id AND order_number = candidate
      );
      candidate := candidate + 1;

      IF attempt >= 1000 THEN
        RAISE WARNING 'assign_order_number: giving up after % attempts for shop %, cart %; leaving order_number NULL', attempt, NEW.shop_id, NEW.id;
        candidate := NULL;
        EXIT;
      END IF;
    END LOOP;

    NEW.order_number := candidate;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
