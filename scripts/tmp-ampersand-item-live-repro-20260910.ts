// Live repro/verify — Zio's Pizzeria "Mac & Cheese Bites" phrase-split bug.
// test:true is real chat-sms code + real Zio's DB rows, just with test-mode
// Stripe/hours rails (no real money moves) — not a fabricated event.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: ZIOS, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

async function runCase(label: string, turns: string[]) {
  const sessionId = `ampersand-repro-${label}-${Math.floor(Math.random() * 1e9)}`;
  console.log(`\n=== ${label} (session ${sessionId}) ===`);
  let last: Record<string, unknown> = {};
  for (const turn of turns) {
    last = await send(turn, sessionId);
    console.log(`customer: ${turn}`);
    console.log(`bot: ${last.reply}`);
  }

  const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
  const [conv] = await convRes.json();
  const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
  const [cart] = await cartRes.json();
  console.log(`cart_json (${label}):`, JSON.stringify(cart.cart_json, null, 2));
  return cart.cart_json;
}

await runCase("mac-and-cheese-then-soda", ["1 Mac & Cheese Bites and a Soda"]);
await runCase("soda-then-mac-and-cheese", ["a Soda and a Mac & Cheese Bites"]);
