const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function send(body: Record<string, unknown>) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const sessionId = `d2-live-verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`=== D2 LIVE VERIFY (session ${sessionId}) ===`);

const TURNS = ["one large pepperoni pizza", "Jason", "thats it, checkout"];
let last: Record<string, unknown> = {};
for (const turn of TURNS) {
  last = await send({ shop_id: VITOS_SHOP_ID, message: turn, session_id: sessionId, test: true });
  console.log(`customer: ${turn}`);
  console.log(`bot: ${last.reply}`);
  console.log("---");
}

// Find the cart via REST (service role) — conversation for this session, then its cart.
const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id,customer_phone&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
const [conv] = await convRes.json();
console.log("conversation:", conv);

const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart] = await cartRes.json();
console.log("cart_json:", JSON.stringify(cart.cart_json, null, 2));
console.log("cart phase:", cart.phase);

// Now fire the real payment_confirmed system event against this REAL cart. This
// is the exact production code path (handleSystemEvent) with REAL cart_json —
// not a fabricated signal. It has NO side effect here: channel === "web" (not
// "sms", not "web:imsg-*"), so index.ts's own channel check sends no SMS/
// iMessage — the rendered message is just returned in the JSON response, which
// is exactly what we need to inspect.
const evt = await send({ system_event: "payment_confirmed", conversation_id: conv.id, order_cart_id: cart.id });
console.log("=== payment_confirmed message ===");
console.log(evt.message);
