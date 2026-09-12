// Stage 2 (V4) canary — ONE live conversation against the deployed chat-sms
// function for Vito's Pizza, on the compiled ordering engine path
// (compiled_ordering_engine_enabled=true, confirmed already set for shop
// e0000000-0000-0000-0000-000000000001 before this run).
//
// PO-authorized hard-stop protocol: "cheeseburger" -> "medium" -> "thats it"
// must produce ONE cart line, Temp: Medium, total $8.49 + $0.99 = $9.48.
// The total is read from the order_carts ROW directly (read-only select
// AFTER the conversation), never from the reply text or the checkout-link.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const sessionId = `vitos-canary-v4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TURNS = ["cheeseburger", "medium", "thats it"];
console.log(`=== VITO'S V4 CANARY (session ${sessionId}) ===`);
for (const turn of TURNS) {
  const r = await send(VITOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
}

// Read-only verification straight off the DB row — never the reply text.
// NOTE: conversations table uses session_id + channel, not shop_id.
const { data: conv, error: convErr } = await supabase
  .from("conversations")
  .select("id")
  .eq("session_id", sessionId)
  .eq("channel", "web")
  .maybeSingle();
if (convErr || !conv) throw new Error(`conversation lookup failed: ${JSON.stringify(convErr)}`);

const { data: cart, error: cartErr } = await supabase
  .from("order_carts")
  .select("cart_json, subtotal_cents, tax_cents, total_cents, phase")
  .eq("conversation_id", conv.id)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (cartErr || !cart) throw new Error(`cart lookup failed: ${JSON.stringify(cartErr)}`);

console.log("\n=== READ-ONLY DB VERIFICATION (order_carts row) ===");
console.log(JSON.stringify(cart, null, 2));

const lines = cart.cart_json as any[];
const lineCount = lines.length;
const line0 = lines[0];
const tempOk = line0 && JSON.stringify(line0.options ?? {}).includes("Medium");
const expectedTotal = 948;
const actualTotal = cart.total_cents ?? (lines.reduce((s, l) => s + l.price_cents * l.quantity, 0) + 99);

console.log(`\nline count: ${lineCount} (expected 1)`);
console.log(`line 0 options: ${JSON.stringify(line0?.options)}`);
console.log(`total_cents (DB): ${cart.total_cents}`);
console.log(`computed total (subtotal+fee, DB): ${actualTotal}`);
console.log(`expected: 948 ($9.48)`);

const pass = lineCount === 1 && tempOk && actualTotal === expectedTotal;
console.log(`\nCANARY ${pass ? "PASS" : "FAIL"}`);
if (!pass) {
  console.log("DIFFERENCE DETECTED — see details above.");
  Deno.exit(1);
}
