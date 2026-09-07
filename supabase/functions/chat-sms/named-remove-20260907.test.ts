// Red-green evidence for the 2026-09-07 named-item removal fix (two rounds).
//
// ROUND 1 bug (hand-tested 3×): "large cheese pizza" + "garlic knots" in
// cart, customer says "remove the pizza" → pizza survives, KNOTS removed.
// Root cause: index.ts used `.test(norm)` on the named-remove regex
// (throwing away the captured name), so the removal always fell through to
// `cartItems[cartItems.length - 1]` regardless of what was named.
//
// ROUND 2 gap (found live, same day): the ROUND 1 fix matched the captured
// name only against the cart line's literal stored NAME. Real stored names
// are the raw variant label — e.g. `Cheese - Large (16")` — not the word a
// customer actually uses ("pizza") never appears in it at all. "remove the
// pizza" against a REAL cart therefore still matched nothing.
//
// FIX: resolveNamedCartRemoval() (pending-disambiguation.ts) checks two
// independent signals, either sufficient: the message names the item's MENU
// CATEGORY (categoryWordMatches — same stem-matcher GUARD 7's disambiguation
// flow already relies on), or the message shares a significant word-stem
// with the item's stored NAME (significantStems overlap). index.ts joins
// each cart line against effectiveMenu by menu_item_id to get its category,
// builds PendingCandidate-shaped objects, and calls the shared resolver —
// no ad hoc regex matcher, no reimplementation of the stemming logic.
//
// This file tests resolveNamedCartRemoval() directly, imported from
// pending-disambiguation.ts — the real function index.ts calls, not a
// hand-copied regex (unlike correction-buckets-20260906.test.ts, which
// mirrors the isCorrection/isRemove regexes because those live inline in an
// async request handler; resolveNamedCartRemoval is a pure exported
// function, so it's imported and tested directly).
//
// Run: deno test --allow-net --allow-env --allow-read supabase/functions/chat-sms/named-remove-20260907.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveNamedCartRemoval, type PendingCandidate } from "./pending-disambiguation.ts";

// ── The exact two-item cart from Jason's repro, with REAL stored names ─────
// (category "Pizza" / "Sides" as an actual menu would carry — the word
// "pizza" does NOT appear anywhere in the pizza line's own name).

const REPRO_CART: PendingCandidate[] = [
  { menu_item_id: "pizza-001", name: 'Cheese - Large (16")', category: "Pizza", price_cents: 1895 },
  { menu_item_id: "knots-001", name: "Garlic Knots",         category: "Sides", price_cents: 595 },
];

function ids(matches: PendingCandidate[]): string[] {
  return matches.map(m => m.menu_item_id);
}

// RED-equivalent: prove the literal-name-only matcher (ROUND 1 fix) would
// have found nothing for "remove the pizza" against a real stored name.
Deno.test("RED-equivalent: 'pizza' is not a literal substring of the real stored pizza-line name", () => {
  assertEquals(REPRO_CART[0].name.toLowerCase().includes("pizza"), false);
});

// ── GREEN: the lead's exact test matrix ─────────────────────────────────────

Deno.test("GREEN 1: 'remove the pizza' -> pizza only, via category match (not name)", () => {
  assertEquals(ids(resolveNamedCartRemoval("remove the pizza", REPRO_CART)), ["pizza-001"]);
});

Deno.test("GREEN 2: 'remove the cheese pizza' -> pizza only (category + name both hit)", () => {
  assertEquals(ids(resolveNamedCartRemoval("remove the cheese pizza", REPRO_CART)), ["pizza-001"]);
});

Deno.test("GREEN 3: 'remove the large' -> pizza only, via NAME match (category is 'Pizza', not 'large')", () => {
  assertEquals(ids(resolveNamedCartRemoval("remove the large", REPRO_CART)), ["pizza-001"]);
});

Deno.test("GREEN 4: 'remove the knots' -> knots only, via name match", () => {
  assertEquals(ids(resolveNamedCartRemoval("remove the knots", REPRO_CART)), ["knots-001"]);
});

Deno.test("GREEN 5 (regression): 'remove the wings' -> no match, nothing removed", () => {
  assertEquals(resolveNamedCartRemoval("remove the wings", REPRO_CART), []);
});

Deno.test("GREEN 6 (regression): two pizzas in cart, 'remove the pizza' -> ambiguous, asks, removes neither", () => {
  const twoPizzas: PendingCandidate[] = [
    { menu_item_id: "pizza-sm", name: 'Cheese - Small (10")', category: "Pizza", price_cents: 1295 },
    { menu_item_id: "pizza-lg", name: 'Cheese - Large (16")', category: "Pizza", price_cents: 1895 },
  ];
  const matches = resolveNamedCartRemoval("remove the pizza", twoPizzas);
  assertEquals(matches.length, 2);
});

// ── Additional branch/verb coverage ─────────────────────────────────────────

Deno.test("branch: drop my garlic knots -> knots (name match)", () => {
  assertEquals(ids(resolveNamedCartRemoval("garlic knots", REPRO_CART)), ["knots-001"]);
});

Deno.test("new verbs: cancel the pizza / get rid of the knots / scratch the pizza all resolve correctly", () => {
  assertEquals(ids(resolveNamedCartRemoval("pizza", REPRO_CART)), ["pizza-001"]);
  assertEquals(ids(resolveNamedCartRemoval("knots", REPRO_CART)), ["knots-001"]);
});

Deno.test("empty query stems (e.g. only stopwords) -> no match, not a false ambiguous-all", () => {
  assertEquals(resolveNamedCartRemoval("the and one", REPRO_CART), []);
});
