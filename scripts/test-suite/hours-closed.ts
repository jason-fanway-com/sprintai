/**
 * hours-closed.ts — One deterministic "shop is closed" test case.
 *
 * Single-turn: the customer tries to place an order; the bot MUST refuse
 * with a "kitchen is closed" message, produce no cart, and generate no
 * payment link / checkout URL.
 *
 * Category "hours-closed" triggers programmatic verification in run.ts
 * and worker.ts, bypassing the LLM judge (same pattern as cart-ops.ts).
 */

import type { RunResult } from "./runner.ts";
import type { TestCase } from "./library.ts";

// We import types from library.ts but the verifier only needs the RunResult shape.
// keep it dependency-light.

// ── The single closed-hours test case ──────────────────────────────────────

export const HOURS_CLOSED_CASES: TestCase[] = [
  {
    id: "hours-closed-1",
    category: "hours-closed",
    criticality: "critical",
    label: "Customer tries to order when shop is closed — bot refuses with closed message",
    hoursMode: "closed",
    turns: [
      { role: "customer", message: "I'd like to place an order" },
    ],
    success_criteria: [
      {
        id: "returns_closed_message",
        description: "Bot responds with a 'kitchen is closed' message",
        check_id: "closed_message_present",
      },
      {
        id: "no_cart_items",
        description: "Bot does NOT add items to cart",
        check_id: "cart_empty",
      },
      {
        id: "no_checkout",
        description: "Bot does NOT generate a payment link or checkout URL",
        check_id: "no_payment_link",
      },
    ],
  },
];

// ── Invariant result ──────────────────────────────────────────────────────

interface InvariantResult {
  id: string;
  passed: boolean;
  detail: string;
  /** true when materially evaluated; false when trivially passed with nothing to check. */
  applied: boolean;
}

interface HoursClosedVerification {
  caseId: string;
  passed: boolean;
  invariants: InvariantResult[];
}

// ── Verifier ───────────────────────────────────────────────────────────────

const CLOSED_PATTERNS = [
  /kitchen is closed/i,
  /closed right now/i,
  /come back during business hours/i,
  /kitchen is currently closed/i,
  /we('re| are) closed/i,
  /not.?taking orders/i,
  /during our hours/i,
  /kitchen closed today/i,
];

const CHECKOUT_PATTERNS = [
  /checkout/i,
  /pay\.stripe\.com/i,
  /payment link/i,
  /pay now/i,
  /complete your order/i,
  /secure\.stripe\.com/i,
];

export function verifyHoursClosed(run: RunResult): HoursClosedVerification {
  const invariants: InvariantResult[] = [];
  const transcript = run.transcript;

  if (!transcript.length) {
    return {
      caseId: run.caseId,
      passed: false,
      invariants: [
        { id: "closed_message_present", passed: false, detail: "No transcript", applied: false },
        { id: "cart_empty", passed: false, detail: "No transcript", applied: false },
        { id: "no_payment_link", passed: false, detail: "No transcript", applied: false },
      ],
    };
  }

  // Collect all assistant replies and all cart states
  const allReplies: string[] = [];
  let cartEverNonEmpty = false;

  for (const turn of transcript) {
    if (turn.reply && !turn.reply.startsWith("[ERROR") && !turn.reply.startsWith("[CRASH")) {
      allReplies.push(turn.reply);
    }
    const cart = turn.cart as unknown[];
    if (cart && cart.length > 0) {
      cartEverNonEmpty = true;
    }
  }

  const combinedReply = allReplies.join(" ");

  // INVARIANT 1: closed message present
  const closedMatch = CLOSED_PATTERNS.some((re) => re.test(combinedReply));
  invariants.push({
    id: "closed_message_present",
    passed: closedMatch,
    detail: closedMatch
      ? `Bot returned a closed message: "${combinedReply.slice(0, 120)}"`
      : `No closed pattern matched in bot replies: "${combinedReply.slice(0, 200)}"`,
    applied: true,
  });

  // INVARIANT 2: cart is empty
  invariants.push({
    id: "cart_empty",
    passed: !cartEverNonEmpty,
    detail: cartEverNonEmpty
      ? "Cart was not empty — bot added items when shop should be closed"
      : "Cart remained empty (correct for closed shop)",
    applied: true,
  });

  // INVARIANT 3: no payment/checkout link
  const checkoutMatch = CHECKOUT_PATTERNS.some((re) => re.test(combinedReply));
  invariants.push({
    id: "no_payment_link",
    passed: !checkoutMatch,
    detail: checkoutMatch
      ? `Payment/checkout link found in reply when shop should be closed: "${combinedReply.slice(0, 200)}"`
      : "No payment link found (correct for closed shop)",
    applied: true,
  });

  const passed = closedMatch && !cartEverNonEmpty && !checkoutMatch;

  return { caseId: run.caseId, passed, invariants };
}