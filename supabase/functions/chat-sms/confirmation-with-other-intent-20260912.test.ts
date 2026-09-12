// C4 (docs/DEFECT-CLASSES.md): matrix test for hasNonConfirmationContent,
// covering the PO's exact acceptance phrasing plus the three real live
// incidents this class produced in one day.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasNonConfirmationContent } from "./confirmation-with-other-intent-20260912.ts";

Deno.test("instance 1 (item drop): 'Yes delivery. But I wanted a pepperoni pizza.' carries other content", () => {
  assertEquals(hasNonConfirmationContent("Yes delivery. But I wanted a pepperoni pizza."), true);
});

Deno.test("instance 2 (read drop): 'Show me the order. Yes it's for me' carries other content", () => {
  assertEquals(hasNonConfirmationContent("Show me the order. Yes it's for me"), true);
});

Deno.test("instance 3 (add drop): 'Yes to Jason. Can you add fries to that?' carries other content, even with the known name stripped", () => {
  assertEquals(hasNonConfirmationContent("Yes to Jason. Can you add fries to that?", "Jason"), true);
});

Deno.test("acceptance matrix: all four PO phrasings are flagged as carrying other content", () => {
  const matrix = [
    "Yes to Jason. Can you add fries to that?",
    "yes, and add fries",
    "yep but drop the pepperoni",
    "that's right, also a coke",
  ];
  for (const m of matrix) {
    assertEquals(hasNonConfirmationContent(m, "Jason"), true, `expected other-content: "${m}"`);
  }
});

Deno.test("pure confirmations (no other content) return false", () => {
  const pure = ["yes", "Yes", "confirm", "that's right", "sure", "ok", "yep", "all set", "sounds good"];
  for (const m of pure) {
    assertEquals(hasNonConfirmationContent(m), false, `expected pure confirmation: "${m}"`);
  }
});

Deno.test("bare known name alone (the plain C2 name-give flow) returns false", () => {
  assertEquals(hasNonConfirmationContent("Jason", "Jason"), false);
});

Deno.test("'Yes it's for me' with no other content returns false", () => {
  assertEquals(hasNonConfirmationContent("Yes it's for me"), false);
});

Deno.test("known-name stripping is exact, never a wildcard 'to <anything>' — 'yes to the fries' still flags", () => {
  assertEquals(hasNonConfirmationContent("yes to the fries", "Jason"), true);
});

Deno.test("polite filler ('thanks', 'please') does not by itself count as other content", () => {
  assertEquals(hasNonConfirmationContent("yes, thanks!"), false);
  assertEquals(hasNonConfirmationContent("sure, please"), false);
});

Deno.test("empty message returns false", () => {
  assertEquals(hasNonConfirmationContent(""), false);
});
