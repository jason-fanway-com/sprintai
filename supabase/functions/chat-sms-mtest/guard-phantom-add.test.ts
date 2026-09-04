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

// ── SEV-1 regression: docs/specs/human-test-2026-09-04.md ────────────────────
// Real order, production v209. The bot claimed to add an $11.99 Chicken
// Parmesan sandwich; the cart stayed at 4 items / $51.77. No guard fired. The
// item was only added after the customer asked "Did you add the chicken
// sandwich?" — caught by customer suspicion, not by the system.

const SEV1_REPLY =
  "Added the Chicken Parmesan sandwich for mom (comes with fries)! So that's " +
  "Hawaiian (med), Buffalo Chicken (small, hot/bleu), bone-in wings (hot), " +
  "plain slice, and chicken parm sandwich. Anything else?";

Deno.test("SEV-1: the exact phantom add that shipped to a customer is caught", () => {
  const cart = [{ name: "Hawaiian - Medium" }, { name: "Buffalo Chicken - Small" },
                { name: "Wings (Bone-In)" }, { name: "Cheese Slice" }];
  assertEquals(claimsAddedWithoutMutation(SEV1_REPLY, cart, cart), true);
});

Deno.test("SEV-1: recipient is not always the customer", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const who of ["mom", "dad", "my wife", "my brother", "her", "them", "Jason"]) {
    assertEquals(
      claimsAddedWithoutMutation(`Added the chicken parm sandwich for ${who}!`, cart, cart),
      true,
      `recipient "${who}" should still trip the guard`,
    );
  }
});

Deno.test("SEV-1: a parenthetical before the terminator no longer hides the claim", () => {
  const cart = [{ name: "Cheese - Large" }];
  assertEquals(
    claimsAddedWithoutMutation("Added the garlic knots (comes with sauce)!", cart, cart),
    true,
  );
});

Deno.test("SEV-1: a REAL add is still not flagged", () => {
  const before = [{ name: "Cheese - Large" }];
  const after = [{ name: "Cheese - Large" }, { name: "Chicken Parmesan" }];
  assertEquals(claimsAddedWithoutMutation(SEV1_REPLY, before, after), false);
});

Deno.test("SEV-1: fee/tip/note narration is still not flagged", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const r of ["Added a $2 tip for the driver.", "Added the note for the kitchen.",
                   "Added the service fee at checkout."]) {
    assertEquals(claimsAddedWithoutMutation(r, cart, cart), false, r);
  }
});

// ── False-positive pins (from /pakka:review of the SEV-1 fix) ────────────────
// When this guard fires it DISCARDS the model's reply. Every broadening above
// must be paired with proof it does not eat a good message.

Deno.test("SEV-1 review: scheduling narration is not an add claim", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const r of [
    "So I put you down for Friday at 5.",
    "I'll put your order in for Pickup at 6.",
    "Added the pizza for Delivery.",
    "Got the pizza ready for Pickup.",
  ]) {
    assertEquals(claimsAddedWithoutMutation(r, cart, cart), false, r);
  }
});

Deno.test("SEV-1 review: a comma clause does not truncate into a false claim", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const r of [
    "Earlier I added the Greek salad, want me to remove it?",
    "I added the extra napkins; anything else?",
  ]) {
    assertEquals(claimsAddedWithoutMutation(r, cart, cart), false, r);
  }
});

Deno.test("SEV-1 review: plural fee/note narration is excluded", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const r of [
    "I added the allergy notes, thanks!",
    "I've added the cooking instructions for the kitchen.",
    "Added the special requests.",
  ]) {
    assertEquals(claimsAddedWithoutMutation(r, cart, cart), false, r);
  }
});

Deno.test("SEV-1 review: capitalised verbs still caught (no /i regression)", () => {
  const cart = [{ name: "Cheese - Large" }];
  for (const r of [
    "Threw in a large pepperoni for you!",
    "Tossed a garlic knot in your cart.",
    "I've Added a Meatball Sub for your wife.",
  ]) {
    assertEquals(claimsAddedWithoutMutation(r, cart, cart), true, r);
  }
});
