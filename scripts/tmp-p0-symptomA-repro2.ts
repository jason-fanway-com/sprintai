// P0 repro variant 2: order pizza first, then decline toppings as a
// SEPARATE follow-up turn ("no extra toppings" / "none" / "nope").
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const RUN = Deno.args[0] ?? "1";
const DECLINE_MSG = Deno.args[1] ?? "no extra toppings";
const TURNS = [
  "pickup",
  "I want a large pizza",
  DECLINE_MSG,
];

const sessionId = `p0-symA2-run${RUN}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`\n=== SYMPTOM A RUN2 ${RUN} decline="${DECLINE_MSG}" (session ${sessionId}) ===`);
for (const turn of TURNS) {
  const r = await send(ZIOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  const cartArr = Array.isArray(r.cart) ? r.cart : [];
  console.log(`cart lines: ${cartArr.length}`);
  for (const c of cartArr) {
    console.log(`  - ${c.name} qty=${c.quantity} price_cents=${c.price_cents} options=${JSON.stringify(c.options ?? {})}`);
  }
}
