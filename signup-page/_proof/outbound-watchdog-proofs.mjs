/**
 * SprintAI — OUTBOUND WATCHDOG PROOF HARNESS
 * ==========================================
 *
 * Exercises the REAL guard logic with ZERO drift. We do NOT copy or regex-strip
 * the guard. Node 22's native TypeScript type-stripping
 * (`node --experimental-strip-types`) imports the actual source file:
 *
 *   supabase/functions/_shared/outbound-guard.ts
 *
 * The guard reads `globalThis.Deno?.env` defensively, so it runs unchanged in
 * Node. What you prove here is exactly what runs in production.
 *
 * RUN:
 *   node --experimental-strip-types signup-page/_proof/outbound-watchdog-proofs.mjs
 *
 * No live services, no secrets, no network. Pure decision logic + a structural
 * deliver-spy proof that deliver() never fires on DENY.
 */

import {
  assertOutboundAllowed,
  guardedSend,
} from "../../supabase/functions/_shared/outbound-guard.ts";

// ── Tiny test runner ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ FAIL: ${name}`);
  }
}

const NOW = Date.now();
const MIN = 60_000;

// ════════════════════════════════════════════════════════════════════════════
// 1. assertOutboundAllowed — pure decision logic
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[1] assertOutboundAllowed — pure decision matrix");

// ── inbound_reply ─────────────────────────────────────────────────────────────
check(
  "inbound_reply: fresh id+ts → ALLOW",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: "SM123", inboundAtMs: NOW }).allow === true,
);
check(
  "inbound_reply: missing id → DENY",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: null, inboundAtMs: NOW }).allow === false,
);
check(
  "inbound_reply: missing timestamp → DENY",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: "SM123", inboundAtMs: null }).allow === false,
);
check(
  "inbound_reply: stale ts (>900s) → DENY",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: "SM123", inboundAtMs: NOW - 16 * MIN }).allow === false,
);
check(
  "inbound_reply: future ts → DENY",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: "SM123", inboundAtMs: NOW + 5 * MIN }).allow === false,
);
check(
  "inbound_reply: ISO-string ts within window → ALLOW",
  assertOutboundAllowed({ reason: "inbound_reply", inboundMessageId: "SM123", inboundAtMs: new Date(NOW - 30_000).toISOString() }).allow === true,
);

// ── payment_confirmed ─────────────────────────────────────────────────────────
check(
  "payment_confirmed: paid state + cartId → ALLOW",
  assertOutboundAllowed({ reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: "paid" }).allow === true,
);
check(
  "payment_confirmed: 'succeeded' state → ALLOW",
  assertOutboundAllowed({ reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: "succeeded" }).allow === true,
);
check(
  "payment_confirmed: unpaid state → DENY",
  assertOutboundAllowed({ reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: "pending" }).allow === false,
);
check(
  "payment_confirmed: missing status → DENY",
  assertOutboundAllowed({ reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: null }).allow === false,
);
check(
  "payment_confirmed: missing cartId → DENY",
  assertOutboundAllowed({ reason: "payment_confirmed", cartId: null, cartPaymentStatus: "paid" }).allow === false,
);

// ── order_refunded ────────────────────────────────────────────────────────────
check(
  "order_refunded: refundedCents>0 + cartId → ALLOW",
  assertOutboundAllowed({ reason: "order_refunded", cartId: "cart_1", cartRefundedCents: 1599 }).allow === true,
);
check(
  "order_refunded: refundedCents=0 → DENY",
  assertOutboundAllowed({ reason: "order_refunded", cartId: "cart_1", cartRefundedCents: 0 }).allow === false,
);
check(
  "order_refunded: refundedCents missing → DENY",
  assertOutboundAllowed({ reason: "order_refunded", cartId: "cart_1", cartRefundedCents: null }).allow === false,
);
check(
  "order_refunded: missing cartId → DENY",
  assertOutboundAllowed({ reason: "order_refunded", cartId: null, cartRefundedCents: 1599 }).allow === false,
);

