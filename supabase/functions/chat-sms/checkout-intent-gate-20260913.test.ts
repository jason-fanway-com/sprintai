// Tests for checkout-intent-gate-20260913.ts — see that file's header for the
// full incident background. These exercise the REAL exported function, not a
// hand-copied mirror (same discipline as guard9/guard13's test files).

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isExplicitCheckoutIntent,
  shouldRedirectNameAskToCheckoutGate,
  renderGuard23Redirect,
  CHECKOUT_READY_QUESTION_RE,
  PICKUP_NAME_QUESTION_RE,
  FINAL_CONFIRM_QUESTION_RE,
} from "./checkout-intent-gate-20260913.ts";

const READY_Q = "You've got 2 items in your cart. Anything else, or ready to check out?";
const ANYTHING_ELSE_ONLY = "Add anything else?";
const NAME_ASK = "What's your name for the order?";
const NAME_CONFIRM = "Putting this in for Jason, right?";

// ── Incident A (live, 2026-09-13): "Yes to delivery but I want pepperoni
//    this time" must never read as checkout/name-confirm intent — the "yes"
//    answers a delivery question, not the ready-to-checkout question, and
//    the turn also carries competing intent (a topping change). ───────────

Deno.test("incident A: 'Yes to delivery but I want pepperoni this time' never authorizes checkout, whatever the bot just asked", () => {
  const msg = "Yes to delivery but I want pepperoni this time";
  assertFalse(isExplicitCheckoutIntent(msg, "Delivery again to 12 Main St?", true));
  assertFalse(isExplicitCheckoutIntent(msg, READY_Q, true));
  assertFalse(isExplicitCheckoutIntent(msg, NAME_CONFIRM, true));
});

Deno.test("incident A shape without the competing clause: a bare 'yes' to a NON-checkout question still does not authorize", () => {
  assertFalse(isExplicitCheckoutIntent("yes", "Delivery again to 12 Main St?", false));
});

// ── Incident B (conv fdf5ec8e, live paid order): "yes to Jason, can you add
//    fries" / "yes but add fries to that" must never authorize a clean
//    name-confirm — the compound turn carries competing intent (a named
//    item). ───────────────────────────────────────────────────────────────

Deno.test("incident B: 'Yes but add fries to that' never authorizes checkout after a name-confirm ask", () => {
  assertFalse(isExplicitCheckoutIntent("Yes but add fries to that", NAME_CONFIRM, true));
  assertFalse(isExplicitCheckoutIntent("yes to Jason, can you add fries", NAME_CONFIRM, true));
});

Deno.test("incident B: 'show me the order' (repeated) never authorizes checkout on its own", () => {
  assertFalse(isExplicitCheckoutIntent("Show me the order", NAME_CONFIRM, true));
  assertFalse(isExplicitCheckoutIntent("Show me the order", NAME_CONFIRM, true));
});

// ── Bare "yes" must NEVER authorize checkout unless it's answering the
//    specific ready-to-checkout question ────────────────────────────────────

Deno.test("bare yes with no prior question does not authorize checkout", () => {
  assertFalse(isExplicitCheckoutIntent("yes", null, false));
});

Deno.test("bare yes answering a plain 'anything else?' does not authorize checkout", () => {
  assertFalse(isExplicitCheckoutIntent("yes", ANYTHING_ELSE_ONLY, false));
});

Deno.test("bare yes answering the ready-to-checkout question DOES authorize checkout", () => {
  assert(isExplicitCheckoutIntent("yes", READY_Q, false));
});

Deno.test("bare yeah/yep/sure/correct answering the ready-to-checkout question all authorize checkout", () => {
  for (const word of ["yeah", "yep", "yup", "sure", "correct", "Yes.", "yes!"]) {
    assert(isExplicitCheckoutIntent(word, READY_Q, false), `expected "${word}" to authorize`);
  }
});

// ── Explicit customer-initiated checkout phrases work regardless of
//    what the bot asked last ────────────────────────────────────────────────

