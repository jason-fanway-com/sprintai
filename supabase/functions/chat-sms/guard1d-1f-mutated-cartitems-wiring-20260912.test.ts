// P0 (2026-09-12, live money defect on Vito's, conv ce84c64b):
// GUARD 1d and GUARD 1f in index.ts compared the model's reply against
// `cartItems` as the "before" cart. `cartItems` is mutated IN PLACE by
// executeTool's push()/splice() calls during this same turn's tool loop
// (add_item/modify_item/etc. all take `cartItems` and mutate it directly),
// so by the time these guards run, `cartItems` already reflects POST-turn
// state -- identical to `guardCart` whether or not a real add happened.
// GUARD 9 already carried a comment warning about this exact wiring bug and
// was built against `cartSnapshotBeforeTurn` (a real JSON.parse(JSON.
// stringify(...)) freeze taken before any tool call) instead -- but 1d/1f
// were never migrated.
//
// Live effect: customer said "Yes delivery. But I wanted to a pepperoni
// pizza." The model correctly called add_item (cart genuinely went from
// empty to one pepperoni pizza) and replied acknowledging it in ordinary
// confirmation language. Because `cartItems` had already been mutated to
// match the post-add `guardCart`, GUARD 1f's ambiguous-correction check saw
// "no diff" and, matching the reply's ordinary "wanted"/"one" phrasing,
// replaced the correct reply with "Your cart is empty. What would you like
// to order?" The customer, told the cart was empty, re-sent "Pepperoni
// pizza" -- a second, genuinely new add_item call -- doubling the quantity
// and the charge ($42 for one pizza instead of $21).
//
// This test pins the wiring-level fix: evaluateGuard1f/claimsAddedWithoutMutation
// must be called with the true pre-turn snapshot, not the turn-mutated array,
// or a real add gets misread as "no mutation happened".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateGuard1f, type Guard1fCartItem } from "./guard1f-correction-claim-20260909.ts";
import { claimsAddedWithoutMutation } from "./phantom-add-guard.ts";

// The live incident's reply shape: the customer's turn combined a delivery
// confirmation with a new item ("Yes delivery. But I wanted to a pepperoni
// pizza."), and the model's natural confirmation for a combined order-type +
// item turn uses an explicit correction verb ("Updated") even though nothing
// was corrected -- it was a fresh add. claimsExplicitCorrectionWithoutMutation
// has NO escape hatch (unlike the ambiguous branch's replyAcknowledgesCart),
// so it trips unconditionally whenever before/after look identical.
const LIVE_REPLY = "Updated! Pepperoni pizza is on its way for delivery.";

const CART_BEFORE_TURN: Guard1fCartItem[] = []; // genuinely empty before this turn
const CART_AFTER_TURN: Guard1fCartItem[] = [{ name: "Large Cheese Pizza" }]; // add_item genuinely ran

Deno.test("wiring bug (RED, documents the live incident): feeding the mutated `cartItems` reference (identical to guardCart post-mutation) makes GUARD 1f wrongly see 'no diff' and trip on a real add", () => {
  // Simulates the bug: `cartItems` was mutated in place by executeTool, so by
  // guard time it already equals guardCart's content -- exactly like handing
  // guardCart to itself as "before".
  const mutatedCartItemsAliasedToAfter = CART_AFTER_TURN;
  const result = evaluateGuard1f(LIVE_REPLY, mutatedCartItemsAliasedToAfter, CART_AFTER_TURN);
  assertEquals(result.tripped, true, "documents the bug: wrong 'before' reference makes a real add look like a no-op correction claim");
});

Deno.test("fix (GREEN): feeding the true pre-turn snapshot, GUARD 1f correctly sees the cart grew and does not trip", () => {
  const result = evaluateGuard1f(LIVE_REPLY, CART_BEFORE_TURN, CART_AFTER_TURN);
  assertEquals(result.tripped, false, "a real add (empty -> one item) must never be misread as a narrated correction with no mutation");
});

Deno.test("fix (GREEN): GUARD 1d (phantom-add) also does not trip on a real add when given the true pre-turn snapshot", () => {
  const addReply = "Added a pepperoni pizza to your cart!";
  const trippedWithWrongBefore = claimsAddedWithoutMutation(addReply, CART_AFTER_TURN, CART_AFTER_TURN);
  const trippedWithRightBefore = claimsAddedWithoutMutation(addReply, CART_BEFORE_TURN, CART_AFTER_TURN);
  assertEquals(trippedWithWrongBefore, true, "documents the bug: aliased before/after makes a genuine add look phantom");
  assertEquals(trippedWithRightBefore, false, "a genuine add (cart grew) must never trip the phantom-add guard");
});
