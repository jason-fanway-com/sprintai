const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS = "e0000000-0000-0000-0000-000000000001";

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return await res.json();
}

const sessionId = `d1-vitos-repro-${Date.now()}`;
console.log(`=== VITO'S D1 REPRO (session ${sessionId}) ===`);
const r = await send(VITOS, "a large cheese pizza with extra cheese and a plain large cheese pizza", sessionId);
console.log(`bot: ${r.reply}`);
console.log(`cart: ${JSON.stringify(r.cart ?? r.cart_json ?? "(no cart field)", null, 2)}`);
console.log(JSON.stringify(r, null, 2).slice(0, 4000));