// ── merchant_welcome ──────────────────────────────────────────────────────────
check(
  "merchant_welcome: subscriptionActive=true → ALLOW",
  assertOutboundAllowed({ reason: "merchant_welcome", subscriptionActive: true }).allow === true,
);
check(
  "merchant_welcome: subscriptionActive=false → DENY",
  assertOutboundAllowed({ reason: "merchant_welcome", subscriptionActive: false }).allow === false,
);
check(
  "merchant_welcome: subscriptionActive missing → DENY",
  assertOutboundAllowed({ reason: "merchant_welcome", subscriptionActive: null }).allow === false,
);

// ── default-deny ──────────────────────────────────────────────────────────────
check(
  "unknown reason → DENY (default-deny)",
  assertOutboundAllowed({ reason: "marketing_blast" }).allow === false,
);
check(
  "blank/empty reason → DENY (default-deny)",
  assertOutboundAllowed({ reason: "" }).allow === false,
);
check(
  "null reason → DENY (default-deny)",
  assertOutboundAllowed({ reason: null }).allow === false,
);
check(
  "no ctx fields at all → DENY (default-deny)",
  assertOutboundAllowed({}).allow === false,
);
check(
  "default-deny reports reason='unknown'",
  assertOutboundAllowed({ reason: "spam" }).reason === "unknown",
);

// ════════════════════════════════════════════════════════════════════════════
// 2. guardedSend STRUCTURAL — deliver() NEVER fires on DENY
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[2] guardedSend STRUCTURAL — deliver-spy proof");

// Capture CRITICAL logs as evidence.
const criticalLines = [];
const origError = console.error;
console.error = (...args) => { criticalLines.push(args.join(" ")); };

async function spyRun(ctx) {
  let delivered = false;
  const deliver = async () => { delivered = true; };
  const res = await guardedSend(ctx, deliver);
  return { delivered, res };
}

// Every DENY case must leave delivered=false.
const denyCases = [
  ["inbound_reply no id", { reason: "inbound_reply", inboundMessageId: null, inboundAtMs: NOW }],
  ["inbound_reply stale", { reason: "inbound_reply", inboundMessageId: "x", inboundAtMs: NOW - 16 * MIN }],
  ["inbound_reply future", { reason: "inbound_reply", inboundMessageId: "x", inboundAtMs: NOW + 5 * MIN }],
  ["payment_confirmed unpaid", { reason: "payment_confirmed", cartId: "c", cartPaymentStatus: "pending" }],
  ["payment_confirmed no cart", { reason: "payment_confirmed", cartPaymentStatus: "paid" }],
  ["order_refunded zero", { reason: "order_refunded", cartId: "c", cartRefundedCents: 0 }],
  ["merchant_welcome inactive", { reason: "merchant_welcome", subscriptionActive: false }],
  ["unknown reason", { reason: "blast" }],
  ["blank reason", { reason: "" }],
];

let allDenyHeldFalse = true;
for (const [label, ctx] of denyCases) {
  const { delivered, res } = await spyRun(ctx);
  const ok = delivered === false && res.sent === false;
  if (!ok) allDenyHeldFalse = false;
  check(`DENY '${label}': deliver() NOT invoked + sent=false`, ok);
}
check("STRUCTURAL: deliver-spy stayed false across EVERY DENY", allDenyHeldFalse);

// Every ALLOW case must fire deliver exactly once.
const allowCases = [
  ["inbound_reply fresh", { reason: "inbound_reply", inboundMessageId: "x", inboundAtMs: NOW }],
  ["payment_confirmed paid", { reason: "payment_confirmed", cartId: "c", cartPaymentStatus: "paid" }],
  ["order_refunded real", { reason: "order_refunded", cartId: "c", cartRefundedCents: 500 }],
  ["merchant_welcome active", { reason: "merchant_welcome", subscriptionActive: true }],
];
let allAllowDelivered = true;
for (const [label, ctx] of allowCases) {
  const { delivered, res } = await spyRun(ctx);
  const ok = delivered === true && res.sent === true;
  if (!ok) allAllowDelivered = false;
  check(`ALLOW '${label}': deliver() invoked once + sent=true`, ok);
}
check("STRUCTURAL: deliver-spy fired true ONLY on ALLOW", allAllowDelivered);

