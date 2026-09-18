import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectSharedModifierSets } from "./modifier-set-detect.ts";
import type { DesiredChoice, DesiredGroup, DesiredItem } from "../../../menu-pipeline/core/import-plan.ts";

function toppings(): DesiredChoice[] {
  return [
    { importKey: "pepperoni", name: "Pepperoni", priceCents: 200, displayOrder: 0 },
    { importKey: "mushroom", name: "Mushroom", priceCents: 200, displayOrder: 1 },
    { importKey: "onion", name: "Onion", priceCents: 200, displayOrder: 2 },
  ];
}

function pizzaItem(n: number, groups: DesiredGroup[]): DesiredItem {
  return {
    importKey: `pizza|pie ${n}|`,
    name: `Pie ${n}`,
    description: "",
    priceCents: 1500,
    category: "Pizza",
    sizeLabel: "",
    displayOrder: n,
    groups,
    promptFor: "",
    upsell: "add extra toppings",
    modifiersJson: null,
  };
}

function toppingsGroup(choices: DesiredChoice[]): DesiredGroup {
  return {
    importKey: "add-ons",
    name: "Toppings",
    required: false,
    minSelect: 0,
    maxSelect: 99,
    displayOrder: 0,
    choices,
  };
}

Deno.test("modifier-set-detect: identical Toppings list across 20 items merges into ONE set", () => {
  const items = Array.from({ length: 20 }, (_, i) => pizzaItem(i, [toppingsGroup(toppings())]));

  const sets = detectSharedModifierSets(items);

  assertEquals(sets.length, 1);
  assertEquals(sets[0].name, "Toppings");
  assertEquals(sets[0].kind, "modifier");
  assertEquals(sets[0].members.length, 20);
  assertEquals(sets[0].choices.map((c) => c.name).sort(), ["Mushroom", "Onion", "Pepperoni"]);
});

Deno.test("modifier-set-detect: a single differing choice breaks the match — no set, items stay unset", () => {
  const same = Array.from({ length: 19 }, (_, i) => pizzaItem(i, [toppingsGroup(toppings())]));
  const different = pizzaItem(19, [
    toppingsGroup([
      { importKey: "pepperoni", name: "Pepperoni", priceCents: 200, displayOrder: 0 },
      { importKey: "mushroom", name: "Mushroom", priceCents: 200, displayOrder: 1 },
      { importKey: "sausage", name: "Sausage", priceCents: 250, displayOrder: 2 }, // differs
    ]),
  ]);

  const sets = detectSharedModifierSets([...same, different]);

  // The 19 identical items still form a set (they're a genuine shared list);
  // the one differing item is simply not a member of it and keeps its own
  // per-item group unset — never forced into the majority's set.
  assertEquals(sets.length, 1);
  assertEquals(sets[0].members.length, 19);
  assertEquals(sets[0].members.some((m) => m.itemImportKey === different.importKey), false);
});

Deno.test("modifier-set-detect: a differing PRICE (same names) also breaks the match", () => {
  const a = pizzaItem(0, [toppingsGroup(toppings())]);
  const b = pizzaItem(1, [
    toppingsGroup(toppings().map((c) => (c.name === "Onion" ? { ...c, priceCents: 300 } : c))),
  ]);

  const sets = detectSharedModifierSets([a, b]);

  assertEquals(sets.length, 0);
});

Deno.test("modifier-set-detect: a list that appears on only ONE item is not a shared set", () => {
  const items = [pizzaItem(0, [toppingsGroup(toppings())])];

  const sets = detectSharedModifierSets(items);

  assertEquals(sets.length, 0);
});

Deno.test("modifier-set-detect: choice order doesn't matter — same set, reordered", () => {
  const a = pizzaItem(0, [toppingsGroup(toppings())]);
  const reordered = [...toppings()].reverse();
  const b = pizzaItem(1, [toppingsGroup(reordered)]);

  const sets = detectSharedModifierSets([a, b]);

  assertEquals(sets.length, 1);
  assertEquals(sets[0].members.length, 2);
});

Deno.test("modifier-set-detect: a required group (slot) is detected with kind 'slot'", () => {
  const dressing: DesiredChoice[] = [
    { importKey: "ranch", name: "Ranch", priceCents: 0, displayOrder: 0 },
    { importKey: "italian", name: "Italian", priceCents: 0, displayOrder: 1 },
  ];
  const group: DesiredGroup = {
    importKey: "dressing", name: "Dressing", required: true, minSelect: 1, maxSelect: 1,
    displayOrder: 0, choices: dressing,
  };
  const a = { ...pizzaItem(0, [group]), category: "Salads" };
  const b = { ...pizzaItem(1, [group]), category: "Salads" };

  const sets = detectSharedModifierSets([a, b]);

  assertEquals(sets.length, 1);
  assertEquals(sets[0].kind, "slot");
});

Deno.test("modifier-set-detect: two distinct shared lists with the SAME group name get disambiguated names", () => {
  const addonsA = toppingsGroup(toppings());
  const addonsB: DesiredGroup = {
    importKey: "add-ons",
    name: "Toppings", // same display name, different content
    required: false,
    minSelect: 0,
    maxSelect: 99,
    displayOrder: 0,
    choices: [
      { importKey: "ranch-dip", name: "Ranch Dip", priceCents: 100, displayOrder: 0 },
      { importKey: "marinara", name: "Marinara", priceCents: 100, displayOrder: 1 },
    ],
  };
  const items = [
    pizzaItem(0, [addonsA]), pizzaItem(1, [addonsA]),
    { ...pizzaItem(2, [addonsB]), category: "Wraps" },
    { ...pizzaItem(3, [addonsB]), category: "Wraps" },
  ];

  const sets = detectSharedModifierSets(items);

  assertEquals(sets.length, 2);
  const names = sets.map((s) => s.name).sort();
  assertEquals(names, ["Toppings", "Toppings #2"]);
});

Deno.test("modifier-set-detect: a group with fewer than 2 choices is never a candidate", () => {
  const single: DesiredGroup = {
    importKey: "single", name: "Single Choice", required: false, minSelect: 0, maxSelect: 1,
    displayOrder: 0, choices: [{ importKey: "only", name: "Only Option", priceCents: 0, displayOrder: 0 }],
  };
  const items = [pizzaItem(0, [single]), pizzaItem(1, [single])];

  const sets = detectSharedModifierSets(items);

  assertEquals(sets.length, 0);
});
