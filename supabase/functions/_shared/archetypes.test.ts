/**
 * archetypes.ts — unit tests (docs/specs/2026-09-07-conversation-ready-menu-design.md
 * §3 stages 4-5, §4.2, Appendix A, §11 item 3).
 *
 * Two groups, same pattern as normalize.test.ts:
 *  - Synthetic fixtures covering each rule in isolation: classification,
 *    each archetype's slot resolution ladder (bind / name-sourced /
 *    description-sourced / default / universal / needs_question / skip /
 *    not_applicable), the size/count sibling special-case, and the
 *    priority + blocking formulas from §5.2.
 *  - Live-data tests against all three real shops (Vito's, Not Just Bagels,
 *    Zio's) — reports which category matched which archetype and what
 *    owner_questions would be generated, per the task's real-data
 *    acceptance bar. Also a standalone grep-style check that nothing in
 *    this module can write to option_groups/option_choices.
 *
 * Run: deno test --allow-net --allow-env --allow-read supabase/functions/_shared/archetypes.test.ts
 */
import { assertEquals, assert, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  ARCHETYPES,
  classifyCategory,
  inferCategory,
  computePriority,
  computeBlocking,
  buildCategoryCandidateGroups,
  type InferItemInput,
  type CategoryPriceItem,
} from "./archetypes.ts";
import { normalizeMenuItems, pickDescriptionSlot, pickSideDescriptionSlot, type RawMenuItemRow } from "./normalize.ts";

function item(overrides: Partial<InferItemInput>): InferItemInput {
  return {
    id: crypto.randomUUID(),
    name: "Item",
    description: null,
    category: "Category",
    productKey: null,
    siblingCount: 1,
    nameSlotChoices: null,
    descriptionSlotChoices: null,
    sideSlotChoices: null,
    extractedGroups: [],
    ...overrides,
  };
}

// ---- Library shape ----------------------------------------------------------

Deno.test("library has exactly 12 archetypes, 'other' last with empty match", () => {
  assertEquals(ARCHETYPES.length, 12);
  assertEquals(ARCHETYPES[ARCHETYPES.length - 1].key, "other");
  assertEquals(ARCHETYPES[ARCHETYPES.length - 1].match.length, 0);
});

Deno.test("every named archetype has at least one match rule and one slot or modifier", () => {
  for (const a of ARCHETYPES) {
    if (a.key === "other") continue;
    assert(a.match.length > 0, `${a.key} has no match rules`);
    assert(a.slots.length > 0 || a.modifiers.length > 0, `${a.key} has no slots or modifiers`);
  }
});

// ---- Classification ----------------------------------------------------------

Deno.test("classify: category text wins over item-name fallback", () => {
  assertEquals(classifyCategory("Pizza", ["Cheese", "Pepperoni"]), "pizza");
  assertEquals(classifyCategory("Salads", ["Caesar", "Greek"]), "salad");
  assertEquals(classifyCategory("Wings", ["6 piece", "12 piece"]), "wings");
});

Deno.test("classify: 'steak' does not false-positive on 'cheesesteak'", () => {
  assertEquals(classifyCategory("Hot Sandwiches", ["Cheesesteak", "Chicken Cheesesteak"]), "sandwich");
  // even with a generic category, item-name fallback must not treat
  // "cheesesteak" as containing the word "steak" -- it should hit sandwich
  // (from /cheesesteak/i) rather than misfire into steak
  assertEquals(classifyCategory("Grill Specials", ["Cheesesteak Deluxe"]), "sandwich");
});

Deno.test("classify: unmatched category with no item hint falls to 'other'", () => {
  assertEquals(classifyCategory("Quesadillas", ["Chicken", "Steak Quesadilla".replace("Steak", "Beef")]), "other");
});

Deno.test("classify: item-name fallback fires when category text itself doesn't match", () => {
  // category is generic; a majority of item names carry archetype signal
  assertEquals(classifyCategory("Chef's Picks", ["Cheese Burger", "Bacon Burger", "Garden Salad"]), "burger");
});

Deno.test("classify: a single stray item-name match does not hijack the whole category (real Vito's/Zio's shape)", () => {
  // Quesadillas: one item literally named "Steak" among five -- must not
  // send the whole category to the steak archetype's temp question.
  assertEquals(classifyCategory("Quesadillas", ["Chicken", "Chicken Fajita", "Southwest Chicken", "Steak", "Veggie"]), "other");
  // Desserts: one "Key Lime Pie" among ten must not send the category to pizza.
  assertEquals(
    classifyCategory("Desserts", ["Cannoli", "Chocolate Cake", "Cheesecake", "Key Lime Pie", "Tiramisu", "Gelato", "Biscotti", "Zeppole", "Sorbet", "Panna Cotta"]),
    "other",
  );
});

// ---- Slot resolution ladder --------------------------------------------------

Deno.test("burger: temp is kitchen_critical and excludes chicken/veggie/turkey items", () => {
  const beef = item({ name: "Bacon Cheeseburger", category: "Burgers" });
  const chicken = item({ name: "Crispy Chicken Burger", category: "Burgers" });
  const result = inferCategory("Burgers", [beef, chicken]);
  assertEquals(result.archetype, "burger");
  const q = result.questions.find(q => q.slot_key === "temp");
  assertExists(q);
  assertEquals(q!.items_affected, 1); // only the beef burger
  assertEquals(q!.blocking, true);
  assert(q!.proposal.exclusions.includes("Crispy Chicken Burger"));
  assertEquals(q!.proposal.choices, ["Rare", "Medium rare", "Medium", "Medium well", "Well done"]);
});

