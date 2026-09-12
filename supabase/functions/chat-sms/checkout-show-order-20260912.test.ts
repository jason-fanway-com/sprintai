// P0 (2026-09-12, live trust incident, conv d79c1d98): "the bot refuses to
// show the customer their own order" once a payment link exists. Pins the
// PO's exact acceptance matrix against both regexes touched by the fix:
// CART_SUMMARY_RE (full-message read request, now usable in checkout too)
// and CART_SUMMARY_MENTION_RE (detects a read request braided into a longer
// compound message, e.g. "Show me the order. Yes it's for me").
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CART_SUMMARY_RE, CART_SUMMARY_MENTION_RE } from "./cart-summary-intent-20260909.ts";

const ACCEPTANCE_MATRIX = [
  "show me the order",
  "show me my order",
  "what's in my order",
  "what am I paying for",
  "read it back to me",
];

Deno.test("CART_SUMMARY_RE: acceptance matrix — all five phrasings match", () => {
  for (const phrase of ACCEPTANCE_MATRIX) {
    assertEquals(CART_SUMMARY_RE.test(phrase), true, `expected match: "${phrase}"`);
  }
});

Deno.test("CART_SUMMARY_RE: still fully anchored — never fires on an ordinary order line mentioning 'order'/'cart' mid-sentence", () => {
  assertEquals(CART_SUMMARY_RE.test("change the order to pickup"), false);
  assertEquals(CART_SUMMARY_RE.test("add fries to my order"), false);
  assertEquals(CART_SUMMARY_RE.test("no, I want to change my order"), false);
});

Deno.test("CART_SUMMARY_MENTION_RE: detects the read request inside the exact live compound message", () => {
  assertEquals(CART_SUMMARY_MENTION_RE.test("Show me the order. Yes it's for me"), true);
});

Deno.test("CART_SUMMARY_MENTION_RE: detects each acceptance-matrix phrase even mid-message", () => {
  for (const phrase of ACCEPTANCE_MATRIX) {
    assertEquals(CART_SUMMARY_MENTION_RE.test(`Sure. ${phrase}`), true, `expected mention match: "${phrase}"`);
  }
});

Deno.test("CART_SUMMARY_MENTION_RE: does NOT false-positive on an ordinary change request (deliberately narrower than the full anchored core)", () => {
  assertEquals(CART_SUMMARY_MENTION_RE.test("change the order to pickup instead"), false);
  assertEquals(CART_SUMMARY_MENTION_RE.test("that's not my order"), false);
});

Deno.test("CART_SUMMARY_MENTION_RE: a plain 'yes' with no read language does not match", () => {
  assertEquals(CART_SUMMARY_MENTION_RE.test("Yes it's for me"), false);
});
