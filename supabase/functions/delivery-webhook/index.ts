/**
 * delivery-webhook — status webhooks from courier providers (Uber Direct now, DoorDash Drive later).
 *
 * POST /functions/v1/delivery-webhook/<provider>     e.g. .../delivery-webhook/uber
 *
 * The provider's verifyWebhook checks the signature (401 on failure). A valid event for a delivery we
 * do not know is acknowledged and ignored (200), so the provider does not retry it forever. Replays and
 * out-of-order events are recorded but never move a delivery backwards (_shared/delivery-store.ts).
 * No customer message is sent from here: tracking lives in the paid receipt (decision 4, default).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { DeliveryProvider } from "../_shared/delivery.ts";
import { providersForWebhook } from "../_shared/delivery-providers.ts";
import { applyDeliveryEvent } from "../_shared/delivery-store.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export async function handle(
  req: Request, db: SupabaseClient, resolve: (name: string) => DeliveryProvider[],
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
  return json({ ok: true, ...r });
}

function json(b: unknown, status = 200): Response {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  Deno.serve((req) => handle(req, db, providersForWebhook));
}