Deno.test("burger: a real platform-sourced (stated) group on the item suppresses the temp question, even though it doesn't bind the temp slot itself", () => {
  const beef = item({
    name: "Bacon Cheeseburger", category: "Burgers",
    extractedGroups: [
      { name: "Choose an option", required: true, choiceNames: ["Plain", "With Bacon"], provenance: "stated" },
      { name: "Add Extra", required: false, choiceNames: ["Extra Cheese"], provenance: "stated" },
    ],
  });
  const result = inferCategory("Burgers", [beef]);
  assertEquals(result.questions.find(q => q.slot_key === "temp"), undefined);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "temp");
  assertEquals(outcome!.kind, "advisory");
  assertEquals(outcome!.choices, ["Rare", "Medium rare", "Medium", "Medium well", "Well done"]);
});

Deno.test("burger: a hand-built/owner_confirmed group (not 'stated') does NOT suppress the temp question — gate is stated-only", () => {
  const beef = item({
    name: "Bacon Cheeseburger", category: "Burgers",
    extractedGroups: [
      { name: "Add Extra", required: false, choiceNames: ["Extra Cheese"], provenance: "owner_confirmed" },
    ],
  });
  const result = inferCategory("Burgers", [beef]);
  assertExists(result.questions.find(q => q.slot_key === "temp"));
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "temp")!.kind, "proposed");
});

Deno.test("sandwich: a real stated group suppresses the unbound bread question for that item only, mixed category unaffected for the rest", () => {
  const hasStatedElsewhere = item({
    name: "Turkey Club", category: "Cold Sandwiches",
    extractedGroups: [{ name: "Choose an option", required: true, choiceNames: ["Regular"], provenance: "stated" }],
  });
  const noSourceData = item({ name: "Ham & Cheese", category: "Cold Sandwiches" });
  const result = inferCategory("Cold Sandwiches", [hasStatedElsewhere, noSourceData]);
  const q = result.questions.find(q => q.slot_key === "bread");
  assertExists(q);
  assertEquals(q!.items_affected, 1); // only Ham & Cheese, which has no source data at all
  assert(q!.proposal.exclusions.includes("Turkey Club"));
  assertEquals(
    result.slotOutcomes.find(o => o.slot_key === "bread" && o.item_id === hasStatedElsewhere.id)!.kind,
    "advisory",
  );
});

Deno.test("sandwich: a required singleton group with provenance='inferred' suppresses the bread question (5.5b) — real Zio's Gyro shape", () => {
  // 2026-09-08: "Gyro" now short-circuits to not_applicable via the
  // sandwich archetype's generalized bread-form-in-name applies_when
  // guard (nameStatesBreadForm includes "gyro") before ever reaching
  // 5.5b's required-singleton-group check — same "no question either
  // way" result, just via the more direct guard now. Renamed the item so
  // this test still exercises 5.5b itself, not the name guard.
  const gyro = item({
    name: "Zio's Basket", category: "Baskets & Gyros",
    description: "Sliced gyro meat with lettuce, tomato, onions & tzatziki sauce, served with fries.",
    extractedGroups: [{ name: "Type", required: true, choiceNames: ["Gyros"], provenance: "inferred" }],
  });
  const result = inferCategory("Baskets & Gyros", [gyro]);
  assertEquals(result.questions.find(q => q.slot_key === "bread"), undefined);
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "bread")!.kind, "advisory");
});

Deno.test("sandwich: an item with ONLY a modifier group (no required group) still gets the bread question (5.5b requires a required group)", () => {
  const noRequiredGroup = item({
    name: "Ham & Cheese", category: "Cold Sandwiches",
    extractedGroups: [{ name: "Add Extra", required: false, choiceNames: ["Extra Mayo"], provenance: "owner_confirmed" }],
  });
  const result = inferCategory("Cold Sandwiches", [noRequiredGroup]);
  assertExists(result.questions.find(q => q.slot_key === "bread"));
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "bread")!.kind, "needs_question");
});

Deno.test("sandwich: a required group with MULTIPLE choices does not trigger 5.5b (real choice present, still needs_question if unbound to bread)", () => {
  const multiChoiceRequired = item({
    name: "Club Sandwich", category: "Cold Sandwiches",
    extractedGroups: [{ name: "Choose an option", required: true, choiceNames: ["Regular", "Large"], provenance: "inferred" }],
  });
  const result = inferCategory("Cold Sandwiches", [multiChoiceRequired]);
  assertExists(result.questions.find(q => q.slot_key === "bread"));
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "bread")!.kind, "needs_question");
});

Deno.test("sandwich: a description stating a single fixed bread type ('on rye bread') suppresses the bread question (4.5) — real NJB Sloppy Joe shape", () => {
  const sloppyJoe = item({
    name: "Sloppy Joe - Roast Beef", category: "Cold Sandwiches",
    description: "Roast beef with coleslaw, provolone cheese & Russian dressing on rye bread.",
  });
  const result = inferCategory("Cold Sandwiches", [sloppyJoe]);
  assertEquals(result.questions.find(q => q.slot_key === "bread"), undefined);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  assertEquals(outcome.kind, "stated");
  assertEquals(outcome.choices, ["rye bread"]);
});

Deno.test("sandwich: a fixed bread type stated at the START of the description (no 'on'/'in') is still recognized — real NJB Avocado Crush shape", () => {
  const avocadoCrush = item({
    name: "Avocado Crush", category: "Breakfast Sandwiches",
    description: "Wheat toast schmeared with crushed fresh avocados and everything flavored seeds.",
  });
  const result = inferCategory("Breakfast Sandwiches", [avocadoCrush]);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  assertEquals(outcome.kind, "stated");
  assertEquals(outcome.choices, ["Wheat toast"]);
});

