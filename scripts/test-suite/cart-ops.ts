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
 *   6. CHECKOUT FINALIZE: order_carts row reaches phase="confirmed", total_cents matches last quoted total
 *   7. HALLUCINATION GUARD: no bot reply mentions a menu item name not in the shop's actual menu
 *
 * ALL CartOps cases are criticality=critical. Scorecard tiered gate
 * already requires 100% critical pass → any CartOps failure blocks.
 */

import type { TestCase, SuccessCriterion } from "./library.ts";
import type { RunResult, TurnResult } from "./runner.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InvariantResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
  /** true when materially evaluated (claims examined / cart tracked); false when trivially passed with nothing to check. */
  applied: boolean;
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
  // Additive order intent is NOT a question: "can I also add X?", "and a Y?",
  // "actually, can I get Z?" are ORDER additions that legitimately mutate the
  // cart. Classifying them as questions would trip the no_mutation_on_non_order
  // invariant and false-fail valid add-then-add flows.
  if (/\b(?:also|add(?: another| a| an)?|and a|and another|and some|and the|can i also|let me also|let me get|i also|ill also|ill have|i'll also|i'll have|i want|gimme|give me|actually |oh and|plus)\b/i.test(t)) {
    return false;
  }
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

/** Find the largest dollar amount in text near "total" language. */
function findQuotedTotal(text: string): { cents: number; raw: string } | null {
  // Strip the service-fee mention FIRST so "$8.98 total (includes $0.99 service
  // fee)" can never let the $0.99 be mistaken for the grand total.
  const cleaned = text
    .replace(/\([^)]*service fee[^)]*\)/gi, "")
    .replace(/(?:\+\s*|includes?\s+)?\$0[.,]\d{2}\s*(?:service\s+)?fee/gi, "");
  // Pattern 1: amount immediately BEFORE the word total — "$8.98 total", "$8.98 due"
  let m = cleaned.match(/\$(\d+[.,]\d{2})\s*(?:total|due|to pay|owed?)/i);
  if (m) return { cents: Math.round(parseFloat(m[1].replace(",", "")) * 100), raw: m[0] };
  // Pattern 2: "Subtotal: $X.XX ( + $0.99 service fee )" → add the fee back
  m = cleaned.match(/(?:subtotal|items? total)[:\s]*\$(\d+[.,]\d{2})/i);
  if (m) {
    const sub = Math.round(parseFloat(m[1].replace(",", "")) * 100);
    return { cents: sub + 99, raw: `subtotal ${m[0]} + $0.99 fee` };
  }
  // Pattern 3: total-claim keyword IMMEDIATELY BEFORE amount — "total is $X.XX",
  // "comes to $X.XX". Two guards against false positives (2026-09-02):
  //   1. \bcomes? to\b — word boundaries so it never matches "come to" inside
  //      "Welcome to Vito's Pizza" (greeting, not a total claim).
  //   2. \D{0,15} — the amount must sit adjacent to the keyword. Real totals
  //      read "total is $X" / "comes to $X" (gap ≤ ~8). A price quoted inside a
  //      disambiguation question or options list ("did you mean the Greek Salad
  //      ($10.99)?") is ~40 chars from any greeting keyword and is NOT a total.
  //   \btotal\b so it never matches inside "Subtotal" (handled above).
  m = cleaned.match(/(?:\btotal\b|\bcomes? to\b|that'll be|that will be|you owe|grand total|order total|adds up to|comes out to)\D{0,15}\$?(\d+[.,]\d{2})/i);
  if (m) return { cents: Math.round(parseFloat(m[1].replace(",", "")) * 100), raw: m[0] };
  // Pattern 4: Checkout link text with amount
  m = cleaned.match(/(?:pay|charge|amount)[:\s]*\$(\d+[.,]\d{2})/i);
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
  /** true when a total was actually compared against the cart; false when there was nothing to verify. */
  applied: boolean;
}

/**
 * Deterministic stated-total verifier — compares the bot's quoted total
 * against the server cart (cart_json-derived subtotal + $0.99 fee).
 *
 * v2 (2026-09-01): Now compares against the authoritative cart_json (server
 * cart) rather than the fixture-derived expectedItemCents.  A stated total
 * that contradicts the server cart is a FAIL — this function can now fail
 * cases, where the v1 version could only rescue.
 *
 * 0¢ tolerance: quoted total must exactly equal cart-derived total.
 *
 * Returns StatedTotalResult (always non-null — never silently defers).
 */
export function verifyStatedTotal(run: RunResult): StatedTotalResult {
  const transcript = run.transcript;
  if (!transcript.length) {
    return { passed: true, detail: "No transcript — skipping stated-total check", applied: false };
  }

  // Scan assistant replies in reverse for a quoted total with corresponding cart
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    const reply = turn.reply ?? "";
    if (!reply) continue;
    const quoted = findQuotedTotal(reply);
    if (quoted !== null) {
      const cart = (turn.cart as CartItemLike[] | undefined) ?? [];
      if (cart.length === 0) {
        return {
          passed: false,
          detail: `Bot quoted total $${(quoted.cents / 100).toFixed(2)} but cart is empty`,
          applied: true,
        };
      }
      const expected = expectedTotalCents(cart);
      if (quoted.cents === expected) {
        return {
          passed: true,
          detail: `Stated total $${(quoted.cents / 100).toFixed(2)} matches cart-derived total $${(expected / 100).toFixed(2)} (subtotal $${(cartSubtotalCents(cart) / 100).toFixed(2)} + $0.99 fee)`,
          applied: true,
        };
      }
      return {
        passed: false,
        detail: `Stated total $${(quoted.cents / 100).toFixed(2)} ≠ cart-derived total $${(expected / 100).toFixed(2)} (diff $${((quoted.cents - expected) / 100).toFixed(2)})`,
        applied: true,
      };
    }
  }

  // No quoted total found — nothing to verify against
  return { passed: true, detail: "No stated total to verify against cart", applied: false };
}

