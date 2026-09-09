/**
 * SprintAI customer-crm Edge Function
 *
 * Serves the owner-facing Customer CRM screen (docs/specs/2026-09-03-customer-crm.md,
 * "Owner-facing CRM view" — explicitly deferred at the backend build, shipped here).
 *
 * `customers` is service-role-only by design (migration 121_customers.sql: RLS FORCE
 * ENABLED, ALL revoked from anon/authenticated) — the browser can never query it
 * directly. This function is the only path a shop owner has to it, and it always
 * uses the service-role client, scoped server-side to the shop's OWN tenant_id.
 *
 * Auth + tenant derivation mirrors admin-chat/index.ts (~1486-1521): read role from
 * app_metadata first (server-controlled), user_metadata fallback for transition.
 * A shop_owner has tenantId set and isAdmin=false; a super_admin has isAdmin=true and
 * may have no tenantId (sees everything, e.g. "View as" owner preview). Shop ownership
 * verification mirrors shop-financials/index.ts's verifyShopAccess: the :shopId in the
 * URL is resolved to its OWN tenant_id server-side, then checked against the caller's
 * tenantId (unless isAdmin) — the caller can never make this function read a
 * different tenant's rows by passing a different shopId or any other client input,
 * because the query itself always filters on the shop's resolved tenant_id, never on
 * anything the client asserts about its own tenant.
 *
 * Raw customer_phone (e.g. `web:imsg-p16102565023-1781561505`, or an anonymous
 * `web:<uuid>` session) NEVER leaves this function — every row is translated to a
 * clean display phone or "no phone on file" here, server-side, before the response
 * is built.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { regularEligibility, type FavoriteItem } from "../_shared/customer-profile.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientAny = any;

function apiResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function apiError(message: string, status = 400): Response {
  return apiResponse({ error: message }, status);
}

/**
 * Never prints an internal identity string to the owner. A canonicalized E.164
 * phone (+1XXXXXXXXXX, per _shared/customer-profile.ts's canonicalizePhone) formats
 * as a normal US number; anything else (bridge ids the canonicalizer couldn't
 * resolve, anonymous web:<uuid> sessions) is unresolvable and shown as such.
 */
