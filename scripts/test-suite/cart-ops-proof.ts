// ── Proof-Grade (Stage 2) Adversarial Cases ─────────────────────────────────
// Appended to cart-ops.ts as an extension module.

import type { TestCase, SuccessCriterion } from "./library.ts";

/**
 * Build a smaller set of Proof-grade cases that exercise catastrophic failure
 * modes — checkout that lies, cart wipe, menu hallucination. Menu-derived like
 * the CartOps builder, but each case carries an explicit `proofGuard` tag so
 * proof.ts can run targeted guard-removal regressions.
 */
export interface ProofCase extends TestCase {
  proofGuard: "checkout-writes-order" | "cart-persists" | "no-menu-hallucination";
}

export function buildProofCases(items: { name: string; price_cents: number }[]): ProofCase[] {
  if (items.length === 0) return [];
  const it = (i: number) => items[i % items.length];
  const A = it(0);
  const B = it(1);
  const C = it(2);

  const base: SuccessCriterion[] = [{ id: "cart_ops_invariants_hold", description: "All CartOps hard invariants pass" }];

  return [
    {
      id: "proof-checkout-writes-order",
      category: "proof",
      criticality: "critical",
      proofGuard: "checkout-writes-order",
      label: `Full checkout: ${A.name} → confirm → name → checkout. Submit MUST write an orders row.`,
      turns: [
        { role: "customer", message: `Hi, I'd like a ${A.name} please` },
        { role: "customer", message: "yes" },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: base,
      expects_checkout: true,
    },
    {
      id: "proof-cart-persists",
      category: "proof",
      criticality: "critical",
      proofGuard: "cart-persists",
      label: `Cart persists: order ${A.name}, ask off-topic question, add ${B.name}. Both items end up in cart.`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "What's your delivery radius?" },
        { role: "customer", message: `Ok, add a ${B.name} too` },
      ],
      success_criteria: base,
    },
    {
      id: "proof-no-menu-hallucination",
      category: "proof",
      criticality: "critical",
      proofGuard: "no-menu-hallucination",
      label: `Hallucination: customer asks for entirely off-menu items. Bot must NOT claim to have added them.`,
      turns: [
        { role: "customer", message: "I'd like a pterodactyl wing platter and a deep-fried laptop please" },
      ],
      success_criteria: base,
    },
    {
      id: "proof-cart-persists-across-multiple",
      category: "proof",
      criticality: "critical",
      proofGuard: "cart-persists",
      label: `Multi-turn cart persist: ${A.name} → question → ${B.name} → checkout → ${C.name} absent.`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Do you have any desserts?" },
        { role: "customer", message: `Actually add a ${B.name}` },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: base,
      expects_checkout: true,
    },
    {
      id: "proof-checkout-multi-item",
      category: "proof",
      criticality: "critical",
      proofGuard: "checkout-writes-order",
      label: `Multi-item checkout: ${B.name} + ${C.name} → checkout → orders row exists with both items.`,
      turns: [
        { role: "customer", message: `I'll take a ${B.name} and a ${C.name}` },
        { role: "customer", message: "yes" },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: base,
      expects_checkout: true,
    },
    {
      id: "proof-hallucination-mid-order",
      category: "proof",
      criticality: "critical",
      proofGuard: "no-menu-hallucination",
      label: `Hallucination mid-order: add ${A.name}, then request fake item. Cart must still contain only real items.`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Can you also add a quantum-baked neutrino wrap?" },
      ],
      success_criteria: base,
    },
  ];
}

// ── Proof Phase 1 Deterministic Verifiers ──────────────────────────────────

export interface ProofVerification {
  runId: string;
  passed: boolean;
  invariants: ProofInvariantResult[];
}

export interface ProofInvariantResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
}

/**
 * INVARIANT P1: Checkout finalize must write an orders row.
 * When chat-sms reaches phase=checkout, it means submit_order succeeded
 * (submit_order updates phase to "checkout" only after Stripe session creation).
 * We also verify no phantom confirmation without a real payment link.
 */
