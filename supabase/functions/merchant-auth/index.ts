/**
 * merchant-auth Edge Function — server-side merchant PIN verification + writes.
 *
 * Replaces the insecure client-side PIN compare and the wide-open anon writes
 * that 004_merchant_pin.sql opened. After migration 012, anon can no longer
 * read shops.merchant_pin nor write availability_overrides / shops.is_paused.
 * The merchant Sold-Out manager (merchant-ui) now goes through THIS function,
 * which uses the service-role key (RLS-exempt) and verifies the PIN server-side.
 *
 * ENDPOINTS (one function, action-routed POST)
 * --------------------------------------------
 *  (A) Verify PIN, mint a session token:
 *      POST { action: "verify", slug, pin }
 *      -> { ok, token, shop: { id, name, is_paused } }   (token TTL = 12h)
 *      The PIN is read server-side via service-role and compared here. The PIN
 *      is NEVER returned to the client.
 *
 *  (B) Load the merchant's working data (menu + today's sold-out set + pause):
 *      POST { action: "state", token }
 *      -> { ok, shop:{id,name,is_paused}, menu_items:[...], sold_out:[ids],
 *           business_date }
 *
 *  (C) Toggle one item's sold-out status for today:
 *      POST { action: "set_availability", token, menu_item_id, sold_out: bool }
 *      -> { ok, sold_out:[ids] }
 *
 *  (D) Reset all of today's overrides:
 *      POST { action: "reset_availability", token }
 *      -> { ok, sold_out: [] }
 *
 *  (E) Pause / resume online ordering:
 *      POST { action: "set_pause", token, paused: bool }
 *      -> { ok, is_paused: bool }
 *
 * TOKEN
 * -----
 * Stateless HMAC-SHA256 token over a compact JSON payload {sid, exp}. Signed
 * with MERCHANT_AUTH_SECRET (env). Every write re-derives the shop_id from the
 * token — the client can ONLY ever act on the shop it authenticated to. There
 * is no shop_id taken from the request body for writes; it comes from the token.
 *
 * SEAM FOR FUTURE SprintAdmin AUTH
 * --------------------------------
 * This is a minimal PIN→token bridge, deliberately self-contained. When the
 * SprintAdmin spec lands (real accounts, credential management), replace the
 * `verifyPin` step and token minting with the real identity provider; the
 * write handlers (set_availability / reset_availability / set_pause) and their
 * "token resolves to exactly one shop_id" contract can stay as-is.
 *
 * HARD RULES HONORED
 * ------------------
 *  - merchant_pin is read only server-side and never echoed.
 *  - Tenant isolation: writes are scoped to the token's shop_id, never a
 *    body-supplied shop_id.
 *  - No card/bank/identity data handled here.
 *  - No secrets logged.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h, matches merchant-ui SESSION_TTL

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const secret = Deno.env.get("MERCHANT_AUTH_SECRET") ?? "";
  if (!secret) return jsonError("Server not configured (MERCHANT_AUTH_SECRET missing)", 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const action = String(body.action ?? "");

  // ── (A) VERIFY ──────────────────────────────────────────────────────────────
  if (action === "verify") {
    const slug = String(body.slug ?? "").trim();
    const pin  = String(body.pin ?? "").trim();
    if (!slug) return jsonError("slug is required");
    if (!pin)  return jsonError("pin is required");

    const { data: shop, error } = await supabase
      .from("shops")
      .select("id, name, is_paused, merchant_pin")
      .eq("slug", slug)
      .maybeSingle();
    if (error) return jsonError("Lookup failed", 500);
    if (!shop) return jsonError("Shop not found", 404);

    // Constant-time-ish compare; PIN never leaves the server.
    if (!shop.merchant_pin || !timingSafeEqual(String(shop.merchant_pin), pin)) {
      return jsonError("Incorrect PIN", 401);
    }

    const token = await mintToken(String(shop.id), secret);
    return jsonResponse({
      ok: true,
      token,
      shop: { id: shop.id, name: shop.name, is_paused: shop.is_paused },
    });
  }

  // All remaining actions require a valid token resolving to a shop_id.
  const token = String(body.token ?? "");
  const shopId = await verifyToken(token, secret);
  if (!shopId) return jsonError("Invalid or expired session. Please sign in again.", 401);

  const today = new Date().toISOString().split("T")[0];

  // ── (B) STATE ────────────────────────────────────────────────────────────────
  if (action === "state") {
    const { data: shop } = await supabase
      .from("shops").select("id, name, is_paused").eq("id", shopId).maybeSingle();
    if (!shop) return jsonError("Shop not found", 404);

    const { data: menus } = await supabase
      .from("menus").select("id").eq("shop_id", shopId)
      .order("created_at", { ascending: false }).limit(1);
    let menu_items: unknown[] = [];
    if (menus && menus.length) {
      const { data: items } = await supabase
        .from("menu_items")
        .select("id, name, price_cents, category, display_order")
        .eq("menu_id", menus[0].id).eq("active", true)
        .order("display_order", { ascending: true });
      menu_items = items ?? [];
    }
    const { data: ov } = await supabase
      .from("availability_overrides").select("menu_item_id")
      .eq("shop_id", shopId).eq("business_date", today);

    return jsonResponse({
      ok: true,
      shop,
      menu_items,
      sold_out: (ov ?? []).map((o: Record<string, unknown>) => o.menu_item_id),
      business_date: today,
    });
  }

  // ── (C) SET AVAILABILITY (86 toggle) ─────────────────────────────────────────
  if (action === "set_availability") {
    const menuItemId = String(body.menu_item_id ?? "");
    const soldOut    = body.sold_out === true;
    if (!menuItemId) return jsonError("menu_item_id is required");

    // Guard: the item must belong to this shop (tenant isolation).
    const ok = await itemBelongsToShop(supabase, menuItemId, shopId);
    if (!ok) return jsonError("Item does not belong to this shop", 403);

    // Upsert pattern mirrors the old client logic: delete then optionally insert.
    await supabase.from("availability_overrides")
      .delete().eq("shop_id", shopId).eq("menu_item_id", menuItemId).eq("business_date", today);
    if (soldOut) {
      const { error } = await supabase.from("availability_overrides").insert({
        shop_id: shopId, menu_item_id: menuItemId, business_date: today,
        source: "merchant", set_by: "merchant-auth",
      });
      if (error) return jsonError("Failed to save: " + error.message, 500);
    }

    const { data: ov } = await supabase
      .from("availability_overrides").select("menu_item_id")
      .eq("shop_id", shopId).eq("business_date", today);
    return jsonResponse({ ok: true, sold_out: (ov ?? []).map((o: Record<string, unknown>) => o.menu_item_id) });
  }

  // ── (D) RESET AVAILABILITY ───────────────────────────────────────────────────
  if (action === "reset_availability") {
    const { error } = await supabase.from("availability_overrides")
      .delete().eq("shop_id", shopId).eq("business_date", today);
    if (error) return jsonError("Failed to reset: " + error.message, 500);
    return jsonResponse({ ok: true, sold_out: [] });
  }

  // ── (E) SET PAUSE ────────────────────────────────────────────────────────────
  if (action === "set_pause") {
    const paused = body.paused === true;
    const { error } = await supabase.from("shops")
      .update({ is_paused: paused }).eq("id", shopId);
    if (error) return jsonError("Failed to update pause status: " + error.message, 500);
    return jsonResponse({ ok: true, is_paused: paused });
  }

  return jsonError("Unknown action: " + action);
});

// ─── Token helpers (HMAC-SHA256 over compact JSON) ───────────────────────────
async function mintToken(shopId: string, secret: string): Promise<string> {
  const payload = { sid: shopId, exp: Date.now() + TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, secret);
  return `${body}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<string | null> {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(body, secret);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as { sid?: string; exp?: number };
    if (!payload.sid || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload.sid;
  } catch { return null; }
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

// Length-independent constant-time-ish string compare.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function itemBelongsToShop(
  supabase: ReturnType<typeof createClient>, menuItemId: string, shopId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("menu_items")
    .select("id, menus!inner(shop_id)")
    .eq("id", menuItemId)
    .eq("menus.shop_id", shopId)
    .maybeSingle();
  return !!data;
}

// ─── Response helpers ────────────────────────────────────────────────────────
function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
