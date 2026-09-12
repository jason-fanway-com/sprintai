// Live re-run of the exact failing menu-checkout-13 transcript (PO repro,
// 2026-09-11) against Vito's on the deployed chat-sms function, post-fix
// (BUG 1: display_name-aware disambiguation rendering; BUG 2: attempt-
// counter backstop forcing a numbered list after 2 unresolved turns).
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

const sessionId = `vitos-gyro-loop-fix-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TURNS = ["I'll take a Gyro (Beef or Chicken)", "Bleu Cheese, Beef", "yes", "checkout", "Jason"];
console.log(`=== menu-checkout-13 RE-RUN (session ${sessionId}) ===`);
for (const turn of TURNS) {
  const r = await send(VITOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  console.log("---");
}

const { data: conv } = await supabase
  .from("conversations")
  .select("id")
  .eq("shop_id", VITOS_SHOP_ID)
  .eq("session_id", sessionId)
  .eq("channel", "web")
  .maybeSingle();
if (conv) {
  const { data: cart } = await supabase
    .from("order_carts")
    .select("cart_json, pending_disambiguation, subtotal_cents, total_cents, phase")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("\n=== FINAL CART/PENDING STATE ===");
  console.log(JSON.stringify(cart, null, 2));
}
