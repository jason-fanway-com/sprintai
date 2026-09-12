// P0 (2026-09-12): re-run Jason's exact live sequence from conv ce84c64b
// against a fresh seeded customer (same delivery memory: 5620 Cetronia Rd,
// Allentown PA) to confirm the GUARD 1d/1f wiring fix (43f34471) stops the
// duplicate-add / doubled charge, and to observe whether defects 2/3/4
// (multi-intent drop, name-confirm regression, ignored price question)
// still reproduce post-fix.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") || "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SERVICE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID   = "e0000000-0000-0000-0000-000000000001";
const VITOS_TENANT_ID = "e0000000-0000-0000-0000-000000000001";

const SESSION_ID = `p0-repro-${Date.now()}`;
const PHONE = `web:${SESSION_ID}`;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function send(msg: string): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ shop_id: VITOS_SHOP_ID, message: msg, session_id: SESSION_ID, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  console.log(`  [debug_perf: ${JSON.stringify(j.debug_perf ?? null)}] [cart_len: ${(j.cart ?? []).length}]`);
  return j.reply ?? j.message ?? JSON.stringify(j);
}

const now = "2026-09-01T12:00:00Z";
const { error: custErr } = await supabase.from("customers").upsert({
  tenant_id: VITOS_TENANT_ID, customer_phone: PHONE, name: "Jason",
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
if (custErr) throw new Error(`seed customer: ${custErr.message}`);

const { error: convErr } = await supabase.from("conversations").insert({
  tenant_id: VITOS_TENANT_ID, customer_phone: PHONE,
  channel: "web", session_id: `${SESSION_ID}-prior`,
  status: "resolved", metadata: {},
});
if (convErr) throw new Error(`seed prior conv: ${convErr.message}`);

console.log(`Session: ${SESSION_ID}\n`);

const turns = [
  "Testmode",
  "Need to order",
  "Yes delivery. But I wanted to a pepperoni pizza.",
  "Pepperoni pizza",
  "You already know my name.",
  "A pepperoni pizza is $42?",
];

for (const t of turns) {
  const r = await send(t);
  console.log(`YOU: "${t}"`);
  console.log(`BOT: "${r}"\n`);
}

// Pull the authoritative cart, scoped to THIS session's conversation only.
const { data: conv } = await supabase
  .from("conversations")
  .select("id")
  .eq("session_id", SESSION_ID)
  .maybeSingle();
const { data: cartRow } = await supabase
  .from("order_carts")
  .select("cart_json, subtotal_cents, total_cents, order_type, pending_disambiguation")
  .eq("conversation_id", conv?.id)
  .maybeSingle();
console.log("AUTHORITATIVE CART:", JSON.stringify(cartRow, null, 2));
