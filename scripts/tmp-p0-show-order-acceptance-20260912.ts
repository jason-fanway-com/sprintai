// P0 (2026-09-12, conv d79c1d98): acceptance matrix for the "show me the
// order" refusal in checkout, plus the two compound-turn scenarios (a
// mixed read+confirm turn must show the order, not send a link; a CHANGE
// -> add item must show the updated order before any new link).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") || "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SERVICE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID   = "e0000000-0000-0000-0000-000000000001";
const VITOS_TENANT_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function send(sessionId: string, msg: string): Promise<{ reply: string; cart: unknown[]; phase: string }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ shop_id: VITOS_SHOP_ID, message: msg, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  return { reply: j.reply ?? j.message ?? JSON.stringify(j), cart: j.cart ?? [], phase: j.phase ?? "?" };
}

async function seedCustomer(sessionId: string) {
  const phone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  await supabase.from("customers").upsert({
    tenant_id: VITOS_TENANT_ID, customer_phone: phone, name: "Jason",
    order_count: 8, total_spent_cents: 28470, favorite_items: [],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  await supabase.from("conversations").insert({
    tenant_id: VITOS_TENANT_ID, customer_phone: phone,
    channel: "web", session_id: `${sessionId}-prior`,
    status: "resolved", metadata: {},
  });
}

async function reachCheckout(sessionId: string) {
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "Large pepperoni pizza");
  await send(sessionId, "pickup");
  const r = await send(sessionId, "Jason");
  return r;
}

console.log("=== MATRIX: read-only phrasings in CHECKOUT phase ===");
const matrix = [
  "show me the order",
  "show me my order",
  "what's in my order",
  "what am I paying for",
  "read it back to me",
];
for (const phrase of matrix) {
  const sessionId = `p0-show-${phrase.replace(/\W+/g, "-")}-${Date.now()}`;
  const reached = await reachCheckout(sessionId);
  console.log(`\n[reached checkout] phase=${reached.phase} reply="${reached.reply.slice(0, 80)}..."`);
  const r = await send(sessionId, phrase);
  console.log(`YOU: "${phrase}"`);
  console.log(`BOT: "${r.reply}"`);
  const showsOrder = /pepperoni|cheese|subtotal/i.test(r.reply);
  console.log(showsOrder ? "✓ PASS — order shown" : "✗ FAIL — order not shown");
}

console.log("\n=== SCENARIO: compound read+confirm must show order, not send a link ===");
{
  const sessionId = `p0-compound-readconfirm-${Date.now()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "Large pepperoni pizza");
  await send(sessionId, "pickup");
  const r = await send(sessionId, "Show me the order. Yes it's for me");
  console.log(`YOU: "Show me the order. Yes it's for me"`);
  console.log(`BOT: "${r.reply}"`);
  const sentLink = /pay here|payment link sent/i.test(r.reply);
  const showedOrder = /pepperoni|subtotal/i.test(r.reply);
  console.log(!sentLink && showedOrder ? "✓ PASS — showed order, did not send a link" : "✗ FAIL");
}

console.log("\n=== SCENARIO: CHANGE -> add item must show updated order before any new link ===");
{
  const sessionId = `p0-change-then-add-${Date.now()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "Large pepperoni pizza");
  await send(sessionId, "pickup");
  await send(sessionId, "Jason");
  const changeReply = await send(sessionId, "Change");
  console.log(`YOU: "Change"`);
  console.log(`BOT: "${changeReply.reply}"`);
  const r = await send(sessionId, "add french fries");
  console.log(`YOU: "add french fries"`);
  console.log(`BOT: "${r.reply}"`);
  const sentNewLink = /pay here|payment link sent/i.test(r.reply);
  const showedUpdatedOrder = /french fries|fries/i.test(r.reply);
  console.log(!sentNewLink && showedUpdatedOrder ? "✓ PASS — showed updated order, held the link" : "✗ FAIL");
}
