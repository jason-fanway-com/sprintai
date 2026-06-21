/**
 * onboarding-save Edge Function — Spec 05 save-and-resume persistence.
 *
 * One endpoint, two shapes:
 *
 *  (A) Create the shop (wizard step 1 "Account & basics"):
 *      POST { action: "create", account: { email, name, website_url, address,
 *             phone, timezone } }
 *      -> creates a tenant + shop row (status='onboarding',
 *         onboarding_step='account'); returns { shop_id, slug }.
 *
 *  (B) Save a step (every later step):
 *      POST { action: "save", shop_id, onboarding_step, fields: { ...allowed } }
 *      -> updates onboarding_step + a whitelisted set of shop columns; returns
 *         the refreshed shop row so the wizard can resume.
 *
 *  (C) Resume:
 *      POST { action: "resume", shop_id }  OR  { action: "resume", email }
 *      -> returns the shop row (incl. onboarding_step) to rehydrate the wizard.
 *
 * Hard rules honored:
 *  - NO card/bank/identity data is ever accepted here (Stripe components only).
 *    The `fields` whitelist below structurally excludes such data.
 *  - Additive, non-destructive. No deletes.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Columns the wizard is allowed to write. Anything not here is dropped — this
// is the structural guard against card/bank/identity data reaching Sprint's DB.
const ALLOWED_FIELDS = new Set<string>([
  "name", "display_name", "website_url", "timezone", "email_ticket_recipient",
  "ai_instructions", "tax_rate_bps", "cash_discount_mode", "catering_mode",
  "wing_flavors_included", "wing_mix_extra", "open_hours", "pause_message",
  "optin_language", "stop_help_wording", "reply_from_e164",
  // subscription STATUS flags only — never payment method data itself.
  "subscription_status", "subscription_pm_set", "stripe_subscription_id",
]);

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "shop";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const action = String(body.action ?? "");

  // ── (A) CREATE ────────────────────────────────────────────────────────────
  if (action === "create") {
    const account = (body.account ?? {}) as Record<string, string>;
    const name = (account.name ?? "").trim();
    const email = (account.email ?? "").trim();
    if (!name) return jsonError("Restaurant name is required");
    if (!email) return jsonError("Email is required");

    // A tenant is the billing/identity parent of a shop (shops.tenant_id NOT NULL).
    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .insert({ name, status: "onboarding", onboarding_status: "pending" })
      .select("id").single();
    if (tErr || !tenant) return jsonError("Failed to create tenant: " + (tErr?.message ?? "unknown"), 500);

    // Unique slug.
    let baseSlug = slugify(name);
    let slug = baseSlug;
    for (let i = 0; i < 50; i++) {
      const { data: clash } = await supabase.from("shops").select("id").eq("slug", slug).maybeSingle();
      if (!clash) break;
      slug = `${baseSlug}-${i + 2}`;
    }

    const { data: shop, error: sErr } = await supabase
      .from("shops")
      .insert({
        tenant_id: tenant.id,
        name,
        display_name: name,
        slug,
        website_url: account.website_url ?? null,
        timezone: account.timezone || "America/New_York",
        email_ticket_recipient: email,
        status: "onboarding",
        onboarding_step: "account",
        is_paused: true,
      })
      .select("id, slug, onboarding_step").single();
    if (sErr || !shop) return jsonError("Failed to create shop: " + (sErr?.message ?? "unknown"), 500);

    return jsonResponse({ ok: true, shop_id: shop.id, slug: shop.slug, onboarding_step: shop.onboarding_step });
  }

  // ── (B) SAVE ──────────────────────────────────────────────────────────────
  if (action === "save") {
    const shopId = String(body.shop_id ?? "");
    if (!shopId) return jsonError("shop_id is required");

    const fields = (body.fields ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (ALLOWED_FIELDS.has(k)) update[k] = v;
    }
    if (body.onboarding_step) update.onboarding_step = String(body.onboarding_step);
    update.updated_at = new Date().toISOString();

    const { data: shop, error } = await supabase
      .from("shops").update(update).eq("id", shopId)
      .select("*").single();
    if (error || !shop) return jsonError("Save failed: " + (error?.message ?? "shop not found"), 404);

    return jsonResponse({ ok: true, shop: redact(shop) });
  }

  // ── (C) RESUME ──────────────────────────────────────────────────────────────
  if (action === "resume") {
    const shopId = body.shop_id ? String(body.shop_id) : "";
    const email = body.email ? String(body.email) : "";
    let q = supabase.from("shops").select("*").eq("status", "onboarding");
    if (shopId) q = q.eq("id", shopId);
    else if (email) q = q.eq("email_ticket_recipient", email);
    else return jsonError("shop_id or email is required");

    const { data: shop } = await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!shop) return jsonResponse({ ok: true, shop: null });
    return jsonResponse({ ok: true, shop: redact(shop) });
  }

  return jsonError("Unknown action: " + action);
});

/** Defensive: never echo any sensitive token back to the browser. */
function redact(shop: Record<string, unknown>): Record<string, unknown> {
  const out = { ...shop };
  for (const k of Object.keys(out)) {
    if (/secret|token|client_secret/i.test(k)) delete out[k];
  }
  return out;
}

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
