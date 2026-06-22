/**
 * SprintAI — STRUCTURAL OUTBOUND WATCHDOG (functions side)
 * ========================================================
 *
 * ONE chokepoint that every customer-facing send on the functions side MUST
 * pass through. It enforces, by construction, the invariant:
 *
 *   A customer-facing (diner) message may be emitted ONLY if it is one of:
 *     1. inbound_reply      — a SYNCHRONOUS reply to a fresh customer inbound
 *                             (real, recent inbound message that triggered this
 *                             turn). STOP/HELP/START TCPA keyword responses are
 *                             synchronous replies and fall under this reason.
 *     2. payment_confirmed  — paid-order receipt; REQUIRES the cart to be paid.
 *     3. order_refunded     — refund notice; REQUIRES a real refund on the cart.
 *
 *   Everything else is DENIED (default-deny) and logged CRITICAL before it can
 *   leave the system. The send NEVER happens on a DENY.
 *
 * Note on audience: this guard governs CUSTOMER-FACING (diner) sends. The
 * merchant-facing B2B onboarding "welcome SMS" in stripe-webhook is a separate
 * audience tied to the merchant's own subscription checkout; it is represented
 * by the explicit `merchant_welcome` reason so it is ACCOUNTED FOR and gated,
 * never silently bypassing the chokepoint.
 *
 * DEFAULT-DENY IS STRUCTURAL, NOT CONVENTIONAL:
 *   The real network sender is NOT exported. The ONLY exported way to send is
 *   `guardedSend(ctx, deliver)`, which calls `assertOutboundAllowed(ctx)` and
 *   ONLY invokes `deliver()` on ALLOW. A new/rogue call site cannot reach the
 *   network without constructing a typed `OutboundContext` and passing the
 *   guard — there is no other door.
 */

// ─── Freshness window ─────────────────────────────────────────────────────────
// A triggering inbound older than this is NOT a live inbound worth auto-
// answering (mirrors the bridge MAX_MSG_AGE_SECONDS fail-closed gate).
// Overridable via env for tests only.
function freshnessWindowMs(): number {
  const env = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env;
  const raw = env?.get?.("OUTBOUND_INBOUND_FRESHNESS_SECONDS");
  const secs = raw ? Number(raw) : 900; // 15 minutes default
  return (Number.isFinite(secs) && secs > 0 ? secs : 900) * 1000;
}

export type OutboundReason =
  | "inbound_reply"
  | "payment_confirmed"
  | "order_refunded"
  | "merchant_welcome";

export interface OutboundContext {
  /** WHY this send is happening. Anything not in the enum → DENY. */
  reason: OutboundReason;
  /** Tenant/shop id for the audit trail (logged, never used for cross-tenant access). */
  shopId?: string | null;
  tenantId?: string | null;
  /** Conversation id (audit). */
  conversationId?: string | null;
  /** Cart id (audit + evidence for transactional reasons). */
  cartId?: string | null;
  /** Destination (audit only; partially redacted in logs). */
  to?: string | null;

  // ── Evidence per reason ──────────────────────────────────────────────────
  /** inbound_reply: the triggering inbound message id (must be present). */
  inboundMessageId?: string | null;
  /** inbound_reply: triggering inbound timestamp (ms epoch or ISO). Must be within window. */
  inboundAtMs?: number | null;
  /**
   * payment_confirmed: verified cart payment status. Must be a paid state.
   * order_refunded: presence of a real refund (refundedCents > 0).
   */
  cartPaymentStatus?: string | null;
  cartRefundedCents?: number | null;
  /** merchant_welcome: the merchant's own subscription/checkout completed. */
  subscriptionActive?: boolean | null;
}

export interface GuardDecision {
  allow: boolean;
  reason: OutboundReason | "unknown";
  why: string;
}

const PAID_STATES = new Set(["paid", "confirmed", "succeeded", "complete", "completed"]);

