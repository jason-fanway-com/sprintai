// P0 repro sweep: multiple realistic phrasings/orders at Zio's, each with an
// explicit "no extra toppings"-class statement, checking for an unrequested
// Extra Cheese (or any paid) option landing on a pizza line. Live endpoint,
// channel: web, fresh session_id per run, no test flag.
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

const SCENARIOS: { label: string; turns: string[] }[] = [
  { label: "single-plain-inline-decline", turns: ["pickup", "I want a large plain pizza, no extra toppings"] },
  { label: "two-pizzas-no-toppings", turns: ["pickup", "I want 2 large pizzas, no extra toppings"] },
  { label: "four-pizzas-mixed-then-decline", turns: ["pickup", "I want 4 large pizzas", "1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers, no extra toppings on any of them"] },
  { label: "generic-decline-after-ask", turns: ["pickup", "I want a large pizza", "just plain, no extra toppings please"] },
  { label: "explicit-no-cheese", turns: ["pickup", "large plain pizza, no extra cheese"] },
];

const RUNIDX = parseInt(Deno.args[0] ?? "0", 10);
const s = SCENARIOS[RUNIDX];
if (!s) { console.log("no such scenario index"); Deno.exit(1); }
const sessionId = `p0-symA-sweep-${RUNIDX}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
console.log(`\n=== SCENARIO [${RUNIDX}] ${s.label} (session ${sessionId}) ===`);
for (const turn of s.turns) {
  const r = await send(ZIOS_SHOP_ID, turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${r.reply}`);
  const cartArr = Array.isArray(r.cart) ? r.cart : [];
  console.log(`cart lines: ${cartArr.length}`);
  for (const c of cartArr) {
    console.log(`  - ${c.name} qty=${c.quantity} price_cents=${c.price_cents} options=${JSON.stringify(c.options ?? {})}`);
  }
}