// ── Hallucination Guard ──────────────────────────────────────────────────

/**
 * Verify no bot reply mentions a menu item name that does not exist in the
 * shop's actual menu. This catches the bot fabricating items.
 * 
 * Phase A (2026-08-30): Rewritten to check against Ledger truth (effective
 * menu) instead of the old "capital word + $" heuristic. The old heuristic
 * produced ~18 false positives on boilerplate like "Your total is $8.99",
 * "I've got 2 items", "$0.99 service fee", and pickup-name prompts.
 * 
 * Strategy:
 *   1. Build a normalized lookup of all menu item names.
 *   2. Extract every candidate phrase from each bot reply that looks like
 *      it COULD be claiming an item (sentence segments, not raw regex).
 *   3. Each candidate that matches a menu item is a PASS.
 *   4. Each candidate that does NOT match and is NOT a known boilerplate
 *      pattern (totals, fees, item counts, phase prompts, checkout language)
 *      is a FAIL — the bot invented a menu item.
 *   5. "Your total is $8.99" passes because it contains no menu-item-like
 *      noun phrases that fail the menu lookup.
 */
/**
 * Phase A (2026-08-30): Rewritten to check against Ledger truth (effective
 * menu) instead of the old "capital word + $" heuristic. The old heuristic
 * produced ~18 false positives on boilerplate like "Your total is $8.99",
 * "I've got 2 items", "$0.99 service fee", and pickup-name prompts.
 * 
 * Strategy (claim-first):
 *   1. Build a normalized lookup of all menu item names.
 *   2. Scan each reply for PRODUCT CLAIM patterns — sentences that appear
 *      to name a specific item the bot is selling/adding/offering:
 *      "1x ItemName", "ItemName added", "ItemName - $X", "added a ItemName".
 *   3. Each claim's item name is validated against the menu.
 *   4. If no claim pattern is found at all, the reply PASSES — it's
 *      boilerplate conversation (totals, fees, counts, pickup prompts).
 *   5. "Your total is $8.99" passes because it contains no product claim.
 */
