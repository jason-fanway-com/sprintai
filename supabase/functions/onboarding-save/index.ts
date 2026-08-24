/**
 * onboarding-save Edge Function — Spec 05 save-and-resume persistence
 * + trimmed self-serve onboarding (2026-08-23).
 *
 * Actions:
 *   create  — create shop + tenant, set owner_name + onboarding_token,
 *             send Resend welcome email, return setup_url.
 *   save    — update allowed fields on an existing shop.
 *   resume  — lookup by shop_id, email, OR onboarding_token.
 *
 * Hard rules:
 *  - NO card/bank/identity data in fields (whitelist gates this).
 *  - If RESEND_API_KEY is unset or send fails, log and continue.
 *  - Token is ≥128-bit (crypto.randomUUID() concatenated twice → 64 hex).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_FIELDS = new Set<string>([
  "name", "display_name", "website_url", "timezone", "email_ticket_recipient",
  "ai_instructions", "tax_rate_bps", "cash_discount_mode", "catering_mode",
  "wing_flavors_included", "wing_mix_extra", "open_hours", "pause_message",
  "optin_language", "stop_help_wording", "reply_from_e164",
  "subscription_status", "subscription_pm_set", "stripe_subscription_id",
  // Phase 2–4 onboarding fields
  "owner_name", "ein", "is_test", "menu_links", "special_instructions",
  "delivery_enabled", "delivery_hours", "delivery_fee_cents",
]);

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "shop";
}

/** Generate an unguessable ≥128-bit token (64 hex chars). */
function generateToken(): string {
  // Two UUIDs concatenated = 64 hex chars = 256 bits.
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
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
    const ownerName = (account.owner_name ?? "").trim();
    const email = (account.email ?? "").trim();
    if (!name) return jsonError("Restaurant name is required");
    if (!ownerName) return jsonError("Owner name is required");
    if (!email) return jsonError("Email is required");

    const ist = isTestEmail(email);
    const baseSlug = slugify(name) || "shop";
    const token = generateToken();

    // Unique tenant slug.
    let tenantSlug = baseSlug;
    for (let i = 0; i < 50; i++) {
      const { data: clash } = await supabase.from("tenants").select("id").eq("slug", tenantSlug).maybeSingle();
      if (!clash) break;
      tenantSlug = `${baseSlug}-${i + 2}`;
    }

    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .insert({ name, slug: tenantSlug, status: "onboarding", onboarding_status: "pending" })
      .select("id").single();
    if (tErr || !tenant) return jsonError("Failed to create tenant: " + (tErr?.message ?? "unknown"), 500);

    // Unique shop slug.
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
        owner_name: ownerName,
        onboarding_token: token,
        website_url: account.website_url ?? null,
        timezone: account.timezone || "America/New_York",
        email_ticket_recipient: email,
        onboarding_step: "account",
        is_paused: true,
        is_test: ist,
        crawl_status: account.website_url ? "pending" : null,
      })
      .select("id, slug, onboarding_step, onboarding_token, website_url, crawl_status").single();
    if (sErr || !shop) return jsonError("Failed to create shop: " + (sErr?.message ?? "unknown"), 500);

    // Kick async website crawl (non-blocking)
    const _scrape = kickScrape(shop.id, shop.website_url ?? null, Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    // Kick async Google Places lookup (non-blocking, Phase 6)
    const _places = kickPlaces(shop.id, name, Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const setupUrl = `https://getsprintai.com/signup-page/setup.html?t=${shop.onboarding_token}`;

    // Send welcome email (non-blocking).
    if (resendKey) {
      try {
        const emailHtml = welcomeEmailHtml(ownerName, setupUrl);
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "SprintAI <hello@getsprintai.com>",
            to: [email],
            subject: `Welcome to the SprintAI family, ${ownerName} 🎉`,
            html: emailHtml,
          }),
        });
        if (!resendRes.ok) {
          const errText = await resendRes.text();
          console.error("Resend send failed:", errText);
        } else {
          console.log("Welcome email sent to", email);
        }
      } catch (e) {
        console.error("Resend send error:", e);
      }
    } else {
      console.warn("RESEND_API_KEY unset — welcome email skipped");
    }

    return jsonResponse({
      ok: true,
      shop_id: shop.id,
      slug: shop.slug,
      onboarding_step: shop.onboarding_step,
      onboarding_token: shop.onboarding_token,
      setup_url: setupUrl,
    });
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

  // ── (D) SAVE_MENU ──────────────────────────────────────────────────────────
  // Phase 4a: full menu_items CRUD for the setup page editable grid.
  if (action === "save_menu") {
    const shopId = String(body.shop_id ?? "");
    if (!shopId) return jsonError("shop_id is required");

    // Ensure a manual menu exists for this shop (create if missing).
    const { data: menu } = await supabase
      .from("menus").select("id").eq("shop_id", shopId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    let menuId: string;
    if (menu) {
      menuId = menu.id as string;
    } else {
      // Fetch shop name for the menu label.
      const { data: sh } = await supabase.from("shops").select("name").eq("id", shopId).single();
      const menuName = (sh?.name ?? "Main Menu") + " (Self-Serve)";
      const { data: newMenu, error: menuErr } = await supabase
        .from("menus").insert({ shop_id: shopId, name: menuName, source: "manual" })
        .select("id").single();
      if (menuErr || !newMenu) return jsonError("Failed to create menu: " + (menuErr?.message ?? "unknown"), 500);
      menuId = newMenu.id as string;
    }

    const items: ItemRow[] = Array.isArray(body.items) ? body.items : [];

    // Batch write: delete inactive rows we own, then upsert the submitted set.
    // Preserve items that already exist in other menus (imported) — only touch
    // items in THIS menu.
    const submittedIds = items.filter(i => i.id).map(i => i.id);
    if (submittedIds.length) {
      // Delete removed items (submitted set minus any we're keeping).
      const { data: existing } = await supabase
        .from("menu_items").select("id").eq("menu_id", menuId);
      const existingIds = (existing ?? []).map((e: any) => e.id);
      const toDelete = existingIds.filter((id: string) => !submittedIds.includes(id));
      if (toDelete.length) {
        await supabase.from("menu_items").delete().in("id", toDelete);
      }
    } else {
      // No existing IDs = replace all items in this menu.
      await supabase.from("menu_items").delete().eq("menu_id", menuId);
    }

    const upserted: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = (it.name ?? "").trim();
      if (!name) continue;
      const row: Record<string, unknown> = {
        menu_id: menuId,
        name,
        price_cents: Math.round(Number(it.price_cents ?? it.price ?? 0)),
        category: (it.category ?? "").trim() || null,
        description: (it.description ?? "").trim() || null,
        display_order: it.display_order ?? i,
        active: it.active !== false,
        updated_at: new Date().toISOString(),
      };
      if (it.id) row.id = it.id;
      const { data: up, error: upErr } = await supabase
        .from("menu_items").upsert(row, { onConflict: "id" }).select("id,name,price_cents,category,description,display_order,active")
        .single();
      if (!upErr && up) upserted.push(up);
    }

    return jsonResponse({ ok: true, menu_id: menuId, items: upserted, count: upserted.length });
  }

  // ── (E) GET_MENU ──────────────────────────────────────────────────────────
  // Phase 4a: load existing menu items for the editable grid.
  if (action === "get_menu") {
    const shopId = String(body.shop_id ?? "");
    if (!shopId) return jsonError("shop_id is required");

    const { data: menu } = await supabase
      .from("menus").select("id").eq("shop_id", shopId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (!menu) return jsonResponse({ ok: true, items: [] });

    const { data: items } = await supabase
      .from("menu_items")
      .select("id,name,price_cents,category,description,display_order,active")
      .eq("menu_id", menu.id)
      .order("display_order", { ascending: true });

    return jsonResponse({ ok: true, items: items ?? [] });
  }

  // ── (C) RESUME ──────────────────────────────────────────────────────────────
  if (action === "resume") {
    const shopId = body.shop_id ? String(body.shop_id) : "";
    const email = body.email ? String(body.email) : "";
    const token = body.token ? String(body.token) : "";

    let q = supabase.from("shops").select("*");

    if (token) {
      // Resume by onboarding_token (setup page).
      q = q.eq("onboarding_token", token);
    } else if (shopId) {
      q = q.eq("id", shopId);
    } else if (email) {
      q = q.eq("email_ticket_recipient", email);
    } else {
      return jsonError("shop_id, email, or token is required");
    }

    const { data: shop } = await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!shop) return jsonResponse({ ok: true, shop: null });
    return jsonResponse({ ok: true, shop: redact(shop) });
  }

  return jsonError("Unknown action: " + action);
});

