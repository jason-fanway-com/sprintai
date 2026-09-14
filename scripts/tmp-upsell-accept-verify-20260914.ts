/**
 * Targeted, deterministic verification for item G follow-up (C2c-upsell
 * over-broad acceptance check). Bypasses the non-deterministic path that
 * naturally produces the upsell offer sentence (the Item 8 compiled
 * pending-answer resolver returns early before ever reaching the upsell
 * render block) by seeding the assistant's upsell-offer message directly
 * into the messages table, then sending a single reply and checking the DB
 * cart.
 *
 * Two scenarios, selected by argv[0]:
 *   "decline"  -> "that's it" must NOT add French Fries (line count stays 1)
 *   "accept"   -> "yes" must add French Fries at its real menu price ($4.99)
 *
 * Run:
 *   deno run --allow-net --allow-env --no-check scripts/tmp-upsell-accept-verify-20260914.ts decline
 *   deno run --allow-net --allow-env --no-check scripts/tmp-upsell-accept-verify-20260914.ts accept
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const scenario = Deno.args[0];
if (scenario !== "decline" && scenario !== "accept") {
  console.error("usage: tmp-upsell-accept-verify-20260914.ts <decline|accept>");
  Deno.exit(2);
}

const sessionId = `upsell-verify-${scenario}-${crypto.randomUUID()}`;
console.log(`=== UPSELL ACCEPT/DECLINE VERIFY (${scenario}, session ${sessionId}) ===`);

async function send(message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`customer: ${message}`);
  console.log(`bot: ${json.reply?.slice(0, 200)}`);
  return json;
}

// Get Cheese Burger to Medium, fully resolved, deterministically.
await send("cheeseburger");
await send("medium");

const { data: conv } = await supabase
  .from("conversations").select("id, tenant_id").eq("session_id", sessionId).maybeSingle();
if (!conv) throw new Error("conversation not found");

// Seed the code-rendered upsell offer as the last assistant message, exactly
// matching renderUpsellOfferSentence's fixed shape (upsell-offer-20260914.ts).
const offerSentence = "Want to add French Fries for $4.99?";
await supabase.from("messages").insert({
  conversation_id: conv.id,
  tenant_id: conv.tenant_id,
  role: "assistant",
  content: offerSentence,
});
console.log(`(seeded assistant offer) bot: ${offerSentence}`);

const replyText = scenario === "decline" ? "thats it" : "yes";
await send(replyText);

const { data: cart } = await supabase
  .from("order_carts")
  .select("cart_json, total_cents, phase")
  .eq("conversation_id", conv.id)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (!cart) throw new Error("cart not found");

const lines = cart.cart_json as Array<{ name: string; quantity: number; price_cents: number }>;
console.log("\n=== DB READ-ONLY VERIFICATION ===");
console.log(JSON.stringify(lines, null, 2));

const friesLine = lines.find(l => l.name === "French Fries");

let pass: boolean;
if (scenario === "decline") {
  pass = lines.length === 1 && !friesLine;
  console.log(`\nline count: ${lines.length} (expected 1)`);
  console.log(`French Fries present: ${!!friesLine} (expected false)`);
} else {
  pass = lines.length === 2 && !!friesLine && friesLine.price_cents === 499 && friesLine.quantity === 1;
  console.log(`\nline count: ${lines.length} (expected 2)`);
  console.log(`French Fries present: ${!!friesLine}, price_cents: ${friesLine?.price_cents} (expected 499), qty: ${friesLine?.quantity} (expected 1)`);
}

console.log(`\nVERIFY ${pass ? "PASS" : "FAIL"}`);
if (!pass) Deno.exit(1);
