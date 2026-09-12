const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function send(body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  return { ...json, __ms: ms };
}

const sessionId = `d3-live-verify2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`=== D3 LIVE VERIFY 2 (session ${sessionId}) ===`);

// Sequential setup turns — same shape as the real order #6 repro, each
// intent its own turn (not combined), to reach the exact moment the real
// bug happened: bot has just asked "what's your name for the order?"
const SETUP_TURNS = ["one cheeseburger", "medium", "thats it, checkout"];
for (const turn of SETUP_TURNS) {
  const r = await send({ shop_id: VITOS_SHOP_ID, message: turn, session_id: sessionId, test: true });
  console.log(`setup "${turn}" (${r.__ms}ms): ${r.reply}`);
  console.log("---");
}

// NOW fire the double-text concurrently, exactly like the real repro: "Yes"
// then "Jason" seconds apart, both landing while the bot is mid-turn on the
// first.
const [r2, r3] = await Promise.all([
  send({ shop_id: VITOS_SHOP_ID, message: "Yes", session_id: sessionId, test: true }),
  (async () => {
    await new Promise(r => setTimeout(r, 300));
    return send({ shop_id: VITOS_SHOP_ID, message: "Jason", session_id: sessionId, test: true });
  })(),
]);
console.log(`concurrent "Yes" (${r2.__ms}ms): ${r2.reply}`);
console.log("---");
console.log(`concurrent "Jason" (${r3.__ms}ms): ${r3.reply}`);
console.log("---");

const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id,processing_claimed_at&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
const [conv] = await convRes.json();
console.log("conversation (lock should be released/null now):", conv);

const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase,pickup_name&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart] = await cartRes.json();
console.log("final cart:", JSON.stringify(cart, null, 2));

const msgRes = await fetch(`${SUPABASE_URL}/rest/v1/messages?select=role,content,created_at&conversation_id=eq.${conv.id}&order=created_at.asc`, { headers: restHeaders });
const msgs = await msgRes.json();
console.log("=== message order (DB truth) ===");
for (const m of msgs) console.log(`[${m.created_at}] ${m.role}: ${m.content.replace(/\n/g, " ")}`);
