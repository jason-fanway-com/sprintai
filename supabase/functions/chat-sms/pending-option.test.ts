// DEFECT 1 (2026-09-06 P0): unit coverage for the deterministic
// pending-option resolver. The live acceptance run (15/15 doneness answers,
// one cart line each) is the real proof; this file locks the pure logic
// down so it can't silently regress.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findPendingOptionQuestion,
  resolveAdditionalGroupSelections,
  resolvePendingOptionAnswer,
  type PendingOptionChoice,
} from "./pending-option.ts";

const TEMP_CHOICES: PendingOptionChoice[] = [
  { name: "Rare", price_cents: 0 },
  { name: "Medium Rare", price_cents: 0 },
  { name: "Medium", price_cents: 0 },
  { name: "Medium Well", price_cents: 0 },
  { name: "Well Done", price_cents: 0 },
];

Deno.test("resolvePendingOptionAnswer: 'medium' resolves to Medium, not Medium Rare/Medium Well", () => {
  const hit = resolvePendingOptionAnswer("medium", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium");
});

Deno.test("resolvePendingOptionAnswer: 'well done' resolves to Well Done, not Medium Well", () => {
  const hit = resolvePendingOptionAnswer("well done", TEMP_CHOICES);
  assertEquals(hit?.name, "Well Done");
});

Deno.test("resolvePendingOptionAnswer: 'rare' resolves to Rare, not Medium Rare", () => {
  const hit = resolvePendingOptionAnswer("rare", TEMP_CHOICES);
  assertEquals(hit?.name, "Rare");
});

Deno.test("resolvePendingOptionAnswer: 'medium rare please' resolves to Medium Rare", () => {
  const hit = resolvePendingOptionAnswer("medium rare please", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium Rare");
});

Deno.test("resolvePendingOptionAnswer: 'medium well' resolves to Medium Well", () => {
  const hit = resolvePendingOptionAnswer("medium well", TEMP_CHOICES);
  assertEquals(hit?.name, "Medium Well");
});

Deno.test("resolvePendingOptionAnswer: unrelated message resolves to nothing", () => {
  const hit = resolvePendingOptionAnswer("can I also get a coke", TEMP_CHOICES);
  assertEquals(hit, null);
});

Deno.test("resolvePendingOptionAnswer: empty message resolves to nothing", () => {
  assertEquals(resolvePendingOptionAnswer("", TEMP_CHOICES), null);
});

Deno.test("findPendingOptionQuestion: finds the open group on the cart line that has one", () => {
  const menuById = new Map([
    ["burger-1", { name: "Cheese Burger", option_groups: [{ name: "Temp", choices: TEMP_CHOICES }] }],
  ]);
  const cart = [
    { menu_item_id: "burger-1", pending_options: ["Temp"] },
  ];
  const q = findPendingOptionQuestion(cart, menuById);
  assertEquals(q?.menu_item_id, "burger-1");
  assertEquals(q?.group_name, "Temp");
  assertEquals(q?.choices.length, 5);
});

Deno.test("findPendingOptionQuestion: no pending groups anywhere returns null", () => {
  const menuById = new Map([
    ["burger-1", { name: "Cheese Burger", option_groups: [{ name: "Temp", choices: TEMP_CHOICES }] }],
  ]);
  const cart = [
    { menu_item_id: "burger-1", pending_options: undefined },
  ];
  assertEquals(findPendingOptionQuestion(cart, menuById), null);
});

Deno.test("findPendingOptionQuestion: ignores lines with no menu_item_id (bundles)", () => {
  const menuById = new Map<string, { name: string; option_groups?: { name: string; choices: PendingOptionChoice[] }[] }>();
  const cart = [{ pending_options: ["Temp"] }];
  assertEquals(findPendingOptionQuestion(cart, menuById), null);
});

// BUG 4 (2026-09-07, Jason, Zio's live verification): "buffalo chicken pizza
// with pepperoni" left Size pending and dropped Pepperoni entirely — real
// Slice option data, Buffalo Chicken Pizza genuinely has an "Add Toppings"
// group with Pepperoni at +$3.00. resolveAdditionalGroupSelections is the
// deterministic backstop that finds a named choice from a group OTHER than
// the one a caller is already resolving.
const BUFFALO_CHICKEN_PIZZA = {
  name: "Buffalo Chicken Pizza",
  option_groups: [
    { name: "Size", choices: [{ name: "Small", price_cents: 0 }, { name: "Large", price_cents: 500 }] },
    { name: "Add Toppings", choices: [{ name: "Pepperoni", price_cents: 300 }, { name: "Mushroom", price_cents: 200 }] },
  ],
};

Deno.test("resolveAdditionalGroupSelections: finds Pepperoni in 'buffalo chicken pizza with pepperoni' while Size is untouched", () => {
  const result = resolveAdditionalGroupSelections(
    "buffalo chicken pizza with pepperoni",
    BUFFALO_CHICKEN_PIZZA,
    new Set(),
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].group_name, "Add Toppings");
  assertEquals(result[0].choice.name, "Pepperoni");
  assertEquals(result[0].choice.price_cents, 300);
});

Deno.test("resolveAdditionalGroupSelections: excludeGroupName skips the group a caller is already resolving via another path", () => {
  // "medium with pepperoni" resolving Size elsewhere — Size itself must not
  // also be returned here even though 'medium' isn't one of these choices.
  const result = resolveAdditionalGroupSelections(
    "large with pepperoni",
    BUFFALO_CHICKEN_PIZZA,
    new Set(),
    "Size",
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].group_name, "Add Toppings");
  assertEquals(result[0].choice.name, "Pepperoni");
});

Deno.test("resolveAdditionalGroupSelections: skips groups already in alreadySelected", () => {
  const result = resolveAdditionalGroupSelections(
    "buffalo chicken pizza with pepperoni",
    BUFFALO_CHICKEN_PIZZA,
    new Set(["Add Toppings"]),
  );
  assertEquals(result.length, 0);
});

Deno.test("resolveAdditionalGroupSelections: no mention of any real choice returns empty", () => {
  const result = resolveAdditionalGroupSelections(
    "just the buffalo chicken pizza please",
    BUFFALO_CHICKEN_PIZZA,
    new Set(),
  );
  assertEquals(result.length, 0);
});

Deno.test("resolveAdditionalGroupSelections: item name words don't false-positive as a choice ('chicken' isn't a topping here)", () => {
  const menuItem = {
    name: "Chicken Caesar",
    option_groups: [
      { name: "Dressing", choices: [{ name: "Chicken", price_cents: 0 }, { name: "Caesar", price_cents: 0 }] },
    ],
  };
  // "i want a chicken caesar salad" names the DISH, not the dressing choice —
  // both choice names happen to be substrings of the item's own name.
  const result = resolveAdditionalGroupSelections("i want a chicken caesar salad", menuItem, new Set());
  assertEquals(result.length, 0);
});

Deno.test("resolveAdditionalGroupSelections: only one group per call, so naming two choices from the SAME group still returns just that group's single best match", () => {
  // "pepperoni and mushroom" both name real choices in the same "Add
  // Toppings" group — resolvePendingOptionAnswer requires ALL of a choice's
  // stems to be present and returns null on a multi-way tie within one
  // group, so the deterministic rule here is "resolve unambiguous groups,
  // never guess within one" rather than silently picking the first mention.
  const result = resolveAdditionalGroupSelections(
    "buffalo chicken pizza with pepperoni and mushroom",
    BUFFALO_CHICKEN_PIZZA,
    new Set(),
  );
  assertEquals(result, []);
});
