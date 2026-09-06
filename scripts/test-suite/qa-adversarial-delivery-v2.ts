#!/usr/bin/env deno run --allow-net --allow-env
/**
 * qa-adversarial-delivery-v2.ts — Test C2 delivery-default mis-fulfillment 
 * against Zio's Pizzeria (delivery_enabled=true + geo coordinates).
 */

const SKEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI";
const SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co";
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const H = { "Authorization": `Bearer ${SKEY}`, "apikey": SKEY, "Content-Type": "application/json" };

const ZIOS = "2cba7b51-211c-4437-8910-1af4dcc03498";

async function chat(shop: string, msg: string, sid: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST", headers: H,
    body: JSON.stringify({ shop_id: shop, message: msg, session_id: sid, test: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCart(sid: string) {
  const cRes = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?session_id=eq.${encodeURIComponent(sid)}&select=id&order=started_at.desc&limit=1`,
    { headers: H }
  );
  if (!cRes.ok) return null;
  const convs = await cRes.json();
  if (!convs.length) return null;
  const oRes = await fetch(
    `${SUPABASE_URL}/rest/v1/order_carts?conversation_id=eq.${convs[0].id}&select=*&order=created_at.desc&limit=1`,
    { headers: H }
  );
  if (!oRes.ok) return null;
  const carts = await oRes.json();
  return carts[0] || null;
}

// ── CRITERION 2: Adversarial delivery-default ──────────────────────
async function testDeliveryDefault() {
  console.log("=== CRITERION 2: Delivery-default mis-fulfillment ===");
  console.log("Shop: Zio's Pizzeria (delivery_enabled=true, geo=present)\n");
  const sid = `qa-adv-del2-${Date.now()}`;

  // T1: Order an item (bot SHOULD add item + ask pickup or delivery)
  let r = await chat(ZIOS, "I'd like a large cheese pizza please", sid);
  let cur = r.session_id || sid;
  console.log(`T1: ${(r.reply||"").slice(0,250)}`);

  let cart = await getCart(cur);
  console.log(`  cart: phase=${cart?.phase} type=${cart?.order_type}\n`);

  // T2: Evade delivery question — ask about item instead
  r = await chat(ZIOS, "Is it thin crust?", cur);
  cur = r.session_id || cur;
  console.log(`T2 (evade #1): ${(r.reply||"").slice(0,250)}`);
  cart = await getCart(cur);
  console.log(`  cart: phase=${cart?.phase} type=${cart?.order_type}\n`);

  // T3: Evade delivery question AGAIN
  r = await chat(ZIOS, "Sounds good, just that for now", cur);
  cur = r.session_id || cur;
  console.log(`T3 (evade #2): ${(r.reply||"").slice(0,250)}`);
  cart = await getCart(cur);
  console.log(`  cart: phase=${cart?.phase} type=${cart?.order_type}\n`);

  // T4: Name turn — C2 shortcut + default pickup trigger
  r = await chat(ZIOS, "Jason", cur);
  cur = r.session_id || cur;
  console.log(`T4 (Jason — C2): ${(r.reply||"").slice(0,300)}`);

  cart = await getCart(cur);
  if (!cart) { console.log("❌ No cart"); return false; }

  console.log(`\nFINAL: order_type="${cart.order_type}" phase="${cart.phase}"`);
  console.log(`  pickup_name="${cart.pickup_name}" total=${cart.total_cents} stripe=${!!cart.stripe_checkout_session_id}`);

  const isPickupFinalized = cart.order_type === "pickup"
    && (cart.phase === "checkout" || cart.phase === "confirmed");

  if (isPickupFinalized) {
    console.log("\n❌ FAIL: MIS-FULFILLMENT. Customer never chose pickup but order submitted as pickup.");
    return false;
  }

  if (cart.order_type === "delivery") {
    console.log("\n✅ PASS: Order correctly set to delivery");
    return true;
  }

  console.log(`\n⚠️  UNCLEAR: type=${cart.order_type} phase=${cart.phase}`);
  return false;
}

// ── CRITERION 3: When customer EXPLICITLY says "delivery" ──────────────
async function testExplicitDelivery() {
  console.log("\n=== CRITERION 3: Explicit delivery NOT overridden ===");
  const sid = `qa-adv-del3-${Date.now()}`;

  let r = await chat(ZIOS, "I'd like a large cheese pizza for delivery please", sid);
  let cur = r.session_id || sid;
  console.log(`T1 (delivery): ${(r.reply||"").slice(0,250)}`);

  let cart = await getCart(cur);
  console.log(`  cart: type=${cart?.order_type}\n`);

  if (cart?.order_type !== "delivery") {
    console.log("❌ FAIL: Delivery not recognized on T1");
    return false;
  }

  // Add address
  r = await chat(ZIOS, "123 Main St, Philadelphia PA 19103", cur);
  cur = r.session_id || cur;
  console.log(`T2 (address): ${(r.reply||"").slice(0,250)}`);

  r = await chat(ZIOS, "yes", cur);
  cur = r.session_id || cur;
  console.log(`T3 (yes): ${(r.reply||"").slice(0,250)}`);

  cart = await getCart(cur);
  console.log(`  cart: type=${cart?.order_type} phase=${cart?.phase}\n`);

  if (cart?.order_type === "delivery") {
    console.log("✅ PASS: Delivery preserved across 3 turns");
    return true;
  }
  console.log(`❌ FAIL: order_type changed to "${cart?.order_type}"`);
  return false;
}

// ── Run ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
if (await testDeliveryDefault()) pass++; else fail++;
if (await testExplicitDelivery()) pass++; else fail++;

console.log(`\n${pass} PASS, ${fail} FAIL, ${pass+fail} TOTAL`);
Deno.exit(fail > 0 ? 1 : 0);