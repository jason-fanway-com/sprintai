/**
 * create-subscription Edge Function — Item A, INSTRUCTION-08/10
 *
 * POST /functions/v1/create-subscription
 * Body: { shop_id }
 *
 * Creates a Stripe Checkout Session in subscription mode ($99/mo).
 * The session is platform-level (NOT a Connect direct charge).
 * The webhook (stripe-webhook) becomes the sole writer of subscription_status.
 *
 * Design decision: NEW endpoint, not an extension of create-checkout.
 * create-checkout handles per-order diner charges (mode:payment, Connect direct).
 * This is a platform subscription (mode:subscription, no Connect). Different
 * Stripe modes, different customer, different webhook handler — forcing them
 * through the same function would create a fragile mode-switching branch.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  const priceId = Deno.env.get("STRIPE_PRICE_SUBSCRIPTION") ?? "";
  if (!priceId) return jsonError("Subscription price not configured", 500);

  let body: { shop_id?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const { shop_id } = body;
  if (!shop_id) return jsonError("shop_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Verify shop exists
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, subscription_status, onboarding_token")
    .eq("id", shop_id)
    .single();

  if (shopErr || !shop) return jsonError("Shop not found", 404);

  // Idempotency: if already active, don't create another session
  if (shop.subscription_status === "active") {
    return jsonResponse({ already_subscribed: true, message: "Subscription already active" });
  }

  const stripe = new Stripe(stripeKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Build success/cancel URLs returning to setup.html.
  // setup.html.boot() resolves the shop from the `t` (onboarding_token) query
  // param — without it the owner lands on "Setup link not found". Carry the
  // token through Stripe so the return trip can resume the correct shop.
  const baseUrl = Deno.env.get("URL") ?? "https://getsprintai.com";
  const setupUrl = `${baseUrl}/signup-page/setup.html`;
  const tokenParam = shop.onboarding_token
    ? `t=${encodeURIComponent(shop.onboarding_token)}&`
    : "";
  const successUrl = `${setupUrl}?${tokenParam}sub=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${setupUrl}?${tokenParam}sub=canceled`;

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: shop_id,
      metadata: { shop_id },
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      payment_method_collection: "always", // CRITICAL: collect card even with 100%-off coupon
      billing_address_collection: "auto",
      subscription_data: {
        metadata: { shop_id },
      },
    };
    // Promo codes are entered by the customer on Stripe's hosted Checkout page
    // (allow_promotion_codes:true). Do NOT pre-apply server-side: passing a
    // promotion code as a `coupon` id is the wrong object type, and `discounts`
    // conflicts with allow_promotion_codes (Stripe rejects both together).

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[create-subscription] Session created: ${session.id} for shop ${shop_id}`);

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[create-subscription] Stripe error:", msg);
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