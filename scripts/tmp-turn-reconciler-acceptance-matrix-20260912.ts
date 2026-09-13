/**
 * Turn-reconciler acceptance matrix (2026-09-12) — drives handleChatSmsRequest
 * DIRECTLY (imported from the locally-edited chat-sms/index.ts, no deploy)
 * against the real Vito's shop_id, web channel + test:true, real Supabase DB,
 * real LLM. Fresh session per case.
 *
 * Cases 1-8: bare/mixed confirmation-word turns during the building phase.
 * Case 9: checkout-phase mixed-intent turn (fries added + payment link reissued).
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   STRIPE_TEST_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-turn-reconciler-acceptance-matrix-20260912.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function seedCustomer(sessionId: string) {
  const customerPhone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  const { error } = await supabase.from("customers").upsert({
    tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
    order_count: 5, total_spent_cents: 8250,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "pickup",
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  if (error) throw new Error(`seed customer: ${error.message}`);
}

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  const json = await res.json();
  console.log(`  YOU: "${message}"`);
  console.log(`  BOT: "${json.reply}"`);
  console.log(`  cart: ${JSON.stringify(json.cart)}`);
  console.log(`  phase: ${json.phase}`);
  return json;
}

async function dumpAuthoritativeCart(sessionId: string) {
  const { data: conv } = await supabase.from("conversations").select("id").eq("session_id", sessionId).maybeSingle();
  const { data: cartRow } = await supabase.from("order_carts")
    .select("cart_json, subtotal_cents, total_cents, phase, pickup_name, stripe_checkout_session_id")
    .eq("conversation_id", conv?.id).maybeSingle();
  console.log("  AUTHORITATIVE CART ROW:", JSON.stringify(cartRow, null, 2));
  return cartRow;
}

type CaseResult = { label: string; message: string; cart: unknown; cartRow: unknown };
const results: CaseResult[] = [];

async function scenario(label: string, finalMessage: string, driveToCheckout: boolean) {
  console.log(`\n########## CASE ${label}: "${finalMessage}" (checkout=${driveToCheckout}) ##########`);
  const sessionId = `reconciler-matrix-${label}-${crypto.randomUUID()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
  if (driveToCheckout) {
    await send(sessionId, "yes");
  }
  const final = await send(sessionId, finalMessage);
  console.log(`  FINAL CART (in-memory):`, JSON.stringify(final.cart, null, 2));
  const cartRow = await dumpAuthoritativeCart(sessionId);
  results.push({ label, message: finalMessage, cart: final.cart, cartRow });
  return final;
}

// Cases 1-8: building-phase (and one bare "yes") confirmation-word turns.
await scenario("1", "Yes to Jason. Can you add fries to that?", false);
await scenario("2", "yes, and add fries", false);
await scenario("3", "yep but drop the pepperoni", false);
await scenario("4", "that's right, also a coke", false);
await scenario("5", "correct, and a side salad", false);
await scenario("6", "yes that's me, add a coke", false);
await scenario("7", "yep, and two cokes", false);
await scenario("8", "yes", false);

// Case 9: checkout-phase mixed-intent — fries added AND payment link reissued.
console.log(`\n########## CASE 9: checkout-phase "add fries" mixed-intent ##########`);
{
  const sessionId = `reconciler-matrix-9-${crypto.randomUUID()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
  await send(sessionId, "yes"); // confirm name -> reach checkout/payment-link phase
  const beforeRow = await dumpAuthoritativeCart(sessionId);
  const final = await send(sessionId, "add fries");
  console.log(`  FINAL CART (in-memory):`, JSON.stringify(final.cart, null, 2));
  const afterRow: any = await dumpAuthoritativeCart(sessionId);
  const linkChanged = (beforeRow as any)?.stripe_checkout_session_id !== afterRow?.stripe_checkout_session_id;
  console.log(`  payment link before: ${(beforeRow as any)?.stripe_checkout_session_id}`);
  console.log(`  payment link after:  ${afterRow?.stripe_checkout_session_id}`);
  console.log(`  payment link changed: ${linkChanged}`);
  results.push({ label: "9", message: "add fries (checkout-phase)", cart: final.cart, cartRow: { ...afterRow, linkChanged } });
}

console.log("\n\n================ SUMMARY (all cases) ================");
for (const r of results) {
  console.log(`\n--- CASE ${r.label}: "${r.message}" ---`);
  console.log(`cart: ${JSON.stringify(r.cart)}`);
  console.log(`authoritative row: ${JSON.stringify(r.cartRow)}`);
}
