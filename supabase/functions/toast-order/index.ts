/**
 * SprintAI toast-order Edge Function
 * Handles Toast POS menu fetching and order placement
 * 
 * POST /functions/v1/toast-order
 * Body: { action: "get_menu" | "place_order" | "get_menu_for_onboarding", tenant_id: string, ... }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const TOAST_API_BASE = "https://ws-api.toasttab.com";
const TOAST_AUTH_URL = "https://ws-api.toasttab.com/authentication/v1/authentication/login";

interface ToastCredentials {
  clientId: string;
  clientSecret: string;
  restaurantGuid: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

interface OrderItem {
  name: string;
  itemGuid: string;
  quantity: number;
  priceCents: number;
  modificationGroups?: OrderModification[];
}

interface OrderModification {
  name: string;
  modificationGuid: string;
}

interface PlaceOrderRequest {
  tenant_id: string;
  conversation_id: string;
  customer_phone: string;
  items: OrderItem[];
  order_type: "TAKE_OUT" | "DELIVERY" | "DINE_IN";
  customer_name?: string;
  delivery_address?: string;
  notes?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const action = body.action as string;
  const tenantId = body.tenant_id as string;

  if (!action || !tenantId) {
    return jsonError("action and tenant_id are required");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // Get tenant's Toast integration config
  const { data: integration, error: integError } = await supabase
    .from("integrations")
    .select("config, status")
    .eq("tenant_id", tenantId)
    .eq("type", "toast")
    .single();

  if (integError || !integration) {
    return jsonError(`No Toast integration found for tenant ${tenantId}`, 404);
  }

  if (integration.status !== "active") {
    return jsonError("Toast integration is not active", 400);
  }

  const config = integration.config as ToastCredentials;
  if (!config.clientId || !config.clientSecret || !config.restaurantGuid) {
    return jsonError("Toast integration is missing required credentials", 400);
  }

  try {
    // Get/refresh access token
    const token = await getToastToken(supabase, tenantId, config);

    switch (action) {
      case "get_menu":
        return await handleGetMenu(token, config.restaurantGuid);

      case "get_menu_for_onboarding":
        return await handleMenuForOnboarding(supabase, tenantId, token, config.restaurantGuid);

      case "place_order":
        return await handlePlaceOrder(supabase, body as unknown as PlaceOrderRequest, token, config.restaurantGuid);

      case "get_order_status":
        return await handleGetOrderStatus(token, config.restaurantGuid, body.toast_order_id as string);

      default:
        return jsonError(`Unknown action: ${action}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[toast-order] Error for tenant ${tenantId}, action ${action}:`, errMsg);

    // Update integration with error
    await supabase
      .from("integrations")
      .update({ last_error: errMsg })
      .eq("tenant_id", tenantId)
      .eq("type", "toast");

    return jsonError(errMsg, 500);
  }
});

// ─── Token Management ─────────────────────────────────────────────────────────

async function getToastToken(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  config: ToastCredentials
): Promise<string> {
  // Check if we have a valid token
  const now = Date.now() / 1000;
  if (config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > now + 60) {
    return config.accessToken;
  }

  // Get new token via OAuth2 client credentials
  console.log(`[toast-order] Fetching new token for tenant ${tenantId}`);

  const tokenRes = await fetch(TOAST_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      userAccessType: "TOAST_MACHINE_CLIENT",
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Toast auth failed: ${tokenRes.status} — ${errText}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.token?.accessToken;
  const expiresIn = tokenData.token?.expiresIn ?? 3600;

  if (!accessToken) {
    throw new Error("Toast auth response missing access token");
  }

  // Update stored config with new token
  const updatedConfig = {
    ...config,
    accessToken,
    tokenExpiresAt: Math.floor(now + expiresIn),
  };

  await supabase
    .from("integrations")
    .update({ config: updatedConfig })
    .eq("tenant_id", tenantId)
    .eq("type", "toast");

  return accessToken;
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

async function handleGetMenu(token: string, restaurantGuid: string): Promise<Response> {
  const menu = await fetchToastMenu(token, restaurantGuid);
  return jsonResponse(menu);
}

/** Fetch menu and store in knowledge_base for RAG */
async function handleMenuForOnboarding(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  token: string,
  restaurantGuid: string
): Promise<Response> {
  const menu = await fetchToastMenu(token, restaurantGuid);

  // Convert menu to text chunks for knowledge base
  const menuChunks = menuToKnowledgeChunks(menu);

  // Delete existing Toast menu entries
  await supabase
    .from("knowledge_base")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("source", "toast_menu");

  // Generate embeddings for menu chunks
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  let inserted = 0;

  for (let i = 0; i < menuChunks.length; i += 20) {
    const batch = menuChunks.slice(i, i + 20);
    const texts = batch.map((c) => c.content);

    const embeddingRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });

    if (!embeddingRes.ok) continue;
    const embeddingData = await embeddingRes.json();
    const embeddings = embeddingData.data.map((d: { embedding: number[] }) => d.embedding);

    const rows = batch.map((chunk, idx) => ({
      tenant_id: tenantId,
      content: chunk.content,
      embedding: JSON.stringify(embeddings[idx]),
      source: "toast_menu",
      metadata: chunk.metadata,
    }));

    const { error } = await supabase.from("knowledge_base").insert(rows);
    if (!error) inserted += batch.length;
  }

  return jsonResponse({
    success: true,
    menu_groups: menu.menuGroups?.length ?? 0,
    chunks_stored: inserted,
  });
}

