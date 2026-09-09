/**
 * menu-readiness.ts — unit tests (docs/specs/2026-09-07-conversation-ready-
 * menu-design.md §8, §11 item 5).
 *
 * §8.1/§8.2 coverage (bot_state, the 8 menu-level invariants) already lives
 * in compile-menu.test.ts, since compile-menu.ts is where those are
 * implemented (item 4) — not duplicated here. This file covers what's new:
 * §8.3, the generated menu walk, executed against the real resolver +
 * ask-plan-engine + pricing + itemizer code (no fixtures pretending to be
 * that code — the actual imports).
 *
 * Run: deno test --allow-net --allow-env --allow-read supabase/functions/_shared/menu-readiness.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compileMenu, type CompileGroup, type CompileItem, type CompiledItem } from "./compile-menu.ts";
import { runItemWalk, runMenuWalk, runMultiItemMenuWalk, summarizeItemStates } from "./menu-readiness.ts";

function choice(overrides: Partial<CompileGroup["choices"][0]> = {}): CompileGroup["choices"][0] {
  return {
    id: crypto.randomUUID(),
    name: "Choice",
    display_name: null,
    price_cents: 0,
    is_default: false,
    provenance: "stated",
    ...overrides,
  };
}

function group(overrides: Partial<CompileGroup> = {}): CompileGroup {
  return {
    id: crypto.randomUUID(),
    name: "Group",
    kind: "slot",
    slot_key: null,
    min_select: 1,
    max_select: 1,
    kitchen_critical: false,
    price_critical: false,
    default_choice_id: null,
    ask_mode: null,
    provenance: "stated",
    display_order: 0,
    choices: [],
    ...overrides,
  };
}

function item(overrides: Partial<CompileItem> = {}): CompileItem {
  return {
    id: crypto.randomUUID(),
    name: "Item",
    display_name: "Item",
    category: "Category",
    price_cents: 1000,
    active: true,
    price_provenance: "stated",
    product_key: null,
    missing_from_source_since: null,
    groups: [],
    ...overrides,
  };
}

function compileOne(one: CompileItem): { item: CompileItem; compiled: CompiledItem; compiledMap: Map<string, CompiledItem> } {
  const result = compileMenu([one], [], "2026-09-09T00:00:00.000Z", true);
  const compiled = result.items[0];
  assertEquals(compiled.bot_state, "orderable", `fixture must compile orderable, got: ${compiled.bot_state_reason}`);
  return { item: one, compiled, compiledMap: new Map([[one.id, compiled]]) };
}

// A full-featured orderable pizza: an "ask" slot (Size, zero-delta choices
// so the walk's price assertion is order-independent), an "auto_single"
// slot (Crust, one choice, priced), an "apply_default" slot (Sauce, a real
// default), and an "offer_once" modifier (Extra Cheese) that must NEVER be
// applied since the walk never mentions it.
function buildPizzaFixture() {
  const small = choice({ name: "Small", display_name: "Small", price_cents: 0 });
  const large = choice({ name: "Large", display_name: "Large", price_cents: 0 });
  const sizeGroup = group({ name: "Size", slot_key: "size", kind: "slot", choices: [small, large] });

  const garlicCrust = choice({ name: "Garlic Crust", display_name: "Garlic Crust", price_cents: 150 });
  const crustGroup = group({ name: "Crust", slot_key: "bread", kind: "slot", choices: [garlicCrust] });

  const marinara = choice({ name: "Marinara", display_name: "Marinara", price_cents: 50 });
  const alfredo = choice({ name: "Alfredo", display_name: "Alfredo", price_cents: 300 });
  const sauceGroup = group({ name: "Sauce", slot_key: "sauce", kind: "slot", default_choice_id: marinara.id, choices: [marinara, alfredo] });

  const extraCheese = choice({ name: "Extra Cheese", display_name: "Extra Cheese", price_cents: 200 });
  const toppingsGroup = group({ name: "Toppings", kind: "modifier", ask_mode: "offer_once", choices: [extraCheese] });

  const pizzaItem = item({
    name: "PIZ001", // raw internal/POS name — deliberately unlike display_name
    display_name: "Cheese Pizza",
    price_cents: 1000, // base
    groups: [sizeGroup, crustGroup, sauceGroup, toppingsGroup],
  });

  return compileOne(pizzaItem);
}

Deno.test("walk: happy path — ask + auto_single + apply_default resolve, offer_once stays unapplied, price and ticket are exact", () => {
  const { item: pizzaItem, compiled, compiledMap } = buildPizzaFixture();
  const result = runItemWalk(pizzaItem, compiled, [pizzaItem], compiledMap);

  assertEquals(result.failures, [], `expected no failures, got: ${JSON.stringify(result.failures, null, 2)}`);
  assert(result.pass);

  // base 1000 + size delta 0 (either Small or Large, both 0) + crust 150 (auto_single) + sauce 50 (apply_default Marinara) = 1200
  assertEquals(result.cart_line_price_cents, 1200);
  assertEquals(result.cart_total_with_fee_cents, 1200 + 99); // SERVICE_FEE_CENTS

  // Ticket must show the resolved choices...
  assert(result.ticket_text!.includes("Garlic Crust"));
  assert(result.ticket_text!.includes("Marinara"));
  // ...must never show the offer_once modifier nobody asked for...
  assert(!result.ticket_text!.includes("Extra Cheese"));
  // ...and must never leak the raw internal name in place of the display name.
  assert(!result.ticket_text!.includes("PIZ001"));
  assert(result.ticket_text!.includes("Cheese Pizza"));
});

// Both of these fixtures used to document genuine matching gaps ("Ay Ox" /
// "Ex" vs "Oh" — displays made entirely of sub-3-character words, which
// resolver.ts's and ask-plan-engine.ts's word-significance filters both
// used to treat as zero significant stems). Two rounds of exact-whole-
// string-match fixes closed both gaps: resolver.ts's findExactItemMatch
// (round 2, commit a9c03a1) resolves an item to itself off a full-string
// echo regardless of word length, and ask-plan-engine.ts's matchChoiceInText
// (round 3, this fix) does the same for a slot's own choices[0].display.
// The one GENUINE gap that survives an exact-string-match tier by design
// (missing beats wrong) is two entities sharing the identical display text
// — real, live examples of exactly this already exist (Zio's two distinct
// "Double Burger" items, flagged by invariants #3/#4) — so both tests below
// now exercise that instead.

Deno.test("walk: resolver-add failure surfaces when two items share the exact same display_name (genuine duplicate-name gap, real Double Burger shape)", () => {
  const soloChoice = choice({ name: "Only", display_name: "Only", price_cents: 0 });
  const soloGroup = group({ name: "Size", slot_key: "size", kind: "slot", choices: [soloChoice] });
  const itemA = item({ name: "TWIN-A", display_name: "Twin Special", price_cents: 500, groups: [soloGroup] });
  const itemB = item({ name: "TWIN-B", display_name: "Twin Special", price_cents: 600, groups: [soloGroup] });

  const compiledResult = compileMenu([itemA, itemB], [], "2026-09-09T00:00:00.000Z", true);
  for (const c of compiledResult.items) {
    assertEquals(c.bot_state, "orderable", `fixture must compile orderable, got: ${c.bot_state_reason}`);
  }
  const compiledMap = new Map(compiledResult.items.map(c => [c.item_id, c]));

  const result = runItemWalk(itemA, compiledMap.get(itemA.id)!, [itemA, itemB], compiledMap);
  assert(!result.pass);
  assert(result.failures.some(f => f.step === "resolver-add"), `expected a resolver-add failure, got: ${JSON.stringify(result.failures)}`);
});

Deno.test("walk: ask-loop failure surfaces when two choices in the same group share the exact same display (genuine duplicate-choice gap)", () => {
  const optA = choice({ name: "Sauce A", display_name: "Extra Sauce", price_cents: 0 });
  const optB = choice({ name: "Sauce B", display_name: "Extra Sauce", price_cents: 0 });
  const unaskableGroup = group({ name: "Style", slot_key: "flavor", kind: "slot", choices: [optA, optB] });
  const badItem = item({ name: "Sandwich", display_name: "Turkey Sandwich", price_cents: 800, groups: [unaskableGroup] });
  const { compiled, compiledMap } = compileOne(badItem);

  const result = runItemWalk(badItem, compiled, [badItem], compiledMap);
  assert(!result.pass);
  assert(
    result.failures.some(f => f.step === "ask-loop" || f.step.startsWith("ask:")),
    `expected an ask-loop/ask: failure, got: ${JSON.stringify(result.failures)}`,
  );
});

Deno.test("walk: runMenuWalk aggregates pass/fail counts across multiple items", () => {
  const good = buildPizzaFixture();
  const optA = choice({ name: "Sauce A", display_name: "Extra Sauce", price_cents: 0 });
  const optB = choice({ name: "Sauce B", display_name: "Extra Sauce", price_cents: 0 });
  const unaskableGroup = group({ name: "Style", slot_key: "flavor", kind: "slot", choices: [optA, optB] });
  const badItem = item({ name: "Sandwich", display_name: "Turkey Sandwich", price_cents: 800, groups: [unaskableGroup] });
  const badCompiled = compileOne(badItem);

  const allItems = [good.item, badItem];
  const allCompiled = new Map([...good.compiledMap, ...badCompiled.compiledMap]);

  const report = runMenuWalk(allItems, allCompiled);
  assertEquals(report.total_orderable, 2);
  assertEquals(report.passed, 1);
  assertEquals(report.failed, 1);
});

Deno.test("summarizeItemStates: counts orderable/blocked/display_only/stale over active items only", () => {
  const orderableItem = buildPizzaFixture().item;
  const blockedItem = item({ display_name: null, price_cents: 500 }); // missing display_name -> blocked
  const inactiveItem = item({ active: false, price_cents: 0 }); // inactive -> display_only, and excluded from total_active

  const result = compileMenu([orderableItem, blockedItem, inactiveItem], [], "t", true);
  const compiledMap = new Map(result.items.map(c => [c.item_id, c]));

  const counts = summarizeItemStates([orderableItem, blockedItem, inactiveItem], compiledMap);
  assertEquals(counts.total_active, 2); // inactiveItem is excluded
  assertEquals(counts.orderable, 1);
  assertEquals(counts.blocked, 1);
});

// ── §8.4 multi-item walk — a small fixture menu shaped to exercise all 4
// multi-item case types: a composed pizza (2 topping choices, so it covers
// both "compose from base+modifier" and "two of the same item, different
// modifiers"), and 3 plain items across 3 other categories.

function buildMultiItemFixtureMenu(): { items: CompileItem[]; compiledMap: Map<string, CompiledItem> } {
  const small = choice({ name: "Small", display_name: "Small", price_cents: 0 });
  const large = choice({ name: "Large", display_name: "Large", price_cents: 0 });
  const sizeGroup = group({ name: "Size", slot_key: "size", kind: "slot", choices: [small, large] });

  const pepperoni = choice({ name: "Pepperoni", display_name: "Pepperoni", price_cents: 300 });
  const mushroom = choice({ name: "Mushroom", display_name: "Mushroom", price_cents: 100 });
  const toppingsGroup = group({ name: "Toppings", kind: "modifier", ask_mode: "offer_once", choices: [pepperoni, mushroom] });

  const pizzaItem = item({
    name: "PIZ001",
    display_name: "Cheese Pizza",
    category: "Pizza",
    price_cents: 1000,
    groups: [sizeGroup, toppingsGroup],
  });

  const drinkItem = item({ name: "DRINK001", display_name: "Sprite", category: "Drinks", price_cents: 200, groups: [] });
  const saladItem = item({ name: "SAL001", display_name: "Garden Salad", category: "Salads", price_cents: 600, groups: [] });
  const wrapItem = item({ name: "WRAP001", display_name: "Turkey Wrap", category: "Wraps", price_cents: 700, groups: [] });

  const all = [pizzaItem, drinkItem, saladItem, wrapItem];
  const result = compileMenu(all, [], "2026-09-09T00:00:00.000Z", true);
  for (const c of result.items) {
    assertEquals(c.bot_state, "orderable", `fixture must compile orderable, got: ${c.bot_state_reason}`);
  }
  return { items: all, compiledMap: new Map(result.items.map(c => [c.item_id, c])) };
}

// KNOWN REAL GAP, not a test bug: resolver.ts's splitOnAndItem() probes 6
// words past each "and" to decide whether it's an item boundary. With 3+
// items chained by "and" and no commas ("one X and one Y and one Z and one
// W"), the probe after the FIRST "and" runs far enough forward to also
// contain the NEXT item's name, so both candidates score 1.0 and the tie
// resolves to null ("missing beats wrong") — only the LAST "and" (nothing
// left to bleed into) actually splits. The result: everything before the
// last item collapses into one unresolved phrase. This is exactly the
// "and"-separated case for 4 items, and this gate now catches it honestly
// instead of silently passing.
const KNOWN_AND_CHAIN_GAP_CASE_ID = "four-items-with-modifier:and-separated";

Deno.test("multi-item walk: all 4 case types generate against a well-formed fixture menu, across all 5 phrasings — every case passes except the documented and-chain gap", () => {
  const { items, compiledMap } = buildMultiItemFixtureMenu();
  const report = runMultiItemMenuWalk(items, compiledMap);

  assertEquals(report.skipped_case_types, [], `expected no skipped case types, got: ${JSON.stringify(report.skipped_case_types)}`);
  assertEquals(report.total_cases, 4 * 5); // 4 case types x 5 phrasings
  const failing = report.results.filter(r => !r.pass).map(r => r.case_id);
  assertEquals(failing, [KNOWN_AND_CHAIN_GAP_CASE_ID], `expected only the documented and-chain gap to fail, got: ${JSON.stringify(failing)}`);
  assertEquals(report.passed, report.total_cases - 1);
});

Deno.test("multi-item walk: two-same-item-different-modifiers case produces 2 distinct lines with isolated toppings, no leakage", () => {
  const { items, compiledMap } = buildMultiItemFixtureMenu();
  const report = runMultiItemMenuWalk(items, compiledMap);

  const cases = report.results.filter(r => r.case_type === "two-same-item-different-modifiers");
  assertEquals(cases.length, 5);
  for (const c of cases) {
    assert(c.pass, `case "${c.case_id}" (utterance: "${c.utterance}") failed: ${JSON.stringify(c.failures, null, 2)}`);
    assertEquals(c.actual_line_count, 2);
    // base 1000 x2 + pepperoni 300 + mushroom 100 = 2400
    assertEquals(c.subtotal_cents, 2400);
  }
});

Deno.test("multi-item walk: reports a case type as skipped (not a false pass) when the menu can't support it", () => {
  // Only plain items, zero modifier-bearing items — none of the modifier-
  // dependent case types can be generated from this menu.
  const drinkItem = item({ name: "DRINK001", display_name: "Sprite", category: "Drinks", price_cents: 200, groups: [] });
  const saladItem = item({ name: "SAL001", display_name: "Garden Salad", category: "Salads", price_cents: 600, groups: [] });
  const result = compileMenu([drinkItem, saladItem], [], "2026-09-09T00:00:00.000Z", true);
  const compiledMap = new Map(result.items.map(c => [c.item_id, c]));

  const report = runMultiItemMenuWalk([drinkItem, saladItem], compiledMap);
  assert(report.skipped_case_types.includes("four-items-with-modifier"));
  assert(report.skipped_case_types.includes("two-same-item-different-modifiers"));
  assert(report.skipped_case_types.includes("item-plus-non-composed"));
  // two-different-categories has a no-modifier fallback path and should still run.
  assert(!report.skipped_case_types.includes("two-different-categories"));
});
