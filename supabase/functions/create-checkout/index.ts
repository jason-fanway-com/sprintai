/**
 * SprintAI create-checkout Edge Function (Spec 02 — DIRECT CHARGE)
 *
 * POST /functions/v1/create-checkout
 * Body: { order_cart_id, success_url?, cancel_url? }
 *
 * Creates a Stripe Checkout Session as a DIRECT CHARGE on the restaurant's
 * connected account (Jason 2026-06-20):
 *   - The session is created WITH the `Stripe-Account: <connected_account_id>`
 *     header, so the PaymentIntent/Charge live ON the restaurant's account.
 *   - A visible "Service fee" line of $0.99 is shown to the diner before they
 *     pay (never labeled a card surcharge).
 *   - `payment_intent_data.application_fee_amount = 99` (constant
 *     SERVICE_FEE_CENTS) rides on top; Sprint keeps the full $0.99 whole.
 *   - NO `transfer_data.destination` and NO `on_behalf_of` (those are
 *     destination-charge params; absent here by design).
 *   - The shop must pass `isShopLive()` or we reject before creating a charge.
 *   - An idempotency key scoped to the connected account prevents double-charge.
 *
 * VERIFIED §10.4 (direct-charge variant): for a Checkout Session in direct-charge
 * mode, `application_fee_amount` goes under `payment_intent_data`, and the
 * `Stripe-Account` header is what makes it a direct charge. The application fee
 * is transferred to the platform; the connected account bears Stripe processing
 * fees (Express => application_express; Standard => account). Confirmed against
 * docs.stripe.com/connect/direct-charges 2026-06-20.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  makeStripe,
  isShopLive,
  connectedAccountOpts,
  SERVICE_FEE_CENTS,
} from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

interface CartItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  modifiers: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  let body: { order_cart_id?: string; success_url?: string; cancel_url?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const { order_cart_id, success_url, cancel_url } = body;
  if (!order_cart_id) return jsonError("order_cart_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Load cart + the shop's Connect state (needed for the go-live gate + routing).
  const { data: cart, error: cartErr } = await supabase
    .from("order_carts")
    .select(`*, shops(
      name, email_ticket_recipient,
      stripe_connected_account_id, connect_account_type,
      charges_enabled, payouts_enabled, connect_status
    )`)
    .eq("id", order_cart_id)
    .single();

  if (cartErr || !cart) return jsonError("Cart not found", 404);
  if (!cart.cart_json?.length) return jsonError("Cart is empty");

  const shop = cart.shops as {
    name: string;
    stripe_connected_account_id: string | null;
    charges_enabled: boolean | null;
    payouts_enabled: boolean | null;
    connect_status: string | null;
  };

  // GO-LIVE GATE: never route a live order to a non-enabled account.
  if (!isShopLive(shop)) {
    console.warn(`[create-checkout] Shop not live for cart ${order_cart_id} (status=${shop?.connect_status})`);
    return jsonError("This restaurant is not yet set up to accept orders.", 409);
  }

  const connectedAccountId = shop.stripe_connected_account_id as string;
  const shopName = shop.name ?? "Our Shop";
  const items = cart.cart_json as CartItem[];

  const stripe = makeStripe(stripeKey);

  // Food line items (as today) + tax (if any) folded into the diner total, then
  // the visible $0.99 service fee as its own line so the diner sees it up front.
  const lineItems: Array<Record<string, unknown>> = items.map((item) => ({
    price_data: {
      currency: "usd",
      unit_amount: item.price_cents,
      product_data: {
        name: item.name,
        description: item.modifiers?.length > 0 ? item.modifiers.join(", ") : undefined,
      },
    },
    quantity: item.quantity,
  }));

  const foodSubtotal = items.reduce((s, i) => s + i.price_cents * i.quantity, 0);
  const taxCents = cart.tax_cents ?? 0;

  // Tax as its own line if present (kept separate from the service fee).
  if (taxCents > 0) {
    lineItems.push({
      price_data: {
        currency: "usd",
        unit_amount: taxCents,
        product_data: { name: "Tax" },
      },
      quantity: 1,
    });
  }

  // Visible service-fee line — disclosed BEFORE payment, never a card surcharge.
  lineItems.push({
    price_data: {
      currency: "usd",
      unit_amount: SERVICE_FEE_CENTS,
      product_data: {
        name: "Service fee",
        description: "SprintAI platform service fee",
      },
    },
    quantity: 1,
  });

  // subtotal_cents = food + tax (what the restaurant keeps minus processing);
  // total_cents = subtotal + $0.99 (what the diner pays).
  const subtotalCents = foodSubtotal + taxCents;
  const totalCents = subtotalCents + SERVICE_FEE_CENTS;

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: lineItems as never,
        metadata: { order_cart_id, connected_account_id: connectedAccountId },
        // DIRECT-CHARGE: application fee rides on top; NO transfer_data / on_behalf_of.
        payment_intent_data: {
          application_fee_amount: SERVICE_FEE_CENTS,
          metadata: { order_cart_id },
        },
        custom_text: { submit: { message: `Your order from ${shopName}` } },
        success_url: success_url ?? `${Deno.env.get("SUPABASE_URL")}/order-success?cart=${order_cart_id}`,
        cancel_url: cancel_url ?? `${Deno.env.get("SUPABASE_URL")}/order-cancel?cart=${order_cart_id}`,
      },
      // Stripe-Account header => DIRECT charge on the connected account.
      // Idempotency key keyed on the cart prevents a duplicate charge on retry.
      connectedAccountOpts(connectedAccountId, `checkout_${order_cart_id}`),
    );

    await supabase
      .from("order_carts")
      .update({
        stripe_checkout_session_id: session.id,
        // PI is usually null at session-creation time for mode:payment; the
        // webhook (checkout.session.completed) captures the PI + charge id from
        // the connected account once payment completes.
        stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
        stripe_connected_account_id: connectedAccountId,
        subtotal_cents: subtotalCents,
        service_fee_cents: SERVICE_FEE_CENTS,
        total_cents: totalCents,
        phase: "checkout",
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
