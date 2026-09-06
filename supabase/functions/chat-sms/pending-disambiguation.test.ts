// BLOCKER 1 (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md): unit
// coverage for the deterministic pending-disambiguation resolver. The live
// acceptance transcript (all four answer forms against the real public
// tester) is the real proof; this file locks the pure logic down so it can't
// silently regress.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  categoryWordMatches,
  extractPriceCentsFromMessage,
  matchOrdinalPosition,
  renderDisambiguationReask,
  resolvePendingDisambiguation,
  stemWord,
  type PendingCandidate,
} from "./pending-disambiguation.ts";

const BLT_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "cold-blt", name: "BLT", category: "Cold Sandwiches", price_cents: 799 },
  { menu_item_id: "panini-blt", name: "BLT", category: "Homemade Paninis", price_cents: 1099 },
];

Deno.test("stemWord: singular/plural round-trips for the categories that actually collide", () => {
  assertEquals(stemWord("Salads"), "salad");
  assertEquals(stemWord("salad"), "salad");
  assertEquals(stemWord("Wraps"), "wrap");
  assertEquals(stemWord("wrap"), "wrap");
  assertEquals(stemWord("Sandwiches"), "sandwich");
  assertEquals(stemWord("Paninis"), "panini");
});

Deno.test("categoryWordMatches: 'caesar salad' names the Salads category (Guard 7 fix)", () => {
  assertEquals(categoryWordMatches("Salads", "caesar salad"), true);
  assertEquals(categoryWordMatches("Wraps", "caesar salad"), false);
});

Deno.test("categoryWordMatches: 'the wrap' names the Wraps category", () => {
  assertEquals(categoryWordMatches("Wraps", "just the wrap please"), true);
});

Deno.test("categoryWordMatches: unrelated message matches neither side", () => {
  assertEquals(categoryWordMatches("Cold Sandwiches", "large pepperoni pizza"), false);
});

Deno.test("resolvePendingDisambiguation form (b): category word — 'the panini one'", () => {
  const resolved = resolvePendingDisambiguation("the panini one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation form (c): ordinal — 'the first one'", () => {
  const resolved = resolvePendingDisambiguation("the first one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "cold-blt");
});

Deno.test("resolvePendingDisambiguation: bare digit positional — '2'", () => {
  const resolved = resolvePendingDisambiguation("2", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation form (d): price — 'the 10.99 one' does NOT read as position 1", () => {
  const resolved = resolvePendingDisambiguation("the 10.99 one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation: price match tolerates a leading dollar sign", () => {
  const resolved = resolvePendingDisambiguation("$7.99 please", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "cold-blt");
});

Deno.test("resolvePendingDisambiguation: unresolvable answer returns null, never guesses", () => {
  assertEquals(resolvePendingDisambiguation("um not sure", BLT_CANDIDATES), null);
});

Deno.test("matchOrdinalPosition: excludes the fractional half of a decimal price", () => {
  assertEquals(matchOrdinalPosition("the 12.95 one", 2), null);
});

Deno.test("extractPriceCentsFromMessage: parses dollar and bare decimal forms", () => {
  assertEquals(extractPriceCentsFromMessage("the 12.95 one"), [1295]);
  assertEquals(extractPriceCentsFromMessage("$9.99"), [999]);
});

Deno.test("renderDisambiguationReask: never produces GUARD 7's original sentence shape", () => {
  const reask = renderDisambiguationReask(BLT_CANDIDATES);
  assertEquals(reask.includes(" or "), true);
  assertEquals(reask.startsWith("We've got a couple options"), false);
});

Deno.test("renderDisambiguationReask: impossible by construction to repeat the identical prior reply", () => {
  const first = renderDisambiguationReask(BLT_CANDIDATES, null);
  const second = renderDisambiguationReask(BLT_CANDIDATES, first);
  assertNotEquals(first, second);
  // A third consecutive failure must not cycle back to a string equal to the
  // immediately preceding one either.
  const third = renderDisambiguationReask(BLT_CANDIDATES, second);
  assertNotEquals(second, third);
});
