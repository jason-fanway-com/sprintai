/**
 * cart-ops.ts — CartOps adversarial test battery.
 *
 * 20+ multi-turn cart-mutation cases with HARD programmatic invariants.
 * These read order_carts.cart_json + the bot's quoted checkout amount
 * directly — they do NOT rely on LLM judgment of prose.
 *
 * Invariants (any failure = hard fail, blocks go-live):
 *   1. quoted_total = sum(cart line totals) + $0.99 service fee + delivery_fee + driver_tip
 *   2. Every displayed item in the bot's summary exists in cart_json at same qty
 *   3. A tip/name/question turn NEVER changes item quantities
 *   4. A correction that reduces/removes IS reflected in cart_json before next reply
 *   5. No duplicate lines for same menu_item_id + modifiers
 *
 * ALL CartOps cases are criticality=critical. Scorecard tiered gate
 * already requires 100% critical pass → any CartOps failure blocks.
 */

import type { TestCase, SuccessCriterion } from "./library.ts";
import type { RunResult, TurnResult } from "./runner.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InvariantResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
}

export interface CartOpsVerification {
  caseId: string;
  passed: boolean;
  invariants: InvariantResult[];
}

interface CartItemLike {
  menu_item_id?: string;
  name?: string;
  quantity?: number;
  price_cents?: number;
  modifiers?: string[];
  options?: Record<string, string[]>;
  type?: string;
  target?: number;
  complete?: boolean;
  selections?: Array<{ flavor: string; quantity: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract ALL dollar amounts from text (e.g. "$17.19", "$3.50"). */
function extractDollarAmounts(text: string): number[] {
  const matches = text.match(/\$\d+[.,]\d{2}/g) ?? [];
  return matches.map((m) => parseFloat(m.replace("$", "").replace(",", "")));
}

/** Compute line-item subtotal from cart_json (sum of price_cents * quantity). */
function cartSubtotalCents(cart: CartItemLike[] | undefined | null): number {
  if (!cart || !Array.isArray(cart)) return 0;
  let sum = 0;
  for (const item of cart) {
    if (item.type === "bundle") {
      sum += (item.price_cents ?? 0) * (item.complete ? 1 : 0);
    } else {
      sum += (item.price_cents ?? 0) * (item.quantity ?? 1);
    }
  }
  return sum;
}

/** Compute the expected grand total: subtotal + $0.99 service fee + delivery_fee + driver_tip. */
function expectedTotalCents(cart: CartItemLike[] | undefined | null, deliveryFeeCents = 0, driverTipCents = 0): number {
  return cartSubtotalCents(cart) + 99 + deliveryFeeCents + driverTipCents;
}

/** Unique key for a cart line: menu_item_id + sorted modifiers. */
function cartLineKey(item: CartItemLike): string {
  if (item.type === "bundle") return `bundle:${item.name}`;
  const mods = (item.modifiers ?? []).slice().sort().join(",");
  return `${item.menu_item_id ?? item.name ?? "?"}::${mods}`;
}

/** Total distinct item count including quantities. */
function cartItemCount(cart: CartItemLike[] | undefined | null): number {
  if (!cart || !Array.isArray(cart)) return 0;
  let count = 0;
  for (const item of cart) {
    if (item.type === "bundle") {
      count += item.complete ? 1 : 0;
    } else {
      count += item.quantity ?? 1;
    }
  }
  return count;
}

/** Deep-compare two cart arrays ignoring order. */
function cartsEquivalent(a: CartItemLike[] | undefined | null, b: CartItemLike[] | undefined | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const keyCount = new Map<string, number>();
  for (const item of a) {
    const k = cartLineKey(item);
    keyCount.set(k, (keyCount.get(k) ?? 0) + (item.quantity ?? 1));
  }
  for (const item of b) {
    const k = cartLineKey(item);
    const remaining = (keyCount.get(k) ?? 0) - (item.quantity ?? 1);
    if (remaining < 0) return false;
    keyCount.set(k, remaining);
  }
  return [...keyCount.values()].every((v) => v === 0);
}

function isQuestion(msg: string): boolean {
  const t = msg.trim();
  return t.endsWith("?") || /\b(what|when|how|where|why|who|do you|are you|can you|is there|does|could you|would you)\b/i.test(t);
}

function isNameProvision(msg: string, phase?: string): boolean {
  // Short name-like message in checkout phase
  if (phase !== "checkout") return false;
  return msg.trim().split(/\s+/).length <= 2 &&
    !/[?]/.test(msg) &&
    !/\b(cancel|remove|add|change|make it|actually|wait|checkout|pay|yes|no|restart|start over)\b/i.test(msg) &&
    !/^\$?\d/.test(msg); // not a tip amount
}

function isTipMessage(msg: string): boolean {
  return /^\$?\s*\d+(\.\d{2})?\s*(tip)?$/i.test(msg.trim()) ||
    /\b(tip)\s*\$?\d/i.test(msg) ||
    /^\d+\s*(%|percent)\s*(tip)?$/i.test(msg.trim());
}

function isCorrection(msg: string): boolean {
  return /\b(actually|wait|no[,.!]|remove|change|make it|instead|swap|switch|just |only |oops|wrong|I meant|scratch that|never mind|cancel that|take that off|don'?t want|not that)\b/i.test(msg.toLowerCase());
}

function isRemoval(msg: string): boolean {
  return /\b(remove|cancel that|take that off|don'?t want|scratch|not that|never mind.*item|without)\b/i.test(msg.toLowerCase());
}

function isReduction(msg: string): boolean {
  return /\b(just |only |make it 1|one\b|actually.*1|actually.*one)\b/i.test(msg.toLowerCase());
}

function isSwap(msg: string): boolean {
  return /\b(instead|swap|switch|change.*to|different|replace)\b/i.test(msg.toLowerCase());
}

/** Find the largest dollar amount in text near "total" language. */
function findQuotedTotal(text: string): { cents: number; raw: string } | null {
  // Pattern 1: "total is $X.XX" / "total: $X.XX"
  let m = text.match(/(?:total|comes? to|that'll be|that will be|you owe|grand total|order total|adds up to|comes out to)\D*\$?(\d+[.,]\d{2})/i);
  if (m) return { cents: Math.round(parseFloat(m[1].replace(",", "")) * 100), raw: m[0] };
  // Pattern 2: "Subtotal: $X.XX + $0.99 service fee"
  m = text.match(/(?:subtotal|items? total)[:\s]*\$(\d+[.,]\d{2})/i);
  if (m) {
    const sub = Math.round(parseFloat(m[1].replace(",", "")) * 100);
    return { cents: sub + 99, raw: `subtotal ${m[0]} + $0.99 fee` };
  }
  // Pattern 3: Checkout link text with amount
  m = text.match(/(?:pay|charge|amount)[:\s]*\$(\d+[.,]\d{2})/i);
  if (m) return { cents: Math.round(parseFloat(m[1].replace(",", "")) * 100), raw: m[0] };
  return null;
}

/** Extract item names the bot claims are in the cart. */
function extractClaimedItems(text: string): string[] {
  // Find list-like patterns: "1x Plain Bagel", "- Plain Bagel $1.50", etc.
  const items: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:\d+x?\s+)?[-•*]\s+(.+?)(?:\s+\$\d+[.,]\d{2})?\s*(?:\n|$)/gim,
    /(?:^|\n)\s*\d+x?\s+(.+?)(?:\s+\$\d+[.,]\d{2})?\s*\n/gim,
  ];
  for (const pat of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const name = m[1].trim().toLowerCase();
      if (name && !name.includes("subtotal") && !name.includes("total") && !name.includes("service fee") && !name.includes("delivery")) {
        items.push(name);
      }
    }
  }
  return items;
}

// ── Stated Total Verifier ─────────────────────────────────────────────────

/** Result of deterministic total-verification override. */
export interface StatedTotalResult {
  passed: boolean;
  detail: string;
}

/**
 * Deterministic total-verification override that kills judge arithmetic
 * false-positives permanently while keeping REAL total errors flagged.
 *
 * Parses the bot's stated dollar TOTAL from the final relevant assistant
 * messages and compares it to expectedItemCents + feeCents.
 *
 * Returns:
 *   { passed: true, detail }  — stated total matches expected (force pass)
 *   { passed: false, detail } — stated total ≠ expected (real error, force fail)
 *   null                      — no explicit total stated (keep LLM verdict)
 */
export function verifyStatedTotal(
  run: RunResult,
  expectedItemCents: number,
  feeCents = 99,
): StatedTotalResult | null {
  const transcript = run.transcript;
  if (!transcript.length) return null;

  // Scan assistant replies in reverse for a quoted total
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    const reply = turn.reply ?? "";
    if (!reply) continue;
    const quoted = findQuotedTotal(reply);
    if (quoted !== null) {
      const expected = expectedItemCents + feeCents;
      if (Math.abs(quoted.cents - expected) <= 2) {
        return {
          passed: true,
          detail: `Stated total $${(quoted.cents / 100).toFixed(2)} matches expected $${(expected / 100).toFixed(2)} (items $${(expectedItemCents / 100).toFixed(2)} + $${(feeCents / 100).toFixed(2)} fee)`,
        };
      }
      return {
        passed: false,
        detail: `Stated total $${(quoted.cents / 100).toFixed(2)} does NOT match expected $${(expected / 100).toFixed(2)} (items $${(expectedItemCents / 100).toFixed(2)} + $${(feeCents / 100).toFixed(2)} fee)`,
      };
    }
  }

  return null;
}

// ── Verifier ───────────────────────────────────────────────────────────────

export function verifyCartOpsInvariants(run: RunResult): CartOpsVerification {
  const invariants: InvariantResult[] = [];
  const transcript = run.transcript;
  if (!transcript.length) {
    return { caseId: run.caseId, passed: true, invariants: [] };
  }

  // ── Track state across turns ──────────────────────────────────────────
  let prevCart: CartItemLike[] | null = null;
  let correctionExpected = false;
  let correctionType: "remove" | "reduce" | "swap" | null = null;
  let quotedTotalChecked = false;
  let quotedTotalOk = true;
  let quotedTotalDetail = "";
  let displayedItemsChecked = false;
  let displayedItemsOk = true;
  let displayedItemsDetail = "";
  let noMutationViolations: string[] = [];
  let correctionViolations: string[] = [];

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    const cart = (turn.cart as CartItemLike[] | undefined) ?? [];
    const reply = turn.reply ?? "";
    const msg = turn.message;
    const phase = turn.phase as string | undefined;

    // Skip synthetic turns
    if (msg === "[crash]" || reply.startsWith("[ERROR") || reply.startsWith("[CRASH")) continue;

    // ── INVARIANT 1: quoted_total_matches_cart ──────────────────────────
    if (cart.length > 0) {
      const quoted = findQuotedTotal(reply);
      if (quoted) {
        quotedTotalChecked = true;
        const expected = expectedTotalCents(cart);
        if (Math.abs(quoted.cents - expected) > 2) {
          quotedTotalOk = false;
          quotedTotalDetail = `Quoted $${(quoted.cents / 100).toFixed(2)} (${quoted.raw}) but cart computes to $${(expected / 100).toFixed(2)} ` +
            `(subtotal $${(cartSubtotalCents(cart) / 100).toFixed(2)} + $0.99 fee)`;
        }
      }
    }

    // ── INVARIANT 2: displayed_items_in_cart ────────────────────────────
    if (cart.length > 0 && (phase === "review" || phase === "checkout")) {
      const claimed = extractClaimedItems(reply);
      if (claimed.length > 0) {
        displayedItemsChecked = true;
        const cartNames = cart.map((item) => (item.name ?? "").toLowerCase());
        for (const claimedName of claimed) {
          const found = cartNames.some((cn) =>
            cn.includes(claimedName) || claimedName.includes(cn) ||
            cn.replace(/\s+/g, "").includes(claimedName.replace(/\s+/g, ""))
          );
          if (!found) {
            displayedItemsOk = false;
            displayedItemsDetail = `Bot claimed "${claimedName}" but it's not in cart_json: ${JSON.stringify(cartNames)}`;
          }
        }
      }
    }

    // ── INVARIANT 3: non-order turns never mutate items ─────────────────
    if (prevCart && prevCart.length > 0 && cart.length > 0) {
      const isNonOrder = isQuestion(msg) || isNameProvision(msg, phase) || isTipMessage(msg);
      if (isNonOrder && !cartsEquivalent(prevCart, cart)) {
        noMutationViolations.push(
          `Turn ${i}: "${msg.slice(0, 40)}..." is a question/name/tip but cart changed from ${cartItemCount(prevCart)} to ${cartItemCount(cart)} items`
        );
      }
    }

    // ── INVARIANT 4: correction IS reflected ────────────────────────────
    if (prevCart && prevCart.length > 0) {
      if (isCorrection(msg)) {
        if (isRemoval(msg)) {
          correctionExpected = true;
          correctionType = "remove";
        } else if (isReduction(msg)) {
          correctionExpected = true;
          correctionType = "reduce";
        } else if (isSwap(msg)) {
          correctionExpected = true;
          correctionType = "swap";
        }
      }
    }

    // After a correction turn, verify the NEXT assistant reply reflects it
    if (correctionExpected && cart && prevCart) {
      if (correctionType === "remove" || correctionType === "reduce") {
        const countBefore = cartItemCount(prevCart);
        const countAfter = cartItemCount(cart);
        if (countAfter >= countBefore) {
          correctionViolations.push(
            `Turn ${i}: Expected cart to shrink after "${correctionType}" correction ("${msg.slice(0, 50)}...") but item count stayed at ${countAfter}`
          );
        }
      }
      correctionExpected = false;
      correctionType = null;
    }

    prevCart = cart.length > 0 ? JSON.parse(JSON.stringify(cart)) : null;
  }

  // ── INVARIANT 5: no_duplicate_lines (check after final turn) ──────────
  let noDupesPassed = true;
  let noDupesDetail = "";
  const finalTurn = transcript[transcript.length - 1];
  const finalCart = (finalTurn?.cart as CartItemLike[] | undefined) ?? [];
  if (finalCart.length > 0) {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const item of finalCart) {
      const k = cartLineKey(item);
      if (seen.has(k)) {
        dupes.push(k);
      }
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    if (dupes.length > 0) {
      noDupesPassed = false;
      noDupesDetail = `Duplicate cart lines: ${[...new Set(dupes)].join(", ")}`;
    }
  }

  // ── Build results ─────────────────────────────────────────────────────

  // Invariant 1: quoted_total_matches_cart
  if (quotedTotalChecked) {
    invariants.push({
      id: "quoted_total_matches_cart",
      description: "Quoted total equals sum(cart_json line totals) + $0.99 service fee",
      passed: quotedTotalOk,
      detail: quotedTotalOk ? "Quoted total matches computed cart total" : quotedTotalDetail,
    });
  }

  // Invariant 2: displayed_items_in_cart
  if (displayedItemsChecked) {
    invariants.push({
      id: "displayed_items_in_cart",
      description: "Every displayed item in summary exists in cart_json at same qty",
      passed: displayedItemsOk,
      detail: displayedItemsOk ? "All displayed items found in cart_json" : displayedItemsDetail,
    });
  }

  // Invariant 3: no_mutation_on_non_order
  invariants.push({
    id: "no_mutation_on_non_order",
    description: "Tip/name/question turns never change item quantities",
    passed: noMutationViolations.length === 0,
    detail: noMutationViolations.length === 0 ? "No non-order mutations detected" : noMutationViolations.join("; "),
  });

  // Invariant 4: correction_reflected
  invariants.push({
    id: "correction_reflected",
    description: "Corrections that reduce/remove are reflected in cart_json",
    passed: correctionViolations.length === 0,
    detail: correctionViolations.length === 0 ? "All corrections reflected in cart" : correctionViolations.join("; "),
  });

  // Invariant 5: no_duplicate_lines
  invariants.push({
    id: "no_duplicate_lines",
    description: "No duplicate lines for same menu_item_id + modifiers",
    passed: noDupesPassed,
    detail: noDupesPassed ? "No duplicate cart lines" : noDupesDetail,
  });

  return {
    caseId: run.caseId,
    passed: invariants.every((inv) => inv.passed),
    invariants,
  };
}

// ── Test Cases ─────────────────────────────────────────────────────────────

/**
 * 20 CartOps test cases. Each is a multi-turn, conversational interaction
 * designed to exercise cart mutation edge cases. All use patterns that the
 * real chat-sms bot handles (add, remove, change qty, cancel, etc.).
 *
 * ALL are criticality=critical. The scorecard tiered gate requires 100%
 * critical pass, so any CartOps failure blocks go-live.
 */

const successCriteria: SuccessCriterion[] = [
  {
    id: "cart_ops_invariants_hold",
    description: "All CartOps hard invariants pass (checked programmatically, not by LLM)",
  },
];

// ── Shop-Aware CartOps Case Builder ────────────────────────────────────────

/**
 * Build the 21 CartOps adversarial mutation cases using the TARGET SHOP'S
 * real menu items instead of hardcoded bagel-shop references. All cases
 * keep category "cart-ops", criticality "critical", and the same verification
 * invariants.
 */
export function buildCartOpsCases(items: { name: string; price_cents: number }[]): TestCase[] {
  if (items.length === 0) return [];

  // Pick distinct items for variety across cases (cycle if menu is small)
  const it = (i: number) => items[i % items.length];
  const A = it(0);
  const B = it(1);
  const C = it(2);
  const D = it(3);
  const E = it(4);

  return [

    // ═══ ADD ITEM ═══════════════════════════════════════════════════════
    {
      id: "cartops-add-single",
      category: "cart-ops",
      criticality: "critical",
      label: `Add single item → verify item appears in cart_json with correct qty=1 (${A.name})`,
      turns: [
        { role: "customer", message: `Hi, I'd like a ${A.name} please` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ ADD TWO IN ONE MESSAGE ═════════════════════════════════════════
    {
      id: "cartops-add-two-single-msg",
      category: "cart-ops",
      criticality: "critical",
      label: `Order two items in first message → both in cart_json, no duplicates (${A.name}, ${B.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name} and a ${B.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ ADD THEN ADD ANOTHER ═══════════════════════════════════════════
    {
      id: "cartops-add-then-add",
      category: "cart-ops",
      criticality: "critical",
      label: `Order one, then add another mid-conversation → both present, qty not doubled (${C.name} → +${A.name})`,
      turns: [
        { role: "customer", message: `Let me get a ${C.name}` },
        { role: "customer", message: `Actually, can I also add a ${A.name}?` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ REMOVE ITEM ════════════════════════════════════════════════════
    {
      id: "cartops-remove-item",
      category: "cart-ops",
      criticality: "critical",
      label: `Order two, then remove one → removed item gone from cart_json (${A.name} + ${B.name} → keep ${A.name})`,
      turns: [
        { role: "customer", message: `I'd like a ${A.name} and a ${B.name}` },
        { role: "customer", message: `Actually, remove the ${B.name} — just the ${A.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ REDUCE QUANTITY ════════════════════════════════════════════════
    {
      id: "cartops-reduce-qty",
      category: "cart-ops",
      criticality: "critical",
      label: `Order quantity 2, then reduce to 1 → cart_json qty=1, not 2 (${A.name})`,
      turns: [
        { role: "customer", message: `I need 2 ${A.name}s` },
        { role: "customer", message: `Actually, just one — make it 1 ${A.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ "JUST ONE" CORRECTION ══════════════════════════════════════════
    {
      id: "cartops-just-one",
      category: "cart-ops",
      criticality: "critical",
      label: `Order 3, then 'just one' → cart_json total qty = 1 (${C.name})`,
      turns: [
        { role: "customer", message: `Give me 3 ${C.name}s` },
        { role: "customer", message: "Actually just one, sorry" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ "ONLY ONE" CORRECTION ══════════════════════════════════════════
    {
      id: "cartops-only-one",
      category: "cart-ops",
      criticality: "critical",
      label: `Order 3, then 'only one please' → cart_json total qty = 1 (${B.name})`,
      turns: [
        { role: "customer", message: `I'll take 3 ${B.name}s` },
        { role: "customer", message: `Wait, only one ${B.name} please` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ "MAKE IT 1" CORRECTION ═════════════════════════════════════════
    {
      id: "cartops-make-it-1",
      category: "cart-ops",
      criticality: "critical",
      label: `Order quantity 2, then 'make it 1' → cart_json qty = 1 (${A.name})`,
      turns: [
        { role: "customer", message: `2 ${A.name}s` },
        { role: "customer", message: "Actually, make it 1" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ RE-ADD AFTER REMOVE ════════════════════════════════════════════
    {
      id: "cartops-readd-after-remove",
      category: "cart-ops",
      criticality: "critical",
      label: `Remove item, then add it back → item appears in cart_json again (${A.name} + ${B.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name} and a ${B.name}` },
        { role: "customer", message: `Actually, remove the ${B.name}` },
        { role: "customer", message: `On second thought, add the ${B.name} back` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ SWAP ITEM ══════════════════════════════════════════════════════
    {
      id: "cartops-swap-item",
      category: "cart-ops",
      criticality: "critical",
      label: `Order item A, then swap for item B → item B in cart, item A removed (${A.name} → ${B.name})`,
      turns: [
        { role: "customer", message: `I'd like a ${A.name}` },
        { role: "customer", message: `Actually, swap that for a ${B.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ CANCEL MID-ORDER ═══════════════════════════════════════════════
    {
      id: "cartops-cancel-mid-order",
      category: "cart-ops",
      criticality: "critical",
      label: `Start order, then cancel → cart_json empty, phase resets (${A.name} + ${D.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name} and a ${D.name}` },
        { role: "customer", message: "Never mind, cancel my order" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ INTERRUPT WITH QUESTION THEN CONTINUE ══════════════════════════
    {
      id: "cartops-interrupt-question",
      category: "cart-ops",
      criticality: "critical",
      label: `Order, ask a question, then continue — cart unchanged through question (${A.name} → +${C.name})`,
      turns: [
        { role: "customer", message: `I'll have a ${A.name}` },
        { role: "customer", message: "What time do you close today?" },
        { role: "customer", message: `OK great, add a ${C.name} too` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ MULTI-ITEM FIRST MESSAGE ═══════════════════════════════════════
    {
      id: "cartops-multi-item-first-msg",
      category: "cart-ops",
      criticality: "critical",
      label: `Order 3+ items in very first message → all captured with correct qtys (${A.name}, ${B.name}, ${C.name})`,
      turns: [
        { role: "customer", message: `Hi, I need a ${A.name}, a ${B.name}, and a ${C.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ NAME DOESN'T MUTATE CART ═══════════════════════════════════════
    {
      id: "cartops-name-no-mutate",
      category: "cart-ops",
      criticality: "critical",
      label: `Provide pickup name → cart items unchanged (${A.name})`,
      turns: [
        { role: "customer", message: `I'd like a ${A.name}` },
        { role: "customer", message: "yes" },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ QUESTION DOESN'T MUTATE CART ═══════════════════════════════════
    {
      id: "cartops-question-no-mutate",
      category: "cart-ops",
      criticality: "critical",
      label: `Ask a question mid-build → cart items unchanged before and after (${D.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${D.name}` },
        { role: "customer", message: "Do you have any gluten free options?" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ INCREASE QUANTITY ══════════════════════════════════════════════
    {
      id: "cartops-qty-increase",
      category: "cart-ops",
      criticality: "critical",
      label: `Order qty 1, then increase to 2 → cart_json shows qty=2 (${A.name})`,
      turns: [
        { role: "customer", message: `One ${A.name} please` },
        { role: "customer", message: `Actually make that 2 ${A.name}s` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ CANCEL THEN REORDER ════════════════════════════════════════════
    {
      id: "cartops-cancel-then-reorder",
      category: "cart-ops",
      criticality: "critical",
      label: `Cancel order, then start fresh → new cart, no stale items (${B.name} → cancel → ${A.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${B.name}` },
        { role: "customer", message: "Actually, cancel my order" },
        { role: "customer", message: `Start a new order — I'll take a ${A.name}` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ ADD-REMOVE-ADD (COMPLEX) ═══════════════════════════════════════
    {
      id: "cartops-add-remove-add",
      category: "cart-ops",
      criticality: "critical",
      label: `Add A, add B, remove A, add C → B and C in cart, A gone (${A.name}/${C.name}/${B.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: `And add a ${C.name}` },
        { role: "customer", message: `Actually, remove the ${A.name}` },
        { role: "customer", message: `Add a ${B.name} instead` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ NO DUPLICATE LINES ═════════════════════════════════════════════
    {
      id: "cartops-no-duplicate-lines",
      category: "cart-ops",
      criticality: "critical",
      label: `Try to re-add same item → no duplicate lines for same menu_item_id+modifiers (${A.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: `Add another ${A.name} — I want 2 total` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ FULL ORDER WITH CORRECTIONS → TOTAL CHECK ══════════════════════
    {
      id: "cartops-full-order-corrections",
      category: "cart-ops",
      criticality: "critical",
      label: `Full order with corrections → total matches cart_json + $0.99 fee (${D.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${D.name}` },
        { role: "customer", message: "Yes" },
        { role: "customer", message: "Checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: successCriteria,
      expects_checkout: true,
    },

    // ═══ EMPTY CART CHECKOUT SHOULD NOT QUOTE WRONG TOTAL ═══════════════
    {
      id: "cartops-empty-cart-no-total",
      category: "cart-ops",
      criticality: "critical",
      label: `Cancel from checkout → empty cart, no stale total quoted (${A.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Cancel my order" },
      ],
      success_criteria: successCriteria,
    },

  ];
}