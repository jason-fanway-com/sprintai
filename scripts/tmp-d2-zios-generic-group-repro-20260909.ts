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

const sessionId = `d2-zios-generic-${Date.now()}`;
console.log(`=== ZIO'S D2 GENERIC-GROUP REPRO (session ${sessionId}) ===`);
const r1 = await send(ZIOS, "I'll get the chicken fingers and fries", sessionId);
console.log(`customer: I'll get the chicken fingers and fries`);
console.log(`bot: ${r1.reply}`);
console.log("LEAK CHECK (raw 'Choices for option'):", /Choices for option/i.test(r1.reply) ? "LEAKED" : "clean");