Deno.test("sandwich: 'on roll' is recognized even alongside an unrelated, non-list 'choice of' clause — real NJB Chicken Cutlet Sandwich shape", () => {
  const chickenCutlet = item({
    name: "Chicken Cutlet Sandwich", category: "Hot Sandwiches",
    description: "Chicken cutlet with choice of cheese, mayo, lettuce, tomatoes and onions on roll.",
  });
  const result = inferCategory("Hot Sandwiches", [chickenCutlet]);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  assertEquals(outcome.kind, "stated");
  assertEquals(outcome.choices, ["roll"]);
});

Deno.test("sandwich: a wrap-named item never gets a bread question regardless of description (wrap applies_when guard) — real NJB Cheesesteak Wrap shape", () => {
  const cheesesteakWrap = item({
    name: "Cheesesteak Wrap", category: "Wraps",
    description: "Cheesesteak with American cheese, peppers & onions in a wrap.",
  });
  const noMentionWrap = item({
    name: "Habanero Wrap", category: "Wraps",
    description: "Grilled or crispy chicken with bacon, ranch, lettuce, tomato & bacon habanero jam.",
  });
  const result = inferCategory("Wraps", [cheesesteakWrap, noMentionWrap]);
  assertEquals(result.questions.find(q => q.slot_key === "bread"), undefined);
  for (const outcome of result.slotOutcomes.filter(o => o.slot_key === "bread")) {
    assertEquals(outcome.kind, "not_applicable");
  }
});

Deno.test("sandwich: a name that states its own bread form never gets a bread question, no option group or description needed (generalized bread-form-in-name guard) — real Zio's Hot/Cold Subs shape", () => {
  const steakSub = item({ name: "Steak Sub", category: "Hot Subs" });
  const hamCheeseSub = item({ name: "Ham & Cheese Sub", category: "Cold Subs" });
  const chickenCheesesteakSub = item({ name: "Chicken Cheesesteak Sub", category: "Hot Subs" });
  const hoagie = item({ name: "Italian Hoagie", category: "Cold Subs" });
  const hero = item({ name: "Meatball Hero", category: "Hot Subs" });
  const panini = item({ name: "Turkey Panini", category: "Hot Sandwiches" });
  const items = [steakSub, hamCheeseSub, chickenCheesesteakSub, hoagie, hero, panini];
  const result = inferCategory("Hot Subs", items);
  assertEquals(result.questions.find(q => q.slot_key === "bread"), undefined);
  for (const it of items) {
    const outcome = result.slotOutcomes.find(o => o.slot_key === "bread" && o.item_id === it.id)!;
    assertEquals(outcome.kind, "not_applicable");
  }
});

Deno.test("sandwich: a name that does NOT state a bread form still gets the bread question (generalized guard must not overreach) — real NJB Reuben/Chicken Cutlet shape", () => {
  const reuben = item({ name: "Reuben", category: "Hot Sandwiches" });
  const chickenCutlet = item({ name: "Chicken Cutlet", category: "Cold Sandwiches" });
  for (const [it, category] of [[reuben, "Hot Sandwiches"], [chickenCutlet, "Cold Sandwiches"]] as const) {
    const result = inferCategory(category, [it]);
    assertExists(result.questions.find(q => q.slot_key === "bread"));
    assertEquals(result.slotOutcomes.find(o => o.slot_key === "bread")!.kind, "needs_question");
  }
});

Deno.test("sandwich: an unenumerated 'choice of bread' stays needs_question (4.5 must not guess at a genuine gap) — real NJB Turkey Melt/Tuna Melt shape", () => {
  const turkeyMelt = item({
    name: "Turkey Melt", category: "Hot Sandwiches",
    description: "Turkey with choice of cheese & grilled tomatoes on choice of bread.",
  });
  const result = inferCategory("Hot Sandwiches", [turkeyMelt]);
  assertExists(result.questions.find(q => q.slot_key === "bread"));
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "bread")!.kind, "needs_question");
});

Deno.test("steak: 'steak' regex is word-bounded, does not match 'cheesesteak' item names", () => {
  const cheesesteak = item({ name: "Cheesesteak", category: "Hot Sandwiches" });
  // category resolves this to sandwich, not steak, and even a direct
  // per-item steak-archetype check should not misfire on the item name
  const steakArchetype = ARCHETYPES.find(a => a.key === "steak")!;
  const matchesName = steakArchetype.match.some(re => re.test(cheesesteak.name));
  assertEquals(matchesName, false);
});

Deno.test("sandwich: bread binds to a found extracted group -> stated, no question", () => {
  const withBread = item({
    name: "BLT", category: "Cold Sandwiches",
    extractedGroups: [{ name: "Bread", required: true, choiceNames: ["White", "Wheat", "Rye"] }],
  });
  const result = inferCategory("Cold Sandwiches", [withBread]);
  const q = result.questions.find(q => q.slot_key === "bread");
  assertEquals(q, undefined);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread");
  assertEquals(outcome!.kind, "stated");
  assertEquals(outcome!.source, "bind");
});

Deno.test("sandwich: bread unbound across the whole category -> one category-scoped question", () => {
  const items = [
    item({ name: "Turkey Club", category: "Cold Sandwiches" }),
    item({ name: "Ham & Cheese", category: "Cold Sandwiches" }),
  ];
  const result = inferCategory("Cold Sandwiches", items);
  const q = result.questions.find(q => q.slot_key === "bread");
  assertExists(q);
  assertEquals(q!.items_affected, 2);
  assertEquals(q!.blocking, true);
  assertEquals(q!.scope_type, "category");
  assertEquals(q!.scope_id, "Cold Sandwiches");
});

Deno.test("sandwich: protein slot resolves from the normalizer's name-sourced 'X or Y' slot", () => {
  const gyro = item({ name: "Gyro", category: "Sandwiches", nameSlotChoices: ["Beef", "Chicken"] });
  const result = inferCategory("Sandwiches", [gyro]);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "protein");
  assertEquals(outcome!.kind, "stated");
  assertEquals(outcome!.source, "name");
  assertEquals(outcome!.choices, ["Beef", "Chicken"]);
  // stated -> no question for protein
  assertEquals(result.questions.find(q => q.slot_key === "protein"), undefined);
});

