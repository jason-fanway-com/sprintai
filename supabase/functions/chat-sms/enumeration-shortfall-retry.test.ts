import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { decideShortfallRetry } from "./enumeration-shortfall-retry.ts";

Deno.test("the exact real repro (merge shape): 4 segments, 3 lines -> retries with a hint", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}]; // one line is the merged pizza+pepperoni; 4th segment has no line of its own
  const decision = decideShortfallRetry("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", before, after, 0, 2);
  assert(decision.shouldRetry);
  assert(decision.hint!.includes("one item"));
  assert(decision.hint!.includes("never attach it as an option/modifier onto a DIFFERENT item's line"));
});

Deno.test("counts match -> no retry", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}, {}];
  const decision = decideShortfallRetry("1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers", before, after, 0, 2);
  assertEquals(decision.shouldRetry, false);
  assertEquals(decision.hint, undefined);
});

Deno.test("retry budget exhausted -> no retry even with a real shortfall (falls through to the post-turn GUARD)", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}];
  const decision = decideShortfallRetry("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", before, after, 2, 2);
  assertEquals(decision.shouldRetry, false);
});

Deno.test("single free-form sentence (not a list) never retries", () => {
  const decision = decideShortfallRetry("can I get a pepperoni pizza", [], [], 0, 2);
  assertEquals(decision.shouldRetry, false);
});

Deno.test("a pure correction turn (0 new lines) never retries, even with a 2-segment message", () => {
  const before = [{}, {}, {}];
  const after = [{}, {}, {}];
  const decision = decideShortfallRetry("1 large, 1 small", before, after, 0, 2);
  assertEquals(decision.shouldRetry, false);
});

Deno.test("shortfall of 2+ uses plural phrasing", () => {
  const before: unknown[] = [];
  const after = [{}];
  const decision = decideShortfallRetry("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", before, after, 0, 2);
  assert(decision.shouldRetry);
  assert(decision.hint!.includes("3 items"));
  assert(decision.hint!.includes("haven't landed"));
});

Deno.test("retriesUsed one below max still retries (boundary)", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}];
  const decision = decideShortfallRetry("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers", before, after, 1, 2);
  assert(decision.shouldRetry);
});

// BLAST RADIUS (2026-09-08, PO dispatch item 1): the underlying detector
// (countUnresolvedSegments) is category-blind — it only ever compares
// segment count to new-cart-line count, never inspects item names or
// categories — so this retry mechanism was never pizza-specific. These
// cases prove it fires identically for subs and salads, the two other
// categories the PO asked to be checked for the same undercounting risk.
Deno.test("blast radius — subs: a 3-item sub list that undercounts by 1 also retries", () => {
  const before: unknown[] = [];
  const after = [{}, {}]; // one sub silently merged/dropped, same shape as the pizza repro
  const decision = decideShortfallRetry("1 turkey sub, 1 italian sub, 1 meatball sub", before, after, 0, 2);
  assert(decision.shouldRetry);
  assert(decision.hint!.includes("one item"));
});

Deno.test("blast radius — subs: counts matching (3 named, 3 lines) never retries", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}];
  const decision = decideShortfallRetry("1 turkey sub, 1 italian sub, 1 meatball sub", before, after, 0, 2);
  assertEquals(decision.shouldRetry, false);
});

Deno.test("blast radius — salads: a 3-item salad list that undercounts by 1 also retries", () => {
  const before: unknown[] = [];
  const after = [{}, {}];
  const decision = decideShortfallRetry("1 caesar salad, 1 greek salad, 1 garden salad", before, after, 0, 2);
  assert(decision.shouldRetry);
});

Deno.test("blast radius — salads: counts matching never retries", () => {
  const before: unknown[] = [];
  const after = [{}, {}, {}];
  const decision = decideShortfallRetry("1 caesar salad, 1 greek salad, 1 garden salad", before, after, 0, 2);
  assertEquals(decision.shouldRetry, false);
});
