/**
 * SprintAI connect-create-express Edge Function (Spec 01, Path B)
 *
 * POST /functions/v1/connect-create-express
 * Body: { shop_id }
 *
 * Creates an EXPRESS connected account for a restaurant new to Stripe and
 * returns an embedded-onboarding Account Session client secret for the wizard
 * to mount <ConnectAccountOnboarding /> (component name verified §10.2).
 *
 * DIRECT-CHARGE MODEL (Jason 2026-06-20):
 *   We create the account with `type: 'express'`. Stripe assigns this account
 *   the fee-payer behavior `application_express`, under which — for DIRECT
 *   charges — the CONNECTED ACCOUNT (restaurant) bears Stripe processing fees
 *   and dispute fees (verified against
 *   docs.stripe.com/connect/direct-charges-fee-payer-behavior, table row
 *   "application_express": Stripe payment processing fees = Connected Account,
 *   Dispute fees = Connected Account). Sprint keeps the full flat $0.99
 *   application fee whole on each direct charge.
 *
 *   ⚠️ DO NOT set controller.fees.payer='account' on an express-dashboard
 *   account — Stripe REJECTS it: "When stripe_dashboard[type]=express, your
 *   platform must collect fees and be liable for negative balances or refunds
 *   and chargebacks." (verified empirically 2026-06-20). The express account
 *   type already gives us the restaurant-bears-fees economics for DIRECT
 *   charges via application_express, so we use type='express' and do not
 *   override the controller.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  makeStripe,
  RESTAURANT_MCC,
} from "../_shared/connect.ts";

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

  let body: { shop_id?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }
  const shopId = body.shop_id;
  if (!shopId) return jsonError("shop_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Load the shop for prefill + idempotency.
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, email_ticket_recipient, stripe_connected_account_id, connect_account_type")
    .eq("id", shopId)
    .single();

  if (shopErr || !shop) return jsonError("Shop not found", 404);

  const stripe = makeStripe(stripeKey);

  try {
    // Idempotency: reuse an existing express account for this shop if present.
    let accountId = shop.stripe_connected_account_id as string | null;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express", // => fees_payer 'application_express' (restaurant bears processing+disputes on DIRECT charges)
        country: "US",
        email: shop.email_ticket_recipient ?? undefined,
        business_type: undefined, // collected in embedded onboarding
        business_profile: {
          mcc: RESTAURANT_MCC,
          name: shop.name ?? undefined,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { shop_id: shopId },
      });
      accountId = account.id;

      await supabase
        .from("shops")
        .update({
          stripe_connected_account_id: accountId,
          connect_account_type: "express",
          connect_status: "pending",
        })
        .eq("id", shopId);

      console.log(`[connect-create-express] Created express account ${accountId} for shop ${shopId}`);
    } else {
      console.log(`[connect-create-express] Reusing existing account ${accountId} for shop ${shopId}`);
    }

    // Create an embedded-onboarding Account Session (§10.2 verified).
    const session = await stripe.accountSessions.create({
      account: accountId,
      components: {
        account_onboarding: { enabled: true },
      },
    });

    return jsonResponse({
      account_id: accountId,
      client_secret: session.client_secret,
      // Front end (spec 05) mounts via @stripe/connect-js loadConnectAndInitialize
      // + <ConnectAccountOnboarding />, fetching this client_secret.
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[connect-create-express] Stripe error:", msg);
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
