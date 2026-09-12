/**
 * F1/F2 acceptance battery (2026-09-08). 10 consecutive live runs against
 * Zio's chat-sms (web JSON path, POST {shop_id, message, session_id,
 * test:true}, never real SMS/Twilio). pickup -> "I want 4 large pizzas" ->
 * "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers". Fresh session_id per run.
 * Captures per-turn latency (Date.now() around each fetch) for F2.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function send(message: string, sessionId: string): Promise<{ reply: string | null; cart?: unknown; phase?: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: ZIOS_SHOP_ID, message, session_id: sessionId, test: true }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return { ...json, ms };
}

const TURNS = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"];
const results: any[] = [];

for (let run = 1; run <= 10; run++) {
  const sessionId = `f1f2-acceptance-zios-run${run}-${Date.now() % 100000}`;
  const transcript: { turn: string; reply: string | null; cart?: unknown; ms: number }[] = [];
  for (const turn of TURNS) {
    const r = await send(turn, sessionId);
    transcript.push({ turn, reply: r.reply, cart: r.cart, ms: r.ms });
  }
  const totalMs = transcript.reduce((s, t) => s + t.ms, 0);
  results.push({ run, sessionId, transcript, totalMs });
  console.log(`\n=== RUN ${run} (session ${sessionId}, totalMs=${totalMs}) ===`);
  for (const t of transcript) {
    console.log(`customer: ${t.turn}  [${t.ms}ms]`);
    console.log(`bot: ${t.reply}`);
  }
}

await Deno.writeTextFile("/tmp/f1-f2-acceptance-10x-results.json", JSON.stringify(results, null, 2));
console.log("\n\nWrote /tmp/f1-f2-acceptance-10x-results.json");
console.log("\n=== LATENCY SUMMARY (final turn = the 4-item enumeration turn) ===");
for (const r of results) {
  const finalTurn = r.transcript[r.transcript.length - 1];
  console.log(`run ${r.run}: final-turn=${finalTurn.ms}ms  total=${r.totalMs}ms`);
}
