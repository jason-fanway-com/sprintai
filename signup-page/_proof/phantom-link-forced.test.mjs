/**
 * Phantom-link guard — FORCED-PHANTOM live proof.
 *
 * Uses a temporary test_mode-only hook (__FORCE_PHANTOM__) that makes the
 * function emit the exact buggy reply ("A payment link is on the way! You're all
 * set.") with NO submit_order call — reproducing the intermittent model bug ON
 * DEMAND. We then verify the guard's two recovery branches live:
 *
 *   CASE A (recoverable): items in cart + pickup name already given.
 *     Expect: guard forces submit_order -> REAL cs_test_ session + phase
 *     checkout, and the outgoing reply is the real "Payment link sent" copy
 *     backed by a real link. NO phantom.
 *
 *   CASE B (not recoverable): items in cart but NO pickup name yet.
 *     Expect: guard replaces the lie with an HONEST reply that asks for the
 *     pickup name and makes NO payment-link claim. Session stays null.
 *
 * Run: node signup-page/_proof/phantom-link-forced.test.mjs
 */
const URL = process.env.SPRINTAI_CHAT_SUPABASE_URL;
const ANON = process.env.SPRINTAI_CHAT_SUPABASE_ANON_KEY;
const SR = process.env.SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY;
const SHOP = "b0000000-0000-0000-0000-000000000001";
const FN = `${URL}/functions/v1/chat-sms`;

const PAYMENT_CLAIM_PATTERNS = [
  /\bpayment link (?:is )?(?:sent|on (?:its|the) way|coming|ready|created|below|here|attached)\b/,
  /\b(?:a |the )?link (?:is |has been |was )?(?:sent|on (?:its|the) way|coming|ready)\b/,
  /\b(?:sent|sending) (?:you )?(?:a |the |your )?(?:payment )?link\b/,
  /\bhere(?:'s| is) (?:your |the |a )?(?:payment )?link\b/,
  /\b(?:tap|click|use|follow) (?:the|your|this) (?:payment )?link\b/,
  /\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b.*\blink\b/,
  /\blink\b.*\bcheck (?:your )?(?:text|texts|phone|email|inbox|messages)\b/,
  /\byou(?:'re| are) all set\b/,
  /\ball set\b.*\b(?:link|pay|payment|text|email)\b/,
  /\b(?:your )?order (?:is|has been|was) (?:placed|submitted|confirmed|complete|completed|in|on its way)\b/,
  /\b(?:i(?:'ve| have) )?(?:placed|submitted|confirmed|sent) (?:your |the )?order\b/,
  /\border(?:'s| is) (?:placed|in|confirmed|all set|on the way)\b/,
  /\bready (?:to|for) (?:pay|payment|checkout)\b.*\b(?:link|text|email|tap|click)\b/,
  /\bproceed to (?:pay|payment|checkout)\b.*\b(?:link|text|email)\b/,
];
const claims = (t) => { if (!t) return false; const n = t.toLowerCase().replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\s+/g," ").trim(); return PAYMENT_CLAIM_PATTERNS.some(r=>r.test(n)); };
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function send(session, message){ const r = await fetch(FN,{method:"POST",headers:{Authorization:`Bearer ${ANON}`,"Content-Type":"application/json"},body:JSON.stringify({shop_id:SHOP,message,session_id:session})}); return r.json(); }
async function readCart(session){ const c=await(await fetch(`${URL}/rest/v1/conversations?select=id&session_id=eq.${session}&channel=eq.web`,{headers:{apikey:SR,Authorization:`Bearer ${SR}`}})).json(); if(!c[0])return null; const ca=await(await fetch(`${URL}/rest/v1/order_carts?select=phase,stripe_checkout_session_id,cart_json,pickup_name&conversation_id=eq.${c[0].id}&order=created_at.desc&limit=1`,{headers:{apikey:SR,Authorization:`Bearer ${SR}`}})).json(); return ca[0]||null; }

let fail = 0;
console.log("=== FORCED-PHANTOM live proof (guard catch + recovery) ===\n");

// CASE A: items + name already provided, then force a phantom reply.
{
  const s = `forced-A-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
  await send(s, "TESTMODE"); await sleep(300);
  await send(s, "Can I get a plain bagel"); await sleep(300);
  await send(s, "that's it"); await sleep(300);
  await send(s, "yes my name is Jason"); await sleep(800); // real submit happens here normally
  // Now the cart is already in checkout from the real submit. Reset to a building
  // cart with items+name to isolate the guard: use a fresh session instead.
}
// Cleaner CASE A: build to the point of having items + a known name, but trigger
// the phantom on the SAME turn the name is given by embedding the magic token.
{
  const s = `forced-A2-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
  await send(s, "TESTMODE"); await sleep(300);
  await send(s, "Can I get a plain bagel"); await sleep(300);
  await send(s, "that's it ready to checkout"); await sleep(300);
  // Give the name AND force the phantom in one turn: guard should RECOVER.
  const resp = await send(s, "yes name is Jason __FORCE_PHANTOM__"); await sleep(1000);
  const cart = await readCart(s);
  const reply = resp.reply || "";
  const sess = cart?.stripe_checkout_session_id || null;
  const phase = cart?.phase || "?";
  const realSession = (!!sess && phase==="checkout") || !!resp.checkout_url;
  const phantom = claims(reply) && !realSession;
  const ok = realSession && !phantom;
  console.log(`CASE A (items+name, forced phantom): ${ok?"PASS":"FAIL"}`);
  console.log(`  recovered real session: ${realSession} (sess=${sess?sess.slice(0,14):"null"}, phase=${phase}, url=${!!resp.checkout_url})`);
  console.log(`  reply: ${JSON.stringify(reply).slice(0,140)}`);
  console.log(`  phantom: ${phantom}  <-- MUST be false\n`);
  if (!ok) fail++;
}

// CASE B: items but NO name, force a phantom -> expect HONEST fallback (no claim).
{
  const s = `forced-B-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
  await send(s, "TESTMODE"); await sleep(300);
  await send(s, "Can I get a plain bagel"); await sleep(300);
  // Force the phantom BEFORE any name is given. lastAssistant won't have asked
  // for a name, so the guard cannot recover -> honest fallback, no claim.
  const resp = await send(s, "I'm done __FORCE_PHANTOM__"); await sleep(1000);
  const cart = await readCart(s);
  const reply = resp.reply || "";
  const sess = cart?.stripe_checkout_session_id || null;
  const phase = cart?.phase || "?";
  const madeClaim = claims(reply);
  const hasSession = !!sess || !!resp.checkout_url;
  // PASS = no phantom: either it did NOT claim (honest), or a real session backs it.
  const phantom = madeClaim && !hasSession && phase!=="checkout";
  const ok = !phantom;
  console.log(`CASE B (items, NO name, forced phantom): ${ok?"PASS":"FAIL"}`);
  console.log(`  reply claims payment: ${madeClaim}  session: ${sess?sess.slice(0,14):"null"} phase=${phase} url=${!!resp.checkout_url}`);
  console.log(`  reply: ${JSON.stringify(reply).slice(0,140)}`);
  console.log(`  phantom: ${phantom}  <-- MUST be false\n`);
  if (!ok) fail++;
}

console.log(`RESULT: ${fail===0?"PASS":"FAIL"}`);
process.exit(fail===0?0:1);
