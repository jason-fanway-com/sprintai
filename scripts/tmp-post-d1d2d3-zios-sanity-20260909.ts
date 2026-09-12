const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const sessionId = `post-d1d2d3-zios-${Date.now()}`;
console.log(`=== ZIO'S POST-D1/D2/D3 SANITY (session ${sessionId}) ===`);
const TURNS = ["I want 4 large pizzas", "one plain, one pepperoni, one meat lover and one hawaiian"];
for (const turn of TURNS) {
  const r = await send(ZIOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  console.log("---");
}
