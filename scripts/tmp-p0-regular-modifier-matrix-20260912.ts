// P0 (2026-09-12): live end-to-end check of the PO's phrasing matrix against
// the deployed C2b-regular deterministic path, beyond the unit tests in
// regular-offer-modifier-20260912.test.ts. Each case seeds a fresh customer
// with the same delivery memory + regular-item eligibility, sends "Need to
// order" (triggers the combined regular+delivery offer), then the matrix
// phrase, and reports the resulting cart.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") || "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SERVICE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID   = "e0000000-0000-0000-0000-000000000001";
const VITOS_TENANT_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function send(sessionId: string, msg: string): Promise<{ reply: string; cart: unknown[] }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ shop_id: VITOS_SHOP_ID, message: msg, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  return { reply: j.reply ?? j.message ?? JSON.stringify(j), cart: j.cart ?? [] };
}

async function seedAndRun(label: string, secondTurn: string) {
  const sessionId = `p0-matrix-${label}-${Date.now()}`;
  const phone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  await supabase.from("customers").upsert({
    tenant_id: VITOS_TENANT_ID, customer_phone: phone, name: "Jason",
    order_count: 8, total_spent_cents: 28470,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "delivery",
    last_delivery_address: {
      street: "5620 Cetronia Rd", city: "Allentown", state: "PA", zip: "18106",
      formatted: "5620 Cetronia Rd, Allentown, PA 18106",
    },
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  await supabase.from("conversations").insert({
    tenant_id: VITOS_TENANT_ID, customer_phone: phone,
    channel: "web", session_id: `${sessionId}-prior`,
    status: "resolved", metadata: {},
  });

  await send(sessionId, "Testmode");
  const r1 = await send(sessionId, "Need to order");
  const r2 = await send(sessionId, secondTurn);

  console.log(`\n=== ${label}: "${secondTurn}" ===`);
  console.log(`TURN 1 BOT: "${r1.reply}"`);
  console.log(`TURN 2 BOT: "${r2.reply}"`);
  console.log(`CART: ${JSON.stringify(r2.cart)}`);
}

await seedAndRun("sure-add-pepperoni", "sure, add pepperoni");
await seedAndRun("yes-no-onions", "yes but no onions");
