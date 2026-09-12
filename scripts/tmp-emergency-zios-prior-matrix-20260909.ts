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

const TWO_TURN_CASES = [
  { label: "phrasing: 1 cheese 1 pepperoni 1 meat lover 1 hawaiian (exact, from unit test)",
    setup: "I want 4 large pizzas", combo: "1 cheese 1 pepperoni 1 meat lover 1 hawaiian" },
  { label: "phrasing: gimme a plain and a pepperoni and a meat lovers and a hawaiian (exact, from unit test)",
    setup: "I want 4 large pizzas", combo: "gimme a plain and a pepperoni and a meat lovers and a hawaiian" },
  { label: "phrasing: a plain, a pepperoni, a meat lovers and a hawaiian (reconstructed variant)",
    setup: "I want 4 large pizzas", combo: "a plain, a pepperoni, a meat lovers and a hawaiian" },
  { label: "phrasing: plain pizza, pepperoni pizza, meat lovers pizza and hawaiian pizza (reconstructed variant)",
    setup: "I want 4 large pizzas", combo: "plain pizza, pepperoni pizza, meat lovers pizza and hawaiian pizza" },
  { label: "adversarial: qty>1 on the composed item",
    setup: "I want 4 large pizzas", combo: "two pepperoni, one plain, and one meat lovers" },
  { label: "adversarial: negation on the composed topping",
    setup: "I want 4 large pizzas", combo: "one plain, one pepperoni no extra cheese, one meat lover and one hawaiian" },
  { label: "adversarial: intentional extra modifier on the composed item",
    setup: "I want 4 large pizzas", combo: "one pepperoni with extra cheese, one plain, one meat lover and one hawaiian" },
  { label: "adversarial: non-pizza item mixed into the same turn",
    setup: "I want 4 large pizzas", combo: "one plain, one pepperoni, one meat lover, one hawaiian and a coke" },
];

const READONLY_CASE = { setup: "I want 4 large pizzas", followup: "one plain, one pepperoni, one meat lover and one hawaiian", readonly: "show me the line items in the order" };

for (const c of TWO_TURN_CASES) {
  const sessionId = `emrg-prior-matrix-${Math.floor(Math.random() * 1e9)}`;
  console.log(`\n--- ${c.label} ---`);
  const r1 = await send(ZIOS_SHOP_ID, c.setup, sessionId);
  console.log(`customer: ${c.setup}`);
  console.log(`bot: ${r1.reply}`);
  const r2 = await send(ZIOS_SHOP_ID, c.combo, sessionId);
  console.log(`customer: ${c.combo}`);
  console.log(`bot: ${r2.reply}`);
}

console.log(`\n--- read-only routing: "show me the line items in the order" ---`);
{
  const sessionId = `emrg-readonly-${Math.floor(Math.random() * 1e9)}`;
  const r1 = await send(ZIOS_SHOP_ID, READONLY_CASE.setup, sessionId);
  console.log(`customer: ${READONLY_CASE.setup}`);
  console.log(`bot: ${r1.reply}`);
  const r2 = await send(ZIOS_SHOP_ID, READONLY_CASE.followup, sessionId);
  console.log(`customer: ${READONLY_CASE.followup}`);
  console.log(`bot: ${r2.reply}`);
  const r3 = await send(ZIOS_SHOP_ID, READONLY_CASE.readonly, sessionId);
  console.log(`customer: ${READONLY_CASE.readonly}`);
  console.log(`bot: ${r3.reply}`);
}
