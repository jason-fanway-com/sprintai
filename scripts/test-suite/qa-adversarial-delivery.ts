#!/usr/bin/env deno run --allow-net --allow-env
/**
 * qa-adversarial-delivery.ts — Precise re-creation of verifier's Criterion 2 test.
 * Pattern: order → bot asks pickup/delivery → evade → evade → "Jason" name
 * The key: does C2 shortcut silently default to pickup when delivery was asked?
 */

const SKEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI";
const SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co";
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const H = { "Authorization": `Bearer ${SKEY}`, "apikey": SKEY, "Content-Type": "application/json" };

const VITOS = "e0000000-0000-0000-0000-000000000001";

async function chat(shop: string, msg: string, sid: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST", headers: H,
    body: JSON.stringify({ shop_id: shop, message: msg, session_id: sid, test: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCart(sid: string) {
  const convRes = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?session_id=eq.${encodeURIComponent(sid)}&select=id&order=started_at.desc&limit=1`,
    { headers: H }
  );
  if (!convRes.ok) return null;
  const convs = await convRes.json();
  if (!convs.length) return null;
  const cr = await fetch(
    `${SUPABASE_URL}/rest/v1/order_carts?conversation_id=eq.${convs[0].id}&select=*&order=created_at.desc&limit=1`,
    { headers: H }
  );
  if (!cr.ok) return null;
  const carts = await cr.json();
  return carts[0] || null;
}

async function runAdversarial() {
  console.log("=== ADVERSARIAL: Delivery-default mis-fulfillment ===");
  console.log("Shop: Vito's Pizza — delivery_enabled=true\n");
  const sid = `qa-adv-del-${Date.now()}`;

  // Turn 1: Simple order — bot should add item and ask pickup vs delivery
  let r = await chat(VITOS, "I'd like a large cheese pizza please", sid);
  let currentSid = r.session_id || sid;
  console.log(`T1 (order): ${(r.reply||"").slice(0,200)}`);

  let cart = await getCart(currentSid);
  console.log(`  → cart: phase=${cart?.phase} order_type=${cart?.order_type} items=${cart?.['cart_json'] ? JSON.stringify(cart['cart_json']).slice(0,100) : 'none'}`);

  // Turn 2: Question about item — ignores delivery question
  r = await chat(VITOS, "Is it thin crust?", currentSid);
  currentSid = r.session_id || currentSid;
  console.log(`\nT2 (evade #1): ${(r.reply||"").slice(0,200)}`);

  cart = await getCart(currentSid);
  console.log(`  → cart: phase=${cart?.phase} order_type=${cart?.order_type}`);

  // Turn 3: "Sounds good, just that for now" — ignores delivery question AGAIN
  r = await chat(VITOS, "Sounds good, just that for now", currentSid);
  currentSid = r.session_id || currentSid;
  console.log(`\nT3 (evade #2): ${(r.reply||"").slice(0,200)}`);

  cart = await getCart(currentSid);
  console.log(`  → cart: phase=${cart?.phase} order_type=${cart?.order_type}`);

  // Turn 4: "Jason" — C2 name shortcut. Delivery question was never answered.
  // The C2 shortcut+default should trigger here.
  r = await chat(VITOS, "Jason", currentSid);
  console.log(`\nT4 (Jason name — C2 shortcut trigger): ${(r.reply||"").slice(0,300)}`);

  cart = await getCart(r.session_id || currentSid);
  if (!cart) {
    console.log("\n❌ NO CART FOUND");
    return false;
  }
  
  console.log(`\n  FINAL CART STATE:`);
  console.log(`  order_type: "${cart.order_type}"`);
  console.log(`  phase: "${cart.phase}"`);
  console.log(`  pickup_name: "${cart.pickup_name}"`);
  console.log(`  total_cents: ${cart.total_cents}`);
  console.log(`  stripe_session: ${!!cart.stripe_checkout_session_id}`);
  console.log(`  delivery_address: "${cart.delivery_address}"`);

  // VERDICT: If order_type is "pickup" and we reached a confirmed/checkout state,
  // that's the bug: customer never chose pickup, delivery was available & asked.
  if (cart.order_type === "pickup" && (cart.phase === "checkout" || cart.phase === "confirmed")) {
    console.log("\n❌ FAIL: MIS-FULFILLMENT CONFIRMED");
    console.log(`   Customer NEVER said "pickup" but order_type="${cart.order_type}"`);
    console.log(`   Bot asked delivery question but C2 defaulted to pickup on name turn.`);
    return false;
  }

  if (cart.order_type === "delivery") {
    console.log("\n✅ PASS: Order correctly set to delivery");
    return true;
  }

  if (cart.order_type === "pickup" && cart.phase !== "checkout" && cart.phase !== "confirmed") {
    console.log(`\n⚠️  UNCLEAR: order_type=pickup but phase=${cart.phase} (not finalized)`);
    console.log(`   Bot may still be waiting for delivery/pickup choice.`);
    return false; // Still a fail — if delivery was offered, default shouldn't be pickup
  }

  console.log(`\n⚠️  UNEXPECTED: order_type=${cart.order_type} phase=${cart.phase}`);
  return false;
}

const passed = await runAdversarial();
Deno.exit(passed ? 0 : 1);