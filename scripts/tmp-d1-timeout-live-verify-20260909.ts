// D1 live verify (2026-09-09): conversation inactivity timeout.
// Establishes a real cart via chat-sms (test mode), backdates the
// conversation's last_message_at past CONVERSATION_TIMEOUT_MS (3h) directly
// in the DB (simulating real elapsed time without waiting 3h), then sends a
// new message and confirms: (a) a NEW conversation id is created, (b) the
// old conversation is now status=resolved, (c) the new cart is empty/fresh
// (no welded-over pizza/cheeseburger from turn 1).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

async function send(body: Record<string, unknown>) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const sessionId = `d1-timeout-live-verify-${Date.now()}`;
console.log(`=== D1 TIMEOUT LIVE VERIFY (session ${sessionId}) ===`);

// Turn 1: establish a real cart with an identifiable item (a real Vito's
// menu item, confirmed via REST: small Margherita pizza).
const t1 = await send({ shop_id: VITOS_SHOP_ID, message: "one small margherita pizza, thats it", session_id: sessionId, test: true });
console.log(`turn1: ${t1.reply}`);

const convRes1 = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id,last_message_at,status&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
const [conv1] = await convRes1.json();
console.log("conversation after turn1:", conv1);

const cartRes1 = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv1.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart1] = await cartRes1.json();
console.log("cart after turn1:", JSON.stringify(cart1.cart_json));

// Backdate last_message_at to 4h ago — past the 3h CONVERSATION_TIMEOUT_MS,
// same calendar day (America/New_York, run at ~18:23 EDT -> 14:23 EDT is
// still today, isolating the INACTIVITY boundary from the shop-close
// boundary).
const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?id=eq.${conv1.id}`, {
  method: "PATCH", headers: restHeaders,
  body: JSON.stringify({ last_message_at: fourHoursAgo }),
});
if (!patchRes.ok) throw new Error(`backdate failed: ${patchRes.status} ${await patchRes.text()}`);
console.log(`backdated last_message_at -> ${fourHoursAgo} (4h ago)`);

// Turn 2: same session_id, new message. Should NOT see the cheeseburger.
const t2 = await send({ shop_id: VITOS_SHOP_ID, message: "hi, whats on the menu", session_id: sessionId, test: true });
console.log(`turn2: ${t2.reply}`);

const convRes2 = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id,last_message_at,status,started_at&session_id=eq.${sessionId}&order=started_at.desc`, { headers: restHeaders });
const allConvs = await convRes2.json();
console.log("all conversations for this session (desc by started_at):", JSON.stringify(allConvs, null, 2));

const newConv = allConvs[0];
const oldConv = allConvs.find((c: { id: string }) => c.id === conv1.id);

const cartRes2 = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${newConv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart2] = await cartRes2.json();
console.log("cart on new conversation:", JSON.stringify(cart2.cart_json));

console.log("\n=== VERDICT ===");
const newConvCreated = newConv.id !== conv1.id;
const oldConvResolved = oldConv?.status === "resolved";
const newCartFresh = Array.isArray(cart2.cart_json) && cart2.cart_json.length === 0;
console.log(`new conversation created: ${newConvCreated} (${conv1.id} -> ${newConv.id})`);
console.log(`old conversation marked resolved: ${oldConvResolved} (status=${oldConv?.status})`);
console.log(`new cart is fresh/empty (no welded cheeseburger): ${newCartFresh}`);
console.log(newConvCreated && oldConvResolved && newCartFresh ? "PASS" : "FAIL");