Deno.test("explicit phrases authorize checkout as the customer's own opening statement", () => {
  for (const phrase of ["that's it", "thats it", "that's all", "ready to check out", "ready to checkout", "send me the link", "send the link", "checkout", "check out", "done", "I'm done"]) {
    assert(isExplicitCheckoutIntent(phrase, null, false), `expected "${phrase}" to authorize`);
    assert(isExplicitCheckoutIntent(phrase, ANYTHING_ELSE_ONLY, false), `expected "${phrase}" to authorize regardless of prior question`);
  }
});

Deno.test("explicit phrase inside an unrelated sentence does not authorize checkout", () => {
  assertFalse(isExplicitCheckoutIntent("I'll check out the menu first", null, false));
});

// ── Pickup-name question path: giving/confirming a name is not itself
//    checkout intent, but is treated as answering a question that was only
//    ever asked after intent was already established — UNLESS this turn
//    also carries a competing ask ──────────────────────────────────────────

Deno.test("a bare name answering the cold name-ask authorizes checkout (no competing intent)", () => {
  assert(isExplicitCheckoutIntent("Jason", NAME_ASK, false));
});

Deno.test("a bare confirmation answering the known-name confirm authorizes checkout (no competing intent)", () => {
  assert(isExplicitCheckoutIntent("yes", NAME_CONFIRM, false));
  assert(isExplicitCheckoutIntent("yep that's me", NAME_CONFIRM, false));
});

Deno.test("a name-question reply WITH competing intent never authorizes checkout", () => {
  assertFalse(isExplicitCheckoutIntent("Jason", NAME_ASK, true));
  assertFalse(isExplicitCheckoutIntent("yes", NAME_CONFIRM, true));
});

Deno.test("a name given with no preceding name question does not authorize checkout", () => {
  assertFalse(isExplicitCheckoutIntent("Jason", ANYTHING_ELSE_ONLY, false));
  assertFalse(isExplicitCheckoutIntent("Jason", null, false));
});

// ── Final pre-submit "Confirm?" question (happy path, name already known) ──

Deno.test("bare yes answering the model's own 'Confirm?' question authorizes checkout (no competing intent)", () => {
  assert(isExplicitCheckoutIntent("yes", "All good — confirm?", false));
  assert(isExplicitCheckoutIntent("yep", "Confirm?", false));
});

Deno.test("bare yes answering 'Confirm?' WITH competing intent never authorizes checkout", () => {
  assertFalse(isExplicitCheckoutIntent("yes, add a coke too", "All good — confirm?", true));
});

// ── Empty/whitespace input never authorizes ─────────────────────────────────

Deno.test("empty or whitespace-only message never authorizes checkout", () => {
  assertFalse(isExplicitCheckoutIntent("", READY_Q, false));
  assertFalse(isExplicitCheckoutIntent("   ", READY_Q, false));
  assertFalse(isExplicitCheckoutIntent(undefined, READY_Q, false));
  assertFalse(isExplicitCheckoutIntent(null, READY_Q, false));
});

// ── Sanity on the exported regexes themselves ───────────────────────────────

Deno.test("CHECKOUT_READY_QUESTION_RE matches every ready-to-checkout phrasing this file sends", () => {
  assert(CHECKOUT_READY_QUESTION_RE.test("Anything else, or ready to check out?"));
  assert(CHECKOUT_READY_QUESTION_RE.test("Anything else or ready to checkout?"));
  assert(CHECKOUT_READY_QUESTION_RE.test("did you want to remove your last item, or are you all set and ready to checkout?"));
  assertFalse(CHECKOUT_READY_QUESTION_RE.test("Anything else?"));
  assertFalse(CHECKOUT_READY_QUESTION_RE.test("Add anything else?"));
});

Deno.test("PICKUP_NAME_QUESTION_RE matches the cold ask and the known-name confirm", () => {
  assert(PICKUP_NAME_QUESTION_RE.test(NAME_ASK));
  assert(PICKUP_NAME_QUESTION_RE.test(NAME_CONFIRM));
  assert(PICKUP_NAME_QUESTION_RE.test("Putting this order in for Mike, right?"));
});

Deno.test("FINAL_CONFIRM_QUESTION_RE matches both prompt wordings of the pre-submit question", () => {
  assert(FINAL_CONFIRM_QUESTION_RE.test("Confirm?"));
  assert(FINAL_CONFIRM_QUESTION_RE.test("All good — confirm?"));
  assertFalse(FINAL_CONFIRM_QUESTION_RE.test("Anything else, or ready to check out?"));
});

