/**
 * Case 9 stress test (checkpoint 2, 2026-09-13): checkout-phase "add fries"
 * mixed-intent turn. Runs 6 fresh sessions in-process against the CURRENT
 * committed code (9a58f012, no stashed hunk applied), dumping the
 * authoritative order_carts row before/after so a silent-drop (LLM says it
 * added fries but add_item never actually fired, cart unchanged) is visible
 * even if the bot's reply text looks fine.
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
 *   STRIPE_TEST_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-repro-case9-checkoutadd-20260913.ts
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
  await supabase.from("customers").upsert({
    tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
    order_count: 5, total_spent_cents: 8250,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "pickup", updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
}

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

async function dumpAuthoritativeCart(sessionId: string) {
  const { data: conv } = await supabase.from("conversations").select("id").eq("session_id", sessionId).maybeSingle();
  const { data: cartRow } = await supabase.from("order_carts")
    .select("cart_json, subtotal_cents, total_cents, phase, pickup_name, stripe_checkout_session_id")
    .eq("conversation_id", conv?.id).maybeSingle();
  return cartRow;
}

const N = 6;
let passCount = 0;
const failures: string[] = [];

for (let i = 0; i < N; i++) {
  const sessionId = `repro-case9-${i}-${crypto.randomUUID()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  await send(sessionId, "that's it");
  await send(sessionId, "yes"); // confirm name -> checkout/payment-link phase
  const beforeRow: any = await dumpAuthoritativeCart(sessionId);
  const r = await send(sessionId, "add fries");
  const afterRow: any = await dumpAuthoritativeCart(sessionId);

  const linkChanged = beforeRow?.stripe_checkout_session_id !== afterRow?.stripe_checkout_session_id;
  const cartNames = ((afterRow?.cart_json ?? []) as any[]).map((c) => c.name ?? "").join(" | ");
  const hasFries = /fries/i.test(cartNames);
  const hasPizza = /pizza|pepperoni/i.test(cartNames);
  const noDupFries = (((afterRow?.cart_json ?? []) as any[]).filter((c) => /fries/i.test(c.name ?? "")).length === 1);

  const ok = hasFries && hasPizza && noDupFries;

  console.log(`\n=== RUN ${i} ===`);
  console.log(`bot: ${r.reply}`);
  console.log(`cart (in-memory): ${JSON.stringify(r.cart)}`);
  console.log(`before row: ${JSON.stringify(beforeRow)}`);
  console.log(`after row:  ${JSON.stringify(afterRow)}`);
  console.log(`linkChanged: ${linkChanged}`);
  console.log(`hasFries=${hasFries} hasPizza=${hasPizza} noDupFries=${noDupFries} => ${ok ? "PASS" : "FAIL"}`);

  if (ok) passCount++;
  else failures.push(`run ${i}: hasFries=${hasFries} hasPizza=${hasPizza} noDupFries=${noDupFries} linkChanged=${linkChanged} cart=${cartNames}`);
}

console.log(`\n\n================ CASE 9 STRESS TEST: ${passCount}/${N} PASS ================`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
