/**
 * SprintAI admin-api Edge Function
 * RESTful API for the admin dashboard
 * 
 * Auth: Bearer JWT (Supabase Auth with is_admin=true in user_metadata)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/admin-api/, "");

  // Create admin Supabase client (service role — bypasses RLS for admin ops)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // Validate admin JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("Unauthorized", 401);
  }

  // For service-to-service calls (using service key directly)
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isServiceCall = authHeader === `Bearer ${serviceKey}`;

  if (!isServiceCall) {
    // Validate user JWT
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    );
    const { data: { user }, error } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (error || !user) {
      return apiError("Unauthorized", 401);
    }

    // Check admin flag
    const isAdmin = user.user_metadata?.is_admin === true;
    if (!isAdmin) {
      return apiError("Forbidden — admin access required", 403);
    }
  }

  try {
    // Route handling
    // GET /tenants — list all tenants with stats
    if (path === "/tenants" && req.method === "GET") {
      return await listTenants(supabase, url.searchParams);
    }

    // POST /tenants — create tenant manually
    if (path === "/tenants" && req.method === "POST") {
      return await createTenant(supabase, await req.json());
    }

    // GET /tenants/:id — get tenant detail
    const tenantMatch = path.match(/^\/tenants\/([a-f0-9-]+)$/);
    if (tenantMatch) {
      const tenantId = tenantMatch[1];
      if (req.method === "GET") return await getTenant(supabase, tenantId);
      if (req.method === "PUT") return await updateTenant(supabase, tenantId, await req.json());
      if (req.method === "DELETE") return await deleteTenant(supabase, tenantId);
    }

    // GET /tenants/:id/conversations
    const convsMatch = path.match(/^\/tenants\/([a-f0-9-]+)\/conversations$/);
    if (convsMatch && req.method === "GET") {
      return await listConversations(supabase, convsMatch[1], url.searchParams);
    }

    // GET /tenants/:id/knowledge-base
    const kbMatch = path.match(/^\/tenants\/([a-f0-9-]+)\/knowledge-base$/);
    if (kbMatch) {
      if (req.method === "GET") return await listKnowledgeBase(supabase, kbMatch[1]);
      if (req.method === "POST") return await addKnowledgeEntry(supabase, kbMatch[1], await req.json());
    }

    // DELETE /knowledge-base/:id
    const kbItemMatch = path.match(/^\/knowledge-base\/([a-f0-9-]+)$/);
    if (kbItemMatch && req.method === "DELETE") {
      return await deleteKnowledgeEntry(supabase, kbItemMatch[1]);
    }

    // POST /tenants/:id/rescrape — trigger re-onboarding
    const rescrapeMatch = path.match(/^\/tenants\/([a-f0-9-]+)\/rescrape$/);
    if (rescrapeMatch && req.method === "POST") {
      return await triggerRescrape(supabase, rescrapeMatch[1]);
    }

    // GET /conversations/:id/messages
    const msgsMatch = path.match(/^\/conversations\/([a-f0-9-]+)\/messages$/);
    if (msgsMatch && req.method === "GET") {
      return await getMessages(supabase, msgsMatch[1]);
    }

    // GET /stats — platform overview
    if (path === "/stats" && req.method === "GET") {
      return await getPlatformStats(supabase);
    }

    // GET /tenants/:id/stats
    const tenantStatsMatch = path.match(/^\/tenants\/([a-f0-9-]+)\/stats$/);
    if (tenantStatsMatch && req.method === "GET") {
      return await getTenantStats(supabase, tenantStatsMatch[1]);
    }

    return apiError(`Route not found: ${req.method} ${path}`, 404);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[admin-api] Error on ${req.method} ${path}:`, errMsg);
    return apiError(errMsg, 500);
  }
});

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function listTenants(
  supabase: ReturnType<typeof createClient>,
  params: URLSearchParams
): Promise<Response> {
  const page = parseInt(params.get("page") ?? "1");
  const pageSize = parseInt(params.get("page_size") ?? "50");
  const status = params.get("status");
  const plan = params.get("plan");
  const search = params.get("search");

  let query = supabase
    .from("tenants")
    .select("*, conversations(count), messages(count)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (status) query = query.eq("status", status);
  if (plan) query = query.eq("plan", plan);
  if (search) query = query.ilike("name", `%${search}%`);

  const { data, error, count } = await query;
  if (error) return apiError(error.message);

  return apiResponse({ tenants: data, total: count, page, page_size: pageSize });
}

async function createTenant(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>
): Promise<Response> {
  const { name, website_url, plan = "starter", config = {} } = body;
  if (!name) return apiError("name is required");

  const slug = (name as string)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50);

  const { data, error } = await supabase
    .from("tenants")
    .insert({ name, slug, website_url, plan, config, status: "active" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return apiResponse(data, 201);
}

async function getTenant(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<Response> {
  const { data, error } = await supabase
    .from("tenants")
    .select("*, integrations(*)")
    .eq("id", tenantId)
    .single();

  if (error) return apiError(error.message, error.code === "PGRST116" ? 404 : 500);
  return apiResponse(data);
}

async function updateTenant(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  body: Record<string, unknown>
): Promise<Response> {
  // Only allow updating safe fields
  const allowedFields = ["name", "status", "config", "phone_number", "website_url", "plan"];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }

  const { data, error } = await supabase
    .from("tenants")
    .update(updates)
    .eq("id", tenantId)
    .select()
    .single();

  if (error) return apiError(error.message);
  return apiResponse(data);
}

async function deleteTenant(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<Response> {
  // Soft delete (set status to cancelled)
  const { error } = await supabase
    .from("tenants")
    .update({ status: "cancelled" })
    .eq("id", tenantId);

  if (error) return apiError(error.message);
  return apiResponse({ success: true });
}

async function listConversations(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  params: URLSearchParams
): Promise<Response> {
  const page = parseInt(params.get("page") ?? "1");
  const pageSize = parseInt(params.get("page_size") ?? "25");

  const { data, error, count } = await supabase
    .from("conversations")
    .select("*, messages(count)", { count: "exact" })
    .eq("tenant_id", tenantId)
    .order("last_message_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (error) return apiError(error.message);
  return apiResponse({ conversations: data, total: count, page, page_size: pageSize });
}

async function getMessages(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<Response> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) return apiError(error.message);
  return apiResponse({ messages: data });
}

async function listKnowledgeBase(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<Response> {
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("id, content, source, metadata, created_at") // exclude embedding blob
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) return apiError(error.message);
  return apiResponse({ entries: data });
}

async function addKnowledgeEntry(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const { content, source = "manual", metadata = {} } = body;
  if (!content) return apiError("content is required");

  // Generate embedding
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  let embedding: number[] | null = null;

  try {
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: content }),
    });

    if (embRes.ok) {
      const embData = await embRes.json();
      embedding = embData.data[0].embedding;
    }
  } catch (err) {
    console.error("[admin-api] Embedding failed:", err);
  }

  const { data, error } = await supabase
    .from("knowledge_base")
    .insert({
      tenant_id: tenantId,
      content,
      source,
      metadata,
      ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
    })
    .select("id, content, source, metadata, created_at")
    .single();

  if (error) return apiError(error.message);
  return apiResponse(data, 201);
}

async function deleteKnowledgeEntry(
  supabase: ReturnType<typeof createClient>,
  entryId: string
): Promise<Response> {
  const { error } = await supabase
    .from("knowledge_base")
    .delete()
    .eq("id", entryId);

  if (error) return apiError(error.message);
  return apiResponse({ success: true });
}

async function triggerRescrape(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<Response> {
  const { data: tenant } = await supabase
    .from("tenants")
    .select("website_url")
    .eq("id", tenantId)
    .single();

  if (!tenant?.website_url) {
    return apiError("Tenant has no website URL configured");
  }

  const functionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/onboard-tenant`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  // Fire-and-forget
  fetch(functionUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tenant_id: tenantId, website_url: tenant.website_url, force: true }),
  }).catch(console.error);

  return apiResponse({ success: true, message: "Rescrape triggered" });
}

async function getPlatformStats(
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const [
    { count: totalTenants },
    { count: activeTenants },
    { count: totalConversations },
    { count: totalMessages },
    { count: totalOrders },
  ] = await Promise.all([
    supabase.from("tenants").select("*", { count: "exact", head: true }),
    supabase.from("tenants").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("conversations").select("*", { count: "exact", head: true }),
    supabase.from("messages").select("*", { count: "exact", head: true }),
    supabase.from("orders").select("*", { count: "exact", head: true }),
  ]);

  // Messages in last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recentMessages } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .gte("created_at", sevenDaysAgo);

  return apiResponse({
    total_tenants: totalTenants ?? 0,
    active_tenants: activeTenants ?? 0,
    total_conversations: totalConversations ?? 0,
    total_messages: totalMessages ?? 0,
    total_orders: totalOrders ?? 0,
    messages_last_7_days: recentMessages ?? 0,
  });
}

async function getTenantStats(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<Response> {
  const [
    { count: totalConversations },
    { count: totalMessages },
    { count: totalOrders },
    { count: kbEntries },
  ] = await Promise.all([
    supabase.from("conversations").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
    supabase.from("messages").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
    supabase.from("orders").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
    supabase.from("knowledge_base").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);

  // Recent activity
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: dailyMessages } = await supabase
    .from("messages")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", sevenDaysAgo)
    .eq("role", "customer");

  return apiResponse({
    total_conversations: totalConversations ?? 0,
    total_messages: totalMessages ?? 0,
    total_orders: totalOrders ?? 0,
    knowledge_base_entries: kbEntries ?? 0,
    messages_last_7_days: dailyMessages?.length ?? 0,
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function apiResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function apiError(message: string, status = 400): Response {
  return apiResponse({ error: message }, status);
}