// ── GUARD 23 (shouldRedirectNameAskToCheckoutGate) regression tests ─────────
// Core spec requirement: item-add → upsell → "anything else, or ready to check
// out?" → ONLY THEN name-ask. A model reply that tries to name-ask before
// checkout intent has been established must be redirected. ───────────────────

// The regression scenario: customer adds an item; bot model eagerly asks for
// the name in the SAME turn (zero checkout intent this turn, none persisted).
// Gate must fire and redirect that reply.
Deno.test("GUARD 23: bare item-add turn followed by model name-ask reply fires the gate (no intent this turn, none persisted)", () => {
  assert(shouldRedirectNameAskToCheckoutGate(
    "What's your name for the order?",
    false,   // hasPickupName: no name on file
    false,   // checkoutIntentEstablishedThisTurn: customer just added an item, no checkout phrase
    false,   // checkoutIntentConfirmedPersisted: never established earlier either
  ));
});

Deno.test("GUARD 23: model name-confirm reply also fires the gate when intent was never established", () => {
  assert(shouldRedirectNameAskToCheckoutGate(
    "Putting this in for Jason, right?",
    false, false, false,
  ));
});

// Non-checkout message after item add — customer says something unrelated.
// Gate still fires because checkoutIntentEstablishedThisTurn is false.
Deno.test("GUARD 23: non-checkout customer message in next turn still blocks premature name-ask", () => {
  assert(shouldRedirectNameAskToCheckoutGate(
    "What's your name for the order?",
    false,  // hasPickupName
    false,  // checkoutIntentEstablishedThisTurn: customer said "add a coke" or similar
    false,  // checkoutIntentConfirmedPersisted: still never established
  ));
});

// Gate does NOT fire when the customer established intent THIS turn.
Deno.test("GUARD 23: gate does NOT fire when checkout intent is established this turn", () => {
  assertFalse(shouldRedirectNameAskToCheckoutGate(
    "What's your name for the order?",
    false,  // hasPickupName
    true,   // checkoutIntentEstablishedThisTurn: customer said "that's it" / "ready to check out"
    false,  // checkoutIntentConfirmedPersisted
  ));
});

// Gate does NOT fire when intent was established in a PRIOR turn (persisted).
Deno.test("GUARD 23: gate does NOT fire when checkout intent was persisted from an earlier turn", () => {
  assertFalse(shouldRedirectNameAskToCheckoutGate(
    "What's your name for the order?",
    false,  // hasPickupName
    false,  // checkoutIntentEstablishedThisTurn
    true,   // checkoutIntentConfirmedPersisted: set in migration 139, established earlier
  ));
});

// Gate does NOT fire when a pickup name is already on file (close is already in
// progress — a later "name" mention in the reply is not a fresh close trigger).
Deno.test("GUARD 23: gate does NOT fire when a pickup name is already on file", () => {
  assertFalse(shouldRedirectNameAskToCheckoutGate(
    "What's your name for the order?",
    true,   // hasPickupName: name already captured in a prior turn
    false, false,
  ));
});

// Gate does NOT fire on a reply that doesn't ask for the pickup name at all.
Deno.test("GUARD 23: gate does NOT fire on a reply that makes no name-ask", () => {
  assertFalse(shouldRedirectNameAskToCheckoutGate(
    "Got it! Vito's Grilled Chicken added.",
    false, false, false,
  ));
  assertFalse(shouldRedirectNameAskToCheckoutGate(
    "Anything else, or ready to check out?",
    false, false, false,
  ));
});

// ── Defects 1 & 2 (live, conv v430, Vito's, 2026-09-13): GUARD 23's redirect
//    used to discard the ENTIRE reply, including any legitimate item-
//    confirmation and upsell-offer content, whenever it fired. The fix
//    (renderGuard23Redirect) must preserve everything except the offending
//    name-ask/confirm sentence. ──────────────────────────────────────────────

Deno.test("renderGuard23Redirect: preserves item-confirmation content, strips only the name-ask sentence", () => {
  const out = renderGuard23Redirect("Got it, swapped to pepperoni! Putting this in for Jason, right?", "Pepperoni - Large (16\")          $16.50");
  assert(out.includes("swapped to pepperoni"), `expected item-confirmation to survive, got: ${out}`);
  assert(!/putting this in for jason/i.test(out), `expected name-ask sentence to be removed, got: ${out}`);
  assert(out.includes("Anything else, or ready to check out?"));
});

