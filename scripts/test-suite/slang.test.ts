/**
 * slang.ts — unit tests for buildSlangCases (pre-go-live SLANG resolution
 * battery: "hoagie" for a menu item filed as "Sub", "pop" for "Soda", etc).
 *
 * Fixture-based, no live bot call or DB — buildSlangCases is a pure function
 * of the menu-item rows it's given, same pattern already used by
 * required-options-guard.test.ts / stated-total-guard.test.ts.
 *
 * Run: deno test --allow-net --allow-env --allow-read scripts/test-suite/slang.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSlangCases } from "./slang.ts";

Deno.test("item named 'Italian Sub' produces exactly one slang case with correct price/line-count", () => {
  const items = [
    { id: "item-1", name: "Italian Sub", category: "Cold Sandwiches", price_cents: 999 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 1);
  const c = cases[0];
  assertEquals(c.expectedItemCents, 999);
  assertEquals(c.expectedLineCount, 1);
  assertEquals(c.turns.length, 1);
  assertEquals(c.turns[0].role, "customer");
});

Deno.test("category match (not just name) triggers a case — 'Subs' category on an unrelated name", () => {
  const items = [
    { id: "item-2", name: "The Godfather", category: "Subs", price_cents: 1050 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 1);
  assertEquals(cases[0].expectedItemCents, 1050);
});

Deno.test("menu-agnostic dictionary terms (soda/pop, pizza/pie, cream cheese/schmear) each match", () => {
  const items = [
    { id: "item-3", name: "Fountain Soda", category: "Drinks", price_cents: 250 },
    { id: "item-4", name: "Cheese Pizza", category: "Pizza", price_cents: 1400 },
    { id: "item-5", name: "Plain Cream Cheese", category: "Spreads", price_cents: 150 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 3);
  for (const c of cases) {
    assertEquals(c.expectedLineCount, 1);
    assertEquals(c.category, "slang-resolution");
  }
});

Deno.test("no dictionary match anywhere in name or category produces zero cases (no false positives)", () => {
  const items = [
    { id: "item-6", name: "Spinach Salad", category: "Salads", price_cents: 899 },
    { id: "item-7", name: "Chicken Tenders", category: "Fryer", price_cents: 799 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 0);
});

Deno.test("token-boundary matching avoids substring false positives (e.g. 'sub' inside 'Substitute')", () => {
  const items = [
    { id: "item-8", name: "Substitute Side", category: "Extras & Add-Ins", price_cents: 100 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 0);
});

Deno.test("multiple sub-family items rotate across hoagie/grinder/hero instead of repeating one term", () => {
  const items = [
    { id: "item-9", name: "Italian Sub", category: "Cold Subs", price_cents: 900 },
    { id: "item-10", name: "Turkey Sub", category: "Cold Subs", price_cents: 950 },
    { id: "item-11", name: "Veggie Sub", category: "Cold Subs", price_cents: 850 },
  ];
  const cases = buildSlangCases(items);
  assertEquals(cases.length, 3);
  const slangTermsUsed = new Set(cases.map((c) => c.label));
  assertEquals(slangTermsUsed.size, 3);
});
