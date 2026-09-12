/**
 * hallucination_guard "they're" contraction false-positive — Red-Green Evidence (2026-09-12)
 *
 * Bug: isQuestionOrFragment() filters captured "item claims" using
 * PRONOUN_DETERMINER_STOPLIST (contains "they"), but checked RAW tokens —
 * never contraction-normalized. "they're" never equals "they" in the set, so
 * a correct bot reply like "You got it - they're already set at 6 Pieces."
 * had "they're already set" extracted by gotPat and flagged as a
 * hallucinated item, flipping menu-single-9 (Zio's) from pass to fail.
 *
 * Fix 1: normalizeContraction() (already used for words[0]) is now applied
 * to every word before the PRONOUN_DETERMINER_STOPLIST lookup.
 * Fix 2: verifyHallucinationGuard now also resolves a claim against the
 * current turn's own cart (turn.cart), not just the shop menu — a phrase
 * that matches neither is prose, not a claim.
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/hallucination-guard-contraction-20260912.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyHallucinationGuard, isQuestionOrFragment } from "./cart-ops.ts";
import type { RunResult } from "./runner.ts";

const ZIOS_MENU = new Set([
  "Jalapeno Poppers",
  "Cheese Pizza - Small (10\")",
  "Garden Salad",
]);

Deno.test("isQuestionOrFragment: 'they're already set' is caught via the pronoun stoplist (contraction-normalized)", () => {
  assertEquals(isQuestionOrFragment("they're already set"), true);
});

Deno.test("exact menu-single-9 (Zio's) repro: 'You got it - they're already set at 6 Pieces.' does NOT flag as hallucination", () => {
  const run: RunResult = {
    transcript: [
      { role: "customer", message: "I'd like a Jalapeno Poppers please" },
      {
        role: "assistant",
        message: "",
        reply: "Got it - Jalapeno Poppers are in the cart!",
        cart: [{ name: "Jalapeno Poppers", quantity: 1, price_cents: 899 }],
      },
      { role: "customer", message: "6 Pieces" },
      {
        role: "assistant",
        message: "",
        reply: "You got it - they're already set at 6 Pieces.",
        cart: [{ name: "Jalapeno Poppers", quantity: 1, price_cents: 899 }],
      },
    ],
  } as unknown as RunResult;

  const r = verifyHallucinationGuard(run, ZIOS_MENU);
  assertEquals(r.passed, true);
});

// ── Control: must STILL catch a real hallucination not resolvable via menu or cart ──

Deno.test("control: 'Got it, one Lobster Thermidor added' (not on menu, not in cart) STILL flags", () => {
  const run: RunResult = {
    transcript: [
      {
        role: "assistant",
        message: "",
        reply: "Got it, one Lobster Thermidor added to your cart.",
        cart: [{ name: "Jalapeno Poppers", quantity: 1, price_cents: 899 }],
      },
    ],
  } as unknown as RunResult;

  const r = verifyHallucinationGuard(run, ZIOS_MENU);
  assertEquals(r.passed, false);
  assertEquals(r.detail.includes("Lobster Thermidor"), true);
});