Deno.test("renderGuard23Redirect: preserves item-confirmation AND an upsell offer riding in the same reply", () => {
  const out = renderGuard23Redirect(
    "Got it — Pepperoni - Large (16\") added! Want to add a Coke to that? What's your name for the order?",
    "Pepperoni - Large (16\")          $16.50",
  );
  assert(out.includes("Pepperoni - Large (16\") added"), `expected item name to survive, got: ${out}`);
  assert(/want to add a coke/i.test(out), `expected upsell offer to survive, got: ${out}`);
  assert(!/what'?s your name/i.test(out), `expected name-ask sentence to be removed, got: ${out}`);
  assert(out.includes("Anything else, or ready to check out?"));
});

Deno.test("renderGuard23Redirect: cold name-ask embedded mid-reply is also stripped, not just name-confirm", () => {
  const out = renderGuard23Redirect("Awesome, added the Fries! What's your name for the order?", "French Fries          $3.50");
  assert(out.includes("Awesome, added the Fries"), `expected content before the name-ask to survive, got: ${out}`);
  assertFalse(/what'?s your name/i.test(out));
});

Deno.test("renderGuard23Redirect: falls back to the itemized recap, not a bare count, only when the WHOLE reply was the name-ask/confirm", () => {
  assertEquals(
    renderGuard23Redirect("Putting this in for Jason, right?", "Pepperoni - Large (16\")          $16.50\nSubtotal          $16.50"),
    "Here's what you've got:\n\nPepperoni - Large (16\")          $16.50\nSubtotal          $16.50\n\nAnything else, or ready to check out?",
  );
  assertEquals(
    renderGuard23Redirect("What's your name for the order?", "French Fries          $3.50\nCoke          $2.00"),
    "Here's what you've got:\n\nFrench Fries          $3.50\nCoke          $2.00\n\nAnything else, or ready to check out?",
  );
});

// ── Defect 4 (live, conv v430, Vito's, 2026-09-13): "yes im ready to check
//    out" authorized nothing — BARE_AFFIRMATIVE_RE requires the message to be
//    NOTHING but the bare word, EXPLICIT_CHECKOUT_PHRASE_RE requires the
//    phrase to BE the whole message. Neither shape matches trailing/leading
//    text around real checkout language. GUARD 23 re-asked the identical
//    question, ignoring unambiguous customer intent. PO-mandated: a MATRIX,
//    not a single case — every row below asserts isExplicitCheckoutIntent's
//    actual output for that exact string. ───────────────────────────────────

// Positive: a bare affirmative alone — context-dependent on what was asked
// (existing, unchanged behavior; not part of the broadened matching).
Deno.test("matrix: bare affirmatives alone only authorize when answering the ready-to-checkout question", () => {
  for (const word of ["yes", "yeah", "yep", "sure"]) {
    assert(isExplicitCheckoutIntent(word, READY_Q, false), `"${word}" answering the ready-to-checkout question should authorize`);
    assertFalse(isExplicitCheckoutIntent(word, ANYTHING_ELSE_ONLY, false), `"${word}" answering a plain "anything else?" should NOT authorize`);
    assertFalse(isExplicitCheckoutIntent(word, null, false), `"${word}" with no prior question should NOT authorize`);
  }
});

// Positive: affirmative word + explicit checkout phrase combined, anywhere in
// the message, regardless of what the bot last asked (the live defect shape).
Deno.test("matrix: affirmative + explicit checkout phrase combined authorizes on the FIRST attempt, regardless of prior question", () => {
  const combos = [
    "yes im ready to check out",
    "yes ready to checkout",
    "yeah, checkout",
    "yeah let's check out",
    "yes ready to checkout please",
    "yep that's it",
    "ok send the link",
    "Yes, I'm ready to check out!",
    "yup, that's all",
  ];
  for (const msg of combos) {
    assert(isExplicitCheckoutIntent(msg, ANYTHING_ELSE_ONLY, false), `expected "${msg}" to authorize checkout (wrong prior question)`);
    assert(isExplicitCheckoutIntent(msg, null, false), `expected "${msg}" to authorize checkout (no prior question)`);
    assert(isExplicitCheckoutIntent(msg, "Delivery again to 12 Main St?", false), `expected "${msg}" to authorize checkout (unrelated prior question)`);
  }
});

// Positive: explicit phrases alone, unaccompanied by any affirmative word —
// already-covered ground, kept in the matrix for completeness per the PO ask.
Deno.test("matrix: explicit checkout phrases alone authorize regardless of what was asked", () => {
  for (const phrase of ["checkout", "that's it", "ready to check out", "send the link", "done", "i'm done"]) {
    assert(isExplicitCheckoutIntent(phrase, null, false), `expected "${phrase}" alone to authorize`);
  }
});

// Negative (Incident A shape, must NOT regress): a bare "yes" answering an
// UNRELATED question, with competing intent in the same turn, never
// authorizes — even now that combined affirmative+checkout matching exists,
// because there is no checkout-phrase substring in this message at all.
Deno.test("matrix: bare 'yes' with competing intent and no checkout language never authorizes (Incident A, C4 money-bug class)", () => {
  const msg = "yes to delivery but I want pepperoni this time";
  assertFalse(isExplicitCheckoutIntent(msg, "Delivery again to 12 Main St?", true));
  assertFalse(isExplicitCheckoutIntent(msg, READY_Q, true));
  assertFalse(isExplicitCheckoutIntent(msg, NAME_CONFIRM, true));
});

// Negative: a bare "yes" answering an unrelated question with NO competing
// intent computed by the caller still must not authorize on its own — it has
// no checkout language and isn't answering a recognized question.
Deno.test("matrix: bare 'yes' answering an unrelated question does not authorize even without competing intent", () => {
  assertFalse(isExplicitCheckoutIntent("yes", "Delivery again to 12 Main St?", false));
});

// Negative: message merely CONTAINS an item name or unrelated content
// alongside "yes", with no real checkout language — must not authorize.
Deno.test("matrix: 'yes' plus an item name or unrelated content, with no checkout language, does not authorize", () => {
  for (const msg of ["yes pepperoni", "yes, add a coke too", "yes I'll take the fries", "sure, extra cheese please"]) {
    assertFalse(isExplicitCheckoutIntent(msg, ANYTHING_ELSE_ONLY, false), `expected "${msg}" to NOT authorize (no checkout language)`);
    assertFalse(isExplicitCheckoutIntent(msg, null, false), `expected "${msg}" to NOT authorize (no checkout language, no prior question)`);
  }
});

// Negative: checkout-language word embedded in an unrelated sentence, with an
// affirmative word elsewhere, must still not be misread as the combo —
// "check out" here is about the menu, not the order.
Deno.test("matrix: affirmative word plus an unrelated 'check out' (about the menu, not the order) still does not authorize via the combo path alone when it also carries competing intent", () => {
  assertFalse(isExplicitCheckoutIntent("yes I'll check out the menu but add pepperoni too", READY_Q, true));
});

// ── Regression (2026-09-13, Melvin adversarial pass): the AFFIRMATIVE_LEAD_IN_RE
//    + CHECKOUT_PHRASE_SUFFIX_RE combo check used to run BEFORE the
//    hasCompetingIntentThisTurn gate, so it authorized checkout whenever
//    competing intent happened to be named BEFORE the trailing checkout
//    phrase — even though the identical competing intent named AFTER the
//    checkout phrase was already correctly blocked. Word order must never
//    change whether competing intent blocks this combo path. ───────────────

Deno.test("matrix: competing intent blocks the checkout-phrase combo regardless of word order", () => {
  // Item named AFTER the checkout phrase — already worked before this fix.
  assertFalse(isExplicitCheckoutIntent("yes, ready to checkout, and also add fries", READY_Q, true));
  // Item named BEFORE the checkout phrase — the regression Melvin found.
  assertFalse(isExplicitCheckoutIntent("yes add fries and ready to checkout", READY_Q, true));
  // Item named in the MIDDLE, checkout phrase still trailing.
  assertFalse(isExplicitCheckoutIntent("yes, add fries, ready to checkout", READY_Q, true));
  // Multiple checkout phrases in the same message — competing intent still
  // must win regardless of how many checkout-shaped phrases surround it.
  assertFalse(isExplicitCheckoutIntent("yes checkout, add fries, ready to checkout", READY_Q, true));
});

Deno.test("matrix: the checkout-phrase combo still authorizes when there is genuinely no competing intent, in any order", () => {
  assert(isExplicitCheckoutIntent("yes, ready to checkout", READY_Q, false));
  assert(isExplicitCheckoutIntent("yes I'm ready to check out", READY_Q, false));
});

// ── Regression (2026-09-13, third-party independent verification): the
//    AFFIRMATIVE_LEAD_IN_RE + CHECKOUT_PHRASE_SUFFIX_RE combo was blind to
//    leading negation — "yeah, I'm not ready to check out" satisfied both
//    halves and authorized checkout, reading an explicit DECLINE as intent
//    to close. Fixed via hasNegatedCheckoutClause: a negation cue in the
//    same clause as the matched checkout phrase blocks the combo. ─────────

Deno.test("matrix: a negated decline is never read as checkout intent via the combo path", () => {
  const declines = [
    "yeah, I'm not ready to check out",
    "sure, maybe later — not ready to check out",
    "correct, I don't want to check out",
    "nah, not ready to checkout",
  ];
  for (const msg of declines) {
    assertFalse(isExplicitCheckoutIntent(msg, READY_Q, false), `expected "${msg}" to NOT authorize (negated decline)`);
    assertFalse(isExplicitCheckoutIntent(msg, ANYTHING_ELSE_ONLY, false), `expected "${msg}" to NOT authorize (negated decline)`);
    assertFalse(isExplicitCheckoutIntent(msg, null, false), `expected "${msg}" to NOT authorize (negated decline)`);
  }
});

// "...not ready to check out yet" already returned false before this fix,
// but only by accident: "yet" breaks CHECKOUT_PHRASE_SUFFIX_RE's end anchor,
// not because of any negation-awareness. Kept as a sanity check that the
// real fix doesn't change this pre-existing (if accidental) correct result.
Deno.test("matrix: 'not ready to check out yet' still does not authorize (pre-existing, now for the right reason too)", () => {
  assertFalse(isExplicitCheckoutIntent("not ready to check out yet", READY_Q, false));
});

// "not yet, but almost ready to check out" carries no affirmative lead-in
// word at all (no yes/yeah/yea/yep/yup/sure/ok/okay/correct), so it never
// reaches the combo path in the first place — it's genuinely ambiguous
// hedging, not a case the combo path was ever meant to authorize. Included
// to confirm the negation fix doesn't accidentally start authorizing it.
Deno.test("matrix: 'not yet, but almost ready to check out' does not authorize (no affirmative lead-in, genuinely hedging)", () => {
  assertFalse(isExplicitCheckoutIntent("not yet, but almost ready to check out", READY_Q, false));
});

// The false-positive-avoidance case from the spec ("no, not the pepperoni,
// add the sausage, ready to check out") never actually reaches the combo
// path at all: it has no affirmative lead-in word (no yes/yeah/yea/yep/yup/
// sure/ok/okay/correct — "no" is not one of those), so AFFIRMATIVE_LEAD_IN_RE
// fails regardless of the negation fix, and it falls through to hasCompetingIntentThisTurn/
// bare-affirmative below. The adapted version here swaps in "yes" so the
// combo path is genuinely exercised, to prove an early decline-shaped "not"
// belonging to an EARLIER clause (about a topping) does not block a
// genuinely trailing, unnegated checkout phrase in a LATER clause.
// hasCompetingIntentThisTurn is passed as false specifically to isolate the
// negation-clause logic under test — in production this turn would also
// carry real competing intent (naming items) and would be blocked by that
// gate regardless, same as the other word-order tests above.
Deno.test("matrix: an early negation about an item does not block genuinely trailing, unnegated checkout intent", () => {
  assert(isExplicitCheckoutIntent("yes, not the pepperoni, add the sausage, ready to check out", READY_Q, false));
  // The literal spec example itself: no affirmative lead-in word at all, so
  // it never reaches the combo path — still correctly does not authorize.
  assertFalse(isExplicitCheckoutIntent("no, not the pepperoni, add the sausage, ready to check out", READY_Q, false));
});
