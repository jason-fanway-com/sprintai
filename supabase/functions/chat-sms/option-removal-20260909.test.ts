// P0 (2026-09-09, live money defect): unit tests for the deterministic
// option-removal detection/matching primitives. Real live incident this
// closes (BLOCKED.txt 2026-09-09, guard1f-correction-claim-20260909.test.ts's
// fixtures): customer adds "large plain pizza with extra cheese" (real cart
// line: Large 18" Neapolitan Cheese Pizza, options {"Add Toppings":
// ["Extra Cheese"]}), says "remove the extra cheese", the cart has a second
// pizza line too (Medium, no Extra Cheese) -- so this must NOT be ambiguous;
// exactly one line has the option, it should resolve immediately.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isRemovalRequested,
  matchOptionRemovalPhrase,
  findCartLinesWithOption,
  type OptionRemovalCartLine,
} from "./option-removal-20260909.ts";

Deno.test("matchOptionRemovalPhrase: 'remove the extra cheese' captures 'extra cheese'", () => {
  assertEquals(matchOptionRemovalPhrase("remove the extra cheese"), "extra cheese");
});

Deno.test("matchOptionRemovalPhrase: 'take the extra cheese off' (object-before-particle)", () => {
  assertEquals(matchOptionRemovalPhrase("take the extra cheese off"), "extra cheese");
});

Deno.test("matchOptionRemovalPhrase: 'take off the extra cheese' (particle-before-object)", () => {
  assertEquals(matchOptionRemovalPhrase("take off the extra cheese"), "extra cheese");
});

Deno.test("matchOptionRemovalPhrase: 'no more pepperoni'", () => {
  assertEquals(matchOptionRemovalPhrase("no more pepperoni"), "pepperoni");
});

Deno.test("matchOptionRemovalPhrase: bare 'no extra cheese' (the literal live customer wording)", () => {
  assertEquals(matchOptionRemovalPhrase("no extra cheese"), "extra cheese");
});

Deno.test("matchOptionRemovalPhrase: 'get rid of the mushrooms'", () => {
  assertEquals(matchOptionRemovalPhrase("get rid of the mushrooms"), "mushrooms");
});

Deno.test("matchOptionRemovalPhrase: a longer compound message (fresh order + negation) does NOT match -- anchored, left to ask-plan-engine's own negation handling", () => {
  assertEquals(matchOptionRemovalPhrase("medium pepperoni pizza, no mushrooms please and a coke"), null);
});

Deno.test("matchOptionRemovalPhrase: no removal language at all -> null", () => {
  assertEquals(matchOptionRemovalPhrase("anything else for you"), null);
});

const ZIOS_CART: OptionRemovalCartLine[] = [
  {
    menu_item_id: "large-neapolitan-cheese",
    name: "Large 18'' Neapolitan Cheese Pizza",
    category: "Pizza",
    price_cents: 2199,
    options: { "Add Toppings": ["Extra Cheese"] },
  },
  {
    menu_item_id: "medium-neapolitan-cheese",
    name: "Medium 16'' Neapolitan Cheese Pizza",
    category: "Pizza",
    price_cents: 1699,
    options: {},
  },
];

Deno.test("findCartLinesWithOption: 'extra cheese' finds exactly the ONE line that has it, not the other pizza -- the whole point of this fix (stem overlap on 'cheese' must not create false ambiguity)", () => {
  const matches = findCartLinesWithOption("extra cheese", ZIOS_CART);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].menu_item_id, "large-neapolitan-cheese");
  assertEquals(matches[0].group_name, "Add Toppings");
  assertEquals(matches[0].matched_value, "Extra Cheese");
});

Deno.test("findCartLinesWithOption: both lines have the option -> 2 candidates (real ambiguity, must ask)", () => {
  const bothHaveIt: OptionRemovalCartLine[] = [
    ZIOS_CART[0],
    { ...ZIOS_CART[1], options: { "Add Toppings": ["Extra Cheese"] } },
  ];
  const matches = findCartLinesWithOption("extra cheese", bothHaveIt);
  assertEquals(matches.length, 2);
});

Deno.test("findCartLinesWithOption: option not present anywhere -> 0 candidates, caller falls through to whole-item removal", () => {
  const matches = findCartLinesWithOption("mushrooms", ZIOS_CART);
  assertEquals(matches.length, 0);
});

Deno.test("findCartLinesWithOption: matches a flat `modifiers` entry too (legacy non-compiled shape)", () => {
  const legacyCart: OptionRemovalCartLine[] = [
    { menu_item_id: "cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849, modifiers: ["Extra Cheese"] },
  ];
  const matches = findCartLinesWithOption("extra cheese", legacyCart);
  assertEquals(matches.length, 1);
  assertEquals(matches[0].group_name, null);
  assertEquals(matches[0].matched_value, "Extra Cheese");
});

Deno.test("findCartLinesWithOption: a generic word alone ('cheese') does not match a DIFFERENT option ('Extra Cheese') via the item's bare SKU name -- only options/modifiers are scanned, never the item name", () => {
  const cart: OptionRemovalCartLine[] = [
    { menu_item_id: "cheese-pizza", name: "Cheese Pizza", category: "Pizza", price_cents: 1599, options: {} },
  ];
  assertEquals(findCartLinesWithOption("cheese", cart).length, 0);
});

Deno.test("isRemovalRequested: 'remove the extra cheese' governs Extra Cheese", () => {
  assertEquals(isRemovalRequested("remove the extra cheese", "Extra Cheese"), true);
});

Deno.test("isRemovalRequested: 'take the extra cheese off' governs Extra Cheese", () => {
  assertEquals(isRemovalRequested("take the extra cheese off", "Extra Cheese"), true);
});

Deno.test("isRemovalRequested: 'take off the extra cheese' governs Extra Cheese", () => {
  assertEquals(isRemovalRequested("take off the extra cheese", "Extra Cheese"), true);
});

Deno.test("isRemovalRequested: clause-scoped -- 'remove the pepperoni but keep the mushrooms' never flags mushrooms", () => {
  assertEquals(isRemovalRequested("remove the pepperoni but keep the mushrooms", "Mushrooms"), false);
  assertEquals(isRemovalRequested("remove the pepperoni but keep the mushrooms", "Pepperoni"), true);
});

Deno.test("isRemovalRequested: unrelated text -> false", () => {
  assertEquals(isRemovalRequested("large plain pizza please", "Extra Cheese"), false);
});
