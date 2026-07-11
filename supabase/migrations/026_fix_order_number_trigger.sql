-- 026: Fix assign_order_number trigger — remove invalid FOR UPDATE with aggregate
CREATE OR REPLACE FUNCTION assign_order_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS DISTINCT FROM 'paid') THEN
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
