const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return await res.json();
}

const sessionId = `d1-zios-repro-${Date.now()}`;
console.log(`=== ZIO'S D1 REPRO (session ${sessionId}) ===`);
const r = await send(ZIOS, "a large cheese pizza with extra cheese and a plain large cheese pizza", sessionId);
console.log(`bot: ${r.reply}`);
console.log(JSON.stringify(r, null, 2).slice(0, 4000));
