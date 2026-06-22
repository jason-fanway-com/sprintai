/**
 * Phantom-link guard — DETECTOR unit test.
 *
 * Mirrors claimsPaymentSent() / PAYMENT_CLAIM_PATTERNS from
 * supabase/functions/chat-sms/index.ts EXACTLY. Kept standalone (node, no Deno,
 * no DB) so the detector is provable in isolation.
 *
 * The detector's job: flag assistant replies that CLAIM a payment link was sent
 * / the order is placed (must be CAUGHT), while leaving normal order-building
 * chatter alone (must NOT be caught). The main handler only lets a payment-claim
 * reply through if a real Stripe session exists; everything caught here that has
 * no session gets recovered or replaced with an honest message.
 *
 * Run: node signup-page/_proof/phantom-link-detector.test.mjs
 */

// ── EXACT copy of the patterns + matcher from index.ts ──────────────────────
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
  /\border (?:placed|confirmed|submitted|complete|completed)\b/,
  /\bready (?:to|for) (?:pay|payment|checkout)\b.*\b(?:link|text|email|tap|click)\b/,
  /\bproceed to (?:pay|payment|checkout)\b.*\b(?:link|text|email)\b/,
];

function claimsPaymentSent(text) {
  if (!text) return false;
  const norm = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return PAYMENT_CLAIM_PATTERNS.some((re) => re.test(norm));
}

// ── Test corpus ─────────────────────────────────────────────────────────────
// MUST be caught (these are the phantom-claim phrases the bug produces).
const SHOULD_CATCH = [
  "Payment link sent! Tap it to complete your order.",
  "A payment link is on the way.",            // the exact real-world failure (conv be210325)
  "A payment link is on its way!",
  "Your payment link is coming right up.",
  "The payment link has been sent to your phone.",
  "I sent you a payment link, check your texts.",
  "Sending your payment link now.",
  "Here's your payment link to finish up.",
  "Here is the link to pay.",
  "Tap the link to pay and you're done.",
  "Click the payment link to complete your order.",
  "Check your text for the link to pay.",
  "Your link is on the way, check your email.",
  "You're all set! Just tap the link.",
  "You are all set.",
  "All set -- check your text for the payment link.",
  "Your order is placed!",
  "Your order has been submitted.",
  "Your order is confirmed.",
  "I've placed your order.",
  "I placed your order, payment link incoming.",
  "Order's in! Link on the way.",
  "Your order is on its way.",
  // Bare past-participle completion claims with NO copula (the residual hole).
  "Order placed!",
  "Order confirmed!",
  "Order submitted!",
  "Order complete!",
  "Order completed!",
  "Done! Order placed.",
  // Adversarial completion variants.
  "order placed \ud83c\udf89",
  "Great news \u2014 order confirmed.",
  "Your order placed successfully.",
  "order completed, see you at pickup!",
  "OK, order submitted to the kitchen.",
];

// MUST NOT be caught (normal building / review chatter — false positives here
// would block legitimate replies).
const SHOULD_NOT_CATCH = [
  "Want that toasted?",
  "Added a dozen bagels to your cart.",
  "Got it, noted toasted.",
  "What name should I put it under for pickup?",
  "Salt, pepper, or ketchup?",
  "Your cart has 2 bacon egg and cheese. Anything else?",
  "Ready to check out? Just say yes to confirm.",
  "That comes to $14.50. Want to add a drink?",
  "What kind of bread -- roll, bagel, or english muffin?",
  "I added the everything bagel. 6 of 12 selected, 6 remaining.",
  "Do you want cream cheese on a bagel or a pound to go?",
  "Sure! What flavors would you like in your dozen?",
  "Your subtotal is $9.00. Anything else before we wrap up?",
  "Got your order! What name should I put it under for pickup?", // honest fallback copy
  "Almost there! Your bundle still needs a few more picks.",     // honest fallback copy
  // NO-FALSE-POSITIVE set for the new bare-participle pattern: "order" + a
  // verb in the WRONG position (instruction / review / menu-building chatter).
  "Here's your order so far",
  "What would you like to order?",
  "Review your order",
  "Complete your order by tapping the link",
  "In order to pay, tap below",
  "your order so far is $9.95",
  "To complete your order, just say confirm.",
  "What order would you like them in?",
];

// ── Run ─────────────────────────────────────────────────────────────────────
let fail = 0;
console.log("=== SHOULD CATCH (phantom payment-claims) ===");
for (const s of SHOULD_CATCH) {
  const got = claimsPaymentSent(s);
  console.log(`${got ? "PASS" : "FAIL"}  caught=${got}  ${JSON.stringify(s)}`);
  if (!got) fail++;
}
console.log("\n=== SHOULD NOT CATCH (normal chatter) ===");
for (const s of SHOULD_NOT_CATCH) {
  const got = claimsPaymentSent(s);
  console.log(`${!got ? "PASS" : "FAIL"}  caught=${got}  ${JSON.stringify(s)}`);
  if (got) fail++;
}

console.log(`\nTOTAL: ${SHOULD_CATCH.length + SHOULD_NOT_CATCH.length} cases, ${fail} failures`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);
