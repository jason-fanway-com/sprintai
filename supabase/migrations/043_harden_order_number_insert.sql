-- 043: Harden order-number assignment — also fire on INSERT when row lands paid
--
-- PROBLEM
-- -------
-- assign_order_number() fires ONLY on BEFORE UPDATE (pending→paid transition).
-- Any path that INSERTs a cart already in paid state skips the trigger entirely,
-- leaving order_number NULL → kitchen ticket emails show no order #.
-- Real customer orders go through pending→paid and are fine, but test-harness
-- and any future direct-paid paths are broken.
--
-- THE FIX
-- --------
-- Extend assign_order_number() to handle INSERT in addition to UPDATE.
-- On INSERT: assign a number when the row is paid AND order_number IS NULL.
-- On UPDATE: existing behavior unchanged (assign only on non-paid→paid transition).
-- Both paths use the SAME advisory lock + SELECT MAX per shop — no second counter.
--
-- COLLISION / DOUBLE-ASSIGNMENT GUARDS
-- - INSERT path: order_number IS NULL gate → never renumbers.
-- - UPDATE path: OLD.payment_status IS DISTINCT FROM 'paid' gate → only fires
--   on transition. A cart already paid (from INSERT) won't re-trigger.
-- - Advisory lock serializes both paths per shop → no concurrent MAX collision.

BEGIN;

-- 1) Extend the existing function to handle both INSERT and UPDATE
CREATE OR REPLACE FUNCTION assign_order_number()
RETURNS TRIGGER AS $$
DECLARE
  should_assign BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Existing path: transitioning from non-paid → paid
    should_assign := NEW.payment_status = 'paid' AND (OLD.payment_status IS DISTINCT FROM 'paid');
  ELSIF TG_OP = 'INSERT' THEN
    -- New path: inserted directly as paid with no number
    should_assign := NEW.payment_status = 'paid' AND NEW.order_number IS NULL;
  END IF;

  IF should_assign THEN
    PERFORM pg_advisory_xact_lock(hashtext('order_num_' || NEW.shop_id::text));
    SELECT COALESCE(MAX(order_number), 0) + 1
    INTO NEW.order_number
    FROM order_carts
    WHERE shop_id = NEW.shop_id
      AND payment_status = 'paid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Add BEFORE INSERT trigger (idempotent)
DROP TRIGGER IF EXISTS trg_assign_order_number_insert ON order_carts;
CREATE TRIGGER trg_assign_order_number_insert
  BEFORE INSERT ON order_carts
  FOR EACH ROW
  EXECUTE FUNCTION assign_order_number();

-- The existing BEFORE UPDATE trigger (trg_assign_order_number, created in 020)
-- is untouched and continues to fire on UPDATE.

COMMIT;