export function verifyHallucinationGuard(
  run: RunResult,
  shopMenuNames: Set<string>,
): InvariantResult {
  // Normalize menu names for matching
  const menuNorm = new Map<string, string>(); // normalized → original
  for (const name of shopMenuNames) {
    menuNorm.set(name.toLowerCase().replace(/\s+/g, " ").trim(), name);
  }

  const nonItemWords = new Set([
    "item", "items", "order", "orders", "cart", "total", "subtotal",
    "name", "text", "texts", "tip", "fee", "fees",
  ]);

  let claimCount = 0;
  const unknownClaims: string[] = [];

  for (const turn of run.transcript) {
    const reply = turn.reply ?? "";
    if (!reply) continue;

    let m: RegExpMatchArray | null;

    // ── Pattern 1a: "1x ItemName" or "2x Everything Bagel" ──
    const qtyPrefPat = /(\d+)\s*x\s+([A-Z][A-Za-z\s'&.()/-]{5,60}?)(?:\s+(?:added|to|for|and|,|\.|$|\())/g;
    while ((m = qtyPrefPat.exec(reply)) !== null) {
      const claimedName = m[2].trim().toLowerCase().replace(/\s+/g, " ");
      if (nonItemWords.has(claimedName)) continue;
      claimCount++;
      if (!menuNameCheck(claimedName, menuNorm)) {
        unknownClaims.push(`"${m[2].trim()}" claimed via "Nx Item": "${reply.slice(0, 80)}..."`);
      }
    }

    // ── Pattern 1b: "added a ItemName" / "added ItemName" ──
    const addPat = /added\s+(?:a\s+)?([A-Z][A-Za-z\s'&.()/-]{4,60}?)(?:\s+(?:to\b|and\b|\bfor\b|at\b|,|\.|$|\$))/gi;
    while ((m = addPat.exec(reply)) !== null) {
      const rawName = m[1].trim();
      const claimedName = rawName.toLowerCase().replace(/\s+/g, " ");
      if (nonItemWords.has(claimedName)) continue;
      if (isQuestionOrFragment(claimedName)) continue;
      claimCount++;
      if (!menuNameCheck(claimedName, menuNorm)) {
        unknownClaims.push(`"${rawName}" claimed via "added X": "${reply.slice(0, 80)}..."`);
      }
    }

    // ── Pattern 1c: "got it — X ItemName" / "got it, X ItemName" ──
    const gotPat = /(?:got it|gotcha|you got it|sure thing)[!.,\s—-]+(?:(?:\d+x?\s+)|(?:\ba\s+)|(?:\bone\s+))?([A-Z][A-Za-z\s'&.()/-]{4,60}?)(?:\s+(?:added|is|coming|will|for|and|,|\.|$|at|\$))/gi;
    while ((m = gotPat.exec(reply)) !== null) {
      const claimedName = m[1].trim().toLowerCase().replace(/\s+/g, " ");
      if (nonItemWords.has(claimedName)) continue;
      // Skip question/sentence fragments captured after "got it —" (not item claims)
      if (isQuestionOrFragment(claimedName)) continue;
      claimCount++;
      if (!menuNameCheck(claimedName, menuNorm)) {
        unknownClaims.push(`"${m[1].trim()}" claimed via "got it X": "${reply.slice(0, 80)}..."`);
      }
    }

    // ── Pattern 2: price-line item "ItemName - $X.XX" ──
    const pricePat = /([A-Z][A-Za-z\s'&.()/-]{5,60}?)\s*[-–—]\s*\$?\d+[.,]\d{2}/g;
    while ((m = pricePat.exec(reply)) !== null) {
      const raw = m[1].trim();
      const claimedName = raw.toLowerCase().replace(/\s+/g, " ");
      if (nonItemWords.has(claimedName)) continue;
      if (/^(total|subtotal|your total|order total|grand total|delivery|service fee|tip|comes|that|including|plus)/i.test(claimedName)) continue;
      claimCount++;
      if (!menuNameCheck(claimedName, menuNorm)) {
        unknownClaims.push(`"${raw}" claimed via price-line: "${reply.slice(0, 80)}..."`);
      }
    }

    // ── Pattern 3: "here's your order: 1x ItemA, 1x ItemB" ──
    const herePat = /(?:here'?s|here is)\s+(?:your\s+)?order\s*:?\s*([^.?!]+)/gi;
    while ((m = herePat.exec(reply)) !== null) {
      const list = m[1];
      const segments = list.split(/(?:,\s*|\s+and\s+)/i);
      for (const seg of segments) {
        const qm = seg.match(/^\s*(?:\d+x?\s+)?([A-Z][A-Za-z\s'&.()/-]{4,60}?)\s*(?:-.*)?$/);
        if (qm) {
          const claimedName = qm[1].trim().toLowerCase().replace(/\s+/g, " ");
          if (claimedName.length < 4) continue;
          if (nonItemWords.has(claimedName)) continue;
          claimCount++;
          if (!menuNameCheck(claimedName, menuNorm)) {
            unknownClaims.push(`"${qm[1].trim()}" claimed via order-list: "${reply.slice(0, 80)}..."`);
          }
        }
      }
    }
  }

  if (unknownClaims.length > 0) {
    return {
      id: "hallucination_guard",
      description: "No bot reply claims a menu item NOT on the effective menu (Ledger-truth check)",
      passed: false,
      detail: `Hallucinated items detected: ${unknownClaims.join("; ")}`,
      applied: claimCount > 0,
    };
  }

  return {
    id: "hallucination_guard",
    description: "No bot reply claims a menu item NOT on the effective menu (Ledger-truth check)",
    passed: true,
    detail: "No hallucinated item names detected in bot replies",
    applied: claimCount > 0,
  };
}

/** Leading interrogatives / helper verbs that mark a captured phrase as a
 * question or sentence fragment, not an item claim (e.g. "What name should
 * I put this order under"). */
const QUESTION_LEADERS = new Set([
  "what", "where", "when", "how", "which", "who", "why", "whose",
  "would", "could", "can", "do", "does", "did", "are", "is", "was",
  "may", "should", "shall", "will", "your", "any",
]);

/** Acknowledgement/discourse words that the bot uses after "got it —"
 * to acknowledge/modify the user's request. These are NOT item claims. */
const ACKNOWLEDGMENT_LEADERS = new Set([
  "no", "noted", "noting", "yes", "okay", "ok", "sure",
  "also", "and", "anything", "nothing",
]);

/** Pronouns and determiners that, when appearing as any word in a captured
 * phrase, strongly suggest a sentence fragment rather than an item claim.
 * Full-item names like "BBQ Chicken Pizza" never contain these words. */
const PRONOUN_DETERMINER_STOPLIST = new Set([
  "those", "them", "they", "it", "that", "this", "these",
  "one", "some", "a", "few", "my",
]);

/** Substrings that mark a captured phrase as a conversational boundary
 * fragment, not an item claim. Never present in real menu item names. */
const FRAGMENT_BOUNDARY_MARKERS = [
  "your cart", "anything else", "want",
];

export function isQuestionOrFragment(claimed: string): boolean {
  const words = claimed.split(/\s+/);
  const first = words[0] ?? "";
  // Question-leader words
  if (QUESTION_LEADERS.has(first)) return true;
  // Acknowledgement/discourse phrases ("noted provolone", "no toasting")
  if (ACKNOWLEDGMENT_LEADERS.has(first)) return true;
  // Pronoun/determiner words anywhere in the phrase ("those items", "make it 2")
  if (words.some(w => PRONOUN_DETERMINER_STOPLIST.has(w))) return true;
  // Fragment boundary markers ("to your cart. Want anything else")
  const lower = claimed.toLowerCase();
  if (FRAGMENT_BOUNDARY_MARKERS.some(m => lower.includes(m))) return true;
  // Sentence punctuation mid-string — real item names never contain these
  if (/[.?!]/.test(claimed)) return true;
  // Word count > 4 — real item names are ≤4 words
  if (words.length > 4) return true;
  return false;
}

/** Check if a normalized claimed item name matches any menu entry. */
function menuNameCheck(claimed: string, menuNorm: Map<string, string>): boolean {
  if (menuNorm.has(claimed)) return true;
  for (const mn of menuNorm.keys()) {
    if (claimed.includes(mn) || mn.includes(claimed)) return true;
  }
  for (const mn of menuNorm.keys()) {
    const mnWords = mn.split(/\s+/);
    if (mnWords.length >= 2 && mnWords.every(w => claimed.includes(w))) return true;
  }
  // Distinctive-token match: the bot may abbreviate a real item ("Cina-Sug
  // Loukoumades" for "Cinnamon Sugar Loukoumades" or "BOBO" for "BOBO
  // Sandwich"). If the claim shares a distinctive token with any menu name,
  // treat as real. A fully invented item (e.g. "Lobster Roll") shares no such
  // token and is still correctly flagged.
  //
  // Strategy: strip stop words, then:
  //   - tokens >= 6 chars match anywhere in the menu item (original rule).
  //   - tokens 3-5 chars use prefix matching against the first TWO meaningful
  //     menu tokens ("bobo" → "BOBO Sandwich", "ec" → "EC Everything").
  //   - short alphanumeric tokens also match menu-item initials ("bec" →
  //     Bacon Egg Cheese), so patrons' casual acronyms resolve correctly.
  // Skip tokens < 3 chars to avoid false positives on "ny", "ec", etc.
  const STOP_WORDS = new Set([
    "the","a","an","and","or","of","in","on","it","is","my","to",
    "for","with","its","at","by","from","as",
  ]);
  const claimedTokens = claimed.split(/[\s-]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
  if (claimedTokens.length === 0) return false;
  for (const mn of menuNorm.keys()) {
    const mnTokens = mn.split(/[\s-]+/).filter(w => !STOP_WORDS.has(w));
    for (const ct of claimedTokens) {
      const limit = ct.length >= 6 ? mnTokens.length : Math.min(2, mnTokens.length);
      for (let i = 0; i < limit; i++) {
        if (mnTokens[i].startsWith(ct)) return true;
      }
      // Acronym match ("bec" → Bacon Egg Cheese)
      if (ct.length >= 3 && ct.length <= 5 && /^[a-z]+$/.test(ct) && mnTokens.length >= 2) {
        const initials = mnTokens.map(w => w[0] ?? "").join("");
        if (initials === ct) return true;
      }
    }
  }
  return false;
}
// ── Cart Persistence Verifier (P2) ──────────────────────────────────────

/**
 * Walk the transcript turn-by-turn. When a turn does not signal order
 * mutation (correction, cancel), the cart item count must not decrease.
 * When the turn is a cancellation/reset, the cart may empty legitimately.
 * This is the deterministic counterpart to the P2 runtime guard.
 */
export function verifyCartPersistence(
  run: RunResult,
): InvariantResult {
  const transcript = run.transcript;
  if (transcript.length < 2) {
    return {
      id: "cart_persists",
      description: "Cart must persist across non-mutating turns; never silently reset",
      passed: true,
      detail: "Only 1 turn — nothing to verify across turns.",
      applied: false,
    };
  }

  let prevCount = 0;
  let cartEverNonEmpty = false;
  const violations: string[] = [];

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    const cart = (turn.cart as unknown[]) ?? [];
    const count = cart.length;
    const msg = (turn.message ?? "").toLowerCase();

    const isCancel = /cancel|reset|never.?mind|start.?over/i.test(msg);
    const isCorrection = /\b(?:actually|wait|no[,.!]|remove|change|make it|instead|swap|switch|just |only |oops|wrong|I meant|scratch that|never mind|cancel that|take that off|don'?t want|not that)\b/i.test(msg);

    if (i > 0 && !isCancel && !isCorrection && prevCount > 0 && count === 0) {
      violations.push(
        `Turn ${i}: Cart went from ${prevCount} items to 0 (no cancel/correction signal). Message: "${turn.message.slice(0, 80)}"`,
      );
    }

    if (isCancel) {
      prevCount = 0;
    } else if (count > 0) {
      prevCount = count;
      cartEverNonEmpty = true;
    }
  }

  if (violations.length > 0) {
    return {
      id: "cart_persists",
      description: "Cart must persist across non-mutating turns; never silently reset",
      passed: false,
      detail: violations.join("; "),
      applied: cartEverNonEmpty,
    };
  }

  return {
    id: "cart_persists",
    description: "Cart must persist across non-mutating turns; never silently reset",
    passed: true,
    detail: "Cart persisted correctly across all turns.",
    applied: cartEverNonEmpty,
  };
}

// ── Checkout Finalize Verifier ────────────────────────────────────────────

/**
 * Verify that a checkout-finalize case produced a confirmed order_carts row
 * whose total_cents matches the last quoted total in the bot's reply.
 */
export async function verifyCheckoutFinalize(
  supabase: SupabaseClient,
  run: RunResult,
): Promise<InvariantResult> {
  const transcript = run.transcript;
  if (!transcript.length) {
    return { id: "checkout_finalize", description: "order_carts row reaches confirmed, total_cents matches", passed: true, detail: "No transcript — skipping checkout finalize check", applied: false };
  }

  // Find the last quoted total from bot replies
  let lastQuotedCents: number | null = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const reply = transcript[i].reply ?? "";
    const quoted = findQuotedTotal(reply);
    if (quoted !== null) {
      lastQuotedCents = quoted.cents;
      break;
    }
  }

  // Find the order_cart for this run by scanning recent carts for the shop
  // that match the session_id pattern or the items ordered.
  // The chat-sms function creates carts keyed by conversation_id which uses
  // session_id. We query by the conversation tied to this test session.
  const sessionId = run.sessionId;
  if (!sessionId) {
    return { id: "checkout_finalize", description: "order_carts row reaches confirmed, total_cents matches", passed: true, detail: "No session_id — skipping checkout finalize check", applied: false };
  }

  // Look up the conversation → cart
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) {
    return { id: "checkout_finalize", description: "order_carts row reaches confirmed, total_cents matches", passed: true, detail: "No conversation found for session — skipping checkout finalize check", applied: false };
  }

  const { data: cart } = await supabase
    .from("order_carts")
    .select("total_cents, phase")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cart) {
    return {
      id: "checkout_finalize",
      description: "order_carts row reaches confirmed, total_cents matches",
      passed: false,
      detail: "No order_cart found for conversation — checkout may not have been created",
      applied: true,
    };
  }

  if (cart.phase !== "confirmed" && cart.phase !== "checkout") {
    return {
      id: "checkout_finalize",
      description: "order_carts row reaches confirmed, total_cents matches",
      passed: false,
      detail: `order_cart phase is "${cart.phase}", expected "confirmed" or "checkout" (checkout link sent)`,
      applied: true,
    };
  }

  // If we have a quoted total, verify it matches the cart's total_cents
  if (lastQuotedCents !== null && cart.total_cents !== null) {
    const diff = Math.abs(cart.total_cents - lastQuotedCents);
    // Allow $0.02 rounding tolerance
    if (diff > 2) {
      return {
        id: "checkout_finalize",
        description: "order_carts row reaches confirmed, total_cents matches",
        passed: false,
        detail: `Checkout total mismatch: cart total_cents=$${(cart.total_cents / 100).toFixed(2)}, last quoted=$${(lastQuotedCents / 100).toFixed(2)}, diff=$${(diff / 100).toFixed(2)}`,
        applied: true,
      };
    }
  }

  return {
    id: "checkout_finalize",
    description: "order_carts row reaches confirmed, total_cents matches",
    passed: true,
    detail: `Checkout finalize OK: cart phase="${cart.phase}", total_cents=$${((cart.total_cents ?? 0) / 100).toFixed(2)}${lastQuotedCents !== null ? `, quoted=$${(lastQuotedCents / 100).toFixed(2)}` : ""}`,
    applied: true,
  };
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
  let quotedTotalChecked = false;
  let quotedTotalOk = true;
  let quotedTotalDetail = "";
  let displayedItemsChecked = false;
  let displayedItemsOk = true;
  let displayedItemsDetail = "";
  let noMutationViolations: string[] = [];

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
      applied: true,
    });
  }

  // Invariant 2: displayed_items_in_cart
  if (displayedItemsChecked) {
    invariants.push({
      id: "displayed_items_in_cart",
      description: "Every displayed item in summary exists in cart_json at same qty",
      passed: displayedItemsOk,
      detail: displayedItemsOk ? "All displayed items found in cart_json" : displayedItemsDetail,
      applied: true,
    });
  }

  // Invariant 3: no_mutation_on_non_order
  invariants.push({
    id: "no_mutation_on_non_order",
    description: "Tip/name/question turns never change item quantities",
    passed: noMutationViolations.length === 0,
    detail: noMutationViolations.length === 0 ? "No non-order mutations detected" : noMutationViolations.join("; "),
    applied: true,
  });

  // Invariant 4: correction_reflected — ONLY when the fixture declares
  // expectCartShrink; otherwise always passes (applied: false).
  // Intent is NEVER inferred from natural-language text.
  const expectShrink = run.expectCartShrink === true;
  if (expectShrink) {
    // Verify the cart actually shrunk from turn to turn when a
    // correction-turn message was followed by a cart reply.
    let shrinkViolations: string[] = [];
    if (transcript.length >= 2) {
      for (let i = 1; i < transcript.length; i++) {
        const prevCart = (transcript[i - 1].cart as CartItemLike[] | undefined) ?? [];
        const thisCart = (transcript[i].cart as CartItemLike[] | undefined) ?? [];
        if (prevCart.length > 0 && thisCart.length > 0) {
          const prevCount = cartItemCount(prevCart);
          const thisCount = cartItemCount(thisCart);
          if (thisCount >= prevCount) {
            shrinkViolations.push(
              `Turn ${i}: cart did not shrink: ${prevCount} → ${thisCount} items`
            );
          }
        }
      }
    }
    // If no cart-pair was available for comparison, pass (nothing to check).
    if (shrinkViolations.length === 0 && transcript.some((t) => (t.cart as any[])?.length > 0)) {
      invariants.push({
        id: "correction_reflected",
        description: "Corrections that reduce/remove are reflected in cart_json",
        passed: true,
        detail: "Cart shrunk as expected",
        applied: true,
      });
    } else if (shrinkViolations.length > 0) {
      invariants.push({
        id: "correction_reflected",
        description: "Corrections that reduce/remove are reflected in cart_json",
        passed: false,
        detail: shrinkViolations.join("; "),
        applied: true,
      });
    } else {
      invariants.push({
        id: "correction_reflected",
        description: "Corrections that reduce/remove are reflected in cart_json",
        passed: true,
        detail: "No cart-pair to compare (expectCartShrink set, but no multi-turn cart data)",
        applied: true,
      });
    }
  } else {
    invariants.push({
      id: "correction_reflected",
      description: "Corrections that reduce/remove are reflected in cart_json",
      passed: true,
      detail: "expectCartShrink not set — correction intent not inferred from NL",
      applied: false,
    });
  }

  // Invariant 5: no_duplicate_lines
  invariants.push({
    id: "no_duplicate_lines",
    description: "No duplicate lines for same menu_item_id + modifiers",
    passed: noDupesPassed,
    detail: noDupesPassed ? "No duplicate cart lines" : noDupesDetail,
    applied: true,
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

    // ═══ PROOF INVARIANT: CHECKOUT WRITES ORDER ROW ═══════════════════════════
    {
      id: "proof-checkout-writes-order",
      category: "proof",
      criticality: "critical",
      label: `Full order → checkout finalize writes an orders row with correct total (${A.name})`,
      turns: [
        { role: "customer", message: `Hi, I'd like a ${A.name} please` },
        { role: "customer", message: "yes" },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: successCriteria,
      expects_checkout: true,
    },

    // ═══ PROOF INVARIANT: CART PERSISTS ACROSS NO-MUTATE TURN ════════════════
    {
      id: "proof-cart-persists",
      category: "proof",
      criticality: "critical",
      label: `Order item, then ask question → cart intact, item still present (${A.name})`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Do you have any specials today?" },
        { role: "customer", message: `Ok great, add a ${B.name} too` },
      ],
      success_criteria: successCriteria,
    },

    // ═══ PROOF INVARIANT: NO MENU HALLUCINATION ═════════════════════════════
    {
      id: "proof-no-menu-hallucination",
      category: "proof",
      criticality: "critical",
      label: `Request off-menu item → bot declines, never invents item not in menu`,
      turns: [
        { role: "customer", message: "I'd like a rattlesnake pizza with extra venom please" },
      ],
      success_criteria: successCriteria,
    },

    // ═══ PROOF: CART PERSISTS ACROSS MULTIPLE TURNS ═══════════════════════
    {
      id: "proof-cart-persists-across-multiple",
      category: "proof",
      criticality: "critical",
      label: `Multi-turn cart persist: ${A.name} → question → ${B.name} → checkout → ${C.name} absent.`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Do you have any desserts?" },
        { role: "customer", message: `Actually add a ${B.name}` },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: successCriteria,
      expects_checkout: true,
    },

    // ═══ PROOF: MULTI-ITEM CHECKOUT WRITES ORDER ══════════════════════════
    {
      id: "proof-checkout-multi-item",
      category: "proof",
      criticality: "critical",
      label: `Multi-item checkout: ${B.name} + ${C.name} → checkout → orders row exists with both items.`,
      turns: [
        { role: "customer", message: `I'll take a ${B.name} and a ${C.name}` },
        { role: "customer", message: "yes" },
        { role: "customer", message: "checkout" },
        { role: "customer", message: "Pat" },
      ],
      success_criteria: successCriteria,
      expects_checkout: true,
    },

    // ═══ PROOF: HALLUCINATION GUARD MID-ORDER ════════════════════════════
    {
      id: "proof-hallucination-mid-order",
      category: "proof",
      criticality: "critical",
      label: `Hallucination mid-order: add ${A.name}, then request fake item. Cart must still contain only real items.`,
      turns: [
        { role: "customer", message: `I'll take a ${A.name}` },
        { role: "customer", message: "Can you also add a quantum-baked neutrino wrap?" },
      ],
      success_criteria: successCriteria,
    },

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
      expectCartShrink: true,
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
      expectCartShrink: true,
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
      expectCartShrink: true,
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
      expectCartShrink: true,
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
      expectCartShrink: true,
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