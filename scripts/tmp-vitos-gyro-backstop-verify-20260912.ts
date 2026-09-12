// Live verification (PO, 2026-09-12): does the disambiguation backstop
// actually fire now, and does a bare "1" answer then resolve to the Gyro
// Salad? Re-runs the PO's exact menu-checkout-13 repro turns against
// deployed chat-sms (v391+), then keeps going past "checkout" with numbered
// answers to prove the numbered list appears and resolves.
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

async function dumpPending(sessionId: string, label: string) {
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("shop_id", VITOS_SHOP_ID)
    .eq("session_id", sessionId)
    .eq("channel", "web")
    .maybeSingle();
  if (!conv) return;
  const { data: cart } = await supabase
    .from("order_carts")
    .select("cart_json, pending_disambiguation, phase")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`  [state after ${label}] pending_disambiguation.attempts=${cart?.pending_disambiguation?.attempts ?? "none"} phase=${cart?.phase}`);
}

const sessionId = `vitos-gyro-backstop-verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`=== BACKSTOP VERIFICATION (session ${sessionId}) ===`);

const openingTurns = ["I'll take a Gyro (Beef or Chicken)", "Bleu Cheese, Beef", "yes", "checkout"];
let numberedListSeen = false;
for (const turn of openingTurns) {
  const r = await send(VITOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  if (/\b1[\.\)]|^1\b/m.test(r.reply) && /2[\.\)]/.test(r.reply)) {
    numberedListSeen = true;
    console.log("  >>> numbered list detected in this reply <<<");
  }
  await dumpPending(sessionId, JSON.stringify(turn));
  console.log("---");
}

// Keep going a couple more turns if the numbered list hasn't shown up yet —
// the PO's own repro went 4 turns without it; push further to find where
// (or whether) it trips.
const extraTurns = ["still not sure, whichever is better", "just pick one for me"];
let i = 0;
while (!numberedListSeen && i < extraTurns.length) {
  const turn = extraTurns[i++];
  const r = await send(VITOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  if (/\b1[\.\)]/m.test(r.reply) && /2[\.\)]/.test(r.reply)) {
    numberedListSeen = true;
    console.log("  >>> numbered list detected in this reply <<<");
  }
  await dumpPending(sessionId, JSON.stringify(turn));
  console.log("---");
}

console.log(`\nnumberedListSeen = ${numberedListSeen}`);

if (numberedListSeen) {
  const r = await send(VITOS_SHOP_ID, "1", sessionId);
  console.log(`customer: 1`);
  console.log(`bot: ${r.reply}`);
  console.log("---");

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
} else {
  console.log("\nBackstop never tripped in this run — needs further investigation, not resolved.");
}
