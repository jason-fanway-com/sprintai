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

for (const msg of ["two large cheese pizzas, one with extra cheese", "a plain large cheese pizza and another plain large cheese pizza"]) {
  const sessionId = `d1-zios-regress-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
  console.log(`\n=== "${msg}" ===`);
  const r = await send(ZIOS, msg, sessionId);
  console.log(`bot: ${r.reply.split("\n\n")[0]}`);
  console.log("cart:", JSON.stringify(r.cart.map((l: any) => ({ qty: l.quantity, price: l.price_cents, options: l.options })), null, 2));
}
