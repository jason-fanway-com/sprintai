/**
 * SprintAI refund-order Edge Function (Spec 02 — refund policy)
 *
 * POST /functions/v1/refund-order
 * Body: { order_cart_id, amount_cents?, reason? }
 *
 * Refunds an order's DIRECT charge on the CONNECTED account.
 *
 * REFUND POLICY (Jason 2026-06-20):
 *   - FULL refund  → also return Sprint's $0.99 application fee by passing
 *                    `refund_application_fee: true` on the Refund create call.
 *                    The $0.99 is NOT returned automatically — it must be
 *                    requested explicitly (verified docs.stripe.com:
 *                    "Application fees aren't automatically refunded when
 *                    issuing a refund").
 *   - PARTIAL refund → KEEP the $0.99 (do NOT set refund_application_fee).
 *
 * The refund is created with the platform secret key while authenticated as the
 * connected account (the `Stripe-Account` header), exactly as Stripe requires
 * for refunding direct charges.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { makeStripe, connectedAccountOpts } from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  let body: { order_cart_id?: string; amount_cents?: number; reason?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }
  const { order_cart_id, amount_cents, reason } = body;
  if (!order_cart_id) return jsonError("order_cart_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: cart, error: cartErr } = await supabase
    .from("order_carts")
    .select("id, total_cents, subtotal_cents, service_fee_cents, stripe_payment_intent_id, stripe_charge_id, stripe_connected_account_id, refunded_cents")
    .eq("id", order_cart_id)
    .single();

  if (cartErr || !cart) return jsonError("Order not found", 404);

  const connectedAccountId = cart.stripe_connected_account_id as string | null;
  if (!connectedAccountId) return jsonError("Order has no connected account on file", 409);

  const paymentIntentId = cart.stripe_payment_intent_id as string | null;
  const chargeId = cart.stripe_charge_id as string | null;
  if (!paymentIntentId && !chargeId) return jsonError("Order has no Stripe charge to refund", 409);

  // Full vs partial determination. Default (no amount) = FULL refund.
  const orderTotal = cart.total_cents ?? 0;
  const isFull = amount_cents == null || amount_cents >= orderTotal;
  const refundAmount = isFull ? undefined : amount_cents; // undefined => Stripe refunds the full remaining

  const stripe = makeStripe(stripeKey);

  try {
    const params: Record<string, unknown> = {
      reason: reason && ["duplicate", "fraudulent", "requested_by_customer"].includes(reason)
        ? reason
        : "requested_by_customer",
    };
    if (paymentIntentId) params.payment_intent = paymentIntentId;
    else params.charge = chargeId;
    if (refundAmount != null) params.amount = refundAmount;

    // FULL refund returns the $0.99; PARTIAL keeps it.
    if (isFull) params.refund_application_fee = true;

    const refund = await stripe.refunds.create(
      params as never,
      // Refund on the connected account (direct charge) + idempotency per attempt.
      connectedAccountOpts(connectedAccountId, `refund_${order_cart_id}_${isFull ? "full" : amount_cents}`),
    );

    const newRefunded = (cart.refunded_cents ?? 0) + (refund.amount ?? 0);
    const refundStatus = newRefunded >= orderTotal ? "full" : "partial";

    await supabase
      .from("order_carts")
      .update({
        refunded_cents: newRefunded,
        refund_status: refundStatus,
        payment_status: refundStatus === "full" ? "refunded" : "paid",
      })
      .eq("id", order_cart_id);

    console.log(`[refund-order] ${refundStatus} refund ${refund.id} on cart ${order_cart_id} acct ${connectedAccountId}: $${((refund.amount ?? 0) / 100).toFixed(2)}${isFull ? " (+$0.99 app fee returned)" : " ($0.99 kept)"}`);

    return jsonResponse({
      refund_id: refund.id,
      amount_cents: refund.amount,
      refund_status: refundStatus,
      application_fee_refunded: isFull,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[refund-order] Stripe error:", msg);
    return jsonError(msg, 500);
  }
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
