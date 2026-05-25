/**
 * SprintAI create-checkout Edge Function
 *
 * POST /functions/v1/create-checkout
 * Body: { order_cart_id, success_url?, cancel_url? }
 *
 * Creates a Stripe Checkout session for an order_cart, saves the session ID
 * back to the cart, and returns the checkout URL.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

interface CartItem {
  menu_item_id: string;
  name:         string;
  quantity:     number;
  price_cents:  number;
  modifiers:    string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  let body: { order_cart_id?: string; success_url?: string; cancel_url?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const { order_cart_id, success_url, cancel_url } = body;
  if (!order_cart_id) return jsonError("order_cart_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Load cart and shop
  const { data: cart, error: cartErr } = await supabase
    .from("order_carts")
    .select("*, shops(name, email_ticket_recipient)")
    .eq("id", order_cart_id)
    .single();

  if (cartErr || !cart) return jsonError("Cart not found", 404);
  if (!cart.cart_json?.length) return jsonError("Cart is empty");

  const shopName = (cart.shops as { name: string })?.name ?? "Our Shop";
  const items    = cart.cart_json as CartItem[];

  const stripe = new Stripe(stripeKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const lineItems = items.map(item => ({
    price_data: {
      currency:     "usd",
      unit_amount:  item.price_cents,
      product_data: {
        name:        item.name,
        description: item.modifiers?.length > 0 ? item.modifiers.join(", ") : undefined,
      },
    },
    quantity: item.quantity,
  }));

  const subtotal = items.reduce((s, i) => s + i.price_cents * i.quantity, 0);

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 "payment",
      payment_method_types: ["card"],
      line_items:           lineItems,
      metadata:             { order_cart_id },
      custom_text:          { submit: { message: `Your order from ${shopName}` } },
      success_url:          success_url ?? `${Deno.env.get("SUPABASE_URL")}/order-success?cart=${order_cart_id}`,
      cancel_url:           cancel_url  ?? `${Deno.env.get("SUPABASE_URL")}/order-cancel?cart=${order_cart_id}`,
    });

    // Save session ID and update cart
    await supabase
      .from("order_carts")
      .update({
        stripe_checkout_session_id: session.id,
        subtotal_cents:             subtotal,
        total_cents:                subtotal,
        phase:                      "checkout",
      })
      .eq("id", order_cart_id);

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[create-checkout] Stripe error:", msg);
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
