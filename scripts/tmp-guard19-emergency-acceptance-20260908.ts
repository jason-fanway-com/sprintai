/**
 * EMERGENCY VERIFICATION (2026-09-08): GUARD 19 false-positive fix + F2 menu
 * dedup latency fix, live against real Zio's + Vito's chat-sms.
 *
 * 1) PO's exact acceptance test, 10 consecutive runs: pickup -> "I want 4
 *    large pizzas" -> "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers".
 * 2) GUARD 19's own protection, unchanged: RESET -> "I want four large
 *    pizzas" (zero signal) must still add ZERO items.
 * 3) Vito's regression: cheeseburger / medium / "thats it" -> $9.48.
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function send(shopId: string, message: string, sessionId: string): Promise<{ reply: string | null; cart?: unknown; phase?: string; latencyMs: number }> {
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

const output: Record<string, unknown> = {};

// ── PART 1: 10x acceptance battery against Zio's ───────────────────────────
const acceptanceRuns: unknown[] = [];
for (let run = 1; run <= 10; run++) {
  const sessionId = `emergency-guard19-zios-run${run}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const turns = ["pickup", "I want 4 large pizzas", "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"];
  const transcript: unknown[] = [];
  for (const turn of turns) {
    const r = await send(ZIOS_SHOP_ID, turn, sessionId);
    transcript.push({ turn, reply: r.reply, cart: r.cart, phase: r.phase, latencyMs: Math.round(r.latencyMs) });
  }
  acceptanceRuns.push({ run, sessionId, transcript });
  console.log(`\n=== RUN ${run} (session ${sessionId}) ===`);
  for (const t of transcript as any[]) {
    console.log(`customer: ${t.turn}`);
    console.log(`bot: ${t.reply}`);
    console.log(`latencyMs: ${t.latencyMs}`);
  }
}
output.acceptanceRuns = acceptanceRuns;

// ── PART 2: GUARD 19's own protection must still fire ───────────────────────
{
  const sessionId = `emergency-guard19-protection-check-${Date.now()}`;
  const r1 = await send(ZIOS_SHOP_ID, "RESET", sessionId);
  const r2 = await send(ZIOS_SHOP_ID, "I want four large pizzas", sessionId);
  output.guard19ProtectionCheck = {
    sessionId,
    resetReply: r1.reply,
    afterQuantityOnly: { reply: r2.reply, cart: r2.cart, phase: r2.phase, latencyMs: Math.round(r2.latencyMs) },
  };
  console.log("\n=== GUARD 19 PROTECTION CHECK (must add ZERO items) ===");
  console.log("after RESET:", r1.reply);
  console.log("after 'I want four large pizzas':", r2.reply);
  console.log("cart:", JSON.stringify(r2.cart));
}

// ── PART 3: Vito's regression ───────────────────────────────────────────────
{
  const sessionId = `emergency-guard19-vitos-regression-${Date.now()}`;
  const r1 = await send(VITOS_SHOP_ID, "cheeseburger", sessionId);
  const r2 = await send(VITOS_SHOP_ID, "medium", sessionId);
  const r3 = await send(VITOS_SHOP_ID, "thats it", sessionId);
  output.vitosRegression = {
    sessionId,
    turns: [
      { turn: "cheeseburger", reply: r1.reply, cart: r1.cart },
      { turn: "medium", reply: r2.reply, cart: r2.cart },
      { turn: "thats it", reply: r3.reply, cart: r3.cart },
    ],
  };
  console.log("\n=== VITO'S REGRESSION (expect $9.48) ===");
  console.log("cheeseburger ->", r1.reply);
  console.log("medium ->", r2.reply);
  console.log("thats it ->", r3.reply);
}

await Deno.writeTextFile("/tmp/guard19-emergency-acceptance-results.json", JSON.stringify(output, null, 2));
console.log("\n\nWrote /tmp/guard19-emergency-acceptance-results.json");
