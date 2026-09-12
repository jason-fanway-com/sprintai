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

const sessionId = `d2-vitos-dressing-${Date.now()}`;
console.log(`=== VITO'S D2 DRESSING REPRO (session ${sessionId}) ===`);
const r1 = await send(VITOS, "I'll get the House salad", sessionId);
console.log(`customer: I'll get the House salad`);
console.log(`bot: ${r1.reply}`);
console.log("LEAK CHECK:", /Choices for/i.test(r1.reply) ? "LEAKED" : "clean");
