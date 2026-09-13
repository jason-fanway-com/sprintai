// Tests for checkout-intent-gate-20260913.ts — see that file's header for the
// full incident background. These exercise the REAL exported function, not a
// hand-copied mirror (same discipline as guard9/guard13's test files).

import { assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isExplicitCheckoutIntent,
  shouldRedirectNameAskToCheckoutGate,
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
