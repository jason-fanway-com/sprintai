const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";

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

const sessionId = `d3-live-verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`=== D3 LIVE VERIFY (session ${sessionId}) ===`);

// Turn 1: establish cart + get to a real double-text-prone moment (bot asks
// for pickup name next), matching the reported repro shape.
const t1 = await send({ shop_id: VITOS_SHOP_ID, message: "one cheeseburger, medium, thats it", session_id: sessionId, test: true });
console.log(`turn1 (${t1.__ms}ms): ${t1.reply}`);
console.log("---");

// Turn 2 + Turn 3: fire CONCURRENTLY (Promise.all, not sequential awaits) —
// mirrors a real customer double-texting before the first reply lands. Turn
// 2 answers a question that hasn't been asked yet ("Yes"); Turn 3 gives the
// actual name ("Jason"). Pre-fix, both requests could read the same starting
// cart/conversation state concurrently, so the name-ask reply could land
// referencing state Turn 3 had already superseded, or Turn 3's answer could
// be lost/misattributed. Post-fix, the D3 turn lock should force Turn 3 to
// wait for Turn 2 to fully finish (incl. its DB writes) before it even reads
// cart state.
const [r2, r3] = await Promise.all([
  send({ shop_id: VITOS_SHOP_ID, message: "Yes", session_id: sessionId, test: true }),
  (async () => {
    // Tiny stagger (50ms) so this is unambiguously the SECOND message sent,
    // like real SMS delivery order, while still overlapping turn 2's
    // in-flight processing — the actual race condition being tested.
    await new Promise(r => setTimeout(r, 50));
    return send({ shop_id: VITOS_SHOP_ID, message: "Jason", session_id: sessionId, test: true });
  })(),
]);
console.log(`turn2 "Yes" (${r2.__ms}ms): ${r2.reply}`);
console.log("---");
console.log(`turn3 "Jason" (${r3.__ms}ms): ${r3.reply}`);
console.log("---");

// Final state: did the pickup name actually land as "Jason", and is the cart
// still coherent (one cheeseburger, not duplicated/lost)?
const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
const [conv] = await convRes.json();
const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase,pickup_name,processing_claimed_at&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart] = await cartRes.json();
console.log("final cart:", JSON.stringify(cart, null, 2));

const msgRes = await fetch(`${SUPABASE_URL}/rest/v1/messages?select=role,content,created_at&conversation_id=eq.${conv.id}&order=created_at.asc`, { headers: restHeaders });
const msgs = await msgRes.json();
console.log("=== message order (DB truth) ===");
for (const m of msgs) console.log(`[${m.created_at}] ${m.role}: ${m.content.replace(/\n/g, " ")}`);
