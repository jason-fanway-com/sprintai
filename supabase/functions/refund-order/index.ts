/**
 * refund-order — cancel or refund a paid order by the agreed rules (Jason 2026-10-05/06; _shared/refund-rules.ts).
 *
 * POST { order_cart_id, initiated_by: "shop" | "customer", food_refund_cents?, preview? }
 *   Authorization: the shop owner's or an OrderFare admin's session (admin-chat forwards the owner's).
 *
 * Only the shop starts a refund; OrderFare never decides one. preview: true returns the plan and changes nothing.
 * Otherwise: cancel the courier first (if the plan says so), re-plan on what Uber actually did, then refund —
 *  - on the shop's Stripe account (a direct charge): hand back the matching part of OrderFare's application fee to the
 *    shop's account, then refund the customer from it; never reverse_transfer (direct charges have no transfer);
 *  - on OrderFare's account (a test order with no shop account): one refund.
 * A shop-caused Uber charge goes on the shop's balance (migration 152). The note is texted with the refund notice.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { makeStripe, connectedAccountOpts } from "../_shared/connect.ts";
import { cancelDeliveryForCart, deliveryForCart } from "../_shared/delivery-store.ts";
import { providerFor } from "../_shared/delivery-providers.ts";
import { applicationFeeRefundCents, planRefund, type CourierStage, type RefundPlan } from "../_shared/refund-rules.ts";
import { getTestModeStripeKey } from "../_shared/test-mode.ts";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
const err = (m: string, status = 400) => json({ error: m }, status);

function stageOf(status: string | null | undefined): CourierStage {
  if (!status) return "none";
  if (status === "created" || status === "quoted") return "requested";
  if (status === "courier_assigned") return "assigned";
  if (status === "picked_up" || status === "dropped_off") return "picked_up";
  return "none"; // canceled / returned / unknown: nothing left to cancel
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return err("Method Not Allowed", 405);
  let body: { order_cart_id?: string; initiated_by?: string; food_refund_cents?: number; preview?: boolean };
  try { body = await req.json(); } catch { return err("Invalid JSON"); }
  const cartId = body.order_cart_id, by = body.initiated_by;
  if (!cartId) return err("order_cart_id is required");
  if (by !== "shop" && by !== "customer") return err("Say who cancelled: the shop or the customer.");

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // who may refund: an OrderFare admin, or the owner of the order's shop (it used to accept anyone, 2026-10-06)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const internalKeys = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("INTERNAL_FUNCTION_SECRET")].filter((k): k is string => !!k && k.length > 20);
  const internal = internalKeys.includes(jwt); // admin-chat (already scoped to the owner's shop) and OrderFare's own tooling
  const user = internal ? null : (await db.auth.getUser(jwt)).data.user;
  if (!internal && !user) return err("Please sign in.", 401);
  const role = internal ? "super_admin" : (user!.app_metadata as { role?: string } | null)?.role, tenant = internal ? undefined : (user!.app_metadata as { tenant_id?: string } | null)?.tenant_id;

  const { data: c } = await db.from("order_carts").select("*, shops(id, tenant_id, name, phone_number_e164)").eq("id", cartId).maybeSingle();
  const cart = c as Record<string, any> | null;
  if (!cart) return err("Order not found.", 404);
  const shop = cart.shops as { id: string; tenant_id: string; name: string };
  if (role !== "super_admin" && !(role === "shop_owner" && tenant && tenant === shop.tenant_id)) return err("Order not found.", 404);
  if (cart.payment_status !== "paid") return err("That order isn't paid, so there's nothing to refund.", 409);
  if ((cart.refunded_cents ?? 0) > 0) return err("That order has already been refunded.", 409);

  const delivery = await deliveryForCart(db, cartId);
  const foodTax = (cart.subtotal_cents ?? 0) + (cart.tax_cents ?? 0);
  const courier = !!delivery && (delivery.provider ?? "own") !== "own";
  const base = {
    foodTaxCents: foodTax, feeCents: cart.service_fee_cents ?? 0, courier,
    deliveryCents: cart.delivery_fee_cents ?? 0, tipCents: cart.driver_tip_cents ?? 0,
    initiatedBy: by as "shop" | "customer", foodRefundCents: body.food_refund_cents ?? foodTax,
  };
  let plan: RefundPlan = planRefund({ ...base, stage: courier ? stageOf(delivery!.status) : "none" });
  if (body.preview) return json({ preview: true, plan, order_number: cart.order_number, total_cents: cart.total_cents });

  // 1. the courier first: what Uber actually does decides OrderFare's part
  if (plan.cancelCourier) {
    const out = await cancelDeliveryForCart(db, cartId, providerFor).catch(() => ({ cancelled: false as const, reason: "provider_refused" as const }));
    if (!out.cancelled) plan = planRefund({ ...base, stage: "picked_up" });                      // Uber refused: treat as on its way
    else if ("fee_cents" in out && out.fee_cents > 0) plan = planRefund({ ...base, stage: "assigned", uberReportedFeeCents: out.fee_cents });
  }
  if (plan.customerRefundCents <= 0) {
    await db.from("order_carts").update({ refund_note: plan.explain.join(" ") || null }).eq("id", cartId);
    return json({ ok: true, plan, refunded_cents: 0 });
  }

  // 2. the money
  const key = cart.test_mode ? (getTestModeStripeKey() ?? "") : (Deno.env.get("STRIPE_SECRET_KEY") ?? "");
  if (!key) return err("Payments aren't configured.", 500);
  const stripe = makeStripe(key);
  const acct = cart.stripe_connected_account_id as string | null;
  const pi = cart.stripe_payment_intent_id as string | null, charge = cart.stripe_charge_id as string | null;
  if (!pi && !charge) return err("That order has no card payment on file.", 409);
  const meta = { orderfare: "1", initiated_by: by, cart_id: cartId };
  try {
    if (acct) {
      const share = base.feeCents + (courier ? base.deliveryCents + base.tipCents : 0);
      if (plan.platformRefundCents > 0) {
        const ch = await stripe.charges.retrieve(charge ?? ((await stripe.paymentIntents.retrieve(pi!, connectedAccountOpts(acct))).latest_charge as string), connectedAccountOpts(acct));
        const feeId = typeof ch.application_fee === "string" ? ch.application_fee : ch.application_fee?.id;
        const feeAmt = ch.application_fee_amount ?? 0;
        const back = applicationFeeRefundCents(feeAmt, share, plan.platformRefundCents);
        if (feeId && back > 0) await stripe.applicationFees.createRefund(feeId, { amount: back, metadata: meta }, { idempotencyKey: `appfee_${cartId}` });
      }
      await stripe.refunds.create({ ...(pi ? { payment_intent: pi } : { charge: charge! }), amount: plan.customerRefundCents, reason: "requested_by_customer", metadata: meta },
        connectedAccountOpts(acct, `refund_${cartId}`));
    } else {
      await stripe.refunds.create({ ...(pi ? { payment_intent: pi } : { charge: charge! }), amount: plan.customerRefundCents, reason: "requested_by_customer", metadata: meta },
        { idempotencyKey: `refund_${cartId}` });
    }
  } catch (e) {
    console.error("[refund-order] stripe:", e);
    return err("The card refund didn't go through: " + (e instanceof Error ? e.message : String(e)), 502);
  }

  // 3. the record
  const full = plan.customerRefundCents >= (cart.total_cents ?? 0);
  await db.from("order_carts").update({
    refunded_cents: plan.customerRefundCents, refund_status: full ? "full" : "partial", payment_status: full ? "refunded" : "paid",
    refund_note: plan.explain.join(" ") || null,
  }).eq("id", cartId);
  if (plan.shopOwesCents > 0) {
    await db.from("shop_balance_entries").insert({ shop_id: shop.id, cart_id: cartId, cents: plan.shopOwesCents, reason: "Uber cancellation fee (shop cancelled after a driver accepted)" });
    const { data: s } = await db.from("shops").select("balance_owed_cents").eq("id", shop.id).single();
    await db.from("shops").update({ balance_owed_cents: ((s as { balance_owed_cents?: number } | null)?.balance_owed_cents ?? 0) + plan.shopOwesCents }).eq("id", shop.id);
  }
  // tell the customer now (the Stripe refund event may come late, or not at all for a test charge)
  if (cart.conversation_id) {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/chat-sms`, {
      method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shop.id, conversation_id: cart.conversation_id, order_cart_id: cartId, system_event: "order_refunded" }),
    }).catch((e) => console.error("[refund-order] refund notice failed:", e));
  }
  console.log(`[refund-order] cart ${cartId} by ${by}: customer ${plan.customerRefundCents} (food ${plan.foodRefundCents}, platform ${plan.platformRefundCents}), uber ${plan.uberChargeCents}, shop owes ${plan.shopOwesCents}`);
  return json({ ok: true, plan, refunded_cents: plan.customerRefundCents });
});
