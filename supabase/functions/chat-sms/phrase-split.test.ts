import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { splitCustomerPhrases } from "./phrase-split.ts";

// P0 regression matrix (2026-09-09, PO idx444/idx482): the same four-pizza
// order expressed at least six ways a real customer would type it, plus four
// adversarial variants (qty>1 on the composed item, negation, an intentional
// modifier, and a non-pizza item in the same list). Every one of these must
// segment into the phrases a human would draw the boundaries at — this is
// the load-bearing invariant every consumer of this module (pizza-topping-
// compose.ts's deterministic compose, ask-plan-engine.ts's
// isolatePhraseForItem) depends on to keep a token from one phrase from
// attaching to another phrase.
Deno.test("splitCustomerPhrases: six-phrasing acceptance matrix, four pizzas each", () => {
  assertEquals(splitCustomerPhrases("1 pepp, 1 plain, 1 hawaiin, 1 meat lovers"),
    ["1 pepp", "1 plain", "1 hawaiin", "1 meat lovers"]);
  assertEquals(splitCustomerPhrases("one plain, one pepperoni, one meat lover and one hawaai"),
    ["one plain", "one pepperoni", "one meat lover", "one hawaai"]);
  assertEquals(splitCustomerPhrases("a plain, a pepperoni, a meat lovers and a hawaiian"),
    ["a plain", "a pepperoni", "a meat lovers", "a hawaiian"]);
  assertEquals(splitCustomerPhrases("plain pizza, pepperoni pizza, meat lovers pizza, hawaiian pizza"),
    ["plain pizza", "pepperoni pizza", "meat lovers pizza", "hawaiian pizza"]);
  assertEquals(splitCustomerPhrases("1 cheese 1 pepperoni 1 meat lover 1 hawaiian"),
    ["1 cheese", "1 pepperoni", "1 meat lover", "1 hawaiian"]);
  assertEquals(splitCustomerPhrases("gimme a plain and a pepperoni and a meat lovers and a hawaiian"),
    ["gimme a plain", "a pepperoni", "a meat lovers", "a hawaiian"]);
});

Deno.test("splitCustomerPhrases: adversarial cases", () => {
  // qty > 1 on the composed item — still a clean two-phrase split.
  assertEquals(splitCustomerPhrases("two pepperoni and a hawaiian"), ["two pepperoni", "a hawaiian"]);
  // Negation must not merge into the preceding phrase.
  assertEquals(splitCustomerPhrases("a hawaiian, no pepperoni"), ["a hawaiian", "no pepperoni"]);
  // An intentional modifier ("with extra pepperoni") is part of the SAME
  // phrase as its item — must NOT be torn apart, there is no list boundary
  // here at all.
  assertEquals(splitCustomerPhrases("a meat lovers with extra pepperoni"), ["a meat lovers with extra pepperoni"]);
  // A non-pizza item mixed into the same list still gets its own phrase.
  assertEquals(splitCustomerPhrases("pepperoni pizza and a coke"), ["pepperoni pizza", "a coke"]);
});

Deno.test("splitCustomerPhrases: a real dish name containing 'and' is never torn in two", () => {
  // "and" only counts as a boundary when what follows is a quantity/article —
  // a dish name whose own name contains "and" for unrelated reasons must
  // survive as one phrase.
  assertEquals(splitCustomerPhrases("one mac and cheese"), ["one mac and cheese"]);
  assertEquals(splitCustomerPhrases("salt and pepper wings"), ["salt and pepper wings"]);
});

Deno.test("splitCustomerPhrases: single-item message is one phrase, not split", () => {
  assertEquals(splitCustomerPhrases("a large pepperoni pizza"), ["a large pepperoni pizza"]);
  assertEquals(splitCustomerPhrases("two cheesesteaks"), ["two cheesesteaks"]);
});

Deno.test("splitCustomerPhrases: empty/whitespace input never crashes", () => {
  assertEquals(splitCustomerPhrases(""), []);
  assertEquals(splitCustomerPhrases("   "), []);
});

