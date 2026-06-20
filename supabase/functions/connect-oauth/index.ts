/**
 * SprintAI connect-oauth Edge Function (Spec 01, Path A — existing Stripe / Standard)
 *
 * Two GET actions on one function:
 *   GET /functions/v1/connect-oauth?action=start&shop_id=<uuid>
 *       → returns { url } : the Stripe OAuth authorize URL (state = signed shop_id).
 *   GET /functions/v1/connect-oauth?action=callback&code=<code>&state=<signed_shop_id>
 *       → exchanges code for connected account id, verifies capabilities,
 *         persists stripe_connected_account_id + connect_account_type='standard',
 *         then redirects the merchant back to the wizard.
 *
 * VERIFIED §10.1: classic Connect OAuth remains valid for connecting existing
 * Standard accounts.
 *   Authorize: https://connect.stripe.com/oauth/authorize?response_type=code
 *              &client_id=<CONNECT_CLIENT_ID>&scope=read_write&state=<signed_shop_id>
 *   Token:     stripe.oauth.token({ grant_type:'authorization_code', code })
 *              → { stripe_user_id } = connected account id.
 *
 * ⚠️ BLOCKED-ON-SECRETS for live test: STRIPE_CONNECT_CLIENT_ID and
 * STRIPE_OAUTH_REDIRECT_URL are not present in Supabase secrets, and Connect
 * must be enabled on the platform account with the redirect URI registered.
 * Code is complete; live round-trip cannot run until those are added.
 *
 * Standard accounts default to fees_payer='account' (restaurant bears Stripe
 * processing fees and disputes on DIRECT charges) — exactly our intended model,
 * no controller override needed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { makeStripe, REQUIRED_CAPABILITIES } from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") return jsonError("Method Not Allowed", 405);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  const clientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID") ?? "";
  const redirectUrl = Deno.env.get("STRIPE_OAUTH_REDIRECT_URL") ?? "";
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const stateSecret = Deno.env.get("CONNECT_OAUTH_STATE_SECRET")
    ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (action === "start") {
    const shopId = url.searchParams.get("shop_id");
    if (!shopId) return jsonError("shop_id is required");
    if (!clientId) return jsonError("STRIPE_CONNECT_CLIENT_ID not configured (blocked-on-secrets)", 503);

    const state = await signState(shopId, stateSecret);
    const authorizeUrl = new URL("https://connect.stripe.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("scope", "read_write");
    authorizeUrl.searchParams.set("state", state);
    if (redirectUrl) authorizeUrl.searchParams.set("redirect_uri", redirectUrl);
    // Prefill account type as standard onboarding for existing-Stripe merchants.
    authorizeUrl.searchParams.set("stripe_landing", "login");

    return jsonResponse({ url: authorizeUrl.toString() });
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      console.error("[connect-oauth] OAuth error:", error, url.searchParams.get("error_description"));
      return redirectToWizard(redirectUrl, { connect: "error", reason: error });
    }
    if (!code || !state) return jsonError("Missing code or state");
    if (!stripeKey) return jsonError("Stripe not configured", 500);

    const shopId = await verifyState(state, stateSecret);
    if (!shopId) return jsonError("Invalid state", 400);

    const stripe = makeStripe(stripeKey);

    try {
      // Exchange the authorization code for the connected account id.
      const token = await stripe.oauth.token({
        grant_type: "authorization_code",
        code,
      });
      const accountId = token.stripe_user_id;
      if (!accountId) return jsonError("No connected account returned from Stripe", 502);

      // Verify required capabilities are active on the connected account.
      const account = await stripe.accounts.retrieve(accountId);
      const missing = REQUIRED_CAPABILITIES.filter(
        (cap) => (account.capabilities as Record<string, string> | undefined)?.[cap] !== "active",
      );

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { persistSession: false } },
      );

      await supabase
        .from("shops")
        .update({
          stripe_connected_account_id: accountId,
          connect_account_type: "standard",
          charges_enabled: account.charges_enabled ?? false,
          payouts_enabled: account.payouts_enabled ?? false,
          connect_requirements_due: account.requirements?.currently_due ?? [],
          connect_status: missing.length === 0 && account.charges_enabled && account.payouts_enabled
            ? "enabled"
            : "pending",
        })
        .eq("id", shopId);

      console.log(`[connect-oauth] Linked standard account ${accountId} to shop ${shopId} (missing caps: ${missing.join(",") || "none"})`);

      return redirectToWizard(redirectUrl, {
        connect: missing.length === 0 ? "connected" : "needs_capabilities",
        shop_id: shopId,
        missing: missing.join(","),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[connect-oauth] Token exchange failed:", msg);
      return jsonError(msg, 502);
    }
  }

  return jsonError("Unknown action (use start|callback)", 400);
});

// ─── Signed state (HMAC) ─────────────────────────────────────────────────────

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

async function signState(shopId: string, secret: string): Promise<string> {
  const payload = `${shopId}.${Date.now()}`;
  const sig = await hmac(payload, secret);
  return b64url(new TextEncoder().encode(payload)) + "." + sig;
}

async function verifyState(state: string, secret: string): Promise<string | null> {
  const dot = state.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  let payload: string;
  try {
    payload = new TextDecoder().decode(fromB64url(payloadB64));
  } catch {
    return null;
  }
  const expected = await hmac(payload, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  const [shopId, tsStr] = payload.split(".");
  // 1-hour state validity window.
  if (!shopId || !tsStr || Date.now() - Number(tsStr) > 3600_000) return null;
  return shopId;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─── Responses ───────────────────────────────────────────────────────────────

function redirectToWizard(redirectUrl: string, params: Record<string, string>): Response {
  // Redirect back to the wizard origin if known, else return JSON for the caller.
  if (!redirectUrl) return jsonResponse({ ok: true, ...params });
  const dest = new URL(redirectUrl);
  for (const [k, v] of Object.entries(params)) if (v) dest.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { ...CORS_HEADERS, Location: dest.toString() } });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