Deno.test("salad: dressing default_from_name excludes caesar/greek items from the question", () => {
  const items = [
    item({ name: "Caesar Salad", category: "Salads" }),
    item({ name: "Greek Salad", category: "Salads" }),
    item({ name: "Garden Salad", category: "Salads" }),
    item({ name: "Chef Salad", category: "Salads" }),
  ];
  const result = inferCategory("Salads", items);
  const q = result.questions.find(q => q.slot_key === "dressing");
  assertExists(q);
  assertEquals(q!.items_affected, 2); // Garden + Chef only
  assert(q!.proposal.exclusions.includes("Caesar Salad"));
  assert(q!.proposal.exclusions.includes("Greek Salad"));
  const caesarOutcome = result.slotOutcomes.find(o => o.slot_key === "dressing" && o.item_id === items[0].id);
  assertEquals(caesarOutcome!.kind, "default");
});

Deno.test("pasta: pasta_type is not kitchen_critical/price_critical -> unbound falls to 'skip', no question", () => {
  const items = [item({ name: "Pasta Alfredo", category: "Pasta" })];
  const result = inferCategory("Pasta", items);
  assertEquals(result.archetype, "pasta");
  const outcome = result.slotOutcomes.find(o => o.slot_key === "pasta_type");
  assertEquals(outcome!.kind, "skip");
  assertEquals(result.questions.length, 0);
});

Deno.test("bagel: bagel_type only applies to 'Bagel with X' items, not bare typed bagels", () => {
  const bareBagel = item({ name: "Cinnamon Raisin Bagel", category: "Bagels" });
  const withBagel = item({ name: "Bagel with Cream Cheese", category: "Bagel With" });
  const bareResult = inferCategory("Bagels", [bareBagel]);
  const withResult = inferCategory("Bagel With", [withBagel]);
  assertEquals(bareResult.slotOutcomes.find(o => o.slot_key === "bagel_type")!.kind, "not_applicable");
  assertEquals(withResult.slotOutcomes.find(o => o.slot_key === "bagel_type")!.kind, "needs_question");
});

Deno.test("bagel: spread applies only when name/description names cream cheese/butter/schmear", () => {
  const plain = item({ name: "Sesame Bagel", category: "Bagels", description: "Fresh baked." });
  const withSpread = item({ name: "Bagel with Flavored Cream Cheese", category: "Bagel With" });
  const plainResult = inferCategory("Bagels", [plain]);
  const spreadResult = inferCategory("Bagel With", [withSpread]);
  assertEquals(plainResult.slotOutcomes.find(o => o.slot_key === "spread")!.kind, "not_applicable");
  assertEquals(spreadResult.slotOutcomes.find(o => o.slot_key === "spread")!.kind, "needs_question");
});

Deno.test("eggs: egg_style universal choices supply WITHOUT an owner question (2026-09-08, PO directive superseding the prior 'proposed' behavior) — real NJB 'Two Eggs Any Style Platter'", () => {
  const anyStyle = item({ name: "Two Eggs Any Style Platter", category: "Omelette & Egg Platters" });
  const omelet = item({ name: "Cheese Omelette Platter", category: "Omelette & Egg Platters" });
  const result = inferCategory("Omelette & Egg Platters", [anyStyle, omelet]);
  const outcomes = result.slotOutcomes.filter(o => o.slot_key === "egg_style");
  const anyStyleOutcome = outcomes.find(o => o.item_id === anyStyle.id)!;
  assertEquals(anyStyleOutcome.kind, "advisory");
  assertEquals(anyStyleOutcome.choices, ["Scrambled", "Over easy", "Over medium", "Over hard", "Sunny side up", "Poached"]);
  assertEquals(outcomes.find(o => o.item_id === omelet.id)!.kind, "not_applicable");
  // advisory never contributes to needsQuestion — no owner_question at all.
  assertEquals(result.questions.find(q => q.slot_key === "egg_style"), undefined);
});

Deno.test("eggs: burger/steak temp is UNAFFECTED by egg_style's universalSuppliesWithoutQuestion opt-in — still asks when unbound (deliberately not mirrored onto every universal_choices slot)", () => {
  const burger = item({ name: "Cheeseburger", category: "Burgers" });
  const result = inferCategory("Burgers", [burger]);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "temp")!;
  assertEquals(outcome.kind, "proposed");
  assertExists(result.questions.find(q => q.slot_key === "temp"));
});

Deno.test("eggs: egg_side binds to the description's SIDE clause (sideSlotChoices), not the bread/toast one — closes the 'genuine by design' standing question, real NJB 10-platter shape", () => {
  const platter = item({
    name: "Western Omelette Platter", category: "Omelette & Egg Platters",
    description: "Western omelette with ham, peppers & onions. Served with home fries or hash brown and choice of bagel or toast.",
    descriptionSlotChoices: ["Bagel", "Toast"],
    sideSlotChoices: ["Home Fries", "Hash Brown"],
  });
  const result = inferCategory("Omelette & Egg Platters", [platter]);
  const side = result.slotOutcomes.find(o => o.slot_key === "egg_side")!;
  assertEquals(side.kind, "stated");
  assertEquals(side.source, "description");
  assertEquals(side.choices, ["Home Fries", "Hash Brown"]);
  const toast = result.slotOutcomes.find(o => o.slot_key === "toast")!;
  assertEquals(toast.kind, "stated");
  assertEquals(toast.choices, ["Bagel", "Toast"]);
  assertEquals(result.questions.find(q => q.slot_key === "egg_side"), undefined);
});

