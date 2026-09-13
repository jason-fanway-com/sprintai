/**
 * C1/C4 investigation repro (2026-09-12): drive handleChatSmsRequest DIRECTLY
 * (imported from the locally-edited chat-sms/index.ts, no deploy) against the
 * real Vito's shop_id, web channel + test:true, with a seeded returning
 * customer ("Jason") to reproduce the PO's reported double-line bug for
 * "Yes to Jason. Can you add fries to that?" once the name-confirm question
 * has already been asked.
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-c1-c4-repro-20260912.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const sessionId = `c1c4-repro-${crypto.randomUUID()}`;
const customerPhone = `web:${sessionId}`;

const now = "2026-09-01T12:00:00Z";
const { error: custErr } = await supabase.from("customers").upsert({
  tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
  order_count: 5, total_spent_cents: 8250,
  favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
  first_seen_at: now, last_seen_at: now, last_order_at: now,
  last_order_type: "pickup",
  updated_at: now,
}, { onConflict: "tenant_id,customer_phone" });
if (custErr) throw new Error(`seed customer: ${custErr.message}`);

async function send(message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`YOU: "${message}"`);
  console.log(`BOT: "${json.reply}"`);
  console.log(`cart: ${JSON.stringify(json.cart)}`);
  console.log("---");
  return json;
}

await send("Testmode");
await send("pickup");
await send("I'll take a large pepperoni pizza");
await send("that's it");
const final = await send("Yes to Jason. Can you add fries to that?");

console.log("FINAL CART (full):", JSON.stringify(final.cart, null, 2));

const { data: conv } = await supabase.from("conversations").select("id").eq("session_id", sessionId).maybeSingle();
const { data: cartRow } = await supabase.from("order_carts").select("cart_json, subtotal_cents, total_cents, phase, pickup_name").eq("conversation_id", conv?.id).maybeSingle();
console.log("AUTHORITATIVE CART ROW:", JSON.stringify(cartRow, null, 2));
