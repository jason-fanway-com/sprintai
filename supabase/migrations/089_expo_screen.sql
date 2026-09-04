-- 089 — Expo Screen kitchen order states (INSTRUCTION-10 item G).
-- The Expo Screen is the default and always-active order delivery path for every shop.
-- Tracks four kitchen states per paid order so the screen can advance them on human action.
-- expo_acknowledged_at drives the 7-minute escalation (INSTRUCTION-10 item I).

ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS expo_status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS expo_acknowledged_at timestamptz;

COMMENT ON COLUMN order_carts.expo_status IS
  'Kitchen state on the Expo Screen: new|acknowledged|preparing|done. Advances on human action only.';
COMMENT ON COLUMN order_carts.expo_acknowledged_at IS
  'When kitchen acknowledged this order. Null = not yet acknowledged. 7-min escalation timer starts from here.';

-- ── Realtime ────────────────────────────────────────────────────────────────
-- The Expo Screen relies on Supabase Realtime to surface newly-paid orders and
-- to recover state after a network drop. An order row is created unpaid and
-- flipped to paid by the Stripe webhook, so the board must receive UPDATE events.
-- REPLICA IDENTITY FULL makes the shop_id filter reliable on UPDATE/DELETE.
ALTER TABLE order_carts REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'order_carts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE order_carts;
  END IF;
END $$;

-- ── Advance RPC ───────────────────────────────────────────────────────────────
-- Shop owners have SELECT-only on order_carts (all writes go through controlled
-- paths). Advancing a kitchen state is therefore a SECURITY DEFINER function that
-- re-checks ownership and only ever touches expo_status / expo_acknowledged_at —
-- never money, totals, or payment_status. Tenant isolation is preserved: a caller
-- can only advance orders belonging to a shop in their own tenant (or a super-admin).
CREATE OR REPLACE FUNCTION public.expo_advance_order(p_order_id uuid, p_next text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop uuid;
  v_tenant text;
BEGIN
  IF p_next NOT IN ('acknowledged', 'preparing', 'done') THEN
    RAISE EXCEPTION 'invalid next status: %', p_next;
  END IF;

  SELECT shop_id INTO v_shop FROM order_carts WHERE id = p_order_id;
  IF v_shop IS NULL THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  v_tenant := auth.jwt() -> 'user_metadata' ->> 'tenant_id';

  IF NOT (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM shops
      WHERE id = v_shop AND tenant_id::text = v_tenant
    )
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE order_carts
     SET expo_status = p_next,
         expo_acknowledged_at = CASE
           WHEN p_next = 'acknowledged' AND expo_acknowledged_at IS NULL THEN now()
           ELSE expo_acknowledged_at
         END
   WHERE id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.expo_advance_order(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.expo_advance_order(uuid, text) TO authenticated;
