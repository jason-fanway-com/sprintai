const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const CASES = [
  "four large plain pizzas",
  "4 large plain pizzas",
  "I need to order four large plain pizzas",
  "large plain pizzas",
  "two cheesesteaks",
];

for (const msg of CASES) {
  const sessionId = `vitos-qtyplain-repro-${Math.floor(Math.random() * 1e9)}`;
  const r = await send(VITOS_SHOP_ID, msg, sessionId);
  console.log(`\ncustomer: ${msg}`);
  console.log(`bot: ${r.reply}`);
}
