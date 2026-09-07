// Live P0 bug (2026-09-07). conv-cancel-item threw a 500 three times in the
// same Proof run (12:53:39 / 12:53:46 / 12:53:56 UTC), never reproduced by
// hand — because it only fires when the E1 GUARD path (clear_cart suppressed
// due to additive intent) actually triggers, which is rare.
//
// ROOT CAUSE: index.ts's E1 GUARD warn log (~line 1750, inside
// runOrderingLoop) referenced `conversation.id` — but `conversation` is not
// a parameter or local of runOrderingLoop (its params are cart/cartId/etc.,
// no conversation object). This throws `ReferenceError: conversation is not
// defined` every time the guard fires, turning a log statement into an
// uncaught exception on a live customer path.
//
// FIX: log `cartId` (already in scope) instead of the nonexistent
// `conversation.id`.
//
// This logic lives inline in an async request handler, not an importable
// module (same convention as correction-buckets-20260906.test.ts) — the
// guard's condition regexes and log-line construction are copied verbatim
// from index.ts. If index.ts changes either, update this file too.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

function e1GuardWarnLine(userMessage: string, cartId: string, cartLength: number): string | null {
  const e1msg = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const isExplicitRestart = /^(start over|restart|cancel (?:everything|all|the order|it all|my order)|new order|clear (?:the cart|it all|everything)|reset|wipe (?:the cart|it|everything))[!.]?$/i.test(e1msg)
    || /\b(?:cancel\s+(?:my\s+)?order|cancel\s+(?:everything|all|it\s+all)|forget\s+(?:it|the whole|everything)|start\s+over|wipe\s+(?:the\s+)?(?:cart|it|everything|all))\b/i.test(e1msg);
  const isAdditive = /\b(?:also|add(?: another| a| an)?|and a|and another|and some|and the|can i also|let me also|let me get|i also|ill also|ill have|i'll also|i'll have|i want|gimme|give me|actually |oh and|plus)\b/i.test(e1msg);
  if (isAdditive && !isExplicitRestart && cartLength > 0) {
    return `[chat-sms] E1 GUARD: suppressed clear_cart — additive user intent (cartId=${cartId}, cart has ${cartLength} items). Message: ${JSON.stringify(userMessage).slice(0, 120)}`;
  }
  return null;
}

Deno.test("E1 GUARD: additive message with items in cart does not throw and logs cartId, not a nonexistent conversation object", () => {
  const cartId = "cart-abc-123";
  // The bug was a ReferenceError thrown during this call — if it regresses,
  // this call throws and the test fails with the same error class the live
  // bot hit (rather than a plain assertion mismatch).
  const line = e1GuardWarnLine("and also a garlic knots", cartId, 2);
  assertEquals(line, `[chat-sms] E1 GUARD: suppressed clear_cart — additive user intent (cartId=${cartId}, cart has 2 items). Message: "and also a garlic knots"`);
});

Deno.test("E1 GUARD: explicit restart is not suppressed (guard does not fire, no log line)", () => {
  const line = e1GuardWarnLine("cancel my order", "cart-abc-123", 2);
  assertEquals(line, null);
});

Deno.test("E1 GUARD: empty cart never triggers the guard", () => {
  const line = e1GuardWarnLine("and also a garlic knots", "cart-abc-123", 0);
  assertEquals(line, null);
});

Deno.test("index.ts no longer references conversation.id in the E1 GUARD log line", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const guardLineMatch = src.match(/E1 GUARD: suppressed clear_cart.*$/m);
  assert(guardLineMatch, "E1 GUARD log line not found in index.ts — update this test if it moved/changed");
  assert(
    !guardLineMatch![0].includes("conversation.id"),
    "regression: E1 GUARD log line references conversation.id again, which is out of scope in runOrderingLoop and throws ReferenceError at runtime",
  );
});
