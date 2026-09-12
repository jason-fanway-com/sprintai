// Rank-2 fix acceptance matrix — 10 cases, all against real Zio's endpoint.
// Expected: 4 lines, subtotal $88.96, Pepperoni on exactly one line.
// Cases 7-10 have different expected behaviors (noted inline).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: ZIOS_SHOP_ID, message, session_id: sessionId, channel: "web" }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

function sid() { return `r2-accept-${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }

const STANDARD = [
  "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers",
  "one plain, one pepperoni, one meat lover and one hawaai",
  "a plain, a pepperoni, a meat lovers and a hawaiian",
  "plain pizza, pepperoni pizza, meat lovers pizza, hawaiian pizza",
  "1 cheese 1 pepperoni 1 meat lover 1 hawaiian",
  "gimme a plain and a pepperoni and a meat lovers and a hawaiian",
];

const ADVERSARIAL = [
  { msg: "two pepperoni and a hawaiian", note: "qty>1 on composed item: expect 2 pepperoni lines + 1 hawaiian, pepperoni on 2 lines only" },
  { msg: "a hawaiian, no pepperoni", note: "negation must not leak: expect 1 hawaiian, NO pepperoni anywhere" },
  { msg: "a meat lovers with extra pepperoni", note: "intended modifier must still apply: expect meat lovers WITH Pepperoni" },
  { msg: "pepperoni pizza and a coke", note: "non-pizza item: expect 1 pepperoni pizza + 1 coke, no bleed" },
];

console.log("=== STANDARD CASES (expect 4 lines, subtotal $88.96, Pepperoni on exactly 1 line) ===\n");
for (let i = 0; i < STANDARD.length; i++) {
  const msg = STANDARD[i];
  console.log(`Case ${i + 1}: "${msg}"`);
  try {
    const r = await send(msg, sid());
    console.log(`  reply: ${r.reply}`);
    console.log(`  cart: ${JSON.stringify(r.cart ?? r.cartItems ?? "(no cart in response)")}`);
  } catch (e) {
    console.log(`  ERROR: ${e}`);
  }
  console.log();
}

console.log("\n=== ADVERSARIAL CASES ===\n");
for (let i = 0; i < ADVERSARIAL.length; i++) {
  const { msg, note } = ADVERSARIAL[i];
  console.log(`Case ${i + 7}: "${msg}"`);
  console.log(`  expected: ${note}`);
  try {
    const r = await send(msg, sid());
    console.log(`  reply: ${r.reply}`);
    console.log(`  cart: ${JSON.stringify(r.cart ?? r.cartItems ?? "(no cart in response)")}`);
  } catch (e) {
    console.log(`  ERROR: ${e}`);
  }
  console.log();
}