function toMs(at: number | string | null | undefined): number | null {
  if (at == null) return null;
  if (typeof at === "number") return Number.isFinite(at) ? at : null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

function redact(to: string | null | undefined): string {
  if (!to) return "(none)";
  const s = String(to);
  if (s.length <= 4) return "****";
  return s.slice(0, 3) + "***" + s.slice(-2);
}

/** Structured CRITICAL alert trail. One line per DENY, greppable by observability. */
function logCritical(d: GuardDecision, ctx: OutboundContext): void {
  // Intentionally NO message body, NO secrets — ids + reason + short why only.
  console.error(
    `[OUTBOUND-WATCHDOG][CRITICAL] DENY reason=${ctx.reason ?? "(blank)"} ` +
    `shop=${ctx.shopId ?? "-"} tenant=${ctx.tenantId ?? "-"} ` +
    `conversation=${ctx.conversationId ?? "-"} cart=${ctx.cartId ?? "-"} ` +
    `to=${redact(ctx.to)} why="${d.why}"`,
  );
}

/**
 * Pure decision function. Returns ALLOW or DENY with a structured reason.
 * On DENY this does NOT log (so it can be unit-tested without noise); callers
 * that actually gate a send use `guardedSend`, which logs CRITICAL on DENY.
 */
export function assertOutboundAllowed(ctx: OutboundContext): GuardDecision {
  const reason = ctx?.reason;

  switch (reason) {
    case "inbound_reply": {
      const id = ctx.inboundMessageId;
      const atMs = toMs(ctx.inboundAtMs ?? null);
      if (!id) {
        return { allow: false, reason, why: "inbound_reply missing triggering inbound message id" };
      }
      if (atMs == null) {
        return { allow: false, reason, why: "inbound_reply missing/invalid inbound timestamp" };
      }
      const age = Date.now() - atMs;
      if (age < 0) {
        return { allow: false, reason, why: "inbound_reply timestamp is in the future" };
      }
      if (age > freshnessWindowMs()) {
        return { allow: false, reason, why: `inbound_reply stale (age ${Math.round(age / 1000)}s > window)` };
      }
      return { allow: true, reason, why: "fresh synchronous inbound reply" };
    }

    case "payment_confirmed": {
      if (!ctx.cartId) {
        return { allow: false, reason, why: "payment_confirmed missing cart id" };
      }
      const status = (ctx.cartPaymentStatus ?? "").toLowerCase();
      if (!PAID_STATES.has(status)) {
        return { allow: false, reason, why: `payment_confirmed cart not in paid state (status=${status || "none"})` };
      }
      return { allow: true, reason, why: "paid-order receipt for paid cart" };
    }

    case "order_refunded": {
      if (!ctx.cartId) {
        return { allow: false, reason, why: "order_refunded missing cart id" };
      }
      const refunded = Number(ctx.cartRefundedCents ?? 0);
      if (!(refunded > 0)) {
        return { allow: false, reason, why: "order_refunded with no real refund on cart" };
      }
      return { allow: true, reason, why: "refund notice for refunded cart" };
    }

    case "merchant_welcome": {
      // B2B: merchant's own subscription checkout completed.
      if (ctx.subscriptionActive !== true) {
        return { allow: false, reason, why: "merchant_welcome without active subscription/checkout" };
      }
      return { allow: true, reason, why: "merchant welcome tied to completed subscription" };
    }

    default:
      // DEFAULT-DENY: unknown/blank/extensible-but-unhandled reason.
      return {
        allow: false,
        reason: "unknown",
        why: `unknown or blank reason (${reason == null ? "null" : JSON.stringify(reason)})`,
      };
  }
}

/**
 * THE ONLY DOOR. Wraps the real network send. `deliver` is the actual
 * network call (e.g. the fetch to Twilio). It is invoked ONLY on ALLOW.
 * On DENY: logs CRITICAL, returns { sent:false }, and NEVER calls deliver.
 *
 * Because the real sender is reached only via this function, a rogue call site
 * with no valid ctx CANNOT send — it fails closed structurally.
 */
export async function guardedSend(
  ctx: OutboundContext,
  deliver: () => Promise<void>,
): Promise<{ sent: boolean; decision: GuardDecision }> {
  const decision = assertOutboundAllowed(ctx);
  if (!decision.allow) {
    logCritical(decision, ctx);
    return { sent: false, decision };
  }
  await deliver();
  return { sent: true, decision };
}