/** Fetch full menu from Toast API */
async function fetchToastMenu(token: string, restaurantGuid: string): Promise<ToastMenu> {
  const res = await fetch(
    `${TOAST_API_BASE}/menus/v2/menus`,
    {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Toast-Restaurant-External-ID": restaurantGuid,
      },
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Toast menu fetch failed: ${res.status} — ${errText}`);
  }

  return await res.json() as ToastMenu;
}

/** Convert Toast menu to searchable text chunks */
function menuToKnowledgeChunks(menu: ToastMenu): Array<{ content: string; metadata: Record<string, unknown> }> {
  const chunks: Array<{ content: string; metadata: Record<string, unknown> }> = [];

  if (!menu.menus || menu.menus.length === 0) {
    return chunks;
  }

  for (const menuDef of menu.menus) {
    for (const group of menuDef.menuGroups ?? []) {
      // Create a chunk per menu group with all items
      const itemLines: string[] = [`Menu Section: ${group.name}`];
      if (group.description) itemLines.push(group.description);

      for (const item of group.menuItems ?? []) {
        const price = item.price ? `$${(item.price / 100).toFixed(2)}` : "";
        const line = `- ${item.name}${price ? ` (${price})` : ""}${item.description ? `: ${item.description}` : ""}`;
        itemLines.push(line);

        // If item has many modifiers, create a separate chunk
        if (item.modifierGroups && item.modifierGroups.length > 0) {
          const modLines = [`Customization options for ${item.name}:`];
          for (const modGroup of item.modifierGroups) {
            modLines.push(`  ${modGroup.name}:`);
            for (const mod of modGroup.modifiers ?? []) {
              const modPrice = mod.price ? ` (+$${(mod.price / 100).toFixed(2)})` : "";
              modLines.push(`    - ${mod.name}${modPrice}`);
            }
          }
          chunks.push({
            content: modLines.join("\n"),
            metadata: { item_guid: item.guid, item_name: item.name, type: "modifiers" },
          });
        }
      }

      chunks.push({
        content: itemLines.join("\n"),
        metadata: { group_guid: group.guid, group_name: group.name, type: "menu_group" },
      });
    }
  }

  return chunks;
}

// ─── Order Placement ──────────────────────────────────────────────────────────

async function handlePlaceOrder(
  supabase: ReturnType<typeof createClient>,
  request: PlaceOrderRequest,
  token: string,
  restaurantGuid: string
): Promise<Response> {
  const { tenant_id, conversation_id, customer_phone, items, order_type, customer_name, delivery_address, notes } = request;

  if (!items || items.length === 0) {
    return jsonError("Order items are required");
  }

  // Calculate total
  const totalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);

  // Build Toast order payload
  const toastOrder = buildToastOrderPayload(items, order_type, customer_name, delivery_address, notes);

  // Place order via Toast API
  const orderRes = await fetch(`${TOAST_API_BASE}/orders/v2/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Toast-Restaurant-External-ID": restaurantGuid,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(toastOrder),
  });

  if (!orderRes.ok) {
    const errText = await orderRes.text();
    throw new Error(`Toast order failed: ${orderRes.status} — ${errText}`);
  }

  const orderData = await orderRes.json();
  const toastOrderId = orderData.guid;
  const estimatedTime = orderData.estimatedFulfillmentDate;

  // Save order to our DB
  const { data: savedOrder, error: orderError } = await supabase
    .from("orders")
    .insert({
      tenant_id,
      conversation_id,
      toast_order_id: toastOrderId,
      items: items,
      total_cents: totalCents,
      status: "confirmed",
      customer_phone,
      notes,
    })
    .select("id")
    .single();

  if (orderError) {
    console.error("[toast-order] Failed to save order to DB:", orderError);
  }

  // Track usage event
  await supabase.from("usage_events").insert({
    tenant_id,
    event_type: "order_placed",
    metadata: { toast_order_id: toastOrderId, total_cents: totalCents },
  });

  const etaMinutes = estimatedTime
    ? Math.round((new Date(estimatedTime).getTime() - Date.now()) / 60000)
    : null;

  return jsonResponse({
    success: true,
    order_id: savedOrder?.id,
    toast_order_id: toastOrderId,
    total_cents: totalCents,
    total_display: `$${(totalCents / 100).toFixed(2)}`,
    estimated_minutes: etaMinutes,
    confirmation_message: `Order confirmed! Your order #${toastOrderId.substring(0, 8)} will be ready in approximately ${etaMinutes ?? 20} minutes. Total: $${(totalCents / 100).toFixed(2)}`,
  });
}

