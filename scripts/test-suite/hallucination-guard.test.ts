/**
 * hallucination_guard contraction false-positive — Red-Green Evidence (2026-09-07)
 *
 * Bug: the bot's own correct checkout line "Got it! What's your name for the
 * order?" was flagged as a hallucinated menu item. Root cause: Pattern 1c
 * (gotPat) captures "What's your name" as the claimed item name after
 * "Got it! ". isQuestionOrFragment() is supposed to filter it via
 * QUESTION_LEADERS.has(first), but QUESTION_LEADERS contains "what", not the
 * contraction "what's" — so the check silently misses, the fragment falls
 * through to menuNameCheck(), and (correctly) fails it since it's not a menu
 * item, producing a false hallucination report.
 *
 * Fix, three layers of defense:
 *   1. Contraction normalization — "what's"/"isn't"/"won't" etc. strip/map to
 *      the leading word their uncontracted form would have before the
 *      QUESTION_LEADERS / ACKNOWLEDGMENT_LEADERS lookup.
 *   2. Question-mark lookahead — if the clause immediately following the
 *      captured span ends in "?" before any other sentence terminator, it's
 *      never treated as an item claim, regardless of the leading word.
 *   3. Hard-exempt known transactional phrases (name / pickup / total /
 *      payment link) outright, rather than relying only on the generic
 *      fragment heuristics.
 * menuNameCheck() itself (the real hallucination signal — does this resolve
 * to an actual menu item) is untouched; these are pre-filters only.
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/hallucination-guard.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyHallucinationGuard, isQuestionOrFragment, isTransactionalClaim } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

function run(reply: string): RunResult {
  return { transcript: [{ reply, cart: [] }] } as unknown as RunResult;
}

const VITOS_MENU = new Set([
  "Cheese Pizza - Small (10\")",
  "Wings (Bone-In) - 10 Pieces",
  "Greek Salad",
  "Everything Stromboli Roll",
]);

// ── RED→GREEN: the exact failing string must NOT be flagged ──

Deno.test("'Got it! What's your name for the order?' does NOT flag as hallucination", () => {
  const r = verifyHallucinationGuard(run("Got it! What's your name for the order?"), VITOS_MENU);
  assertEquals(r.passed, true);
});

Deno.test("other contractions ('Who's', 'Where's') behave the same as their bare form", () => {
  const who = verifyHallucinationGuard(run("Got it! Who's this order for?"), VITOS_MENU);
  assertEquals(who.passed, true);
  const where = verifyHallucinationGuard(run("Got it! Where's the best spot for pickup?"), VITOS_MENU);
  assertEquals(where.passed, true);
});

// ── Defense-in-depth layers, tested directly against the pure functions ──

Deno.test("isQuestionOrFragment: contraction-leading claim is caught via QUESTION_LEADERS", () => {
  assertEquals(isQuestionOrFragment("what's your name"), true);
});

Deno.test("isQuestionOrFragment: question-mark lookahead catches a claim even without a leading question word", () => {
  // No leading question word, but the clause it's part of ends in "?"
  assertEquals(isQuestionOrFragment("ready for pickup", " today?"), true);
});

Deno.test("isTransactionalClaim: hard-exempts name/pickup/total/payment-link phrasing", () => {
  assertEquals(isTransactionalClaim("what's your name"), true);
  assertEquals(isTransactionalClaim("ready for pickup"), true);
  assertEquals(isTransactionalClaim("your total is"), true);
  assertEquals(isTransactionalClaim("payment link"), true);
  assertEquals(isTransactionalClaim("chicken piccata"), false);
});

// ── Control case: must STILL catch a real hallucination after the fix ──

Deno.test("control: 'Got it, one Lobster Thermidor added' (not on menu) STILL flags", () => {
  const r = verifyHallucinationGuard(run("Got it, one Lobster Thermidor added to your cart."), VITOS_MENU);
  assertEquals(r.passed, false);
  assertEquals(r.detail.includes("Lobster Thermidor"), true);
});

// ── Must still pass a correct, on-menu claim ──

Deno.test("control: 'Got it, one Greek Salad added' (on menu) passes", () => {
  const r = verifyHallucinationGuard(run("Got it, one Greek Salad added to your cart."), VITOS_MENU);
  assertEquals(r.passed, true);
});