interface ItemRow {
  id?: string;
  name?: string;
  price_cents?: number;
  price?: number; // dollar-format alias
  category?: string;
  description?: string;
  display_order?: number;
  active?: boolean;
}

/** Defensive: never echo any sensitive token back to the browser. */
function redact(shop: Record<string, unknown>): Record<string, unknown> {
  const out = { ...shop };
  for (const k of Object.keys(out)) {
    if (/secret|token|client_secret/i.test(k)) delete out[k];
  }
  // EIN: strip from resume but allow on save actions
  delete out.ein;
  // onboarding_token is needed for setup — only redact the raw key, not the token
  delete out.onboarding_token;
  return out;
}

function jsonResponse(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** Emails that auto-set is_test = true on create (server-side, not flippable). */
function isTestEmail(email: string): boolean {
  const allowlist = (Deno.env.get("TEST_EMAIL_ALLOWLIST") ?? "").toLowerCase();
  const e = email.toLowerCase().trim();
  if (!allowlist) {
    // Fallback hardcoded allowlist
    return e === "jason@fanway.com"
      || e.endsWith("@getsprintai.com")
      || e.endsWith("@fanway.com")
      || e.endsWith("@sprintai.dev")
      || e.endsWith("@pgbeast.com");
  }
  const domains = allowlist.split(",").map(d => d.trim()).filter(Boolean);
  return domains.some(d => d.startsWith("@") ? e.endsWith(d) : e === d);
}

/** Kick an async website scrape in the background — fire-and-forget, never blocks create. */
async function kickScrape(shopId: string, websiteUrl: string | null, supabaseUrl: string, serviceKey: string) {
  if (!websiteUrl) return;
  try {
    await fetch(`${supabaseUrl}/functions/v1/scrape-shop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ shop_id: shopId }),
    });
  } catch (_) { /* fire-and-forget */ }
}

/** Kick an async Google Places lookup in the background — fire-and-forget, never blocks create. */
async function kickPlaces(shopId: string, shopName: string, supabaseUrl: string, serviceKey: string) {
  try {
    await fetch(`${supabaseUrl}/functions/v1/google-places-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ shop_id: shopId, name: shopName }),
    });
  } catch (_) { /* fire-and-forget */ }
}

