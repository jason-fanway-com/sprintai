// Deterministic red-then-green for the 2026-09-02 money bug.
//
// NJB menu-single-504 (run a2964ae4): customer "I'd like a Pumpernickel Bagel",
// bot "I've added a Pumpernickel Bagel for ya", cart EMPTY. The stated-total
// invariant caught it; Guard 1d (claimsAddedWithoutMutation) should have but
// didn't — its regex only accepted "for you", not the colloquial "for ya".
//
// This test pins the fix so the guard can never silently regress on phrasing.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimsAddedWithoutMutation } from "./phantom-add-guard.ts";

// The OLD regex, reproduced verbatim, to prove the bug was real (RED).
const OLD =
  /\b(?:added|i['"]?ve\s+added|i\s+added|put|i['"]?ve\s+put|threw|tossed)\s+(?:a\s+)?.*(?:to\s+(?:your|the)\s+cart|in\s+(?:your|the)\s+cart|for\s+you)\b/i;

const REPRO = "Hey there! Welcome to Not Just Bagels! I've added a Pumpernickel Bagel for ya. Would you like a pound of cream cheese spread? Plain ($10.95) or flavored ($11.95)?";

Deno.test("RED: old regex missed 'for ya' (this is the shipped bug)", () => {
  assertEquals(OLD.test(REPRO), false); // old guard stayed silent — money bug shipped
});

Deno.test("GREEN: fixed guard catches 'for ya' phantom add, empty cart", () => {
  assertEquals(claimsAddedWithoutMutation(REPRO, [], []), true);
});

Deno.test("GREEN: bare item-add claim, no completion suffix", () => {
  assertEquals(claimsAddedWithoutMutation("I've added a Pumpernickel Bagel!", [], []), true);
});

Deno.test("GREEN: still catches the original 'for you' / 'to your cart' phrasings", () => {
  assertEquals(claimsAddedWithoutMutation("Added a plain bagel to your cart.", [], []), true);
  assertEquals(claimsAddedWithoutMutation("I've added a coffee for you.", [], []), true);
});

Deno.test("NO FALSE POSITIVE: real add that mutated the cart", () => {
  const before: any[] = [];
  const after: any[] = [{ name: "Pumpernickel Bagel", quantity: 1, price_cents: 250 }];
  assertEquals(claimsAddedWithoutMutation("I've added a Pumpernickel Bagel for ya!", before, after), false);
});

Deno.test("NO FALSE POSITIVE: driver tip / fee narration, cart unchanged", () => {
  const cart: any[] = [{ name: "Bagel", quantity: 1, price_cents: 250 }];
  assertEquals(claimsAddedWithoutMutation("$2 driver tip added. What name for pickup?", cart, cart), false);
  assertEquals(claimsAddedWithoutMutation("A $0.99 service fee is added at checkout.", cart, cart), false);
  assertEquals(claimsAddedWithoutMutation("I've added a note to your order for the kitchen.", cart, cart), false);
});
