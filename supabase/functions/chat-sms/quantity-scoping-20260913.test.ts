// PO 2026-09-13. Regression test for the $341.98 incident: "yep, and two cokes"
// set the PIZZA to x16 because a bare count parsed from the whole turn was
// handed to every writeCartLine call in that turn.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseExplicitQuantityForItem } from "./turn-reconciler.ts";

Deno.test("a bare count binds to the item it is spoken next to, not to every item", () => {
  const turn = "yep, and two cokes";
  assertEquals(parseExplicitQuantityForItem(turn, "Coke"), { kind: "absolute", value: 2 });
  // THE BUG: this used to return {absolute:2} and set the pizza to 2+, then x16.
  assertEquals(parseExplicitQuantityForItem(turn, 'Cheese - Large (16")'), null);
});

Deno.test("contextual forms still refer to the line under discussion", () => {
  assertEquals(parseExplicitQuantityForItem("make it 2", 'Cheese - Large (16")'), { kind: "absolute", value: 2 });
  assertEquals(parseExplicitQuantityForItem("another one", 'Cheese - Large (16")'), { kind: "relative", delta: 1 });
});

Deno.test("no count, or an unscopable count, applies to nothing", () => {
  assertEquals(parseExplicitQuantityForItem("yes", "Coke"), null);
  assertEquals(parseExplicitQuantityForItem("two", undefined), null);
});

Deno.test("plural and adjacent-filler phrasings still bind", () => {
  assertEquals(parseExplicitQuantityForItem("and three large cokes please", "Coke"), { kind: "absolute", value: 3 });
  assertEquals(parseExplicitQuantityForItem("add 2 side salads", "Side Salad"), { kind: "absolute", value: 2 });
});
