/**
 * set-app-metadata — server-side edge function to set role + tenant in app_metadata.
 *
 * WHY APP_METADATA
 * ----------------
 * Supabase `user_metadata` is editable by the user via auth.updateUser().
 * `app_metadata` is server-controlled — only the service-role key can write it.
 * RLS policies read app_metadata via auth.jwt() → app_metadata is the
 * authoritative authorization source.
 *
 * ENDPOINT
 * --------
 * POST /functions/v1/set-app-metadata
 *   Authorization: Bearer <service-role-key>
 *   Body: { action, email, role?, tenant_id? }
 *
 * Actions:
 *   "set"    — set role + tenant_id in app_metadata for a user
 *              { action: "set", email: "user@example.com", role: "shop_owner", tenant_id: "uuid" }
 *   "get"    — read a user's app_metadata
 *              { action: "get", email: "user@example.com" }
 *   "list"   — list all users with their app_metadata
 *              { action: "list", page?, per_page? }
 *   "migrate"— run after deployment to set everyone's app_metadata from user_metadata
 *              { action: "migrate" }
 *
 * SECURITY
 * --------
 * Only accepts service-role key (NOT user JWTs). This ensures no user —
 * not even an admin — can escalate their own privileges through this endpoint.
 * Auth is checked at the Supabase client level (createClient with service key).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Known accounts for initial migration
const SUPER_ADMIN_EMAIL = "jason@fanway.com";
const DEFAULT_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body: { action?: string; email?: string; role?: string; tenant_id?: string; page?: number; per_page?: number };
  try { body = await req.json(); } catch { return jsonError("Invalid JSON"); }

  const { action, email, role, tenant_id, page = 1, per_page = 100 } = body;

  // Only the service-role key can call this function.
  // The Supabase Admin API (auth.admin.*) requires the service-role key.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${serviceKey}`) {
    return jsonError("Forbidden — service-role key required", 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    switch (action) {
      case "set":
        return await handleSet(supabase, email!, role!, tenant_id!);
      case "get":
        return await handleGet(supabase, email!);
      case "list":
        return await handleList(supabase, page, per_page);
      case "migrate":
        return await handleMigrate(supabase);
      default:
        return jsonError(`Unknown action: ${action}. Use set, get, list, or migrate.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[set-app-metadata]", message);
    return jsonError(message, 500);
  }
});

// ─── Handlers ────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function handleSet(
  supabase: any,
  email: string,
  role: string,
  tenantId: string,
): Promise<Response> {
  if (!email) return jsonError("email is required");
  if (!role) return jsonError("role is required");
  if (!["super_admin", "shop_owner"].includes(role)) {
    return jsonError("role must be super_admin or shop_owner");
  }
  if (role === "shop_owner" && !tenantId) {
    return jsonError("tenant_id is required for shop_owner");
  }

  // Find user by email
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1, perPage: 1,
  });

  if (listErr) return jsonError(`Failed to list users: ${listErr.message}`, 500);

  // Supabase paginated list — we need to find by email. Use filter.
  // The admin API doesn't have a direct "find by email" endpoint,
  // so we search through users.
  const user = await findUserByEmail(supabase, email);
  if (!user) return jsonError(`User not found: ${email}`, 404);

  const appMetadata = {
    ...(user.app_metadata || {}),
    role,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: appMetadata,
  });

  if (error) return jsonError(`Failed to update: ${error.message}`, 500);

  return jsonResponse({
    ok: true,
    user_id: user.id,
    email: user.email,
    app_metadata: appMetadata,
  });
}

async function handleGet(
  supabase: any,
  email: string,
): Promise<Response> {
  if (!email) return jsonError("email is required");
  const user = await findUserByEmail(supabase, email);
  if (!user) return jsonError(`User not found: ${email}`, 404);

  return jsonResponse({
    id: user.id,
    email: user.email,
    app_metadata: user.app_metadata || {},
    user_metadata: user.user_metadata || {},
  });
}

async function handleList(
  supabase: any,
  page: number,
  perPage: number,
): Promise<Response> {
  const allUsers = await listAllUsers(supabase);
  const start = (page - 1) * perPage;
  const users = allUsers.slice(start, start + perPage).map(u => ({
    id: u.id,
    email: u.email,
    app_metadata: u.app_metadata || {},
    user_metadata: u.user_metadata || {},
  }));

  return jsonResponse({ users, total: allUsers.length, page, per_page: perPage });
}

async function handleMigrate(
  supabase: any,
): Promise<Response> {
  const allUsers = await listAllUsers(supabase);
  const results: { email: string; previous: Record<string, unknown>; updated: Record<string, unknown> }[] = [];

  for (const user of allUsers) {
    const prevMeta = user.app_metadata || {};
    const userMeta = user.user_metadata || {};

    // Only migrate if not already set
    if (prevMeta.role) {
      results.push({ email: user.email!, previous: prevMeta, updated: prevMeta });
      continue;
    }

    let newMeta: Record<string, unknown>;
    if (user.email === SUPER_ADMIN_EMAIL) {
      // Jason = super_admin
      newMeta = { role: "super_admin" };
    } else if (userMeta.tenant_id || userMeta.is_admin) {
      // Existing shop accounts: preserve tenant from user_metadata
      const tenantId = userMeta.tenant_id || DEFAULT_TENANT_ID;
      newMeta = {
        role: userMeta.is_admin ? "super_admin" : "shop_owner",
        ...(userMeta.is_admin ? {} : { tenant_id: tenantId }),
      };
    } else {
      // Unknown user — skip
      results.push({ email: user.email!, previous: prevMeta, updated: prevMeta });
      continue;
    }

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: { ...prevMeta, ...newMeta },
    });

    if (error) {
      results.push({ email: user.email!, previous: prevMeta, updated: { error: error.message } });
    } else {
      results.push({ email: user.email!, previous: prevMeta, updated: { ...prevMeta, ...newMeta } });
    }
  }

  return jsonResponse({ ok: true, migrated: results.length, results });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findUserByEmail(
  supabase: any,
  email: string,
): Promise<{ id: string; email?: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null> {
  // Supabase admin API paginates; we iterate to find the user
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`listUsers error: ${error.message}`);
    if (!data?.users?.length) return null;

    const found = data.users.find((u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;

    if (data.users.length < 100) return null;
    page++;
  }
}

async function listAllUsers(
  supabase: any,
): Promise<{ id: string; email?: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }[]> {
  const all: typeof Array.prototype = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`listUsers error: ${error.message}`);
    if (!data?.users?.length) break;
    all.push(...data.users);
    if (data.users.length < 100) break;
    page++;
  }
  return all;
}

// ─── Response Helpers ────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}