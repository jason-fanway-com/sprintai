/**
 * delivery-webhook — status webhooks from courier providers (Uber Direct now, DoorDash Drive later).
 *
 * POST /functions/v1/delivery-webhook/<provider>     e.g. .../delivery-webhook/uber
 *
 * The provider's verifyWebhook checks the signature (401 on failure). A valid event for a delivery we
 * do not know is acknowledged and ignored (200), so the provider does not retry it forever. Replays and
 * out-of-order events are recorded but never move a delivery backwards (_shared/delivery-store.ts).
 * Customer texts: on a forward move to picked up, delivered or canceled, chat-sms texts the customer (system_event
 * delivery_update; it re-reads the status and announces each one once). The courier's own texts are off.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { DeliveryProvider } from "../_shared/delivery.ts";
import { providersForWebhook } from "../_shared/delivery-providers.ts";
import { applyDeliveryEvent, NOTICE_STATUSES } from "../_shared/delivery-store.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/** asks chat-sms to text the customer about this cart's delivery; it decides what (if anything) to say */
export type Notify = (cart: { id: string; shop_id: string; conversation_id: string }) => Promise<void>;

export async function handle(
  req: Request, db: SupabaseClient, resolve: (name: string) => DeliveryProvider[], notify: Notify = notifyChatSms,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  const name = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  const candidates = resolve(name);
  if (candidates.length === 0) return json({ error: "unknown provider" }, 404);
  // live and sandbox may sign with different secrets: the first credential set that verifies wins
  let provider = candidates[0], v: Awaited<ReturnType<DeliveryProvider["verifyWebhook"]>> = { ok: false, event: null };
  for (const c of candidates) {
    v = await c.verifyWebhook(req.clone());
    if (v.ok) { provider = c; break; }
  }
  if (!v.ok) {
    console.warn(`[delivery-webhook] ${name}: signature rejected`);
    return json({ error: "invalid signature" }, 401);
  }
  if (!v.event) return json({ ok: true, ignored: "event kind" });
  const r = await applyDeliveryEvent(db, provider.name, v.event);
  console.log(`[delivery-webhook] ${name} ${v.event.delivery_id} ${v.event.provider_status} -> ${JSON.stringify(r)}`);
  if (!r.applied && r.reason === "conflict") return json({ error: "busy, retry" }, 503); // provider retries
  if (r.applied && r.changed && NOTICE_STATUSES.has(r.status)) {
    const { data: d } = await db.from("deliveries").select("cart_id").eq("provider", provider.name).eq("delivery_id", v.event.delivery_id).maybeSingle();
    const { data: c } = d ? await db.from("order_carts").select("id, shop_id, conversation_id").eq("id", (d as { cart_id: string }).cart_id).maybeSingle() : { data: null };
    const cart = c as { id: string; shop_id: string; conversation_id: string | null } | null;
    if (cart?.conversation_id) await notify({ id: cart.id, shop_id: cart.shop_id, conversation_id: cart.conversation_id }).catch((e) => console.error(`[delivery-webhook] notice failed: ${e}`));
  }
  return json({ ok: true, ...r });
}

async function notifyChatSms(cart: { id: string; shop_id: string; conversation_id: string }): Promise<void> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/chat-sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: cart.shop_id, conversation_id: cart.conversation_id, order_cart_id: cart.id, system_event: "delivery_update" }),
  });
  console.log(`[delivery-webhook] delivery_update cart=${cart.id.slice(0, 8)} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function json(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  Deno.serve((req) => handle(req, db, providersForWebhook));
}
