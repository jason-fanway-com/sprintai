const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";
const VITOS_SHOP_ID = "e0000000-0000-0000-0000-000000000001";

async function send(shopId: string, message: string, sessionId: string) {
  const t0 = performance.now();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  const latencyMs = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`chat-sms ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  return { ...json, latencyMs };
}

console.log("=== GUARD 19 PROTECTION CHECK (must add ZERO items) ===");
{
  const sessionId = `emergency-guard19-protection-${Date.now()}`;
  const r1 = await send(ZIOS_SHOP_ID, "RESET", sessionId);
  console.log("after RESET:", r1.reply, `(${r1.latencyMs}ms)`);
  const r2 = await send(ZIOS_SHOP_ID, "I want four large pizzas", sessionId);
  console.log("after 'I want four large pizzas':", r2.reply, `(${r2.latencyMs}ms)`);
  console.log("cart:", JSON.stringify(r2.cart));
}

console.log("\n=== VITO'S REGRESSION (expect $9.48) ===");
{
  const sessionId = `emergency-vitos-regression-${Date.now()}`;
  const r1 = await send(VITOS_SHOP_ID, "cheeseburger", sessionId);
  console.log("cheeseburger ->", r1.reply, `(${r1.latencyMs}ms)`);
  const r2 = await send(VITOS_SHOP_ID, "medium", sessionId);
  console.log("medium ->", r2.reply, `(${r2.latencyMs}ms)`);
  const r3 = await send(VITOS_SHOP_ID, "thats it", sessionId);
  console.log("thats it ->", r3.reply, `(${r3.latencyMs}ms)`);
  console.log("final cart:", JSON.stringify(r3.cart));
}
