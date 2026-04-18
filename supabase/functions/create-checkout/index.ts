/**
 * SprintAI create-checkout Edge Function
 * Creates a Stripe Checkout session for the signup page
 * 
 * POST /functions/v1/create-checkout
 * Body: { price_id, plan, business_name, website_url, business_type, email, success_url, cancel_url }
 */

import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON");
  }

  const {
    price_id,
    plan,
    business_name,
    website_url,
    business_type,
    email,
    success_url,
    cancel_url,
  } = body;

  if (!price_id || !email || !business_name) {
    return jsonError("price_id, email, and business_name are required");
  }

  const stripe = new Stripe(stripeKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: price_id, quantity: 1 }],
      customer_email: email,
      success_url: success_url ?? `${req.headers.get("origin")}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancel_url ?? `${req.headers.get("origin")}/signup`,
      metadata: {
        business_name,
        website_url: website_url ?? "",
        business_type: business_type ?? "business",
        plan: plan ?? "starter",
      },
      subscription_data: {
        trial_period_days: 30,
        metadata: {
          business_name,
          website_url: website_url ?? "",
          business_type: business_type ?? "business",
          plan: plan ?? "starter",
        },
      },
      allow_promotion_codes: true,
      billing_address_collection: "required",
    });

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[create-checkout] Stripe error:", errMsg);
    return jsonError(errMsg, 500);
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
