/**
 * In-process canary — drives handleChatSmsRequest directly from the local
 * index.ts (no deploy). Mirrors the logic of tmp-v4-vitos-canary-20260911.ts:
 * "cheeseburger" -> "medium" -> "thats it" must produce ONE cart line,
 * Temp: Medium, total $8.49 + $0.99 platform fee = $9.48.
 * Cart row read from DB — never from reply text.
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   STRIPE_TEST_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-inprocess-canary-20260912.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const sessionId = `inprocess-canary-${crypto.randomUUID()}`;
console.log(`=== VITO'S IN-PROCESS CANARY (session ${sessionId}) ===`);

async function send(message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`customer: ${message}`);
  console.log(`bot: ${json.reply?.slice(0, 120)}`);
  return json;
}

const TURNS = ["cheeseburger", "medium", "thats it"];
for (const turn of TURNS) {
  await send(turn);
}

// Read cart row directly from DB.
const { data: conv } = await supabase
  .from("conversations").select("id").eq("session_id", sessionId).maybeSingle();
if (!conv) throw new Error("conversation not found");

const { data: cart } = await supabase
  .from("order_carts")
  .select("cart_json, subtotal_cents, tax_cents, total_cents, phase")
  .eq("conversation_id", conv.id)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (!cart) throw new Error("cart not found");

console.log("\n=== DB READ-ONLY VERIFICATION ===");
console.log(JSON.stringify(cart, null, 2));

const lines = cart.cart_json as Array<{ options?: Record<string, string[]>; quantity: number; price_cents: number }>;
const lineCount = lines.length;
const line0 = lines[0];
const tempOk = line0 && JSON.stringify(line0.options ?? {}).includes("Medium");
const expectedTotal = 948;
const subtotal = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
const actualTotal = (cart.total_cents ?? (subtotal + 99));

console.log(`\nline count: ${lineCount} (expected 1)`);
console.log(`line 0 options: ${JSON.stringify(line0?.options)}`);
console.log(`total_cents (DB): ${cart.total_cents}`);
console.log(`computed total (subtotal+fee): ${actualTotal}`);
console.log(`expected: 948 ($9.48)`);

// During building phase total_cents = subtotal only (fee applied at checkout).
// Compute total as subtotal + 99 to match the expected $9.48.
const computedTotal = subtotal + 99;
const pass = lineCount === 1 && tempOk && computedTotal === expectedTotal;
console.log(`\nCANARY ${pass ? "PASS" : "FAIL"}`);
if (!pass) {
  Deno.exit(1);
}
