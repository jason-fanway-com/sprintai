/**
 * C1/C4 acceptance matrix (2026-09-12) — drives handleChatSmsRequest DIRECTLY
 * (imported from the locally-edited chat-sms/index.ts, no deploy) against the
 * real Vito's shop_id, web channel + test:true, real Supabase DB, real LLM.
 * Four independent conversations, one per PO phrasing:
 *   (a) "Yes to Jason. Can you add fries to that?"   — building phase
 *   (b) "yes, and add fries"                         — building phase
 *   (c) "yep but drop the pepperoni"                  — building phase (must still pass)
 *   (d) "Yes, add fries to that"                      — CHECKOUT phase (no premature link)
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-c1-c4-acceptance-matrix-20260912.ts
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

async function scenario(label: string, finalMessage: string, driveToCheckout: boolean) {
  console.log(`\n########## SCENARIO ${label}: "${finalMessage}" (checkout=${driveToCheckout}) ##########`);
  const sessionId = `c1c4-matrix-${label}-${crypto.randomUUID()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
  if (driveToCheckout) {
    // Confirm the name straight (bare "yes") to actually reach checkout/payment-link phase.
    await send(sessionId, "yes");
  }
  const final = await send(sessionId, finalMessage);
  console.log(`  FINAL CART (in-memory):`, JSON.stringify(final.cart, null, 2));
  await dumpAuthoritativeCart(sessionId);
  return final;
}

await scenario("a", "Yes to Jason. Can you add fries to that?", false);
await scenario("b", "yes, and add fries", false);
await scenario("c", "yep but drop the pepperoni", false);
await scenario("d", "Yes, add fries to that", true);
