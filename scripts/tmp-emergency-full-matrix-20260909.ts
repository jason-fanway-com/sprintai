const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";
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

// Single-turn cases: message is self-contained.
const SINGLE_TURN_CASES = [
  "four large plain pizzas",
  "4 large plain pizzas",
  "I need to order four large plain pizzas",
  "large plain pizzas",
  "two cheesesteaks",
];

// Two-turn cases: establish "4 large pizzas" context first (matches the
// real reported shape — PO idx444/idx482 — where size was already
// established before the combo line), then the combo phrase itself.
const TWO_TURN_CASES = [
  { setup: "I want 4 large pizzas", combo: "one plain, one pepperoni, one meat lover and one hawaai" },
  { setup: "I want 4 large pizzas", combo: "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers" },
];

for (const shop of [{ name: "VITO'S", id: VITOS_SHOP_ID }, { name: "ZIO'S", id: ZIOS_SHOP_ID }]) {
  console.log(`\n\n========== ${shop.name} ==========`);
  for (const msg of SINGLE_TURN_CASES) {
    const sessionId = `emrg-matrix-${Math.floor(Math.random() * 1e9)}`;
    const r = await send(shop.id, msg, sessionId);
    console.log(`\ncustomer: ${msg}`);
    console.log(`bot: ${r.reply}`);
  }
  for (const c of TWO_TURN_CASES) {
    const sessionId = `emrg-matrix-${Math.floor(Math.random() * 1e9)}`;
    const r1 = await send(shop.id, c.setup, sessionId);
    console.log(`\ncustomer: ${c.setup}`);
    console.log(`bot: ${r1.reply}`);
    const r2 = await send(shop.id, c.combo, sessionId);
    console.log(`customer: ${c.combo}`);
    console.log(`bot: ${r2.reply}`);
  }
}