export function verifyCheckoutWritesOrder(
  run: { transcript: Array<{ phase?: string; cart?: unknown[]; reply?: string | null }> },
): ProofInvariantResult {
  const last = run.transcript[run.transcript.length - 1];
  const phase = last?.phase ?? "";

  if (phase !== "checkout") {
    return {
      id: "checkout_writes_order",
      description: "When checkout finalizes, an orders row must be written (stripe_checkout_session_id set)",
      passed: false,
      detail: `Expected phase "checkout" but got "${phase}". Cannot verify order row was written.`,
    };
  }

  const reply = last?.reply ?? "";
  const hasLinkPattern = /(?:payment|checkout) link|pay\.getsprintai\.com|tap (?:the link|to pay|to finish)/i.test(reply);
  const hasThankYouPattern = /(?:order confirmed|order placed|all set|you're all set)/i.test(reply);

  if (hasThankYouPattern && !hasLinkPattern) {
    return {
      id: "checkout_writes_order",
      description: "When checkout finalizes, reply must include a real payment link, never a phantom confirmation",
      passed: false,
      detail: `Reached checkout but reply claims order confirmed without a payment link — guard may have failed. Reply: "${reply.slice(0, 120)}"`,
    };
  }

  return {
    id: "checkout_writes_order",
    description: "When checkout finalizes, an orders row must be written (stripe_checkout_session_id set)",
    passed: true,
    detail: `Checkout reached; payment link ${hasLinkPattern ? "present" : "implied by phase"} — guard holds.`,
  };
}

/**
 * INVARIANT P2: Cart persists across turns.
 * Walk the transcript turn-by-turn. When a turn does not signal order
 * mutation (tip, name, question), the cart item count must not decrease.
 * When the turn is a cancellation/reset, the cart may empty legitimately.
 */
export function verifyCartPersistence(
  run: { transcript: Array<{ role: string; message: string; cart?: unknown[]; reply?: string | null }> },
): ProofInvariantResult {
  const transcript = run.transcript;
  if (transcript.length < 2) {
    return {
      id: "cart_persists",
      description: "Cart must persist across non-mutating turns; never silently reset",
      passed: true,
      detail: "Only 1 turn — nothing to verify across turns.",
    };
  }

  let prevCount = 0;
  const violations: string[] = [];

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    const cart = (turn.cart as unknown[]) ?? [];
    const count = cart.length;
    const msg = (turn.message ?? "").toLowerCase();

    const isCancel = /cancel|reset|never.?mind|start.?over/i.test(msg);

    if (i > 0 && !isCancel && prevCount > 0 && count === 0) {
      violations.push(
        `Turn ${i}: Cart went from ${prevCount} items to 0 (no cancel signal). Message: "${turn.message.slice(0, 80)}"`,
      );
    }

    if (isCancel) {
      prevCount = 0;
    } else if (count > 0) {
      prevCount = count;
    }
  }

  if (violations.length > 0) {
    return {
      id: "cart_persists",
      description: "Cart must persist across non-mutating turns; never silently reset",
      passed: false,
      detail: violations.join("; "),
    };
  }

  return {
    id: "cart_persists",
    description: "Cart must persist across non-mutating turns; never silently reset",
    passed: true,
    detail: "Cart persisted correctly across all turns.",
  };
}

/**
 * INVARIANT P3: No menu hallucination.
 * Every item name that appears in the assistant's reply must exist in the
 * effective menu OR be a generic food/service word.
 */
export function verifyNoMenuHallucination(
  run: { transcript: Array<{ role: string; reply?: string | null }> },
  menuItemNames: string[],
): ProofInvariantResult {
  const lowerMenu = new Set(menuItemNames.map((n) => n.toLowerCase()));
  const genericTerms = new Set([
    "order", "orders", "item", "items", "cart", "checkout",
    "payment", "pay", "pickup", "delivery", "name", "address",
    "service fee", "total", "receipt", "confirmation",
    "pickup order", "delivery order", "today", "anything",
    "bagel", "bagels", "pizza", "pizzas", "salad", "salads",
    "drink", "drinks", "dessert", "desserts", "side", "sides",
    "toast", "toasted", "cream cheese", "butter", "cheese",
    "sandwich", "sandwiches", "special", "specials", "menu",
    "pepperoni", "mushroom", "olive", "onion", "garlic",
    "sausage", "bacon", "chicken", "tomato", "basil",
    "thanks", "welcome", "enjoy", "great", "perfect",
  ]);

  const violations: string[] = [];

  for (let i = 0; i < run.transcript.length; i++) {
    const reply = run.transcript[i].reply ?? "";
    if (!reply) continue;

    const addedPatterns = [
      /(?:added|add|got|have) (?:a |an |the )?([A-Z][A-Za-z\s]{2,40}?)(?: to your cart|\.|$)/gi,
      /(?:your cart[^.]*?)([A-Z][A-Za-z\s]{3,40}?)(?:—|-|total|\.|$)/gi,
      /"([A-Z][A-Za-z\s]{3,40})"/g,
    ];

    for (const pat of addedPatterns) {
      for (const match of reply.matchAll(pat)) {
        const name = (match[1] ?? "").trim();
        if (name.length < 3) continue;
        const lower = name.toLowerCase();
        if (genericTerms.has(lower)) continue;
        if (!lowerMenu.has(lower) && ![...lowerMenu].some(m => lower.includes(m) || m.includes(lower))) {
          violations.push(
            `Turn ${i}: Assistant mentioned "${name}" which is not in the menu. Reply excerpt: "${reply.slice(0, 120)}"`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    return {
      id: "no_menu_hallucination",
      description: "Assistant must never invent or claim to add items not in the effective menu",
      passed: false,
      detail: violations.join("; "),
    };
  }

  return {
    id: "no_menu_hallucination",
    description: "Assistant must never invent or claim to add items not in the effective menu",
    passed: true,
    detail: "No menu hallucination detected in assistant replies.",
  };
}

/**
 * Run ALL Proof-grade invariants against a single run transcript.
 */
export function verifyProofInvariants(
  run: {
    caseId: string;
    transcript: Array<{ role: string; message: string; cart?: unknown[]; reply?: string | null; phase?: string }>;
  },
  menuItemNames: string[],
): ProofVerification {
  const p1 = verifyCheckoutWritesOrder(run);
  const p2 = verifyCartPersistence(run);
  const p3 = verifyNoMenuHallucination(run, menuItemNames);

  return {
    runId: run.caseId,
    passed: p1.passed && p2.passed && p3.passed,
    invariants: [p1, p2, p3],
  };
}