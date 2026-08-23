/**
 * SprintAI connect-create-express Edge Function (Spec 01, Path B)
 *
 * POST /functions/v1/connect-create-express
 * Body: { shop_id, return_url?, refresh_url? }
 *
 * Creates an EXPRESS connected account and returns a HOSTED onboarding link
 * (accountLinks.create) — never embedded. Restaurant completes onboarding on
 * Stripe's hosted flow; Stripe redirects back to return_url.
 *
 * DIRECT-CHARGE MODEL (Jason 2026-06-20):
 *   type='express' → fee-payer behavior 'application_express'. On DIRECT
 *   charges the CONNECTED ACCOUNT (restaurant) bears processing + dispute fees.
 *   Sprint keeps the full flat $0.99 application fee.
 *
 *   ⚠️ DO NOT set controller.fees.payer='account' on an express account —
 *   Stripe REJECTS it (verified empirically 2026-06-20).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  makeStripe,
  RESTAURANT_MCC,
} from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!stripeKey) return jsonError("Stripe not configured", 500);

  let body: { shop_id?: string; return_url?: string; refresh_url?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }
  const shopId = body.shop_id;
  if (!shopId) return jsonError("shop_id is required");

  // Default return/refresh URLs (setup page overrides with its own origin)
  const returnUrl = body.return_url ?? "https://getsprintai.com/admin/shop-owner";
  const refreshUrl = body.refresh_url ?? "https://getsprintai.com/admin/shop-owner?reauth=true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name, email_ticket_recipient, stripe_connected_account_id, connect_account_type")
    .eq("id", shopId)
    .single();

  if (shopErr || !shop) return jsonError("Shop not found", 404);

  const stripe = makeStripe(stripeKey);

  try {
    let accountId = shop.stripe_connected_account_id as string | null;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: shop.email_ticket_recipient ?? undefined,
        business_type: undefined,
        business_profile: {
          mcc: RESTAURANT_MCC,
          name: (shop.name ?? "").trim() || undefined,
        },
        // Prefill company name for hosted onboarding
        company: { name: (shop.name ?? "").trim() || undefined },
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

    // HOSTED onboarding link (never embedded — prevents collecting bank/SSN/identity)
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });

    return jsonResponse({
      account_id: accountId,
      url: link.url,
      return_url: returnUrl,
      onboarding_started_at: new Date().toISOString(),
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
