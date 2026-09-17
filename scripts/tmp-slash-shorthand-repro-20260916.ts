// Repro for slash-compressed shorthand silently dropping the whole order.
// Live endpoint, channel: web (no test flag), fresh session_id per run.
// Vito's real menu item: "Cheese Burger" (id 442f650d-dc96-4a95-9762-f6b571a4dd8c),
// required ask_plan slot "Temp" with choice "Medium" — customer's casual,
// unspaced "cheeseburger" fuzzy-matches this via GUARD 19.
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

async function run(label: string, orderTurn: string) {
  const sessionId = `slash-repro-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  console.log(`\n=== ${label} (session ${sessionId}) ===`);
  const turns = ["pickup", orderTurn];
  for (const turn of turns) {
    const r = await send(VITOS_SHOP_ID, turn, sessionId);
    console.log(`customer: ${turn}`);
    console.log(`bot: ${r.reply}`);
    const cartArr = Array.isArray(r.cart) ? r.cart : [];
    console.log(`cart lines: ${cartArr.length}`);
    for (const c of cartArr) {
      console.log(`  - ${c.name} qty=${c.quantity} price_cents=${c.price_cents} options=${JSON.stringify(c.options ?? {})}`);
    }
  }
}

await run("SLASH-SHORTHAND", "cheeseburger / medium / thats it");
await run("COMMA-EQUIVALENT", "cheeseburger, medium, that's it");
