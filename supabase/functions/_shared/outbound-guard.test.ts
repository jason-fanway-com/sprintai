// Unit tests for the structural outbound watchdog (_shared/outbound-guard.ts).
// Every OutboundReason gets one ALLOW case and one DENY case per required
// evidence field, so a rogue call site cannot send by omitting evidence.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertOutboundAllowed, guardedSend, type OutboundContext } from "./outbound-guard.ts";

// ─── Minimal SupabaseClient spy (reused by error-log stage tests) ─────────────
function makeSupabaseSpy() {
  const rows: Record<string, unknown>[] = [];
  const client = {
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          rows.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, rows };
}

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

// ─── error-log stage tests (migration 137 acceptance criteria) ───────────────
// These run the REAL guardedSend/logError code path with an instrumented
// Supabase spy. Per project rule (no synthetic evidence), we do NOT write rows
// directly to error_log — we drive the real functions and observe what they
// would insert.

Deno.test("stage=guard_deny: guardedSend with errorLog inserts a guard_deny row on DENY", async () => {
  const { client, rows } = makeSupabaseSpy();
  const ctx: OutboundContext = { reason: "owner_escalation" }; // missing all evidence → DENY
  const { sent } = await guardedSend(ctx, async () => {}, { supabase: client, phase: "chat-sms", customerMessage: "hi" });
  assertEquals(sent, false);
  assertEquals(rows.length, 1, "expected exactly one error_log row inserted");
  assertEquals(rows[0].stage, "guard_deny");
  assertEquals(typeof rows[0].error_message, "string");
  assertEquals((rows[0].error_message as string).length > 0, true);
});

Deno.test("stage=guard_deny: no errorLog param → no insert (guard still denies)", async () => {
  const { rows } = makeSupabaseSpy();
  const ctx: OutboundContext = { reason: "owner_escalation" };
  const { sent } = await guardedSend(ctx, async () => {});
  assertEquals(sent, false);
  assertEquals(rows.length, 0);
});

Deno.test("stage=outbound_send: guardedSend with errorLog inserts outbound_send row when deliver throws", async () => {
  const { client, rows } = makeSupabaseSpy();
  const deliverError = new Error("Twilio 503 Service Unavailable");
  // Must rethrow — use assertRejects to catch and verify
  await assertRejects(
    () =>
      guardedSend(
        VALID_ESCALATION,
        async () => { throw deliverError; },
        { supabase: client, phase: "chat-sms", customerMessage: "your order is ready" },
      ),
    Error,
    "Twilio 503",
  );
  assertEquals(rows.length, 1, "expected exactly one error_log row inserted");
  assertEquals(rows[0].stage, "outbound_send");
  assertEquals(rows[0].error_message, "Twilio 503 Service Unavailable");
  assertEquals(rows[0].customer_message, "your order is ready");
});

Deno.test("stage=outbound_send: deliver throws without errorLog → rethrows, no insert", async () => {
  const { rows } = makeSupabaseSpy();
  await assertRejects(
    () => guardedSend(VALID_ESCALATION, async () => { throw new Error("net"); }),
    Error,
    "net",
  );
  assertEquals(rows.length, 0);
});

Deno.test("stage=outbound_send: __errorLogged flag is set on the thrown error after logging", async () => {
  const { client } = makeSupabaseSpy();
  const err = new Error("net failure");
  let caughtErr: unknown;
  try {
    await guardedSend(
      VALID_ESCALATION,
      async () => { throw err; },
      { supabase: client, phase: "chat-sms" },
    );
  } catch (e) {
    caughtErr = e;
  }
  assertEquals((caughtErr as { __errorLogged?: boolean }).__errorLogged, true);
});
