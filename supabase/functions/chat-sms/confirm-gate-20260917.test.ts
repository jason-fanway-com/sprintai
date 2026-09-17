// 00-BE: the last gate before a payment link was rejecting "yes".
// Every affirmative below is verbatim from one 100-conversation run, where
// each was re-asked "All good - confirm?" eight or more times until the
// customer gave up. The cart, the name and the money were all correct.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isConfirmAffirmative } from "./turn-engine.ts";

Deno.test("00-BE: the real messages customers sent, that were all rejected", () => {
  for (const msg of [
    "Yes, confirm the order!",
    "Yes, please confirm the order for pickup! Thanks!",
    "Yes, I confirm the order!",
    "Yes, please confirm the order!",
    "Yes, confirm the order for one Thin Sicilian Pizza for pickup under the name Chris!",
    "Yes, confirm it please!",
    "I already said yes! Confirm the order already!",
    "Just confirm the order for the last time! Why is this so hard?",
    "I'm confirming! I just want the 2 Italian wraps for pickup under the name Alex.",
  ]) {
    assertEquals(isConfirmAffirmative(msg), true, `must be read as a yes: ${msg}`);
  }
});

Deno.test("00-BE: a bare yes still works — the one case that already did", () => {
  for (const msg of ["yes", "yep", "sure", "ok", "correct", "go ahead"]) {
    assertEquals(isConfirmAffirmative(msg), true, msg);
  }
});

Deno.test("00-BE: anything hesitant, negated or corrective must NOT place the order", () => {
  // This is the dangerous direction: a false yes charges someone who did not
  // agree. Every one of these must fall through.
  for (const msg of [
    "no",
    "not yet",
    "don't confirm yet",
    "wait, that's wrong",
    "hold on",
    "cancel that",
    "no, I wanted to change the order",
    "that's not right",
    "actually remove the fries",
    "can I change the size instead",
    "",
    "   ",
  ]) {
    assertEquals(isConfirmAffirmative(msg), false, `must NOT be read as a yes: ${JSON.stringify(msg)}`);
  }
});