Deno.test("eggs: egg_side still asks when a description states no side clause at all (no silent stated-with-wrong-data, no regression for items with genuinely no side data)", () => {
  const noSide = item({ name: "Cheese Omelette Platter", category: "Omelette & Egg Platters", sideSlotChoices: null });
  const result = inferCategory("Omelette & Egg Platters", [noSide]);
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "egg_side")!.kind, "needs_question");
});

Deno.test("platter: side binds from the normalizer's description slot when present, else asks", () => {
  const withOr = item({
    name: "Fish Platter", category: "Entrees",
    description: "Served with choice of rice or fries.",
    descriptionSlotChoices: ["Rice", "Fries"],
  });
  // Vito's real phrasing has no "or" at all ("choice of pasta, garlic
  // knots, side salad") so normalize.ts intentionally does NOT produce a
  // descriptionSlotChoices for it -- side must fall through to needs_question,
  // not silently claim "stated".
  const noOr = item({
    name: "Chicken Marsala", category: "Entrees",
    description: "Served with choice of pasta, garlic knots, side salad.",
    descriptionSlotChoices: null,
  });
  const result = inferCategory("Entrees", [withOr, noOr]);
  const outcomes = result.slotOutcomes.filter(o => o.slot_key === "side");
  assertEquals(outcomes.find(o => o.item_id === withOr.id)!.kind, "stated");
  assertEquals(outcomes.find(o => o.item_id === noOr.id)!.kind, "needs_question");
});

Deno.test("platter: side wires an item's own real unclaimed option_group instead of asking, when no description clause exists (Fix 1, real Vito's Chicken Parmesan/Pasta shape)", () => {
  const withPasta = item({
    name: "Chicken Parmesan", category: "Entrees",
    description: "Served with choice of pasta, garlic knots, side salad.",
    descriptionSlotChoices: null,
    extractedGroups: [
      { name: "Pasta", required: true, choiceNames: ["Spaghetti", "Penne", "Angel Hair", "Linguine"], provenance: "owner_confirmed" },
    ],
  });
  const noGroup = item({
    name: "Chicken Marsala", category: "Entrees",
    description: "Served with choice of pasta, garlic knots, side salad.",
    descriptionSlotChoices: null,
  });
  const result = inferCategory("Entrees", [withPasta, noGroup]);
  const outcomes = result.slotOutcomes.filter(o => o.slot_key === "side");
  const wired = outcomes.find(o => o.item_id === withPasta.id)!;
  assertEquals(wired.kind, "stated");
  assertEquals(wired.source, "bind");
  assertEquals(wired.choices, ["Spaghetti", "Penne", "Angel Hair", "Linguine"]);
  assertEquals(outcomes.find(o => o.item_id === noGroup.id)!.kind, "needs_question");
  // withPasta is excluded from the resulting question; noGroup is still the
  // one genuine gap left in the category.
  const question = result.questions.find(q => q.slot_key === "side")!;
  assertEquals(question.items_affected, 1);
  assert(question.proposal.exclusions.includes("Chicken Parmesan"));
});

Deno.test("sandwich: bread does NOT wire an item's unrelated, unclaimed group (guard against red herrings, real Vito's Buffalo Chicken Cheesesteak shape: a real 'Sauce' group exists, 'Bread' genuinely doesn't)", () => {
  const noBreadButSauce = item({
    name: "Buffalo Chicken Cheesesteak", category: "Hot Sandwiches",
    extractedGroups: [
      { name: "Sauce", required: true, choiceNames: ["Hot", "Mild", "BBQ", "Sweet & Spicy"], provenance: "owner_confirmed" },
    ],
  });
  const result = inferCategory("Hot Sandwiches", [noBreadButSauce]);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  // bread HAS its own bind_to_list_named (/bread|roll/i) — the generalized
  // fallback must never kick in for a slot that already tried and failed to
  // find its answer by name; "Sauce" must stay unclaimed, not misread as bread.
  assertEquals(outcome.kind, "needs_question");
});

Deno.test("platter: side falls through to needs_question (not a wrong guess) when an item has TWO real unclaimed groups (genuine ambiguity, no bind pattern to disambiguate)", () => {
  const twoGroups = item({
    name: "Sampler Platter", category: "Entrees",
    extractedGroups: [
      { name: "Pasta", required: true, choiceNames: ["Spaghetti", "Penne"], provenance: "owner_confirmed" },
      { name: "Vegetable", required: true, choiceNames: ["Broccoli", "Green Beans"], provenance: "owner_confirmed" },
    ],
  });
  const result = inferCategory("Entrees", [twoGroups]);
  assertEquals(result.slotOutcomes.find(o => o.slot_key === "side")!.kind, "needs_question");
});

Deno.test("size/count: multiple sibling rows -> stated with no question; a single row -> not_applicable", () => {
  const folded = [
    item({ name: "Cheese - Small", category: "Pizza", productKey: "pizza:cheese", siblingCount: 3 }),
  ];
  const single = [
    item({ name: "Margherita", category: "Pizza", productKey: "pizza:margherita", siblingCount: 1 }),
  ];
  const foldedResult = inferCategory("Pizza", folded);
  const singleResult = inferCategory("Pizza", single);
  assertEquals(foldedResult.slotOutcomes.find(o => o.slot_key === "size")!.kind, "stated");
  assertEquals(singleResult.slotOutcomes.find(o => o.slot_key === "size")!.kind, "not_applicable");
  // neither ever produces an owner_question for size
  assertEquals(foldedResult.questions.find(q => q.slot_key === "size"), undefined);
  assertEquals(singleResult.questions.find(q => q.slot_key === "size"), undefined);
});

