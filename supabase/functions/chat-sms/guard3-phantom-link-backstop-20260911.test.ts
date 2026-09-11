// Coverage gap closed (2026-09-11, per docs/specs/2026-09-11-guard-retirement-audit.md):
// Guard 3 (index.ts ~line 8173, "POST-TURN PHANTOM-LINK SAFETY NET") is a
// payment-integrity backstop -- "payment links can only be sent on a paid
// cart" -- with zero located test coverage before this file. The audit flagged
// it as the single highest-priority NEEDS-COVERAGE-FIRST item on the whole
// 36-guard list given its blast radius: a phantom payment link is real
// customer money confusion (a customer paying, or believing they paid, on a
// cart that was never actually submitted to Stripe).
//
// This is a NEW test proving CURRENT behavior, not a bug fix. It does not
// modify Guard 3.
//
// index.ts calls Deno.serve() only behind `if (import.meta.main)`, so the
// guard's own trigger function, claimsPaymentSent(), is directly importable
// and exercised for real below. The guard's surrounding branch logic
// (checkoutAlreadyExists, honestFallbackReply, the RECOVER/EXISTS/FALLBACK
// decision, and the final `safeReply` gate a few hundred lines later) lives
// inline in the single large HTTP handler and is not decomposed into
// importable functions -- same constraint documented in
// guard-defects-20260906.test.ts and money-footer-double-render-20260909.test.ts.
// Per that same house pattern (see e1-guard-crash-20260907.test.ts), the
// non-exported pieces are mirrored here verbatim from index.ts and pinned
// against the actual source text via regex, so a future edit that changes
// the guard's real behavior without updating this file fails loudly instead
// of silently passing against a stale copy.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimsPaymentSent } from "./index.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// ── Part 1: real claimsPaymentSent() detection ──────────────────────────────
// This is the guard's actual trigger condition, imported and run for real
// (not a mirror) -- if this function stops matching a phantom-link claim,
// the rest of the guard never fires, no matter what the branch logic does.

Deno.test("claimsPaymentSent: fires on a hallucinated payment-link reply (the exact shape submit_order would never actually produce)", () => {
  assert(claimsPaymentSent("All set! Payment link sent -- check your texts. Order confirmed!"));
  assert(claimsPaymentSent("Your order is placed. Tap the link we texted you to pay."));
  assert(claimsPaymentSent("Thanks for your order! You're all set."));
});

Deno.test("claimsPaymentSent: does NOT fire on ordinary mid-order chatter (no false positives that would trip the guard on a normal reply)", () => {
  assert(!claimsPaymentSent("Got it, one Large Cheese Pizza. What else would you like?"));
  assert(!claimsPaymentSent("Your subtotal so far is $17.99. Anything else?"));
  assert(!claimsPaymentSent("What's your name for the order?"));
});

// ── Part 2: branch behavior, mirroring index.ts's non-exported decision logic ──
// Mirrors checkoutAlreadyExists() and honestFallbackReply() (index.ts ~3128,
// ~3148) plus the Guard 3 if/else-if/else block that calls them (~8186-8250).
// If index.ts changes any of these, update this mirror too.

interface MirrorCartLine {
  menu_item_id?: string;
  quantity?: number;
  type?: "bundle";
  complete?: boolean;
}

function checkoutAlreadyExistsMirror(
  row: { stripe_checkout_session_id?: string | null; phase?: string } | null | undefined,
): boolean {
  return !!row && (!!row.stripe_checkout_session_id || row.phase === "checkout");
}

function honestFallbackReplyMirror(cart: MirrorCartLine[], incompleteBundle = false, hasHistory = false): string {
  if (!cart || cart.length === 0) {
    return hasHistory
      ? "Sorry, I didn't catch that — what would you like to order?"
      : "What can I get started for you? Let me know your items and I'll get your order going.";
  }
  if (incompleteBundle) {
    return "Almost there! Your bundle still needs a few more picks before I can send your payment link. What else would you like in it?";
  }
  return "Got your order! What's the name for the order? Once I have that I'll send your payment link.";
}

