/**
 * go-live Edge Function — Spec 05 step 8 go-live gate.
 *
 * POST { shop_id }
 *
 * Verifies ALL go-live prerequisites and ONLY flips status='active',
 * is_paused=false when every gate passes. The Connect gate uses the shared
 * isShopLive() (single source of truth, spec 01/02) — so in Phase 1, with
 * Connect unconfigured, this endpoint correctly REFUSES to go live.
 *
 * Gates (all must pass):
 *   - Connect:       isShopLive(shop) === true  (charges+payouts enabled)
 *   - Menu:          a confirmed csv-source menu with >=1 active item
 *   - Number:        phone_number_e164 set
 *   - Hours:         open_hours has at least one day configured
 *   - Subscription:  subscription_status === 'active'
 *
 * Returns { ok, live, gates: {...}, blocked_by: [...] }. Never throws the shop
 * live partially; it's all-or-nothing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { isShopLive } from "../_shared/connect.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: { shop_id?: string };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }
  const shopId = body.shop_id;
  if (!shopId) return jsonError("shop_id is required");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, status, open_hours, phone_number_e164, subscription_status, stripe_connected_account_id, charges_enabled, payouts_enabled, connect_status")
    .eq("id", shopId).single();
  if (shopErr || !shop) return jsonError("Shop not found", 404);

  // Menu gate: confirmed csv menu with >=1 active item.
  const { data: menu } = await supabase
    .from("menus").select("id").eq("shop_id", shopId).eq("source", "csv").maybeSingle();
  let activeItems = 0;
  if (menu?.id) {
    const { count } = await supabase
      .from("menu_items").select("id", { count: "exact", head: true })
      .eq("menu_id", menu.id).eq("active", true);
    activeItems = count ?? 0;
  }

  const hoursSet = !!shop.open_hours && typeof shop.open_hours === "object" &&
    Object.keys(shop.open_hours as Record<string, unknown>).length > 0;

  const gates = {
    connect: isShopLive(shop),               // Phase-1: false (correct refusal)
    menu: activeItems > 0,
    number: !!shop.phone_number_e164,
    hours: hoursSet,
    subscription: shop.subscription_status === "active",
  };

  const blocked_by = Object.entries(gates).filter(([, ok]) => !ok).map(([k]) => k);

  if (blocked_by.length > 0) {
    return jsonResponse({
      ok: true, live: false, gates, blocked_by,
      message:
        blocked_by.includes("connect")
          ? "Go-live refused: Stripe Connect is not enabled yet (charges_enabled false). This is the expected Phase-1 gate — the shop cannot take live orders until payouts are configured."
          : "Go-live refused: " + blocked_by.join(", "),
    });
  }

  // All gates pass → flip live.
  const { error: upErr } = await supabase
    .from("shops").update({ status: "active", is_paused: false, onboarding_step: "done", updated_at: new Date().toISOString() })
    .eq("id", shopId);
  if (upErr) return jsonError("Failed to flip live: " + upErr.message, 500);

  return jsonResponse({ ok: true, live: true, gates, blocked_by: [] });
});

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