function formatPhoneDisplay(customerPhone: string): string {
  const m = customerPhone.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (!m) return "No phone on file";
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

interface CustomerDbRow {
  id: string;
  customer_phone: string;
  name: string | null;
  order_count: number;
  total_spent_cents: number;
  favorite_items: FavoriteItem[] | null;
  last_order_at: string | null;
}

interface CustomerOut {
  id: string;
  name: string | null;
  phone_display: string;
  order_count: number;
  total_spent_cents: number;
  last_order_at: string | null;
  top_item: string | null;
  favorite_items: FavoriteItem[];
  is_returning: boolean;
  is_regular: boolean;
  opted_out: boolean;
}

// ─── Tenant / Shop Verification (mirrors shop-financials/index.ts) ─────────

async function resolveShopTenant(
  supabase: SupabaseClientAny,
  shopId: string,
  callerTenantId: string | null,
  isAdmin: boolean,
): Promise<{ allowed: boolean; tenantId: string | null; shopName: string }> {
  const { data, error } = await supabase
    .from("shops")
    .select("id, name, tenant_id")
    .eq("id", shopId)
    .maybeSingle();

  if (error || !data) return { allowed: false, tenantId: null, shopName: "" };

  const shop = data as { id: string; name: string; tenant_id: string };

  if (isAdmin || shop.tenant_id === callerTenantId) {
    return { allowed: true, tenantId: shop.tenant_id, shopName: shop.name };
  }
  return { allowed: false, tenantId: null, shopName: "" };
}

// ─── Route Handler ──────────────────────────────────────────────────────────

async function getCustomers(
  supabase: SupabaseClientAny,
  tenantId: string,
  params: URLSearchParams,
): Promise<Response> {
  const search = (params.get("search") ?? "").trim();
  const sortField = params.get("sort") ?? "last_order_at";
  const sortDir = params.get("dir") === "asc" ? "asc" : "desc";
  const allowedSorts = new Set(["last_order_at", "order_count", "total_spent_cents"]);
  const safeSort = allowedSorts.has(sortField) ? sortField : "last_order_at";

  // Fetch the FULL tenant customer set — the summary line (AC: total/returning/
  // regulars) must reflect all customers, not just what a search filter narrows to.
  const { data, error } = await supabase
    .from("customers")
    .select("id, customer_phone, name, order_count, total_spent_cents, favorite_items, last_order_at")
    .eq("tenant_id", tenantId);

  if (error) return apiError(error.message);

  const rows = (data ?? []) as CustomerDbRow[];

  // Batch opt-out lookup — one query for every phone this tenant has, same
  // (tenant_id, customer_phone, opted_back_at IS NULL) shape as isOptedOut().
  const phones = rows.map((r) => r.customer_phone);
  const optedOutSet = new Set<string>();
  if (phones.length > 0) {
    const { data: optOutRows } = await supabase
      .from("sms_opt_outs")
      .select("customer_phone")
      .eq("tenant_id", tenantId)
      .in("customer_phone", phones)
      .is("opted_back_at", null);
    for (const r of (optOutRows ?? []) as Array<{ customer_phone: string }>) {
      optedOutSet.add(r.customer_phone);
    }
  }

  const allCustomers: CustomerOut[] = rows.map((r) => {
    const favoriteItems = r.favorite_items ?? [];
    const regular = regularEligibility(favoriteItems);
    return {
      id: r.id,
      name: r.name,
      phone_display: formatPhoneDisplay(r.customer_phone),
      order_count: r.order_count,
      total_spent_cents: r.total_spent_cents,
      last_order_at: r.last_order_at,
      top_item: favoriteItems[0]?.name ?? null,
      favorite_items: favoriteItems,
      is_returning: r.order_count >= 2,
      is_regular: regular !== null,
      opted_out: optedOutSet.has(r.customer_phone),
    };
  });

  const summary = {
    total: allCustomers.length,
    returning: allCustomers.filter((c) => c.is_returning).length,
    regulars: allCustomers.filter((c) => c.is_regular).length,
  };

  // Search (name substring, case-insensitive; or phone digits substring against
  // the DISPLAY phone only — a search can never match against the raw internal
  // identity string, since that string is never in scope here).
  let filtered = allCustomers;
  if (search) {
    const needle = search.toLowerCase();
    const digitsNeedle = search.replace(/\D/g, "");
    filtered = allCustomers.filter((c) => {
      const nameMatch = c.name?.toLowerCase().includes(needle);
      const phoneMatch = digitsNeedle.length > 0 && c.phone_display.replace(/\D/g, "").includes(digitsNeedle);
      return nameMatch || phoneMatch;
    });
  }

  filtered.sort((a, b) => {
    const av = a[safeSort as "last_order_at" | "order_count" | "total_spent_cents"];
    const bv = b[safeSort as "last_order_at" | "order_count" | "total_spent_cents"];
    const cmp = av === bv ? 0 : (av ?? "") < (bv ?? "") ? -1 : 1;
    return sortDir === "asc" ? cmp : -cmp;
  });

  return apiResponse({ customers: filtered, summary });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/customer-crm/, "").replace(/^\/customer-crm/, "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  // Service-role client only — `customers` has RLS FORCE ENABLED with ALL
  // revoked from anon/authenticated (migration 121), so there is no RLS path
  // for this table. Every query below is scoped explicitly by tenant_id,
  // resolved server-side, never by a client-supplied value.
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return apiError("Unauthorized", 401);
  const token = authHeader.replace("Bearer ", "");

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!userRes.ok) return apiError("Unauthorized", 401);

  const { app_metadata, user_metadata } = await userRes.json() as {
    app_metadata?: { tenant_id?: string; role?: string };
    user_metadata?: { tenant_id?: string; is_admin?: boolean };
  };
  const appRole = app_metadata?.role;
  const isAdmin = appRole === "super_admin" || (!appRole && user_metadata?.is_admin === true);
  const callerTenantId = app_metadata?.tenant_id || user_metadata?.tenant_id || null;
  if (!callerTenantId && !isAdmin) {
    return apiError("No tenant_id in app_metadata and not admin", 403);
  }

  try {
    const customersMatch = path.match(/^\/([a-f0-9-]+)\/customers$/);
    if (customersMatch && req.method === "GET") {
      const shopId = customersMatch[1];
      const { allowed, tenantId } = await resolveShopTenant(supabase, shopId, callerTenantId, isAdmin);
      if (!allowed || !tenantId) return apiError("Not found", 404);
      return await getCustomers(supabase, tenantId, url.searchParams);
    }

    return apiError(`Route not found: ${req.method} ${path}`, 404);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[customer-crm] Error on ${req.method} ${path}:`, errMsg);
    return apiError(errMsg, 500);
  }
});