// Mirrors the Guard 3 decision: given the model's phantom-claiming reply and
// the authoritative (not-yet-paid) cart state, what does the customer
// actually receive? `forceSubmit` stands in for the real executeTool("submit_order", ...)
// call -- injected so this test never touches the network/DB, matching how
// the guard itself only calls it when the cart is genuinely submittable.
function runGuard3Mirror(opts: {
  modelReply: string;
  cart: MirrorCartLine[];
  incompleteBundle: boolean;
  pickupName: string | undefined;
  cartRow: { stripe_checkout_session_id?: string | null; phase?: string } | null;
  hasHistory: boolean;
  forceSubmit: () => { ok: boolean; checkoutUrl?: string };
}): { reply: string; checkoutUrl: string | undefined } {
  let reply = opts.modelReply;
  let checkoutUrl: string | undefined;

  // Guard trigger, verbatim: `if (!checkoutUrl && claimsPaymentSent(reply))`.
  // checkoutUrl starts falsy in this scenario (submit_order was never
  // actually called this turn -- that's the whole point of the phantom-link
  // case this guard exists for).
  if (!checkoutUrl && claimsPaymentSent(reply)) {
    const hasItems = opts.cart.length > 0;

    if (checkoutAlreadyExistsMirror(opts.cartRow)) {
      reply = "Your payment link was already sent -- check your texts or email for it. Tap it to finish your order.";
    } else if (hasItems && !opts.incompleteBundle && opts.pickupName) {
      const forced = opts.forceSubmit();
      if (forced.ok && forced.checkoutUrl) {
        checkoutUrl = forced.checkoutUrl;
      } else {
        reply = honestFallbackReplyMirror(opts.cart, false, opts.hasHistory);
      }
    } else {
      reply = honestFallbackReplyMirror(opts.cart, opts.incompleteBundle, opts.hasHistory);
    }
  }

  return { reply, checkoutUrl };
}

const PHANTOM_CLAIM = "All set! Payment link sent -- check your texts. Order confirmed! Thanks for your order.";

Deno.test("Guard 3 mirror: NOT-paid cart, no items -- phantom claim is replaced with an honest fallback, never a link", () => {
  const forceSubmitCalled = { count: 0 };
  const result = runGuard3Mirror({
    modelReply: PHANTOM_CLAIM,
    cart: [],
    incompleteBundle: false,
    pickupName: undefined,
    cartRow: { stripe_checkout_session_id: null, phase: "building" },
    hasHistory: true,
    forceSubmit: () => { forceSubmitCalled.count++; return { ok: true, checkoutUrl: "https://pay.example/x" }; },
  });

  assertEquals(result.checkoutUrl, undefined, "an empty cart must never end up with a checkout URL");
  assertEquals(claimsPaymentSent(result.reply), false, "the replacement reply must not itself re-trip the payment-claim detector");
  assertEquals(result.reply.includes("http"), false, "no link of any kind may reach the customer for an unsubmittable cart");
  assertEquals(forceSubmitCalled.count, 0, "must never attempt to force a real order for an empty cart");
});

Deno.test("Guard 3 mirror: NOT-paid cart, incomplete bundle -- phantom claim is replaced with the bundle-incomplete fallback, never a link", () => {
  const result = runGuard3Mirror({
    modelReply: PHANTOM_CLAIM,
    cart: [{ menu_item_id: "bundle-1", type: "bundle", complete: false }],
    incompleteBundle: true,
    pickupName: "Jason",
    cartRow: { stripe_checkout_session_id: null, phase: "building" },
    hasHistory: true,
    forceSubmit: () => ({ ok: true, checkoutUrl: "https://pay.example/x" }),
  });

  assertEquals(result.checkoutUrl, undefined);
  assertEquals(claimsPaymentSent(result.reply), false);
  assertStringIncludes(result.reply, "still needs a few more picks");
});

Deno.test("Guard 3 mirror: NOT-paid cart, has items + pickup name but forced submit fails -- honest fallback, never a link", () => {
  const result = runGuard3Mirror({
    modelReply: PHANTOM_CLAIM,
    cart: [{ menu_item_id: "cheeseburger", quantity: 1 }],
    incompleteBundle: false,
    pickupName: "Jason",
    cartRow: { stripe_checkout_session_id: null, phase: "building" },
    hasHistory: true,
    forceSubmit: () => ({ ok: false }), // e.g. shop closed, menu item pulled mid-turn, Stripe error
  });

  assertEquals(result.checkoutUrl, undefined);
  assertEquals(claimsPaymentSent(result.reply), false);
  assertEquals(result.reply.includes("http"), false);
});