// Item 3 Phase 1a (2026-09-10): the four resolver.test.ts acceptance cases
// (resolver.ts is dead code — never wired into chat-sms/index.ts — but its
// test suite is the regression record for the pepperoni-bleed defect), ported
// onto the live splitter every add_item call actually goes through.
Deno.test("splitCustomerPhrases: PHRASE ISOLATION direction A — 'Hawaiian with pepperoni, Meat Lover's' splits at the comma, pepperoni stays in the Hawaiian phrase", () => {
  assertEquals(
    splitCustomerPhrases("1 Hawaiian with pepperoni, 1 Meat Lover's"),
    ["1 Hawaiian with pepperoni", "1 Meat Lover's"],
  );
});

Deno.test("splitCustomerPhrases: PHRASE ISOLATION direction B — reversed order still splits cleanly (not just 'first phrase wins')", () => {
  assertEquals(
    splitCustomerPhrases("1 Meat Lover's, 1 Hawaiian with pepperoni"),
    ["1 Meat Lover's", "1 Hawaiian with pepperoni"],
  );
});

Deno.test("splitCustomerPhrases: THREE-PIZZA ORDER — three comma-separated phrases, including two identical 'large cheese' base items", () => {
  assertEquals(
    splitCustomerPhrases("1 large cheese with pepperoni, 1 large cheese with mushrooms, 1 Hawaiian"),
    ["1 large cheese with pepperoni", "1 large cheese with mushrooms", "1 Hawaiian"],
  );
});

Deno.test("splitCustomerPhrases: MULTI-TOPPING — 'with pepperoni and mushrooms' stays ONE phrase ('mushrooms' is not a quantity/article, so 'and' is not a boundary here)", () => {
  assertEquals(
    splitCustomerPhrases("large cheese pizza with pepperoni and mushrooms"),
    ["large cheese pizza with pepperoni and mushrooms"],
  );
});

// Live regression (2026-09-10, §8.4 gate run against real Zio's Pizzeria
// data, tenant 2cba7b51-211c-4437-8910-1af4dcc03498): the generic separator
// set above treats '&' as an unconditional boundary, but Zio's has a real
// menu item literally named "Mac & Cheese Bites" — its OWN name contains
// that trigger character. Any message naming that item plus anything else
// tore the item's own name in half and bled phrase-scoping into whatever
// came after. The fix (findProtectedNames in phrase-split.ts) generalizes to
// ANY shop with an '&'/','/'and'-containing item name — these cases pass a
// menu list, not a hardcoded string match, on purpose.
const ZIOS_MENU = [
  { name: "Mac & Cheese Bites" },
  { name: "Coke" },
  { name: "Meat Lover's" },
  { name: "Garlic Knots" },
];

Deno.test("splitCustomerPhrases: '&'-containing item name ordered ALONE stays one phrase, not split on its own '&'", () => {
  assertEquals(
    splitCustomerPhrases("1 Mac & Cheese Bites", ZIOS_MENU),
    ["1 Mac & Cheese Bites"],
  );
});

Deno.test("splitCustomerPhrases: '&'-containing item name ordered FIRST in a multi-item message", () => {
  assertEquals(
    splitCustomerPhrases("Mac & Cheese Bites and a Coke", ZIOS_MENU),
    ["Mac & Cheese Bites", "a Coke"],
  );
});

Deno.test("splitCustomerPhrases: '&'-containing item name ordered LAST in a multi-item message", () => {
  assertEquals(
    splitCustomerPhrases("a Coke and a Mac & Cheese Bites", ZIOS_MENU),
    ["a Coke", "a Mac & Cheese Bites"],
  );
});

Deno.test("splitCustomerPhrases: '&'-containing item name ordered in the MIDDLE, with items before and after", () => {
  assertEquals(
    splitCustomerPhrases("a Coke, Mac & Cheese Bites, and a Meat Lover's", ZIOS_MENU),
    ["a Coke", "Mac & Cheese Bites", "a Meat Lover's"],
  );
});
