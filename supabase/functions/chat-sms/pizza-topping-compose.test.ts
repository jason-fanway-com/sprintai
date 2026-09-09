import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { composeDeterministicPizzaLines, findBasePizzaFamily, pickSizeVariant, type ComposeMenuItem } from "./pizza-topping-compose.ts";

function toppingStep(choices: string[]) {
  return {
    group_id: "toppings-group",
    slot_key: null,
    kind: "modifier" as const,
    ask_mode: "on_request" as const,
    prompt_template: "add_toppings.on_request",
    choices: choices.map((name, i) => ({ id: `choice-${i}-${name}`, display: name, price_delta_cents: 300 })),
  };
}

// Mirrors real Zio's topping list exactly (verified live 2026-09-08):
// "Peppers" and "Roasted Red Peppers" both exist alongside "Pepperoni" —
// the real ambiguity a bare "pepp" must resolve correctly, not just a
// synthetic worst case.
const TOPPING_CHOICES = [
  "Pepperoni", "Sausage", "Mushrooms", "Onions", "Extra Cheese", "Bacon",
  "Peppers", "Hot Peppers", "Roasted Red Peppers", "Fresh Garlic",
];

// Mirrors real Zio's shape: 3 active size variants of the base cheese pizza,
// a single-size Sicilian and Grandma alternative (so a tie-break is real),
// standalone specialty pizzas, and a same-named-topping Calzone that must
// NEVER be selected as a base.
function buildMenu(): ComposeMenuItem[] {
  return [
    { id: "neap-small", name: "Neapolitan Cheese Pizza - Small 14''", category: "Pizza", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Small Neapolitan Cheese Pizza", base_price_cents: 1525, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
    { id: "neap-med", name: "Neapolitan Cheese Pizza - Medium 16''", category: "Pizza", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Medium Neapolitan Cheese Pizza", base_price_cents: 1675, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
    { id: "neap-large", name: "Neapolitan Cheese Pizza - Large 18''", category: "Pizza", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Large Neapolitan Cheese Pizza", base_price_cents: 1799, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
    { id: "sicilian", name: "Sicilian Cheese Pizza", category: "Pizza", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Sicilian Cheese Pizza", base_price_cents: 1999, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
    { id: "grandma", name: "Grandma Cheese Pizza", category: "Pizza", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Grandma Cheese Pizza", base_price_cents: 1899, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
    { id: "hawaiian", name: "Hawaiian Pizza - Large 18''", category: "Pizza" },
    { id: "meatlovers", name: "Meat Lover's Pizza - Large 18''", category: "Pizza" },
    { id: "pepp-calzone", name: "Pepperoni Calzone", category: "Calzones & Strombolis", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Pepperoni Calzone", base_price_cents: 999, recap_template: "", ticket_template: "", steps: [toppingStep(TOPPING_CHOICES)] } },
  ];
}

Deno.test("findBasePizzaFamily: picks the family with the most active size variants (Neapolitan over single-size Sicilian/Grandma)", () => {
  const family = findBasePizzaFamily(buildMenu());
  assertEquals(family?.length, 3);
  assertEquals(family?.every(m => m.name.startsWith("Neapolitan Cheese Pizza")), true);
});

Deno.test("findBasePizzaFamily: never includes a Calzone even though it also has a topping group and 'pepperoni' in its name", () => {
  const family = findBasePizzaFamily(buildMenu());
  assertEquals(family?.some(m => m.id === "pepp-calzone"), false);
});

Deno.test("findBasePizzaFamily: real tie (two single-size families, no Neapolitan) returns null — missing beats wrong", () => {
  const menu = buildMenu().filter(m => !m.id.startsWith("neap"));
  assertEquals(findBasePizzaFamily(menu), null);
});

Deno.test("pickSizeVariant: resolves 'large' stated one turn earlier via carry-forward text", () => {
  const family = findBasePizzaFamily(buildMenu())!;
  const variant = pickSizeVariant(family, "I want 4 large pizzas 1 pepp, 1 plain, 1 hawaiin, 1 meat lovers");
  assertEquals(variant?.id, "neap-large");
});

Deno.test("pickSizeVariant: no size stated and multiple variants exist -> null, not a guess", () => {
  const family = findBasePizzaFamily(buildMenu())!;
  assertEquals(pickSizeVariant(family, "1 pepp, 1 plain"), null);
});

Deno.test("composeDeterministicPizzaLines: the full acceptance shape — 'pepp' composes, 'hawaiin'/'meat lovers' are left to the model (real standalone items)", () => {
  const menu = buildMenu();
  const cart: { menu_item_id: string }[] = [];
  const composed = composeDeterministicPizzaLines(
    "1 pepp, 1 plain, 1 hawaiin, 1 meat lovers",
    "I want 4 large pizzas 1 pepp, 1 plain, 1 hawaiin, 1 meat lovers",
    menu,
    cart,
  );
  // Exactly two deterministic decisions this turn: the topping compose and
  // the bare "plain" compose. "hawaiin"/"meat lovers" name real standalone
  // items (typos aside) and are correctly left alone.
  assertEquals(composed.length, 2);
  const pepp = composed.find(c => c.token === "pepp");
  assertEquals(pepp?.baseMenuItemId, "neap-large");
  assertEquals(pepp?.toppingChoiceDisplay, "Pepperoni");
  assertEquals(pepp?.quantity, 1);
  const plain = composed.find(c => c.token === "plain");
  assertEquals(plain?.baseMenuItemId, "neap-large");
  assertEquals(plain?.toppingChoiceDisplay, undefined);
});

Deno.test("composeDeterministicPizzaLines: never composes without established pizza context", () => {
  const menu = buildMenu();
  const composed = composeDeterministicPizzaLines("1 pepp please", "1 pepp please", menu, []);
  assertEquals(composed.length, 0);
});

Deno.test("composeDeterministicPizzaLines: pizza context via an existing pizza line already in the cart (no 'pizza' word needed this turn)", () => {
  const menu = buildMenu();
  const cart = [{ menu_item_id: "hawaiian" }];
  const composed = composeDeterministicPizzaLines("1 pepp", "I want a large pizza too, 1 pepp", menu, cart);
  assertEquals(composed.length, 1);
  assertEquals(composed[0].toppingChoiceDisplay, "Pepperoni");
});

Deno.test("composeDeterministicPizzaLines: never substitutes the Calzone even when 'pepperoni' is the exact word and pizza context exists", () => {
  const menu = buildMenu();
  const composed = composeDeterministicPizzaLines(
    "1 pepperoni pizza please",
    "give me a large pizza, 1 pepperoni pizza please",
    menu,
    [],
  );
  assertEquals(composed.length, 1);
  assertEquals(composed[0].baseMenuItemId, "neap-large");
  assertEquals(composed[0].toppingChoiceDisplay, "Pepperoni");
});

Deno.test("composeDeterministicPizzaLines: 'pepp' resolves to Pepperoni, never to 'Peppers' or the multi-word 'Roasted Red Peppers'/'Hot Peppers' compounds it also shares a word with (live-confirmed regression, 2026-09-08)", () => {
  const menu = buildMenu();
  const composed = composeDeterministicPizzaLines(
    "1 pepp",
    "I want a large pizza, 1 pepp",
    menu,
    [],
  );
  assertEquals(composed.length, 1);
  assertEquals(composed[0].toppingChoiceDisplay, "Pepperoni");
});

Deno.test("composeDeterministicPizzaLines: a single-word topping that is genuinely part of only one multi-word choice still composes (coverage tie-break doesn't over-exclude)", () => {
  const menu = buildMenu();
  const composed = composeDeterministicPizzaLines(
    "1 garlic",
    "I want a large pizza, 1 garlic",
    menu,
    [],
  );
  assertEquals(composed.length, 1);
  assertEquals(composed[0].toppingChoiceDisplay, "Fresh Garlic");
});

Deno.test("composeDeterministicPizzaLines: ambiguous topping match (0 or >1 hits) never guesses", () => {
  const menu = buildMenu();
  // "extra" alone would loosely relate to "Extra Cheese" but is too generic/
  // ambiguous a stem on its own — no other choice contains it, so this
  // actually resolves it; use a genuinely non-matching bare word instead to
  // assert the missing-beats-wrong path.
  const composed = composeDeterministicPizzaLines("1 pizza thingamajig", "1 pizza thingamajig", menu, []);
  assertEquals(composed.length, 0);
});