Deno.test("Guard 3 mirror: a session already exists on the row -- honest reminder is sent, no duplicate session, no fabricated link text", () => {
  const forceSubmitCalled = { count: 0 };
  const result = runGuard3Mirror({
    modelReply: PHANTOM_CLAIM,
    cart: [{ menu_item_id: "cheeseburger", quantity: 1 }],
    incompleteBundle: false,
    pickupName: "Jason",
    cartRow: { stripe_checkout_session_id: "cs_real_existing_session", phase: "checkout" },
    hasHistory: true,
    forceSubmit: () => { forceSubmitCalled.count++; return { ok: true, checkoutUrl: "https://pay.example/NEW" }; },
  });

  assertEquals(forceSubmitCalled.count, 0, "must never create a second session when one already exists (idempotency)");
  assertStringIncludes(result.reply, "already sent");
  assertEquals(result.reply.includes("https://pay.example/NEW"), false, "must not fabricate a brand-new link when a real one already exists");
});

Deno.test("Guard 3 mirror: genuinely submittable cart -- RECOVER path produces a real checkoutUrl instead of trusting the model's claim", () => {
  const result = runGuard3Mirror({
    modelReply: PHANTOM_CLAIM,
    cart: [{ menu_item_id: "cheeseburger", quantity: 1 }],
    incompleteBundle: false,
    pickupName: "Jason",
    cartRow: { stripe_checkout_session_id: null, phase: "building" },
    hasHistory: true,
    forceSubmit: () => ({ ok: true, checkoutUrl: "https://pay.example/real-session" }),
  });

  assertEquals(result.checkoutUrl, "https://pay.example/real-session");
});

// ── Part 3: pin the real guard's structure in index.ts ──────────────────────
// Regex assertions against the actual source, not the mirror above -- catches
// a future edit that silently changes the trigger condition or drops a
// branch's safe reassignment of `reply`, which the mirror alone cannot detect
// since it would keep passing against its own frozen copy.

Deno.test("SOURCE PIN: Guard 3's trigger is exactly '!checkoutUrl && claimsPaymentSent(reply)'", () => {
  assertStringIncludes(INDEX_SOURCE, "if (!checkoutUrl && claimsPaymentSent(reply)) {");
});

Deno.test("SOURCE PIN: every Guard 3 branch reassigns `reply` (or forces a real checkoutUrl) -- none can fall through leaving the model's phantom claim intact", () => {
  const guardStart = INDEX_SOURCE.indexOf("if (!checkoutUrl && claimsPaymentSent(reply)) {");
  assert(guardStart !== -1, "Guard 3 block not found in index.ts");
  // The block is self-contained and ends before the D2-retirement comment
  // that immediately follows it (see docs/specs/2026-09-11-guard-retirement-audit.md
  // guard inventory row 34).
  const guardEnd = INDEX_SOURCE.indexOf("D2 (retired 2026-09-04)", guardStart);
  assert(guardEnd !== -1, "expected marker after Guard 3 not found -- index.ts structure changed, update this test's slice boundary");
  const guardBlock = INDEX_SOURCE.slice(guardStart, guardEnd);

  assertStringIncludes(guardBlock, 'reply = "Your payment link was already sent');
  assertStringIncludes(guardBlock, "reply = honestFallbackReply(guardCart, false, !isLifetimeFirstContact);");
  assertStringIncludes(guardBlock, "reply = honestFallbackReply(guardCart, !!incompleteBundle, !isLifetimeFirstContact);");
  assertStringIncludes(guardBlock, "checkoutUrl = forced.checkoutUrl;");
});

Deno.test("SOURCE PIN: the final safeReply gate never lets a falsy-checkoutUrl reply through unexamined -- it's whatever Guard 3 already made safe", () => {
  assertStringIncludes(
    INDEX_SOURCE,
    'safeReply = `Payment link sent!${totalStr} Tap it to complete your order. Check your text or email.`;',
  );
  // The else branch: `safeReply = reply;` -- correct ONLY because Guard 3 (which
  // runs earlier, unconditionally, before this gate) has already overwritten
  // `reply` in every phantom-claim scenario. This test's Part 2 above is what
  // makes that "only because" true; this pin just proves the wiring order
  // still holds in the real file.
  const guard3Index = INDEX_SOURCE.indexOf("if (!checkoutUrl && claimsPaymentSent(reply)) {");
  const finalGateIndex = INDEX_SOURCE.indexOf("safeReply = reply;");
  assert(guard3Index !== -1 && finalGateIndex !== -1, "expected markers not found");
  assert(guard3Index < finalGateIndex, "Guard 3 must run BEFORE the final safeReply gate, not after");
});
