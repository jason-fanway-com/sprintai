#!/usr/bin/env deno run --allow-net --allow-env
/**
 * verify-cart-fix.ts — Replay Jason's exact failing flow against LIVE chat-sms
 * and assert cart integrity at each step by reading order_carts.cart_json from DB.
 */

const SUPABASE_URL = "https://rvdqfxtrskxekfkqnegx.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDc0ODY4OSwiZXhwIjoyMDkwMzI0Njg5fQ.18IySZjyLd2KPNxJSDq--UMvICqbTbjMM1ZC5J-g9oI";
const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat-sms`;
const SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498"; // Zio's Pizzeria

const H = { "Authorization": `Bearer ${SUPABASE_KEY}`, "apikey": SUPABASE_KEY };

async function sq(table: string, qs: string) {
  const url = qs ? `${SUPABASE_URL}/rest/v1/${table}?${qs}` : `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) { const t = await res.text(); throw new Error(`${table}: ${res.status} ${t.slice(0,300)}`); }
  return res.json();
}

async function sendChat(shopId: string, message: string, sessionId: string) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...H },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`chat: ${res.status} ${t.slice(0,500)}`); }
  return res.json();
}

async function getCart(sessionId: string) {
  const convs = await sq("conversations", `session_id=eq.${sessionId}&select=id&order=started_at.desc&limit=1`);
  console.log(`   [dbg] convs found: ${convs.length}  ${convs.length ? `id=${convs[0].id}` : "NONE"}`);
  if (!convs.length) return null;
  const carts = await sq("order_carts", `conversation_id=eq.${convs[0].id}&select=cart_json,phase,total_cents,subtotal_cents,tax_cents,stripe_checkout_session_id,driver_tip_cents,delivery_fee_cents&order=created_at.desc&limit=1`);
  console.log(`   [dbg] carts found: ${carts.length}  phase=${carts[0]?.phase}  cart_json_len=${JSON.stringify(carts[0]?.cart_json)?.length || 0}`);
  return carts[0] || null;
}

function assertEqual<T>(label: string, actual: T, expected: T): boolean {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}: ${label}`);
  if (!ok) console.log(`     Expected: ${JSON.stringify(expected)}\n     Actual:   ${JSON.stringify(actual)}`);
  return ok;
}

const $ = (r: string) => { const m = r.match(/\$(\d+\.\d{2})/); return m ? Math.round(parseFloat(m[1]) * 100) : null; };
const pl = (r: string) => { const m = r.match(/https:\/\/checkout\.stripe\.com\/[^\s\)]+/); return m ? m[0] : null; };

const items = (cj: any) => Array.isArray(cj) ? cj : (cj?.lines || cj?.items || []);
const iName = (i: any) => (i.name || i.label || "?").toLowerCase();
const iQty = (i: any) => i.quantity || 1;
const iPrice = (i: any) => i.unit_price_cents || i.price_cents || 0;
const isPizza = (i: any) => { const n = iName(i); return n.includes("pizza")||n.includes("cheese")||n.includes("neapolitan")||n.includes("sicilian")||n.includes("grandma"); };
const pizzaLines = (cj: any) => items(cj).filter(isPizza).length;
const pizzaQty = (cj: any) => items(cj).filter(isPizza).reduce((s:number,i:any)=>s+iQty(i),0);
const cartNames = (cj: any) => items(cj).map((i:any)=>`${i.name||i.label||"?"} x${iQty(i)}`).join(", ");
const tipC = (c: any): number | null => c?.driver_tip_cents || null;
const sumL = (cj: any) => items(cj).reduce((s:number,i:any)=>s+iPrice(i)*iQty(i),0);

// ── MAIN ──────────────────────────────────────────────────────────────────

console.log("=== Cart Integrity Verification — Zio's Pizzeria ===\n");

let sessionId = `vrf-${Date.now()}`;
let allOk = true;

async function step(msg: string) {
  const r = await sendChat(SHOP_ID, msg, sessionId);
  // Use session_id from response if present
  if (r.session_id) sessionId = r.session_id;
  console.log(`   [using session_id: ${sessionId}]`);
  return r;
}

// 1-5: Build the Neapolitan pizza
console.log("1. 'needs some pizza'");
let r = await step("needs some pizza");
console.log(`   Bot: ${r.reply?.slice(0,150)}...`);

console.log("\n2. 'delivery'");
r = await step("delivery");
console.log(`   Bot: ${r.reply?.slice(0,150)}...`);

console.log("\n3. Address");
r = await step("5620 Cetronia Rd, Allentown 18106");
console.log(`   Bot: ${r.reply?.slice(0,200)}...`);

console.log("\n4. '1 large cheese pizza'");
r = await step("1 large cheese pizza");
console.log(`   Bot: ${r.reply?.slice(0,200)}...`);

console.log("\n5. 'Neapolitan' (explicit style)");
r = await step("Neapolitan");
console.log(`   Bot: ${r.reply?.slice(0,250)}...`);

let cart = await getCart(sessionId);
console.log(`   phase=${cart?.phase}  items=[${cartNames(cart?.cart_json)}]`);
console.log(`   pizzas: ${pizzaLines(cart?.cart_json)} lines, ${pizzaQty(cart?.cart_json)} qty`);
allOk = assertEqual("Step 5: ONE pizza line", pizzaLines(cart?.cart_json), 1) && allOk;

// 6: $2 tip
console.log("\n6. '$2' driver tip");
r = await step("$2");
console.log(`   Bot: ${r.reply?.slice(0,200)}...`);
cart = await getCart(sessionId);
console.log(`   items=[${cartNames(cart?.cart_json)}]  tip_cents=${tipC(cart)}`);
console.log(`   pizzas: ${pizzaLines(cart?.cart_json)} lines, ${pizzaQty(cart?.cart_json)} qty`);
allOk = assertEqual("BUG1: pizza lines==1 after tip", pizzaLines(cart?.cart_json), 1) && allOk;
allOk = assertEqual("BUG1: pizza qty==1 after tip", pizzaQty(cart?.cart_json), 1) && allOk;
allOk = assertEqual("tip_cents==200", tipC(cart), 200) && allOk;

// 7: wings
console.log("\n7. 'bone in hot wings'");
r = await step("bone in hot wings");
console.log(`   Bot: ${r.reply?.slice(0,200)}...`);
cart = await getCart(sessionId);
console.log(`   items=[${cartNames(cart?.cart_json)}]`);

// 8: correction
console.log("\n8. Correction: 'wait, why 2x pizza? I just want one'");
r = await step("wait, why 2x pizza? I just want one");
console.log(`   Bot: ${r.reply?.slice(0,300)}...`);
cart = await getCart(sessionId);
console.log(`   items=[${cartNames(cart?.cart_json)}]`);
console.log(`   pizzas: ${pizzaLines(cart?.cart_json)} lines, ${pizzaQty(cart?.cart_json)} qty`);
console.log(`   raw cart_json: ${JSON.stringify(cart?.cart_json).slice(0,600)}`);
allOk = assertEqual("BUG2: pizza lines==1", pizzaLines(cart?.cart_json), 1) && allOk;
allOk = assertEqual("BUG2: pizza qty==1", pizzaQty(cart?.cart_json), 1) && allOk;

// 9: name → order submit
console.log("\n9. Name: 'jason'");
r = await step("jason");
console.log(`   Bot: ${r.reply?.slice(0,600)}...`);

const qt = $(r.reply||"");
const link = pl(r.reply||"");
console.log(`   Quoted total: ${qt} cents  Pay link: ${link}`);

cart = await getCart(sessionId);
const itemsT = sumL(cart?.cart_json);
const tip = tipC(cart)||0;
const delFee = cart?.delivery_fee_cents || 499;
const fee = 99;
const exp = itemsT + tip + delFee + fee;
console.log(`   DB total=${cart?.total_cents}  items=${itemsT} tip=${tip} del=${delFee} fee=${fee}  computed=${exp}`);

allOk = assertEqual("Step9: total_cents==computed", cart?.total_cents, exp) && allOk;
if (qt !== null) {
  allOk = assertEqual("Step9: quoted==DB total_cents", qt, cart?.total_cents) && allOk;
}
if (cart?.stripe_checkout_session_id) {
  console.log(`   Stripe session: ${cart.stripe_checkout_session_id} (verify manually)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEPARATE: Correction path 2x → 1x
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n═══ Separate Correction Test (2x → 1x) ═══\n");
let s2 = `vrf-2x-${Date.now()}`;

