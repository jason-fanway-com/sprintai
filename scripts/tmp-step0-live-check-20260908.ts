/**
 * STEP 0 live check: is v301 (guard19-fuzzy-item-match only, F2 dedupe excluded)
 * currently safe or actively broken on real Zio's traffic? 3 runs of the PO's
 * acceptance test.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(shopId: string, message: string, sessionId: string) {
  const t0 = performance.now();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  const latencyMs = performance.now() - t0;
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  return { ...json, latencyMs };
}

for (let run = 1; run <= 3; run++) {
  const sessionId = `step0-livecheck-run${run}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const turns = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"];
  console.log(`\n=== RUN ${run} (session ${sessionId}) ===`);
  for (const turn of turns) {
    const r = await send(ZIOS_SHOP_ID, turn, sessionId);
    console.log(`customer: ${turn}`);
    console.log(`bot: ${r.reply}`);
    console.log(`cart: ${JSON.stringify(r.cart)}`);
    console.log(`latencyMs: ${Math.round(r.latencyMs)}`);
  }
}
