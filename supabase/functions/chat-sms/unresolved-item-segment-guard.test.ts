import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { countUnresolvedSegments } from "./unresolved-item-segment-guard.ts";

Deno.test("the exact real repro: 4 named segments, only 3 new lines -> shortfall of 1", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}]; // Cheese, Hawaiian, Meat Lover's — Pepperoni never added
  const result = countUnresolvedSegments("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", before, after);
  assertEquals(result, 1);
});

Deno.test("counts match -> 0, no false trigger", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}, {}];
  const result = countUnresolvedSegments("1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers", before, after);
  assertEquals(result, 0);
});

Deno.test("single free-form sentence (not a list) is out of scope, never flags", () => {
  const result = countUnresolvedSegments("can I get a pepperoni pizza", [], []);
  assertEquals(result, 0);
});

Deno.test("a pure correction turn (0 new lines) never trips the guard, even with a 2-segment message", () => {
  // 3 items already in cart from a PRIOR turn; this turn adds 0 new lines
  // (e.g. a correction like "no, 1 large and 1 small" that legitimately
  // modifies existing lines via modify_item, not add_item). newLineCount
  // === 0 proves this wasn't an add-items turn at all — must stay quiet.
  const before = [{}, {}, {}];
  const after = [{}, {}, {}];
  const result = countUnresolvedSegments("1 large, 1 small", before, after);
  assertEquals(result, 0);
});

Deno.test("empty message -> 0, never crashes", () => {
  assertEquals(countUnresolvedSegments("", [], []), 0);
});

Deno.test("segments without a leading quantity are not counted as list items", () => {
  // "and a coffee" style trailing clause with no number is not itself
  // countable as a distinct list item by this detector.
  const result = countUnresolvedSegments("thanks and a coffee", [], []);
  assertEquals(result, 0);
});

Deno.test("more new lines than segments named (e.g. a bundle) never produces a negative shortfall", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}];
  const result = countUnresolvedSegments("1 pepperoni", before, after);
  assertEquals(result, 0);
});

Deno.test("an ordinal ('1st time ordering') is not miscounted as a quantity segment (2026-09-08 adversarial review)", () => {
  const before: unknown[] = [];
  const after = [{}]; // "2 pizzas please" correctly landed as one line, qty 2
  const result = countUnresolvedSegments("1st time ordering, 2 pizzas please", before, after);
  assertEquals(result, 0);
});

Deno.test("ordinals 2nd/3rd/4th are also excluded from the quantity-segment count", () => {
  assertEquals(countUnresolvedSegments("2nd time here, 3rd order this week, 4th time trying pizza", [], []), 0);
});

Deno.test("a genuine numeric quantity is still counted even when an ordinal appears elsewhere in the same message", () => {
  const before: unknown[] = [];
  const after = [{}]; // only 1 of the 2 named items landed
  const result = countUnresolvedSegments("1st time ordering, 1 pepperoni, 1 plain", before, after);
  assertEquals(result, 1);
});
