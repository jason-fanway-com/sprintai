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
