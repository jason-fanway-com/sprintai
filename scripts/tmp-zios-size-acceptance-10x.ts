/**
 * PO acceptance test, 10 consecutive live runs against Zio's chat-sms
 * (web JSON path, same safe contract as scripts/test-suite/runner.ts --
 * POST {shop_id, message, session_id, test:true}, never real SMS/Twilio).
 * pickup -> "I want 4 large pizzas" -> "1 pepp, 1 plain, 1 hawaiin, 1 meat
 * lovers". Fresh session_id per run.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(message: string, sessionId: string): Promise<{ reply: string | null; cart?: unknown; phase?: string }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: ZIOS_SHOP_ID, message, session_id: sessionId, test: true }),
  });
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const TURNS = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"];
const results: any[] = [];

for (let run = 1; run <= 10; run++) {
  const sessionId = `po-acceptance-zios-large-pizzas-run${run}-${run}x${Date.now() % 100000}`;
  const transcript: { turn: string; reply: string | null; cart?: unknown }[] = [];
  for (const turn of TURNS) {
    const r = await send(turn, sessionId);
    transcript.push({ turn, reply: r.reply, cart: r.cart });
  }
  results.push({ run, sessionId, transcript });
  console.log(`\n=== RUN ${run} (session ${sessionId}) ===`);
  for (const t of transcript) {
    console.log(`customer: ${t.turn}`);
    console.log(`bot: ${t.reply}`);
  }
}

await Deno.writeTextFile("/tmp/zios-acceptance-10x-results.json", JSON.stringify(results, null, 2));
console.log("\n\nWrote /tmp/zios-acceptance-10x-results.json");
