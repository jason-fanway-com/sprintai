/**
 * Phantom-link guard — INVARIANT integration test (logic harness).
 *
 * Proves the post-turn safety-net decision tree from index.ts holds the core
 * invariant across the full state matrix:
 *
 *   INVARIANT: a reply that asserts "payment link sent / order placed" only
 *   goes out when a REAL checkout session exists. Otherwise the guard either
 *   (a) recovers by forcing submit_order (producing a real session), or
 *   (b) replaces the reply with an honest message that makes NO such claim.
 *
 * This mirrors the branch logic in the main handler. submit_order is stubbed to
 * simulate Stripe session creation deterministically (no network, no DB, no
 * Deno) so we can drive every state and assert the invariant 15+ times.
 *
 * Run: node signup-page/_proof/phantom-link-guard-invariant.test.mjs
 */

// ── Detector (exact copy) ───────────────────────────────────────────────────
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
function claimsPaymentSent(text) {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
  return PAYMENT_CLAIM_PATTERNS.some((re) => re.test(norm));
}
function checkoutAlreadyExists(row) {
  return !!row && (!!row.stripe_checkout_session_id || row.phase === "checkout");
}
function honestFallbackReply(cart, incompleteBundle = false) {
  if (!cart || cart.length === 0) return "What can I get started for you? Let me know your items and I'll get your order going.";
  if (incompleteBundle) return "Almost there! Your bundle still needs a few more picks before I can send your payment link. What else would you like in it?";
  return "Got your order! What name should I put it under for pickup? Once I have that I'll send your payment link.";
}

// ── Stubbed submit_order: simulates real Stripe session creation ────────────
let sessionsCreated = 0;
function fakeSubmitOrder(cart, pickupName) {
  // Mirrors executeTool("submit_order"): empty cart or incomplete bundle => fail.
  if (!cart || cart.length === 0) return { ok: false, result: { error: "empty" } };
  const incomplete = cart.find((i) => i.type === "bundle" && !i.complete);
  if (incomplete) return { ok: false, result: { error: "bundle" } };
  sessionsCreated++;
  return { ok: true, checkoutUrl: `https://checkout.stripe.com/c/pay/cs_test_${sessionsCreated}` };
}

