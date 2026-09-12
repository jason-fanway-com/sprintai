/**
 * Batched Zio's acceptance runner (2026-09-09): PO's exact acceptance test,
 * pickup / "I want 4 large pizzas" / "1 pepp, 1 plain, 1 hawaiin, 1 meat
 * lovers", run START..END (inclusive) of the required 10. Batched so each
 * invocation finishes well inside a single tool-call timeout.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

const START = parseInt(Deno.args[0] ?? "1", 10);
const END = parseInt(Deno.args[1] ?? "1", 10);

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

for (let run = START; run <= END; run++) {
  const sessionId = `zios-acc-run${run}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const turns = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"];
  console.log(`\n=== RUN ${run} (session ${sessionId}) ===`);
  for (const turn of turns) {
    const r = await send(ZIOS_SHOP_ID, turn, sessionId);
    console.log(`customer: ${turn}`);
    console.log(`bot: ${r.reply}`);
    if (turn.startsWith("1 pepp")) {
      const cartArr = Array.isArray(r.cart) ? r.cart : [];
      console.log(`cart lines: ${cartArr.length}`);
      for (const c of cartArr) {
        console.log(`  - ${c.name} qty=${c.quantity} price_cents=${c.price_cents} options=${JSON.stringify(c.options ?? {})}`);
      }
      const subtotal = cartArr.reduce((s: number, c: any) => s + c.price_cents * (c.quantity || 1), 0);
      console.log(`subtotal_cents=${subtotal} total_with_fee_cents=${subtotal + 99}`);
    }
    console.log(`latencyMs: ${Math.round(r.latencyMs)}`);
  }
}
