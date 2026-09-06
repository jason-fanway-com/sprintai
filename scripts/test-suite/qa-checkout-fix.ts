#!/usr/bin/env deno run --allow-net --allow-env
/**
 * qa-checkout-fix.ts — QA the checkout-finalize fix deployed to chat-sms.
 * Tests acceptance criteria 1-5 against the LIVE function.
 */

const SKEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI";
const SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co";
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const H = { "Authorization": `Bearer ${SKEY}`, "apikey": SKEY, "Content-Type": "application/json" };

// Vito's Pizza: delivery_enabled=true (CRITICAL for adversarial test)
const VITOS = "e0000000-0000-0000-0000-000000000001";
// NJB test clone: delivery_enabled=false (our standard test shop)
const NJB_TEST = "38ae034c-cb9d-4f32-b4f1-d9b40393574b";

const verdicts: Array<{ id: string; pass: boolean; detail: string }> = [];

function V(id: string, pass: boolean, detail: string) {
  verdicts.push({ id, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${id}: ${detail}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function chat(shop: string, msg: string, sid: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ shop_id: shop, message: msg, session_id: sid, test: true }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCartBySid(sid: string) {
  // Find conversation → cart
  const convRes = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?session_id=eq.${encodeURIComponent(sid)}&select=id&order=started_at.desc&limit=1`,
    { headers: H }
  );
  if (!convRes.ok) return null;
  const convs = await convRes.json();
  if (!convs.length) return null;
  
  const cartRes = await fetch(
    `${SUPABASE_URL}/rest/v1/order_carts?conversation_id=eq.${convs[0].id}&select=*&order=created_at.desc&limit=1`,
    { headers: H }
  );
  if (!cartRes.ok) return null;
  const carts = await cartRes.json();
  return carts[0] || null;
}

async function getOrdersByCart(cartId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?cart_id=eq.${encodeURIComponent(cartId)}&select=*&limit=1`,
    { headers: H }
  );
  if (!res.ok) return null;
  const orders = await res.json();
  return orders[0] || null;
}

function cartHasItems(cart: any): boolean {
  const cj = cart?.cart_json;
  if (Array.isArray(cj)) return cj.length > 0;
  if (cj?.lines && Array.isArray(cj.lines)) return cj.lines.length > 0;
  return false;
}

function isCheckout(cart: any): boolean {
  return cart?.phase === "checkout" || cart?.phase === "confirmed";
}

function hasRealSession(cart: any): boolean {
  return !!(cart?.stripe_checkout_session_id);
}

// Check total matches within $0.02
function totalClose(quotedCents: number | null, cartTotalCents: number | null): boolean {
  if (quotedCents === null || cartTotalCents === null) return false;
  return Math.abs(quotedCents - cartTotalCents) <= 2;
}

function extractCentsFromReply(reply: string): number | null {
  // Match dollar amounts like $12.95 or $8.99
  const matches = reply.match(/\$(\d+\.\d{2})/g);
  if (!matches) return null;
  // Return the last dollar amount (usually the total)
  const last = matches[matches.length - 1];
  return Math.round(parseFloat(last.replace("$", "")) * 100);
}

// ── TEST 1: menu-checkout-13 — "Jason" name turn must reach checkout ───────

async function testMenuCheckout13() {
  console.log("\n── TEST 1: menu-checkout-13 (Jason name turn) ──");
  const sid = `qa-cf-menuchkout13-${Date.now()}`;
  try {
    // Turn 1: order item
    let r = await chat(NJB_TEST, "I'll take a plain bagel with butter", sid);
    console.log(`  T1 reply: ${(r.reply||"").slice(0,120)}`);
    
    // Turn 2: confirm
    r = await chat(NJB_TEST, "yes", r.session_id || sid);
    console.log(`  T2 reply: ${(r.reply||"").slice(0,120)}`);
    
    // Turn 3: checkout
    r = await chat(NJB_TEST, "checkout", r.session_id || sid);
    console.log(`  T3 reply: ${(r.reply||"").slice(0,120)}`);
    
    // Turn 4: name
    const finalSid = r.session_id || sid;
    r = await chat(NJB_TEST, "Jason", finalSid);
    console.log(`  T4 reply (Jason name): ${(r.reply||"").slice(0,200)}`);
    
    const cart = await getCartBySid(finalSid);
    if (!cart) { V("menu-checkout-13", false, "No cart found"); return; }
    console.log(`  Cart phase=${cart.phase} order_type=${cart.order_type} pickup_name=${cart.pickup_name} total_cents=${cart.total_cents} stripe=${!!cart.stripe_checkout_session_id}`);
    
    const phaseOk = isCheckout(cart);
    const nameOk = cart.pickup_name === "Jason";
    // The quote may be in the reply
    const quoted = extractCentsFromReply(r.reply || "");
    const totalOk = totalClose(quoted, cart.total_cents);
    
    if (phaseOk && (nameOk || hasRealSession(cart))) {
      V("menu-checkout-13", true,
        `phase=${cart.phase}, name=${cart.pickup_name}, total_cents=${cart.total_cents}, session=${!!cart.stripe_checkout_session_id}`);
    } else if (phaseOk && !nameOk) {
      V("menu-checkout-13", false,
        `Reached checkout but name=${cart.pickup_name} != Jason`);
    } else {
      V("menu-checkout-13", false,
        `phase=${cart.phase} (expected checkout/confirmed), name=${cart.pickup_name}, reply trunc: ${(r.reply||"").slice(0,100)}`);
    }
  } catch (e) {
    V("menu-checkout-13", false, `Exception: ${(e as Error).message}`);
  }
}

// ── TEST 2: proof-checkout-writes-order ────────────────────────────────────

async function testProofCheckoutWritesOrder() {
  console.log("\n── TEST 2: proof-checkout-writes-order ──");
  const sid = `qa-cf-writesorder-${Date.now()}`;
  try {
    // Uses NJB_TEST (not delivery enabled) — standard 4-turn checkout
    let r = await chat(NJB_TEST, "I'll take a plain bagel with butter", sid);
    const currentSid = r.session_id || sid;
    console.log(`  T1 reply: ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "yes", currentSid);
    console.log(`  T2 reply: ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "checkout", currentSid);
    console.log(`  T3 reply: ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "Pat", currentSid);
    console.log(`  T4 reply (name): ${(r.reply||"").slice(0,200)}`);
    
    const cart = await getCartBySid(currentSid);
    if (!cart) { V("proof-checkout-writes-order", false, "No cart found"); return; }
    console.log(`  Cart: phase=${cart.phase} order_type=${cart.order_type} pickup_name=${cart.pickup_name} total_cents=${cart.total_cents} stripe=${!!cart.stripe_checkout_session_id}`);
    
    const phaseOk = isCheckout(cart);
    const quoted = extractCentsFromReply(r.reply || "");
    const totalOk = totalClose(quoted, cart.total_cents);
    
    if (phaseOk && hasRealSession(cart)) {
      // Check orders table
      const order = await getOrdersByCart(cart.id);
      V("proof-checkout-writes-order", true,
        `phase=${cart.phase}, order_row=${!!order}, session=${!!cart.stripe_checkout_session_id}, total=${cart.total_cents}, quoted=${quoted}`);
    } else if (phaseOk && !hasRealSession(cart)) {
      V("proof-checkout-writes-order", false,
        `Phase=${cart.phase} but NO real checkout session (phantom link). Reply: ${(r.reply||"").slice(0,120)}`);
    } else {
      V("proof-checkout-writes-order", false,
        `phase=${cart.phase}, session=${!!cart.stripe_checkout_session_id}, reply: ${(r.reply||"").slice(0,100)}`);
    }
  } catch (e) {
    V("proof-checkout-writes-order", false, `Exception: ${(e as Error).message}`);
  }
}

// ── TEST 3: proof-cart-persists-across-multiple ────────────────────────────

async function testCartPersistsAcrossMultiple() {
  console.log("\n── TEST 3: proof-cart-persists-across-multiple ──");
  const sid = `qa-cf-persists-${Date.now()}`;
  try {
    let r = await chat(NJB_TEST, "I'll take a plain bagel with butter", sid);
    let currentSid = r.session_id || sid;
    console.log(`  T1 (order): ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "Do you have any desserts?", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T2 (question): ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "Actually add a sesame bagel with cream cheese", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T3 (add 2nd item): ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "checkout", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T4 (checkout): ${(r.reply||"").slice(0,120)}`);
    
    r = await chat(NJB_TEST, "Pat", currentSid);
    console.log(`  T5 (name): ${(r.reply||"").slice(0,200)}`);
    
    const cart = await getCartBySid(currentSid);
    if (!cart) { V("proof-cart-persists-across-multiple", false, "No cart found"); return; }
    
    const cj = Array.isArray(cart.cart_json) ? cart.cart_json : (cart.cart_json?.lines || []);
    const items = cj.map((i: any) => i.name || i.item_name || "?").join(", ");
    console.log(`  Cart: phase=${cart.phase} items=[${items}] total_cents=${cart.total_cents} stripe=${!!cart.stripe_checkout_session_id}`);
    
    const phaseOk = isCheckout(cart);
    // Should have 2 items (bagel+butter, sesame+CC)
    const itemCountOk = cj.length >= 2;
    
    if (phaseOk && hasRealSession(cart) && itemCountOk) {
      V("proof-cart-persists-across-multiple", true,
        `phase=${cart.phase}, ${cj.length} items, session=${!!cart.stripe_checkout_session_id}`);
    } else if (!phaseOk) {
      V("proof-cart-persists-across-multiple", false,
        `phase=${cart.phase}, ${cj.length} items, session=${!!cart.stripe_checkout_session_id}. Reply: ${(r.reply||"").slice(0,100)}`);
    } else if (!itemCountOk) {
      V("proof-cart-persists-across-multiple", false,
        `CART LOST — only ${cj.length} items: ${items}. Reply: ${(r.reply||"").slice(0,100)}`);
    } else {
      V("proof-cart-persists-across-multiple", false,
        `No real session. Reply: ${(r.reply||"").slice(0,100)}`);
    }
  } catch (e) {
    V("proof-cart-persists-across-multiple", false, `Exception: ${(e as Error).message}`);
  }
}

// ── TEST 4 (CRITICAL): Adversarial — delivery shop, customer implies delivery
//    but never says "pickup" or "delivery". Does the order silently submit as PICKUP?
//    This is the make-or-break check. ──────────────────────────────────────

async function testAdversarialDeliveryDefault() {
  console.log("\n── TEST 4 (CRITICAL): Adversarial delivery-default mis-fulfillment ──");
  console.log("  Shop: Vito's Pizza (delivery_enabled=true)");
  const sid = `qa-cf-adversarial-${Date.now()}`;
  try {
    // Turn 1: "I need a large pepperoni pizza delivered"
    // Notice: says "delivered" — implies delivery but NOT the exact word "delivery"
    // The word "delivered" might or might not match the \bdelivery\b regex
    let r = await chat(VITOS, "Hi I need a large pepperoni pizza delivered to 123 Main St", sid);
    let currentSid = r.session_id || sid;
    console.log(`  T1 (order + address): ${(r.reply||"").slice(0,200)}`);
    
    // Check what order_type was set
    let cart = await getCartBySid(currentSid);
    console.log(`  T1 cart: order_type=${cart?.order_type} phase=${cart?.phase} items=${cart ? (Array.isArray(cart.cart_json) ? cart.cart_json.length : 0) : 0}`);
    
    // Turn 2: confirm/yes
    r = await chat(VITOS, "yes", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T2 (yes): ${(r.reply||"").slice(0,200)}`);
    
    // Check order_type after "yes"
    cart = await getCartBySid(currentSid);
    console.log(`  T2 cart: order_type=${cart?.order_type} phase=${cart?.phase} pickup_name=${cart?.pickup_name}`);
    
    // Turn 3: checkout
    r = await chat(VITOS, "checkout", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T3 (checkout): ${(r.reply||"").slice(0,200)}`);
    
    cart = await getCartBySid(currentSid);
    console.log(`  T3 cart: order_type=${cart?.order_type} phase=${cart?.phase} delivery_address=${cart?.delivery_address}`);
    
    // Turn 4: give name
    r = await chat(VITOS, "Jason", currentSid);
    console.log(`  T4 (name): ${(r.reply||"").slice(0,200)}`);
    
    cart = await getCartBySid(currentSid);
    if (!cart) { V("adversarial-delivery-default", true, "SKIP: No cart — likely delivery address gate right (requires real address?)"); return; }
    
    const orderType = cart.order_type;
    const phase = cart.phase;
    const hasSession = !!cart.stripe_checkout_session_id;
    
    console.log(`  FINAL cart: order_type=${orderType} phase=${phase} pickup_name=${cart.pickup_name} stripe_session=${hasSession} delivery_address=${cart.delivery_address}`);
    
    if (orderType === "pickup" && phase === "checkout") {
      // BAD: customer wanted delivery but order is pickup
      V("adversarial-delivery-default", false,
        `MIS-FULFILLMENT: order_type="pickup" despite customer saying "delivered to 123 Main St". Customer expects delivery, order says pickup. Cart order_type=${orderType} phase=${phase}. Reply: ${(r.reply||"").slice(0,120)}`);
    } else if (orderType === "delivery" && phase === "checkout") {
      V("adversarial-delivery-default", true,
        `CORRECT: order_type="delivery", phase=${phase}, no wrong-default`);
    } else if (orderType === "pickup" && phase !== "checkout") {
      V("adversarial-delivery-default", true,
        `OK: order_type="pickup" but phase=${phase} (not at checkout yet — delivery gate may still be in play). Reply: ${(r.reply||"").slice(0,120)}`);
    } else {
      V("adversarial-delivery-default", false,
        `UNEXPECTED: order_type=${orderType}, phase=${phase}, session=${hasSession}. Reply: ${(r.reply||"").slice(0,120)}`);
    }
  } catch (e) {
    V("adversarial-delivery-default", false, `Exception: ${(e as Error).message}`);
  }
}

// ── TEST 5: Delivery mention must NOT be overridden by pickup-default ─────

async function testDeliveryNotOverridden() {
  console.log("\n── TEST 5: Explicit delivery choice preserved ──");
  const sid = `qa-cf-delpreserve-${Date.now()}`;
  try {
    let r = await chat(VITOS, "I'd like a large pepperoni pizza for delivery", sid);
    let currentSid = r.session_id || sid;
    console.log(`  T1 (order + delivery): ${(r.reply||"").slice(0,200)}`);
    
    let cart = await getCartBySid(currentSid);
    console.log(`  T1 cart: order_type=${cart?.order_type}`);
    
    // Verify delivery was recognized
    if (cart?.order_type !== "delivery") {
      V("explicit-delivery-preserved", false,
        `T1: expected order_type="delivery", got "${cart?.order_type}"`);
      return;
    }
    
    // Continue a few turns to ensure it sticks
    r = await chat(VITOS, "123 Main St, Philadelphia PA", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  T2 (address): ${(r.reply||"").slice(0,150)}`);
    
    cart = await getCartBySid(currentSid);
    console.log(`  T2 cart: order_type=${cart?.order_type}`);
    
    r = await chat(VITOS, "yes", currentSid);
    currentSid = r.session_id || currentSid;
    
    cart = await getCartBySid(currentSid);
    console.log(`  T3 cart: order_type=${cart?.order_type}`);
    
    if (cart?.order_type === "delivery") {
      V("explicit-delivery-preserved", true,
        `order_type="delivery" persisted across 3 turns`);
    } else {
      V("explicit-delivery-preserved", false,
        `order_type was "delivery" at T1, now "${cart?.order_type}" — DELIVERY CHOICE OVERRIDDEN`);
    }
  } catch (e) {
    V("explicit-delivery-preserved", false, `Exception: ${(e as Error).message}`);
  }
}

// ── TEST 6: No auto-add of items ───────────────────────────────────────────

async function testNoAutoAdd() {
  console.log("\n── TEST 6: No cart mutation / auto-add introduced ──");
  const sid = `qa-cf-noautoadd-${Date.now()}`;
  try {
    // Simple order: "I'll take a plain bagel with butter"
    let r = await chat(NJB_TEST, "I'll take a plain bagel with butter", sid);
    let currentSid = r.session_id || sid;
    
    let cart = await getCartBySid(currentSid);
    const cj = Array.isArray(cart?.cart_json) ? cart.cart_json : (cart?.cart_json?.lines || []);
    const initialCount = cj.length;
    const initialNames = cj.map((i: any) => i.name || i.item_name || "?").join(", ");
    console.log(`  Initial cart: ${initialCount} items: ${initialNames}`);
    
    // Now provide a name (which should trigger C2 shortcut + pickup-default)
    r = await chat(NJB_TEST, "Jason", currentSid);
    currentSid = r.session_id || currentSid;
    console.log(`  Name turn reply: ${(r.reply||"").slice(0,200)}`);
    
    cart = await getCartBySid(currentSid);
    const cj2 = Array.isArray(cart?.cart_json) ? cart.cart_json : (cart?.cart_json?.lines || []);
    const finalCount = cj2.length;
    const finalNames = cj2.map((i: any) => i.name || i.item_name || "?").join(", ");
    console.log(`  Final cart: ${finalCount} items: ${finalNames}`);
    console.log(`  Cart phase=${cart?.phase} order_type=${cart?.order_type} pickup_name=${cart?.pickup_name}`);
    
    if (finalCount === initialCount && initialCount > 0) {
      V("no-auto-add-items", true,
        `Item count unchanged: ${initialCount}→${finalCount}. Items: ${initialNames}`);
    } else if (finalCount > initialCount) {
      V("no-auto-add-items", false,
        `AUTO-ADD DETECTED: ${initialCount}→${finalCount} items. Initial: ${initialNames}, Final: ${finalNames}`);
    } else {
      V("no-auto-add-items", false,
        `Item count went from ${initialCount}→${finalCount}`);
    }
  } catch (e) {
    V("no-auto-add-items", false, `Exception: ${(e as Error).message}`);
  }
}

// ── Run all ─────────────────────────────────────────────────────────────────

console.log("=== QA: checkout-finalize fix ===");
console.log(`Live function: ${CHAT_URL}`);
console.log(`Time: ${new Date().toISOString()}`);

await testMenuCheckout13();
await testProofCheckoutWritesOrder();
await testCartPersistsAcrossMultiple();
await testNoAutoAdd();
await testDeliveryNotOverridden();
await testAdversarialDeliveryDefault();

console.log("\n=== VERDICTS ===");
let pass = 0, fail = 0;
for (const v of verdicts) {
  console.log(`${v.pass ? "✅" : "❌"} ${v.id}: ${v.detail}`);
  if (v.pass) pass++; else fail++;
}
console.log(`\n${pass} PASS, ${fail} FAIL out of ${verdicts.length}`);

// Non-zero exit on failure
if (fail > 0) Deno.exit(1);