Deno.test("owner_question templates never leak an unrendered placeholder (Melvin finding, Bug 1)", () => {
  for (const archetype of ARCHETYPES) {
    for (const slot of archetype.slots) {
      if (!slot.owner_question) continue; // size/count: never rendered into a question
      assert(!/\{display_name\}|\{choices_or\}/.test(slot.owner_question),
        `${archetype.key}.${slot.slot_key} owner_question has an unrenderable placeholder: "${slot.owner_question}"`);
    }
  }
});

Deno.test("description-sourced binding rejects a clause clipped mid-parenthetical (Melvin finding, Bug 2)", () => {
  // Reproduces NJB's real "Bacon, Sausage, Ham or Pork Roll Omelette
  // Platter": normalize.ts's first-match-only regex captures the MEAT
  // clause, not the toast clause, leaving an unbalanced paren in the token.
  const mislabeled = item({
    name: "Bacon, Sausage, Ham or Pork Roll Omelette Platter",
    category: "Omelette & Egg Platters",
    description: "Omelette with choice of meat (Bacon, Sausage, Ham, or Pork Roll). Served with home fries or hash brown and choice of bagel or toast.",
    descriptionSlotChoices: ["Meat (Bacon", "Sausage", "Ham", "Or Pork Roll)"],
  });
  const result = inferCategory("Omelette & Egg Platters", [mislabeled]);
  const toast = result.slotOutcomes.find(o => o.slot_key === "toast" && o.item_id === mislabeled.id);
  assertEquals(toast!.kind, "needs_question"); // NOT "stated" with wrong data
});

Deno.test("classify: 'gyro' resolves to sandwich (Appendix B's own worked example)", () => {
  assertEquals(classifyCategory("Baskets & Gyros", ["Gyro", "Chicken Gyro", "Fried Shrimp & Fries", "Chicken Fingers & Fries"]), "sandwich");
});

// ---- Category-as-shared-list binding (real NJB bug: bagel_type/spread asked
// unnecessarily even though a real "Bagels" / "Homemade Cream Cheese
// Spreads" category IS the choice list) ---------------------------------------

Deno.test("bind: bagel_type binds to a real 'Bagels' category candidate, zero questions, real price deltas only", () => {
  const priceItems = new Map([
    ["Bagels", [
      { name: "Plain Bagel", priceCents: 150 },
      { name: "Everything Bagel", priceCents: 150 },
      { name: "Assorted Flagel", priceCents: 210 },
    ]],
    ["Bagel With", [{ name: "Bagel with Butter", priceCents: 275 }]],
  ]);
  const candidates = buildCategoryCandidateGroups(priceItems);
  const bagelWithItems = [item({
    name: "Bagel with Butter", category: "Bagel With",
    categoryCandidateGroups: [...candidates.values()].filter(g => g.name !== "Bagel With"),
  })];
  const result = inferCategory("Bagel With", bagelWithItems);
  assertEquals(result.questions.find(q => q.slot_key === "bagel_type"), undefined);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bagel_type")!;
  assertEquals(outcome.kind, "stated");
  assertEquals(outcome.source, "bind");
  assertEquals(outcome.choices, ["Plain Bagel", "Everything Bagel", "Assorted Flagel"]);
  // baseline 150 (mode) -> Plain/Everything no delta, Flagel +60c real delta.
  assertEquals(outcome.choicePriceDeltaCents, [null, null, 60]);
});

Deno.test("bind guard: a category matching the pattern only by its HEADING, not its items, does not bind (real Vito's 'Stromboli Rolls'/'Flatbreads' false positive)", () => {
  const priceItems = new Map([
    ["Stromboli Rolls", [
      { name: "Cheesesteak", priceCents: 999 },
      { name: "Pepperoni", priceCents: 999 },
      { name: "Meat Lovers", priceCents: 999 },
    ]],
    // "Sandwiches" (not "Wraps"/"Subs") -- 2026-09-08: this test's target
    // item must not itself name a bread form (sub/hoagie/wrap/etc.), since
    // that now short-circuits to not_applicable via the sandwich
    // archetype's generalized bread-form-in-name applies_when guard (see
    // nameStatesBreadForm in archetypes.ts) before ever reaching the bind
    // step this test exists to exercise. Swapped to a plain sandwich item —
    // the Stromboli Rolls/Flatbreads false-positive-bind scenario is
    // identical either way, it's the item's OWN category/name that must
    // not matter.
    ["Sandwiches", [{ name: "Chicken Caesar Sandwich", priceCents: 895 }]],
  ]);
  const candidates = buildCategoryCandidateGroups(priceItems);
  // "Stromboli Rolls" classifies as pizza (an unrelated named archetype) —
  // fails the archetype-coherence guard even before item-support is checked.
  assertEquals(candidates.get("Stromboli Rolls")!.sourceArchetype, "pizza");
  const subItems = [item({
    name: "Chicken Caesar Sandwich", category: "Sandwiches",
    categoryCandidateGroups: [...candidates.values()].filter(g => g.name !== "Sandwiches"),
  })];
  const result = inferCategory("Sandwiches", subItems);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  assertEquals(outcome.kind, "needs_question"); // NOT wrongly bound to Stromboli Rolls
  assertExists(result.questions.find(q => q.slot_key === "bread"));
});

Deno.test("bind guard: item-level support blocks a category that classifies 'other' but whose items don't actually match the pattern (real Vito's 'Flatbreads')", () => {
  const priceItems = new Map([
    ["Flatbreads", [
      { name: "BBQ Chicken", priceCents: 1050 },
      { name: "Margherita", priceCents: 1050 },
    ]],
    // "Sandwiches", not "Wraps"/"Subs" -- see comment in the test above.
    ["Sandwiches", [{ name: "Chicken Caesar Sandwich", priceCents: 895 }]],
  ]);
  const candidates = buildCategoryCandidateGroups(priceItems);
  assertEquals(candidates.get("Flatbreads")!.sourceArchetype, "other"); // passes the archetype guard...
  const subItems = [item({
    name: "Chicken Caesar Sandwich", category: "Sandwiches",
    categoryCandidateGroups: [...candidates.values()].filter(g => g.name !== "Sandwiches"),
  })];
  const result = inferCategory("Sandwiches", subItems);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bread")!;
  assertEquals(outcome.kind, "needs_question"); // ...but 0/2 items mention bread/roll, so no bind
});