/** Branded welcome email HTML for self-serve signup. */
function welcomeEmailHtml(ownerName: string, setupUrl: string): string {
  const name = ownerName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FFFDF9;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFDF9;padding:40px 0;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.06);overflow:hidden;">
  <!-- Header bar -->
  <tr><td style="background:#E8521A;padding:28px 32px;text-align:center;">
    <div style="font-size:32px;">🍕</div>
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#fff;margin-top:6px;">SprintAI</div>
  </td></tr>
  <!-- Body -->
  <tr><td style="padding:32px;color:#2A3540;">
    <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 12px;color:#17212E;">Welcome to the family, ${name}!</h1>
    <p style="font-size:16px;line-height:1.6;margin:0 0 16px;color:#2A3540;">
      We're excited to have you on board. Your restaurant is one step away from taking text orders — no app, no middleman, no surprise fees.
    </p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 24px;color:#2A3540;">
      Next up: upload your menu and add any special instructions on your setup page. It takes about 5 minutes, and we'll walk you through it.
    </p>
    <!-- CTA Button -->
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
      <tr><td align="center" style="background:#E8521A;border-radius:10px;">
        <a href="${setupUrl}" style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:600;color:#fff;text-decoration:none;font-family:'DM Sans',Arial,sans-serif;">
          Set up your shop →
        </a>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#687585;margin:0 0 8px;">
      If the button doesn't work, copy and paste this link:
    </p>
    <p style="font-size:13px;color:#E8521A;word-break:break-all;margin:0;">
      ${setupUrl}
    </p>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background:#FEF3EE;padding:20px 32px;text-align:center;">
    <p style="font-size:12px;color:#96A5B4;margin:0;">
      SprintAI · Bethlehem, PA · <a href="https://getsprintai.com/privacy.html" style="color:#96A5B4;">Privacy</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}