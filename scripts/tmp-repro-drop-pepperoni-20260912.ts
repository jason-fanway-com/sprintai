import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

for (let i = 0; i < 6; i++) {
  const sessionId = `repro-drop-pepp-${i}-${crypto.randomUUID()}`;
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
  const r = await send(sessionId, "yep but drop the pepperoni");
  console.log(`\n=== RUN ${i} ===`);
  console.log(`bot: ${r.reply}`);
  console.log(`cart: ${JSON.stringify(r.cart)}`);
}