Deno.test("bind: a category priced '(per pound)' contributes real choice names but never a price delta (real NJB 'Homemade Cream Cheese Spreads')", () => {
  const priceItems = new Map([
    ["Homemade Cream Cheese Spreads", [
      { name: "Plain Cream Cheese Spread (per pound)", priceCents: 1095 },
      { name: "Lox Cream Cheese Spread (per pound)", priceCents: 1395 },
    ]],
    ["Bagel With", [{ name: "Bagel with Cream Cheese", priceCents: 400 }]],
  ]);
  const candidates = buildCategoryCandidateGroups(priceItems);
  const group = candidates.get("Homemade Cream Cheese Spreads")!;
  assertEquals(group.choicePriceDeltaCents, undefined); // bulk-unit prices, never a per-choice delta
  const bagelWithItems = [item({
    name: "Bagel with Cream Cheese", category: "Bagel With",
    categoryCandidateGroups: [...candidates.values()].filter(g => g.name !== "Bagel With"),
  })];
  const result = inferCategory("Bagel With", bagelWithItems);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "spread")!;
  assertEquals(outcome.kind, "stated");
  assertEquals(outcome.choices, ["Plain Cream Cheese Spread (per pound)", "Lox Cream Cheese Spread (per pound)"]);
  assertEquals(outcome.choicePriceDeltaCents, undefined);
});

Deno.test("bind: a real per-item extracted group still wins over a category candidate for the same pattern", () => {
  const priceItems = new Map([
    ["Bagels", [{ name: "Plain Bagel", priceCents: 150 }]],
  ]);
  const candidates = buildCategoryCandidateGroups(priceItems);
  const bagelWithItems = [item({
    name: "Bagel with Butter", category: "Bagel With",
    extractedGroups: [{ name: "Bagel Type", required: true, choiceNames: ["Hand-picked flavor"] }],
    categoryCandidateGroups: [...candidates.values()],
  })];
  const result = inferCategory("Bagel With", bagelWithItems);
  const outcome = result.slotOutcomes.find(o => o.slot_key === "bagel_type")!;
  assertEquals(outcome.choices, ["Hand-picked flavor"]);
});

// ---- §5.2 priority + blocking formulas --------------------------------------

Deno.test("computePriority matches §5.2 exactly: items_affected * (kc?3:0 + pc?3:0 + 1)", () => {
  assertEquals(computePriority(24, true, false), 24 * 4);
  assertEquals(computePriority(24, false, true), 24 * 4);
  assertEquals(computePriority(24, true, true), 24 * 7);
  assertEquals(computePriority(24, false, false), 24 * 1);
  assertEquals(computePriority(1, true, false), 4);
});

Deno.test("computeBlocking is true iff kitchen_critical or price_critical", () => {
  assertEquals(computeBlocking(true, false), true);
  assertEquals(computeBlocking(false, true), true);
  assertEquals(computeBlocking(true, true), true);
  assertEquals(computeBlocking(false, false), false);
});

Deno.test("inferCategory's questions carry priority/blocking computed by the same two functions", () => {
  const items = [item({ name: "Gyro Sandwich", category: "Sandwiches" }), item({ name: "Club", category: "Sandwiches" })];
  const result = inferCategory("Sandwiches", items);
  const bread = result.questions.find(q => q.slot_key === "bread")!;
  assertEquals(bread.priority, computePriority(bread.items_affected, true, false));
  assertEquals(bread.blocking, computeBlocking(true, false));
});

// ---- The hard invariant: never touches option_groups/option_choices --------