// Restore console.error and verify CRITICAL evidence was captured.
console.error = origError;
const criticalDenies = criticalLines.filter((l) => l.includes("[OUTBOUND-WATCHDOG][CRITICAL] DENY"));
check(`CRITICAL log emitted on DENY (captured ${criticalDenies.length} lines)`, criticalDenies.length >= denyCases.length);
check("CRITICAL line carries NO message body (ids+reason only)", criticalDenies.every((l) => !l.includes("Body=") && !l.toLowerCase().includes("password")));

console.log("\n  --- Sample captured CRITICAL DENY line (evidence) ---");
console.log("  " + (criticalDenies[0] ?? "(none)"));

// ════════════════════════════════════════════════════════════════════════════
// 3. ROGUE-SEND simulation — there is no door but guardedSend
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[3] Rogue-send simulation — no ungated path to the network");

// The real Twilio fetch lives INSIDE the deliver closure passed to guardedSend.
// A rogue caller that wants to "just send" still has to call guardedSend with a
// ctx; if the ctx is junk, deliver() never runs. We model "the network" as a
// side-effect that ONLY the deliver closure can trigger.
let networkHit = false;
const rogueDeliver = async () => { networkHit = true; /* <-- the Twilio fetch */ };

// Rogue attempt 1: no reason at all.
await guardedSend({}, rogueDeliver);
check("rogue send with empty ctx → network NOT hit", networkHit === false);

// Rogue attempt 2: made-up reason to look legit.
await guardedSend({ reason: "promo", to: "+15551234567" }, rogueDeliver);
check("rogue send with fake reason → network NOT hit", networkHit === false);

// Rogue attempt 3: right reason, NO evidence (the classic bypass attempt).
await guardedSend({ reason: "payment_confirmed", to: "+15551234567" }, rogueDeliver);
check("rogue 'payment_confirmed' with no paid cart → network NOT hit", networkHit === false);

// Only a fully-evidenced ALLOW reaches the network.
await guardedSend({ reason: "payment_confirmed", cartId: "c", cartPaymentStatus: "paid" }, rogueDeliver);
check("legit evidenced send → network hit exactly once", networkHit === true);

// ════════════════════════════════════════════════════════════════════════════
// 4. REGRESSION — the two real receipts + synchronous inbound replies still ALLOW
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[4] Regression — real production ctxs still ALLOW");

// chat-sms txnCtx (payment_confirmed) with real cart evidence shape.
check(
  "REGRESSION: chat-sms payment receipt (real cartRow paid) → ALLOW",
  assertOutboundAllowed({
    reason: "payment_confirmed",
    shopId: "shop_1", tenantId: "t_1", conversationId: "conv_1",
    cartId: "cart_1", cartPaymentStatus: "paid", cartRefundedCents: null,
  }).allow === true,
);
// chat-sms txnCtx (order_refunded) with real cart evidence shape.
check(
  "REGRESSION: chat-sms refund notice (real refundedCents) → ALLOW",
  assertOutboundAllowed({
    reason: "order_refunded",
    shopId: "shop_1", tenantId: "t_1", conversationId: "conv_1",
    cartId: "cart_1", cartPaymentStatus: "paid", cartRefundedCents: 1599,
  }).allow === true,
);
// chat-sms inboundReplyCtx (synchronous reply) — live MessageSid + now.
check(
  "REGRESSION: chat-sms synchronous inbound reply (MessageSid+now) → ALLOW",
  assertOutboundAllowed({
    reason: "inbound_reply", to: "+15551230000",
    inboundMessageId: "SM" + "a".repeat(32), inboundAtMs: Date.now(),
  }).allow === true,
);
// stripe-webhook merchant_welcome with real subscription.status === active.
check(
  "REGRESSION: stripe-webhook merchant welcome (sub active) → ALLOW",
  assertOutboundAllowed({ reason: "merchant_welcome", tenantId: "t_1", subscriptionActive: true }).allow === true,
);

// ════════════════════════════════════════════════════════════════════════════
console.log("\n══════════════════════════════════════════════════════════════");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("ALL OUTBOUND-WATCHDOG PROOFS PASSED ✅");
process.exit(0);
