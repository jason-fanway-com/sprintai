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
import { runItemWalk, runMenuWalk, summarizeItemStates } from "./menu-readiness.ts";

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

Deno.test("walk: resolver-add failure surfaces when resolveUtterance can't find the item by its own display_name", () => {
  // A display_name made entirely of sub-3-character words has zero
  // "significant" words by the resolver's own definition (resolver.ts's
  // significantItemWords filters length < 3) — findItemInText can never
  // score it above zero, so even resolving the item by its OWN exact name
  // fails. This is a genuine conversation-readiness gap the gate must catch,
  // not a harness bug.
  const soloChoice = choice({ name: "Only", display_name: "Only", price_cents: 0 });
  const soloGroup = group({ name: "Size", slot_key: "size", kind: "slot", choices: [soloChoice] });
  const badItem = item({ name: "XY", display_name: "Ay Ox", price_cents: 500, groups: [soloGroup] });
  const { compiled, compiledMap } = compileOne(badItem);

  const result = runItemWalk(badItem, compiled, [badItem], compiledMap);
  assert(!result.pass);
  assert(result.failures.some(f => f.step === "resolver-add"), `expected a resolver-add failure, got: ${JSON.stringify(result.failures)}`);
});

Deno.test("walk: ask-loop failure surfaces when choices[0].display can't be resolved back by the engine's own matcher", () => {
  // Both choices are 2-character displays — ask-plan-engine.ts's
  // matchChoiceInText (via significantStems, length >= 3) can never match
  // either one against itself, so answering "choices[0].display" verbatim
  // never resolves the slot. A real, unaskable slot — exactly the class of
  // bug the walk exists to catch.
  const optA = choice({ name: "Ex", display_name: "Ex", price_cents: 0 });
  const optB = choice({ name: "Oh", display_name: "Oh", price_cents: 0 });
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
  const soloChoice = choice({ name: "Only", display_name: "Only", price_cents: 0 });
  const soloGroup = group({ name: "Size", slot_key: "size", kind: "slot", choices: [soloChoice] });
  const badItem = item({ name: "XY", display_name: "Ay Ox", price_cents: 500, groups: [soloGroup] });
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
