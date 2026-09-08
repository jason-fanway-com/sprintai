/**
 * size-fold.ts — unit tests (ec35040, item A). Same testable-without-a-DB
 * pattern as archetypes.test.ts/normalize.test.ts.
 *
 * Run: deno test --allow-read supabase/functions/_shared/size-fold.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planSizeFold, type SizeFoldSourceItem, type SizeFoldChoice } from "./size-fold.ts";

function item(overrides: Partial<SizeFoldSourceItem>): SizeFoldSourceItem {
  return { id: "item-1", name: "Item", category: "Category", description: null, price_cents: 1000, ...overrides };
}

function choice(overrides: Partial<SizeFoldChoice>): SizeFoldChoice {
  return { id: crypto.randomUUID(), name: "Choice", display_name: null, price_cents: 0, ...overrides };
}

Deno.test("multi-choice group explodes into one insert per choice, price = base + delta, original retires", () => {
  const taco = item({ id: "taco", name: "Taco Pizza", category: "Pizza", description: "Ground beef...", price_cents: 1999 });
  const choices = [
    choice({ name: "Small 14''", price_cents: 0 }),
    choice({ name: "Medium 16''", price_cents: 300 }),
    choice({ name: "Large 18''", price_cents: 500 }),
  ];
  const plan = planSizeFold(taco, choices);
  assertEquals(plan.retiresOriginal, true);
  assertEquals(plan.actions.length, 3);
  assertEquals(plan.actions, [
    { kind: "explode_insert", base_item_id: "taco", name: "Taco Pizza - Small 14''", size_label: "Small 14''", price_cents: 1999, category: "Pizza", description: "Ground beef..." },
    { kind: "explode_insert", base_item_id: "taco", name: "Taco Pizza - Medium 16''", size_label: "Medium 16''", price_cents: 2299, category: "Pizza", description: "Ground beef..." },
    { kind: "explode_insert", base_item_id: "taco", name: "Taco Pizza - Large 18''", size_label: "Large 18''", price_cents: 2499, category: "Pizza", description: "Ground beef..." },
  ]);
});

Deno.test("a single-choice (true singleton) group does NOT explode -- sets size_label on the existing row only, original not retired", () => {
  const sicilian = item({ id: "sicilian", name: "Mike's Hot Honey Pepperoni Sicilian", price_cents: 2699 });
  const plan = planSizeFold(sicilian, [choice({ name: "Large 18''", price_cents: 0 })]);
  assertEquals(plan.choice_count, 1);
  assertEquals(plan.retiresOriginal, false);
  assertEquals(plan.actions, [{ kind: "singleton_update", item_id: "sicilian", size_label: "Large 18''" }]);
});

Deno.test("two-choice group (real Zio's sub shape) explodes to exactly 2 rows", () => {
  const sub = item({ id: "sub1", name: "Italian Hot Dog Sub", category: "Hot Subs", price_cents: 1099 });
  const choices = [choice({ name: "Medium 12''", price_cents: 0 }), choice({ name: "Large 16''", price_cents: 800 })];
  const plan = planSizeFold(sub, choices);
  assertEquals(plan.actions.length, 2);
  assertEquals((plan.actions[1] as any).price_cents, 1899);
});

Deno.test("choice label prefers display_name over name when both are present", () => {
  const it = item({ id: "x", name: "Widget", price_cents: 500 });
  const plan = planSizeFold(it, [
    choice({ name: "raw-small", display_name: "Small", price_cents: 0 }),
    choice({ name: "raw-large", display_name: "Large", price_cents: 200 }),
  ]);
  assertEquals((plan.actions[0] as any).size_label, "Small");
  assertEquals((plan.actions[0] as any).name, "Widget - Small");
});

Deno.test("zero choices (data anomaly) produces an empty plan, not a throw", () => {
  const plan = planSizeFold(item({ id: "empty" }), []);
  assertEquals(plan.actions, []);
  assertEquals(plan.retiresOriginal, false);
  assertEquals(plan.choice_count, 0);
});

Deno.test("a null price_cents delta on a choice is treated as zero, not NaN", () => {
  const it = item({ id: "y", name: "Drink", price_cents: 200 });
  const plan = planSizeFold(it, [
    choice({ name: "Small", price_cents: null }),
    choice({ name: "Large", price_cents: 100 }),
  ]);
  assertEquals((plan.actions[0] as any).price_cents, 200);
  assertEquals((plan.actions[1] as any).price_cents, 300);
});