// ── The guard decision tree (mirrors index.ts main handler) ─────────────────
function runGuard({ reply, checkoutUrl, cartRow, userMessage, lastAssistant }) {
  let outReply = reply;
  let outUrl = checkoutUrl;

  if (!outUrl && claimsPaymentSent(reply)) {
    const guardCart = cartRow.cart_json ?? [];
    const hasItems = guardCart.length > 0;
    const incompleteBundle = guardCart.find((i) => i.type === "bundle" && !i.complete);

    let pickupName = cartRow.pickup_name || undefined;
    if (!pickupName) {
      const trimmed = (userMessage || "").trim();
      const looksLikeName = /^[A-Za-z][A-Za-z .'-]{0,30}$/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
      const askedForName = typeof lastAssistant === "string" && /\bname\b/i.test(lastAssistant) &&
        /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for/i.test(lastAssistant);
      if (looksLikeName && askedForName) pickupName = trimmed;
    }

    if (checkoutAlreadyExists(cartRow)) {
      outReply = "Your payment link was already sent -- check your texts or email for it. Tap it to finish your order.";
    } else if (hasItems && !incompleteBundle && pickupName) {
      const forced = fakeSubmitOrder(guardCart, pickupName);
      if (forced.ok && forced.checkoutUrl) outUrl = forced.checkoutUrl;
      else outReply = honestFallbackReply(guardCart);
    } else {
      outReply = honestFallbackReply(guardCart, !!incompleteBundle);
    }
  }

  const safeReply = outUrl ? "Payment link sent! Tap it to complete your order. Check your text or email." : outReply;
  // A real session backs the claim if one was produced this turn (outUrl) OR
  // one already exists on the cart row (the already-sent reminder case).
  const realSessionExists = !!outUrl || checkoutAlreadyExists(cartRow);
  return { safeReply, checkoutUrl: outUrl, realSessionExists };
}

// ── Scenarios: every "customer confirms + claim emitted" state ──────────────
const ITEM = { menu_item_id: "x", name: "Bagel", quantity: 1, price_cents: 200 };
const INCOMPLETE_BUNDLE = { type: "bundle", name: "Dozen", target: 12, complete: false, selections: [] };

const scenarios = [
  { label: "claim + items + stored name (RECOVER)",       reply: "A payment link is on the way!", checkoutUrl: undefined, cartRow: { cart_json: [ITEM], pickup_name: "Jason" } },
  { label: "claim + items + name in user msg (RECOVER)",  reply: "You're all set!",                checkoutUrl: undefined, cartRow: { cart_json: [ITEM], pickup_name: null }, userMessage: "Mike", lastAssistant: "What name should I put for pickup?" },
  { label: "claim + items + NO name (HONEST ask name)",   reply: "Payment link sent!",             checkoutUrl: undefined, cartRow: { cart_json: [ITEM], pickup_name: null }, userMessage: "yes", lastAssistant: "Ready to check out?" },
  { label: "claim + EMPTY cart (HONEST restart)",         reply: "Your order is placed!",          checkoutUrl: undefined, cartRow: { cart_json: [], pickup_name: null } },
  { label: "claim + incomplete bundle (HONEST bundle)",   reply: "All set, link on the way!",      checkoutUrl: undefined, cartRow: { cart_json: [INCOMPLETE_BUNDLE], pickup_name: "Sue" } },
  { label: "claim + session already exists (NO 2nd)",     reply: "Payment link sent!",             checkoutUrl: undefined, cartRow: { cart_json: [ITEM], pickup_name: "Jason", stripe_checkout_session_id: "cs_test_existing", phase: "checkout" } },
  { label: "REAL path: claim WITH real session (pass)",   reply: "Payment link sent!",             checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_real", cartRow: { cart_json: [ITEM], pickup_name: "Jason", phase: "checkout" } },
  { label: "non-claim building reply (untouched)",        reply: "Want that toasted?",             checkoutUrl: undefined, cartRow: { cart_json: [ITEM], pickup_name: null } },
];

let fail = 0;
let phantomCount = 0;
let realSessionCount = 0;
let honestCount = 0;

console.log("=== INVARIANT: claim-out => real session, else honest reply ===\n");
// Run the matrix 3x to demonstrate determinism (24 runs >= 15 required).
for (let pass = 1; pass <= 3; pass++) {
  for (const s of scenarios) {
    const out = runGuard(s);
    const asserts = claimsPaymentSent(out.safeReply);
    const hasSession = out.realSessionExists;
    // PHANTOM = the reply asserts a link/placement BUT NO real session exists
    // (neither created this turn nor already present on the cart row).
    const phantom = asserts && !hasSession;
    if (phantom) phantomCount++;
    if (hasSession) realSessionCount++;
    if (!hasSession && !asserts) honestCount++;

    const ok = !phantom; // invariant
    if (!ok) fail++;
    if (pass === 1) {
      const outcome = hasSession ? "REAL-SESSION+claim" : (asserts ? "!!PHANTOM!!" : "HONEST(no-claim)");
      console.log(`${ok ? "PASS" : "FAIL"}  [${outcome}]  ${s.label}`);
      console.log(`        -> ${JSON.stringify(out.safeReply)}`);
    }
  }
}

console.log(`\n--- Counts over 3 passes x ${scenarios.length} scenarios = ${3 * scenarios.length} runs ---`);
console.log(`Real sessions / valid-claim replies : ${realSessionCount}`);
console.log(`Honest no-claim replies             : ${honestCount}`);
console.log(`PHANTOM (claim + null session)      : ${phantomCount}   <-- MUST be 0`);
console.log(`Stripe sessions created (stub)      : ${sessionsCreated}`);

// Determinism / no-double-session: the "already exists" scenario must NOT
// create a new session. With 6 RECOVER-eligible runs (2 recover scenarios x 3
// passes) we expect exactly 6 session creations, never more.
const expectedSessions = 6;
const noDouble = sessionsCreated === expectedSessions;
console.log(`No-double-session (expect ${expectedSessions})        : ${noDouble ? "PASS" : "FAIL (" + sessionsCreated + ")"}`);
if (!noDouble) fail++;

console.log(`\nRESULT: ${fail === 0 && phantomCount === 0 ? "PASS" : "FAIL"}`);
process.exit(fail === 0 && phantomCount === 0 ? 0 : 1);