Deno.test("source contains no reference to writing option_groups or option_choices", async () => {
  const source = await Deno.readTextFile(new URL("./archetypes.ts", import.meta.url));
  // this file must only ever mention these tables in comments explaining the
  // invariant -- never in a string that looks like a table name passed to
  // .from(...) / an INSERT / an UPDATE.
  assert(!/\.from\(\s*["'`]option_(groups|choices)["'`]/.test(source));
  assert(!/insert\s+into\s+option_(groups|choices)/i.test(source));
  assert(!/update\s+option_(groups|choices)/i.test(source));
});

// ==============================================================================
// LIVE DATA — all three real shops. Skipped (not failed) if creds are absent.
// ==============================================================================
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SHOPS: Record<string, string> = {
  "Vito's Pizza": "e0000000-0000-0000-0000-000000000001",
  "Not Just Bagels": "b0000000-0000-0000-0000-000000000001",
  "Zio's Pizzeria": "2cba7b51-211c-4437-8910-1af4dcc03498",
};

// deno-lint-ignore no-explicit-any
async function loadShopItems(supabase: any, shopId: string): Promise<InferItemInput[]> {
  const { data: menus } = await supabase.from("menus").select("id").eq("shop_id", shopId).limit(1);
  const menuId = (menus as { id: string }[] | null)?.[0]?.id;
  if (!menuId) return [];
  const { data: rows } = await supabase
    .from("menu_items")
    .select("id,name,description,category,price_cents,size_label")
    .eq("menu_id", menuId);
  const items = (rows ?? []) as { id: string; name: string; description: string | null; category: string | null; price_cents: number; size_label: string | null }[];

  const ids = items.map(i => i.id);
  const groups: { id: string; name: string; required: boolean; menu_item_id: string; provenance: string }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await supabase.from("option_groups").select("id,name,required,menu_item_id,provenance").in("menu_item_id", chunk);
    groups.push(...((data ?? []) as typeof groups));
  }
  const groupIds = groups.map(g => g.id);
  const choices: { option_group_id: string; name: string }[] = [];
  for (let i = 0; i < groupIds.length; i += 200) {
    const chunk = groupIds.slice(i, i + 200);
    const { data } = await supabase.from("option_choices").select("option_group_id,name").in("option_group_id", chunk);
    choices.push(...((data ?? []) as typeof choices));
  }
  const choicesByGroup = new Map<string, string[]>();
  for (const c of choices) {
    const list = choicesByGroup.get(c.option_group_id) ?? [];
    list.push(c.name);
    choicesByGroup.set(c.option_group_id, list);
  }
  const groupsByItem = new Map<string, { name: string; required: boolean; choiceNames: string[]; provenance: string }[]>();
  for (const g of groups) {
    const list = groupsByItem.get(g.menu_item_id) ?? [];
    list.push({ name: g.name, required: g.required, choiceNames: choicesByGroup.get(g.id) ?? [], provenance: g.provenance });
    groupsByItem.set(g.menu_item_id, list);
  }

  // crude product_key/siblingCount: same category + name with a trailing
  // " - <size_label>" stripped, matching normalize.ts's own rule closely
  // enough for a sibling count (not a byte-for-byte reimplementation).
  const baseNameOf = (name: string, sizeLabel: string | null): string => {
    if (!sizeLabel) return name;
    const escaped = sizeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = name.match(new RegExp(`^(.*?)\\s*-\\s*${escaped}$`, "i"));
    return m ? m[1].trim() : name;
  };
  const siblingCounts = new Map<string, number>();
  for (const it of items) {
    const key = `${it.category ?? ""}::${baseNameOf(it.name, it.size_label).toLowerCase()}`;
    siblingCounts.set(key, (siblingCounts.get(key) ?? 0) + 1);
  }

  // Same "category as shared list" recognition as compile-menu.ts's
  // buildOwnerQuestionSummaries and the item-9 report — exercises the real
  // fix against real data instead of a parallel reimplementation.
  const priceItemsByCategory = new Map<string, CategoryPriceItem[]>();
  for (const it of items) {
    if (!it.category) continue;
    const list = priceItemsByCategory.get(it.category) ?? [];
    list.push({ name: it.name, priceCents: it.price_cents });
    priceItemsByCategory.set(it.category, list);
  }
  const categoryCandidates = buildCategoryCandidateGroups(priceItemsByCategory);

  // Real normalize.ts output, not a parallel reimplementation — this is
  // what closed the gap between this report and the actual production
  // extraction (2026-09-08: the prior hand-rolled regex here predated even
  // the Oxford-comma fix and never saw more than one "choice of" clause per
  // item, so it silently under-reported what the real pipeline resolves).
  const rawForNormalize: RawMenuItemRow[] = items.map(it => ({
    id: it.id, name: it.name, description: it.description, category: it.category,
    price_cents: it.price_cents, size_label: it.size_label,
  }));
  const normalizedById = new Map(normalizeMenuItems(rawForNormalize).map(n => [n.id, n]));

  return items.map(it => {
    const normalized = normalizedById.get(it.id);
    const nameSlot = normalized?.slots.find(s => s.source === "name");
    const descriptionSlot = normalized ? pickDescriptionSlot(normalized) : undefined;
    const sideSlot = normalized ? pickSideDescriptionSlot(normalized) : undefined;
    return {
      id: it.id,
      name: it.name,
      description: it.description,
      category: it.category,
      productKey: null,
      siblingCount: siblingCounts.get(`${it.category ?? ""}::${baseNameOf(it.name, it.size_label).toLowerCase()}`) ?? 1,
      nameSlotChoices: nameSlot ? nameSlot.choices.map(c => c.display_name) : null,
      descriptionSlotChoices: descriptionSlot ? descriptionSlot.choices.map(c => c.display_name) : null,
      sideSlotChoices: sideSlot ? sideSlot.choices.map(c => c.display_name) : null,
      extractedGroups: groupsByItem.get(it.id) ?? [],
      categoryCandidateGroups: [...categoryCandidates.values()].filter(g => g.name !== it.category),
    };
  });
}

for (const [shopName, shopId] of Object.entries(SHOPS)) {
  Deno.test({
    name: `live: ${shopName} — every category classifies and infers without throwing`,
    ignore: !SUPABASE_URL || !SUPABASE_KEY,
    async fn() {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
      const items = await loadShopItems(supabase, shopId);
      assert(items.length > 0, `${shopName} has no menu items — check shop_id`);

      const byCategory = new Map<string, InferItemInput[]>();
      for (const it of items) {
        const cat = it.category ?? "(uncategorized)";
        const list = byCategory.get(cat) ?? [];
        list.push(it);
        byCategory.set(cat, list);
      }

      const report: string[] = [`\n===== ${shopName} (${items.length} items, ${byCategory.size} categories) =====`];
      let otherCount = 0;
      let blockingQuestions = 0;
      for (const [category, catItems] of byCategory) {
        const result = inferCategory(category, catItems);
        if (result.archetype === "other") otherCount++;
        blockingQuestions += result.questions.filter(q => q.blocking).length;
        const qSummary = result.questions.map(q => `${q.slot_key}(${q.items_affected}${q.blocking ? ",blocking" : ""})`).join(", ");
        report.push(`  [${category}] (${catItems.length} items) -> ${result.archetype}${qSummary ? " | questions: " + qSummary : ""}`);
      }
      report.push(`  -- ${otherCount}/${byCategory.size} categories fell to 'other'; ${blockingQuestions} blocking questions total`);
      console.log(report.join("\n"));
    },
  });
}