async function handleGetOrderStatus(token: string, restaurantGuid: string, toastOrderId: string): Promise<Response> {
  if (!toastOrderId) return jsonError("toast_order_id is required");

  const res = await fetch(`${TOAST_API_BASE}/orders/v2/orders/${toastOrderId}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Toast-Restaurant-External-ID": restaurantGuid,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Toast order status failed: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  return jsonResponse({
    toast_order_id: toastOrderId,
    status: data.displayState,
    estimated_time: data.estimatedFulfillmentDate,
  });
}

/** Build Toast order payload */
function buildToastOrderPayload(
  items: OrderItem[],
  orderType: string,
  customerName?: string,
  deliveryAddress?: string,
  notes?: string
): Record<string, unknown> {
  return {
    restaurantServiceType: orderType,
    source: "ONLINE",
    ...(customerName ? { customer: { firstName: customerName } } : {}),
    ...(notes ? { specialInstructions: notes } : {}),
    ...(deliveryAddress && orderType === "DELIVERY"
      ? {
        deliveryInfo: {
          address1: deliveryAddress,
        },
      }
      : {}),
    selections: items.map((item) => ({
      itemGuid: item.itemGuid,
      quantity: item.quantity,
      ...(item.modificationGroups && item.modificationGroups.length > 0
        ? {
          modifiers: item.modificationGroups.map((m) => ({
            modifierOptionGuid: m.modificationGuid,
          })),
        }
        : {}),
    })),
  };
}

// ─── Toast API Types ──────────────────────────────────────────────────────────

interface ToastMenu {
  menus: ToastMenuDef[];
  menuGroups: ToastMenuGroup[];
  menuItems: ToastMenuItem[];
  modifierGroups: ToastModifierGroup[];
}

interface ToastMenuDef {
  guid: string;
  name: string;
  menuGroups: ToastMenuGroup[];
}

interface ToastMenuGroup {
  guid: string;
  name: string;
  description?: string;
  menuItems: ToastMenuItem[];
}

interface ToastMenuItem {
  guid: string;
  name: string;
  description?: string;
  price?: number; // in cents
  modifierGroups?: ToastModifierGroup[];
}

interface ToastModifierGroup {
  guid: string;
  name: string;
  modifiers?: ToastModifier[];
}

interface ToastModifier {
  guid: string;
  name: string;
  price?: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
