-- 020: Per-shop order numbers — auto-assigned on payment confirmation
-- Each shop gets its own sequence (NJB-1, NJB-2, ...). Numbers never collide across shops.
-- Only confirmed/paid orders get a number; abandoned carts do not consume one.

BEGIN;

-- 1) Add the nullable column
ALTER TABLE order_carts ADD COLUMN order_number INTEGER;

-- 2) Unique per shop so no two confirmed orders share a number
CREATE UNIQUE INDEX idx_order_carts_shop_order_number
  ON order_carts(shop_id, order_number)
  WHERE order_number IS NOT NULL;

-- 3) Trigger function: assign next number when payment_status → 'paid'
CREATE OR REPLACE FUNCTION assign_order_number()
RETURNS TRIGGER AS $$
BEGIN
  -- Only assign if transitioning to paid (not already paid, not for non-paid states)
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS DISTINCT FROM 'paid') THEN
    -- Lock the shop's row in a tiny counter table (auto-created by first use)
    -- Using advisory lock is simpler and race-condition-free
    PERFORM pg_advisory_xact_lock(hashtext('order_num_' || NEW.shop_id::text));

    SELECT COALESCE(MAX(order_number), 0) + 1
    INTO NEW.order_number
    FROM order_carts
    WHERE shop_id = NEW.shop_id
      AND payment_status = 'paid'
    FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4) Attach trigger
CREATE TRIGGER trg_assign_order_number
  BEFORE UPDATE ON order_carts
  FOR EACH ROW
  EXECUTE FUNCTION assign_order_number();

COMMIT;