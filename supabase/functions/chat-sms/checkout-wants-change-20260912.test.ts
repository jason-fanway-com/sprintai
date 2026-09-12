// C4 (docs/DEFECT-CLASSES.md, 2026-09-12, conv 08782185): "add fries" in
// checkout was refused because only explicit correction language ("change",
// "wrong", "remove") triggered a reopen — "add"/"also"/"another"/"drop"/
// "swap" were all missing. Pins the widened regex against the acceptance
// case and a few natural variants, plus confirms it still doesn't fire on
// ordinary confirmation language.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CHECKOUT_WANTS_CHANGE_RE, CHECKOUT_WANTS_RESTART_RE } from "./checkout-wants-change-20260912.ts";

Deno.test("CHECKOUT_WANTS_CHANGE_RE: 'add fries' (the live acceptance case) matches without the word CHANGE", () => {
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("ADD FRIES"), true);
});

Deno.test("CHECKOUT_WANTS_CHANGE_RE: natural add/remove/swap variants all match", () => {
  const variants = ["ALSO A COKE", "ANOTHER PIZZA", "DROP THE PEPPERONI", "SWAP THE FRIES FOR A SALAD", "TAKE OFF THE ONIONS", "NO MORE PEPPERONI", "DON'T WANT THE FRIES ANYMORE"];
  for (const v of variants) {
    assertEquals(CHECKOUT_WANTS_CHANGE_RE.test(v), true, `expected match: "${v}"`);
  }
});

Deno.test("CHECKOUT_WANTS_CHANGE_RE: still matches the original explicit-correction vocabulary", () => {
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("CHANGE"), true);
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("THAT'S WRONG"), true);
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("REMOVE THE PEPPERONI"), true);
});

Deno.test("CHECKOUT_WANTS_CHANGE_RE: ordinary confirmation language does not match", () => {
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("YES"), false);
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("THAT'S RIGHT"), false);
  assertEquals(CHECKOUT_WANTS_CHANGE_RE.test("SOUNDS GOOD"), false);
});

Deno.test("CHECKOUT_WANTS_RESTART_RE: unchanged", () => {
  assertEquals(CHECKOUT_WANTS_RESTART_RE.test("RESTART"), true);
  assertEquals(CHECKOUT_WANTS_RESTART_RE.test("START OVER"), true);
  assertEquals(CHECKOUT_WANTS_RESTART_RE.test("ADD FRIES"), false);
});
