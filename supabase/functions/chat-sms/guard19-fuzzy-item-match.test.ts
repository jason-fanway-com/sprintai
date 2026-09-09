import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fuzzyWordMatch, hasGuard19NamedSignal } from "./guard19-fuzzy-item-match.ts";

// Mirrors the real Zio's menu shape (verified live 2026-09-08): pepperoni is
// ONLY a topping choice on the base cheese pizza, never a standalone item.
// Hawaiian and Meat Lover's ARE standalone items, spelled/punctuated exactly
// as they are live.
const ZIOS_LIKE_MENU = [
  {
    name: "Neapolitan Cheese Pizza",
    option_groups: [
      { choices: [
        { name: "Pepperoni" }, { name: "Sausage" }, { name: "Mushrooms" },
        { name: "Onions" }, { name: "Extra Cheese" },
      ] },
    ],
  },
  { name: "Plain Pan Pizza" },
  { name: "Hawaiian Pizza" },
  { name: "Hawaiian Pizza - Large 18''" },
  { name: "Meat Lover's Pizza" },
  { name: "Meat Lover's Pizza - Large 18''" },
  { name: "Garden Pizza" },
];

Deno.test("regression_2026-09-08_zios_false_revert: 'pepp, plain, hawaiin, meat lovers' is real signal", () => {
  const result = hasGuard19NamedSignal(
    "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers",
    ZIOS_LIKE_MENU,
    0, // exact-match count is genuinely zero — this is exactly the incident
  );
  assertEquals(result, true);
});

// NARROWED (2026-09-08, same day as the fix above): a bare composed topping
// with NOTHING else in the message is no longer this module's signal to
// give — pizza-topping-compose.ts resolves that case deterministically in
// index.ts BEFORE this guard runs, and index.ts feeds a successful compose
// into GUARD 19 directly (deterministicComposedThisTurn), not through this
// vocab. This module's remaining scope is standalone item names only (see
// the "hawaiin" test below) — see this file's header for the full
// reasoning.
Deno.test("hasGuard19NamedSignal: bare composed topping alone is OUT of this module's scope now (handled deterministically upstream instead)", () => {
  assertEquals(hasGuard19NamedSignal("just 1 pepp please", ZIOS_LIKE_MENU, 0), false);
});

Deno.test("hasGuard19NamedSignal: typo of a real item name is real signal ('hawaiin')", () => {
  assertEquals(hasGuard19NamedSignal("give me a hawaiin", ZIOS_LIKE_MENU, 0), true);
});

Deno.test("hasGuard19NamedSignal: dropped apostrophe/pluralization is real signal ('meat lovers')", () => {
  assertEquals(hasGuard19NamedSignal("meat lovers please", ZIOS_LIKE_MENU, 0), true);
});

// THE ACTUAL PROTECTION THIS GUARD EXISTS FOR (commit b865d3a shape) — must
// survive this fix untouched: a bare quantity with NOTHING resolvable, not
// even a generic size/format word, is still zero signal.
Deno.test("hasGuard19NamedSignal: genuine zero-signal quantity-only message stays zero signal", () => {
  assertEquals(hasGuard19NamedSignal("I want four large pizzas", ZIOS_LIKE_MENU, 0), false);
  assertEquals(hasGuard19NamedSignal("just give me four of the usual amount", ZIOS_LIKE_MENU, 0), false);
  assertEquals(hasGuard19NamedSignal("four please", ZIOS_LIKE_MENU, 0), false);
});

Deno.test("hasGuard19NamedSignal: exact-match count short-circuits to true regardless of menu", () => {
  assertEquals(hasGuard19NamedSignal("anything at all", [], 3), true);
});

// LIVE REGRESSION (2026-09-09, Vito's demo shop down): "four large plain
// pizzas" reverted the whole cart even though the correct pizza was added —
// see guard19-fuzzy-item-match.ts's hasBarePizzaIndicatorSignal header for
// the full mechanism. "plain"/"cheese" are deliberately generic everywhere
// else in this file; they only count as grounding when the shop actually
// has a pizza-category item resolver.ts's own bare-plain/cheese fallback
// would resolve them to.
const VITOS_LIKE_MENU = [
  { name: "Neapolitan Cheese Pizza", category: "Pizza" },
  { name: "Hawaiian Pizza", category: "Pizza" },
  { name: "Cheese Fries", category: "Sides" },
  { name: "Cheese Steak", category: "Sandwiches" },
];

Deno.test("hasGuard19NamedSignal: bare 'plain'/'cheese' pizza reference IS real signal when the shop has a pizza-category cheese/plain item", () => {
  assertEquals(hasGuard19NamedSignal("four large plain pizzas", VITOS_LIKE_MENU, 0), true);
  assertEquals(hasGuard19NamedSignal("4 large plain pizzas", VITOS_LIKE_MENU, 0), true);
  assertEquals(hasGuard19NamedSignal("I need to order four large plain pizzas", VITOS_LIKE_MENU, 0), true);
  assertEquals(hasGuard19NamedSignal("four large cheese pizzas", VITOS_LIKE_MENU, 0), true);
});

Deno.test("hasGuard19NamedSignal: 'plain' does NOT become a false signal when the shop has no pizza-category plain/cheese item", () => {
  // Neither item's own name contains "plain"/"cheese" and neither is
  // category "Pizza" with such wording — bare "plain" must stay ungrounded.
  const noCheesePizzaMenu = [{ name: "Hawaiian Pizza", category: "Pizza" }, { name: "Turkey Club", category: "Sandwiches" }];
  assertEquals(hasGuard19NamedSignal("four large plain pizzas", noCheesePizzaMenu, 0), false);
});

Deno.test("fuzzyWordMatch: prefix match requires shorter word >=4 chars", () => {
  assertEquals(fuzzyWordMatch("pepp", "pepperoni"), true);
  assertEquals(fuzzyWordMatch("lover", "lovers"), true);
  // "pi" is too short (2 chars) to safely prefix-match "pizza" — would
  // false-positive on nearly every message.
  assertEquals(fuzzyWordMatch("pi", "pizza"), false);
});

Deno.test("fuzzyWordMatch: edit distance scales with word length, never for short words", () => {
  assertEquals(fuzzyWordMatch("hawaiin", "hawaiian"), true); // distance 1, len 8
  assertEquals(fuzzyWordMatch("ham", "ha"), false); // len<5, distance must be 0 (exact only)
  assertEquals(fuzzyWordMatch("cheese", "cheesy"), true); // distance 2 within a 6-char word window? verify below
});

Deno.test("fuzzyWordMatch: does not spuriously match unrelated short words via edit distance", () => {
  // "four" (4 chars) is one edit from "flour" but too short to risk the
  // edit-distance branch on — must fall through to false (no prefix either).
  assertEquals(fuzzyWordMatch("four", "flour"), false);
  assertEquals(fuzzyWordMatch("want", "wants"), true); // prefix match ("want" is a 4-char prefix of "wants")
});
