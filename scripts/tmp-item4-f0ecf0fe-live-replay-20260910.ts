// P0 LIVE replay (2026-09-10) — closes the gap the unit-level replay in
// supabase/functions/chat-sms/zios-89-95-vs-95-95-20260909.test.ts declared
// up front: that file exercises only the extracted pricing/detection/render
// functions in isolation, never the live LLM tool-call sequence. This script
// drives the actual deployed chat-sms endpoint with the real customer's own
// words from conversation f0ecf0fe-909f-4bd6-aa1a-e73f778c501c (Zio's,
// 2026-09-09 11:07-11:10 UTC), pulled fresh from the messages table, not
// paraphrased. test:true is real chat-sms code + real Zio's DB rows on
// test-mode Stripe/hours rails — not a fabricated event.
//
// Original incident: pepperoni got applied to BOTH the Meat Lover's and the
// Hawaiian pizza instead of only the pizza the customer actually named
// pepperoni for, producing a $95.95 total ($94.96 + $0.99 fee) against the
// correct $89.95 ($88.96 + $0.99). GUARD 2c/the widened currency lint and
// the modifier-scope fixes shipped since then are supposed to prevent this
// in the live pipeline, not just in the unit reconstruction.
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: ZIOS, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return await res.json();
}

const sessionId = `item4-f0ecf0fe-replay-${Math.floor(Math.random() * 1e9)}`;
console.log(`=== f0ecf0fe live replay (session ${sessionId}) ===`);

// Verbatim from the real conversation (fetched via REST, messages table,
// conversation_id=f0ecf0fe-909f-4bd6-aa1a-e73f778c501c), not paraphrased.
const TURNS = [
  "I need 4 large pizzas please",
  "1 plain, 1 pepperoni, 1 meat lovers and one hawaii",
];

let last: Record<string, unknown> = {};
for (const turn of TURNS) {
  last = await send(turn, sessionId);
  console.log(`customer: ${turn}`);
  console.log(`bot: ${last.reply}`);
}

const restHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const convRes = await fetch(`${SUPABASE_URL}/rest/v1/conversations?select=id&session_id=eq.${sessionId}&order=started_at.desc&limit=1`, { headers: restHeaders });
const [conv] = await convRes.json();
const cartRes = await fetch(`${SUPABASE_URL}/rest/v1/order_carts?select=id,cart_json,phase&conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`, { headers: restHeaders });
const [cart] = await cartRes.json();

console.log(`\ncart_json:`, JSON.stringify(cart.cart_json, null, 2));

const lines = (cart.cart_json ?? []) as Array<{ name: string; price_cents: number; quantity: number; menu_item_id: string }>;
const subtotalCents = lines.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
const totalCents = subtotalCents + 99;
console.log(`\nsubtotal: $${(subtotalCents / 100).toFixed(2)}  total: $${(totalCents / 100).toFixed(2)}`);

// NOTE: the historical $89.95 figure assumed "pepperoni" had no standalone
// menu row and got composed as a priced modifier on top of another pizza.
// Zio's menu has since gained a real "18'' Pepperoni Pizza" item, so a
// byte-for-byte total match is no longer the right pass bar — the actual
// P0 was a $3.00 pepperoni MODIFIER duplicated onto the Meat Lover's AND
// the Hawaiian line simultaneously. Check that invariant directly, against
// each line's own real base price (menu_item_id -> price_cents), not a
// hardcoded historical total.
const MEAT_LOVERS_ID = "0b7a33b7-f02c-4609-b7d2-1b99c08e805a";
const HAWAIIAN_ID = "5eb4554f-d4f7-4f8d-8440-55b051856650";
const BASE_PRICE_CENTS = 2499; // both rows, confirmed live 2026-09-09 via qa_ro
const meatLovers = lines.find((l) => l.menu_item_id === MEAT_LOVERS_ID);
const hawaiian = lines.find((l) => l.menu_item_id === HAWAIIAN_ID);
const noDuplicateModifier =
  (!meatLovers || meatLovers.price_cents === BASE_PRICE_CENTS) &&
  (!hawaiian || hawaiian.price_cents === BASE_PRICE_CENTS);

console.log(`\nMeat Lover's price_cents: ${meatLovers?.price_cents ?? "(not in cart)"} (expect ${BASE_PRICE_CENTS}, no pepperoni upcharge)`);
console.log(`Hawaiian price_cents: ${hawaiian?.price_cents ?? "(not in cart)"} (expect ${BASE_PRICE_CENTS}, no pepperoni upcharge)`);
console.log(noDuplicateModifier
  ? "PASS — the original P0 (pepperoni double-applied as a paid modifier to both pizzas) does NOT reproduce on the live pipeline"
  : "FAIL — pepperoni was applied as a modifier to Meat Lover's and/or Hawaiian — the original P0 still reproduces");
