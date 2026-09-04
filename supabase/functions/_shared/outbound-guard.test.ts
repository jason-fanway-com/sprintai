// Unit tests for the structural outbound watchdog (_shared/outbound-guard.ts).
// Every OutboundReason gets one ALLOW case and one DENY case per required
// evidence field, so a rogue call site cannot send by omitting evidence.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertOutboundAllowed, guardedSend, type OutboundContext } from "./outbound-guard.ts";

// ─── inbound_reply ────────────────────────────────────────────────────────
Deno.test("ALLOW: inbound_reply with fresh inbound", () => {
  const ctx: OutboundContext = {
    reason: "inbound_reply",
    inboundMessageId: "msg_1",
    inboundAtMs: Date.now() - 1000,
  };
  assertEquals(assertOutboundAllowed(ctx).allow, true);
});

Deno.test("DENY: inbound_reply missing message id", () => {
  const ctx: OutboundContext = { reason: "inbound_reply", inboundAtMs: Date.now() };
  assertEquals(assertOutboundAllowed(ctx).allow, false);
});

Deno.test("DENY: inbound_reply stale beyond freshness window", () => {
  const ctx: OutboundContext = {
    reason: "inbound_reply",
    inboundMessageId: "msg_1",
    inboundAtMs: Date.now() - 20 * 60_000, // 20 min > 15 min default window
  };
  assertEquals(assertOutboundAllowed(ctx).allow, false);
});

// ─── payment_confirmed ────────────────────────────────────────────────────
Deno.test("ALLOW: payment_confirmed for a paid cart", () => {
  const ctx: OutboundContext = { reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: "paid" };
  assertEquals(assertOutboundAllowed(ctx).allow, true);
});

Deno.test("DENY: payment_confirmed for an unpaid cart", () => {
  const ctx: OutboundContext = { reason: "payment_confirmed", cartId: "cart_1", cartPaymentStatus: "pending" };
  assertEquals(assertOutboundAllowed(ctx).allow, false);
});

// ─── order_refunded ───────────────────────────────────────────────────────
Deno.test("ALLOW: order_refunded with a real refund", () => {
  const ctx: OutboundContext = { reason: "order_refunded", cartId: "cart_1", cartRefundedCents: 500 };
  assertEquals(assertOutboundAllowed(ctx).allow, true);
});

Deno.test("DENY: order_refunded with no refund on the cart", () => {
  const ctx: OutboundContext = { reason: "order_refunded", cartId: "cart_1", cartRefundedCents: 0 };
  assertEquals(assertOutboundAllowed(ctx).allow, false);
});

// ─── merchant_welcome ─────────────────────────────────────────────────────
Deno.test("ALLOW: merchant_welcome with active subscription", () => {
  const ctx: OutboundContext = { reason: "merchant_welcome", subscriptionActive: true };
  assertEquals(assertOutboundAllowed(ctx).allow, true);
});

Deno.test("DENY: merchant_welcome without active subscription", () => {
  const ctx: OutboundContext = { reason: "merchant_welcome", subscriptionActive: false };
  assertEquals(assertOutboundAllowed(ctx).allow, false);
});

// ─── owner_escalation (INSTRUCTION-10 item I) ────────────────────────────
const VALID_ESCALATION: OutboundContext = {
  reason: "owner_escalation",
  cartId: "cart_1",
  cartPaymentStatus: "paid",
  ticketHandedOff: true,
  unackedMinutes: 7,
  escalationClaimed: true,
};

Deno.test("ALLOW: owner_escalation with all five conditions satisfied", () => {
  assertEquals(assertOutboundAllowed(VALID_ESCALATION).allow, true);
});

Deno.test("DENY: owner_escalation missing cart id", () => {
  const { cartId: _cartId, ...rest } = VALID_ESCALATION;
  assertEquals(assertOutboundAllowed(rest as OutboundContext).allow, false);
});

Deno.test("DENY: owner_escalation cart not paid", () => {
  assertEquals(
    assertOutboundAllowed({ ...VALID_ESCALATION, cartPaymentStatus: "pending" }).allow,
    false,
  );
});

Deno.test("DENY: owner_escalation without delivered/handed-off ticket", () => {
  assertEquals(
    assertOutboundAllowed({ ...VALID_ESCALATION, ticketHandedOff: false }).allow,
    false,
  );
});

Deno.test("DENY: owner_escalation before the 7-minute threshold", () => {
  assertEquals(
    assertOutboundAllowed({ ...VALID_ESCALATION, unackedMinutes: 5 }).allow,
    false,
  );
});

Deno.test("DENY: owner_escalation without the exactly-once DB claim", () => {
  assertEquals(
    assertOutboundAllowed({ ...VALID_ESCALATION, escalationClaimed: false }).allow,
    false,
  );
});

Deno.test("DENY: owner_escalation with no evidence at all (rogue call site)", () => {
  assertEquals(assertOutboundAllowed({ reason: "owner_escalation" }).allow, false);
});

// ─── default-deny ─────────────────────────────────────────────────────────
Deno.test("DENY: unknown reason is default-denied", () => {
  // deno-lint-ignore no-explicit-any
  assertEquals(assertOutboundAllowed({ reason: "made_up" as any }).allow, false);
});

Deno.test("guardedSend never calls deliver on DENY", async () => {
  let delivered = false;
  const { sent } = await guardedSend({ reason: "owner_escalation" }, async () => {
    delivered = true;
  });
  assertEquals(sent, false);
  assertEquals(delivered, false);
});

Deno.test("guardedSend calls deliver on ALLOW", async () => {
  let delivered = false;
  const { sent } = await guardedSend(VALID_ESCALATION, async () => {
    delivered = true;
  });
  assertEquals(sent, true);
  assertEquals(delivered, true);
});