async function step2(msg: string) {
  const r = await sendChat(SHOP_ID, msg, s2);
  if (r.session_id) s2 = r.session_id;
  console.log(`   [s2: ${s2}]`);
  return r;
}

console.log("1. delivery");
r = await step2("delivery");
console.log(`   Bot: ${r.reply?.slice(0,150)}...`);
console.log("2. address");
r = await step2("123 Main St, Allentown 18106");
console.log(`   Bot: ${r.reply?.slice(0,150)}...`);
console.log("3. '2 large cheese pizzas'");
r = await step2("2 large cheese pizzas");
console.log(`   Bot: ${r.reply?.slice(0,250)}...`);
// Handle style
if (r.reply?.toLowerCase().includes("neapolitan") || r.reply?.toLowerCase().includes("sicilian")) {
  console.log("   → selecting 'Neapolitan'");
  r = await step2("Neapolitan");
  console.log(`   Bot: ${r.reply?.slice(0,250)}...`);
}

cart = await getCart(s2);
console.log(`   BEFORE correction: [${cartNames(cart?.cart_json)}] qty=${pizzaQty(cart?.cart_json)}`);

console.log("\n4. Correct: 'actually just want one pizza'");
r = await step2("actually just want one pizza");
console.log(`   Bot: ${r.reply?.slice(0,300)}...`);

cart = await getCart(s2);
console.log(`   AFTER correction: [${cartNames(cart?.cart_json)}] qty=${pizzaQty(cart?.cart_json)}`);
const ct = $(r.reply||"");
console.log(`   Quoted total: ${ct}`);
allOk = assertEqual("Corr test: pizza lines==1", pizzaLines(cart?.cart_json), 1) && allOk;
allOk = assertEqual("Corr test: pizza qty==1", pizzaQty(cart?.cart_json), 1) && allOk;

console.log("\n5. Name: 'john'");
r = await step2("john");
console.log(`   Bot: ${r.reply?.slice(0,350)}...`);
const ft = $(r.reply||"");
cart = await getCart(s2);
console.log(`   Final: total=${cart?.total_cents}, items=[${cartNames(cart?.cart_json)}]`);
console.log(`   Quoted final: ${ft}`);

// ── SUMMARY ───────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════");
console.log(allOk ? "✅ ALL CART INTEGRITY CHECKS PASSED" : "❌ SOME CHECKS FAILED");
console.log("═══════════════════════════════════════");
Deno.exit(allOk ? 0 : 1);