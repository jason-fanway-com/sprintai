/**
 * compile-menu.ts — unit tests (docs/specs/2026-09-07-conversation-ready-menu-design.md
 * §3 stage 7, §11 item 4).
 *
 * Run: deno test --allow-net --allow-env --allow-read supabase/functions/_shared/compile-menu.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyOverrides,
  buildAskPlan,
  buildDerivedRows,
  buildOwnerQuestionSummaries,
  categoryLexiconTerms,
  compileItem,
  compileMenu,
  computeMenuInvariants,
  planOwnerQuestionsRefresh,
  type AskPlan,
  type CompileGroup,
  type CompileItem,
  type CompiledItem,
  type ExistingOwnerQuestionRow,
  type InferSourceItem,
  type OverrideRow,
  type PendingQuestion,
} from "./compile-menu.ts";
import type { OwnerQuestionDraft } from "./archetypes.ts";

function inferSourceItem(overrides: Partial<InferSourceItem> = {}): InferSourceItem {
  return {
    id: crypto.randomUUID(),
    name: "Item",
    description: null,
    category: "Category",
    productKey: null,
    extractedGroups: [],
    nameSlotChoices: null,
    descriptionSlotChoices: null,
    sideSlotChoices: null,
    priceCents: 0,
    ...overrides,
  };
}

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

// ---- Idempotency -----------------------------------------------------------

Deno.test("idempotency: compileItem run twice on identical input is byte-identical except compiled_at", () => {
  const beef = choice({ name: "Beef" });
  const chicken = choice({ name: "Chicken" });
  const it = item({
    display_name: "Gyro",
    groups: [group({ slot_key: "protein", kitchen_critical: true, max_select: 1, choices: [beef, chicken] })],
  });
  const a = compileItem(it, [], "2026-09-07T00:00:00Z");
  const b = compileItem(it, [], "2026-09-08T00:00:00Z");
  assertEquals({ ...a.ask_plan, compiled_at: "x" }, { ...b.ask_plan, compiled_at: "x" });
  assertEquals(a.bot_state, b.bot_state);
  assertEquals(a.bot_state_reason, b.bot_state_reason);
  assertEquals(a.lexicon_terms, b.lexicon_terms);
});

Deno.test("idempotency: compileMenu run twice on identical menu is byte-identical except compiled_at", () => {
  const items = [
    item({ display_name: "Large Cheese Pizza", category: "Pizza", groups: [group({ slot_key: "size", price_critical: true, choices: [choice({ name: "Large" })] })] }),
    item({ display_name: "Small Cheese Pizza", category: "Pizza", groups: [group({ slot_key: "size", price_critical: true, choices: [choice({ name: "Small" })] })] }),
  ];
  const r1 = compileMenu(items, [], "2026-09-07T00:00:00Z", false);
  const r2 = compileMenu(items, [], "2026-09-08T00:00:00Z", false);
  const strip = (r: typeof r1) => ({
    ...r,
    items: r.items.map(i => ({ ...i, ask_plan: { ...i.ask_plan, compiled_at: "x" } })),
  });
  assertEquals(strip(r1), strip(r2));
});

// ---- Canonical step order ---------------------------------------------------

Deno.test("canonical order: size, protein, temp, bread, dressing, side, then offer_once modifiers", () => {
  const it = item({
    groups: [
      group({ slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", choices: [choice()] }),
      group({ slot_key: "side", choices: [choice()] }),
      group({ slot_key: "dressing", choices: [choice()] }),
      group({ slot_key: "bread", choices: [choice()] }),
      group({ slot_key: "temp", choices: [choice(), choice()] }),
      group({ slot_key: "protein", choices: [choice(), choice()] }),
      group({ slot_key: "size", choices: [choice(), choice()] }),
    ],
  });
  const plan = buildAskPlan(it, "2026-09-07T00:00:00Z");
  assertEquals(plan.steps.map(s => s.slot_key), ["size", "protein", "temp", "bread", "dressing", "side", "toppings"]);
});

Deno.test("on_request modifiers appear as steps, ordered last (reactive-match only, bug 4 fix)", () => {
  const it = item({
    groups: [
      group({ slot_key: "addons", kind: "modifier", ask_mode: "on_request", choices: [choice()] }),
      group({ slot_key: "size", choices: [choice(), choice()] }),
    ],
  });
  const plan = buildAskPlan(it, "2026-09-07T00:00:00Z");
  assertEquals(plan.steps.map(s => s.slot_key), ["size", "addons"]);
  assertEquals(plan.steps[1].ask_mode, "on_request");
});

// ---- ask_mode derivation -----------------------------------------------------

Deno.test("ask_mode: single choice -> auto_single", () => {
  const it = item({ groups: [group({ slot_key: "egg_style", choices: [choice({ name: "Omelet" })] })] });
  assertEquals(buildAskPlan(it, "t").steps[0].ask_mode, "auto_single");
});

Deno.test("ask_mode: multiple choices + default_choice_id -> apply_default", () => {
  const c1 = choice({ name: "Caesar" });
  const c2 = choice({ name: "Ranch" });
  const it = item({ groups: [group({ slot_key: "dressing", default_choice_id: c1.id, choices: [c1, c2] })] });
  assertEquals(buildAskPlan(it, "t").steps[0].ask_mode, "apply_default");
});

Deno.test("ask_mode: multiple choices, no default -> ask", () => {
  const it = item({ groups: [group({ slot_key: "temp", choices: [choice({ name: "Rare" }), choice({ name: "Medium" })] })] });
  assertEquals(buildAskPlan(it, "t").steps[0].ask_mode, "ask");
});

Deno.test("ask_mode: modifier with pre-set offer_once passes through", () => {
  const it = item({ groups: [group({ slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", choices: [choice()] })] });
  assertEquals(buildAskPlan(it, "t").steps[0].ask_mode, "offer_once");
});

Deno.test("ask_mode: modifier with no pre-set ask_mode defaults to on_request (still a step, reactive-match only)", () => {
  const it = item({ groups: [group({ slot_key: "addons", kind: "modifier", ask_mode: null, choices: [choice()] })] });
  const plan = buildAskPlan(it, "t");
  assertEquals(plan.steps.length, 1);
  assertEquals(plan.steps[0].ask_mode, "on_request");
});

// ---- bot_state ---------------------------------------------------------------

Deno.test("bot_state: orderable when every slot has a priced, confirmed choice", () => {
  const it = item({ groups: [group({ slot_key: "temp", kitchen_critical: true, choices: [choice({ name: "Rare" }), choice({ name: "Medium" })] })] });
  assertEquals(compileItem(it, [], "t").bot_state, "orderable");
});

Deno.test("bot_state: display_only when price is missing", () => {
  const it = item({ price_cents: 0 });
  assertEquals(compileItem(it, [], "t").bot_state, "display_only");
});

Deno.test("bot_state: display_only when price_provenance is inferred", () => {
  const it = item({ price_provenance: "inferred" });
  assertEquals(compileItem(it, [], "t").bot_state, "display_only");
});

Deno.test("bot_state: blocked when a kitchen-critical slot has zero choices", () => {
  const it = item({ groups: [group({ slot_key: "temp", kitchen_critical: true, choices: [] })] });
  const c = compileItem(it, [], "t");
  assertEquals(c.bot_state, "blocked");
  assert(c.bot_state_reason?.includes("temp"));
});

Deno.test("bot_state: blocked when a kitchen-critical slot is inferred/unconfirmed", () => {
  const it = item({ groups: [group({ slot_key: "bread", kitchen_critical: true, provenance: "inferred", choices: [choice(), choice()] })] });
  assertEquals(compileItem(it, [], "t").bot_state, "blocked");
});

Deno.test("bot_state: blocked when a pending blocking owner_question is scoped to the item", () => {
  const it = item();
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "bread", blocking: true, status: "pending", question_text: "Bread?", exclusions: [] };
  assertEquals(compileItem(it, [q], "t").bot_state, "blocked");
});

Deno.test("bot_state: blocked when a pending blocking owner_question is scoped to the item's category", () => {
  const it = item({ category: "Sandwiches" });
  const q: PendingQuestion = { scope_type: "category", scope_id: "Sandwiches", slot_key: "bread", blocking: true, status: "pending", question_text: "Bread?", exclusions: [] };
  assertEquals(compileItem(it, [q], "t").bot_state, "blocked");
});

Deno.test("bot_state: orderable when a category-scoped blocking question EXCLUDES this item by name (2026-09-07 regression: item 9's stated-provenance gate reduced Zio's Burgers/Wraps to 1 genuinely-unresolved item each, but 17 items stayed blocked menu-wide because the exclusions list computed by archetypes.ts's inferCategory was never consulted here)", () => {
  const it = item({ name: "Cheese Burger", category: "Burgers" });
  const q: PendingQuestion = { scope_type: "category", scope_id: "Burgers", slot_key: "temp", blocking: true, status: "pending", question_text: "Temp?", exclusions: ["Cheese Burger", "Mamma Mia Burger"] };
  assertEquals(compileItem(it, [q], "t").bot_state, "orderable");
});

Deno.test("bot_state: still blocked for a category-scoped question when this item is NOT in the exclusions list", () => {
  const it = item({ name: "Double Burger", category: "Burgers" });
  const q: PendingQuestion = { scope_type: "category", scope_id: "Burgers", slot_key: "temp", blocking: true, status: "pending", question_text: "Temp?", exclusions: ["Cheese Burger", "Mamma Mia Burger"] };
  assertEquals(compileItem(it, [q], "t").bot_state, "blocked");
});

Deno.test("bot_state: display_only when the blocking owner_question was dismissed", () => {
  const it = item();
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "bread", blocking: true, status: "dismissed", question_text: "Bread?", exclusions: [] };
  assertEquals(compileItem(it, [q], "t").bot_state, "display_only");
});

Deno.test("bot_state: non-blocking pending question does not affect the item", () => {
  const it = item();
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "confirm_alias", blocking: false, status: "pending", question_text: "Alias?", exclusions: [] };
  assertEquals(compileItem(it, [q], "t").bot_state, "orderable");
});

Deno.test("bot_state: stale when missing_from_source_since is over 14 days old", () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const it = item({ missing_from_source_since: old });
  assertEquals(compileItem(it, [], "t").bot_state, "stale");
});

// ---- Lexicon (rules 1, 2, 3, 6 only) -------------------------------------------

Deno.test("lexicon rule 1: display_name itself -> item term", () => {
  const it = item({ display_name: "Gyro" });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "gyro" && t.target_type === "item" && t.target_id === it.id));
});

Deno.test("lexicon rule 2: category-qualified display_name also indexes the unqualified form", () => {
  const it = item({ display_name: "Chicken Caesar Salad", category: "Salads" });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "chicken caesar salad"));
  assert(terms.some(t => t.term === "chicken caesar"));
});

Deno.test("lexicon rule 2 guard: a stripped alias is dropped when it collides with a different item's own real name (real Zio's/NJB gap)", () => {
  // Real gap found via item 9's invariant 4 report: "Zio's Salad" stripping
  // "Salad" collides with a genuine, distinct entree literally named "Zio's";
  // "Shrimp Parmigiana Sub" stripping "Sub" collides with the Seafood entree
  // "Shrimp Parmigiana". Passing compileItem the owner map directly here
  // (compileMenu's own wiring is covered by the end-to-end test below).
  const entree = item({ display_name: "Zio's", category: "Chicken or Veal" });
  const salad = item({ display_name: "Zio's Salad", category: "Salads" });
  const owners = new Map([["zios", entree.id]]);
  const entreeTerms = compileItem(entree, [], "t", owners).lexicon_terms;
  const saladTerms = compileItem(salad, [], "t", owners).lexicon_terms;
  assert(entreeTerms.some(t => t.term === "zios" && t.target_id === entree.id));
  assert(!saladTerms.some(t => t.term === "zios"), "alias 'zios' must not be generated for a different item");
  assert(saladTerms.some(t => t.term === "zios salad"), "the item's own rule-1 term must still be generated");
});

Deno.test("lexicon rule 2 guard: an alias is still generated when nothing else owns the stripped term", () => {
  const it = item({ display_name: "Chicken Caesar Salad", category: "Salads" });
  const owners = new Map<string, string>(); // no collision registered
  const terms = compileItem(it, [], "t", owners).lexicon_terms;
  assert(terms.some(t => t.term === "chicken caesar"));
});

Deno.test("compileMenu end-to-end: the Zio's/Shrimp Parmigiana/Eggplant Parmigiana collisions resolve and both items keep a unique term", () => {
  const entree = item({ display_name: "Zio's", category: "Chicken or Veal" });
  const salad = item({ display_name: "Zio's Salad", category: "Salads" });
  const panini = item({ display_name: "Zio's Panini", category: "Paninis" });
  const seafood = item({ display_name: "Shrimp Parmigiana", category: "Seafood" });
  const sub = item({ display_name: "Shrimp Parmigiana Sub", category: "Hot Subs" });
  const { items: compiled } = compileMenu([entree, salad, panini, seafood, sub], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const entreeHasUniqueZios = byId.get(entree.id)!.lexicon_terms.some(t => t.term === "zios");
  const saladHasZios = byId.get(salad.id)!.lexicon_terms.some(t => t.term === "zios");
  const paniniHasZios = byId.get(panini.id)!.lexicon_terms.some(t => t.term === "zios");
  assert(entreeHasUniqueZios);
  assert(!saladHasZios);
  assert(!paniniHasZios);

  const seafoodHasUniqueTerm = byId.get(seafood.id)!.lexicon_terms.some(t => t.term === "shrimp parmigiana");
  const subHasShrimpParmigiana = byId.get(sub.id)!.lexicon_terms.some(t => t.term === "shrimp parmigiana");
  assert(seafoodHasUniqueTerm);
  assert(!subHasShrimpParmigiana);

  // Invariant 4 must now pass for both real-menu-shaped entrees (all 5 items
  // orderable here since none has any option groups to block on).
  const inv4 = compileMenu([entree, salad, panini, seafood, sub], [], "t", false).invariants.find(i => i.invariant === 4)!;
  assert(inv4.pass, `invariant 4 should pass, violations: ${inv4.violations.join(", ")}`);
});

Deno.test("lexicon rule 2 guard B: a stripped alias claimed by TWO different items (not a Rule-1 name) is dropped for both (real Zio's 'pepperoni' gap, 2026-09-08 P0)", () => {
  // Real Zio's shape: "Pepperoni Stromboli" and "Pepperoni Calzone" each
  // strip their own category noun to "pepperoni" independently — neither
  // collides with another item's Rule-1 primary name (Guard A), so without
  // Guard B both would write an active lexicon row for the identical term
  // "pepperoni" pointing at two different target_ids, a coin-flip for any
  // future reader of the table.
  const stromboli = item({ display_name: "Pepperoni Stromboli", category: "Strombolis" });
  const calzone = item({ display_name: "Pepperoni Calzone", category: "Calzones" });
  const { items: compiled } = compileMenu([stromboli, calzone], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(!byId.get(stromboli.id)!.lexicon_terms.some(t => t.term === "pepperoni"),
    "ambiguous alias must not be written for the Stromboli");
  assert(!byId.get(calzone.id)!.lexicon_terms.some(t => t.term === "pepperoni"),
    "ambiguous alias must not be written for the Calzone");
  // Each item's own full name (Rule 1) must still be generated — only the
  // ambiguous shared alias is dropped, not the item's real identity.
  assert(byId.get(stromboli.id)!.lexicon_terms.some(t => t.term === "pepperoni stromboli"));
  assert(byId.get(calzone.id)!.lexicon_terms.some(t => t.term === "pepperoni calzone"));
});

Deno.test("lexicon rule 2 guard B: a stripped alias claimed by only ONE item is still generated", () => {
  const stromboli = item({ display_name: "Pepperoni Stromboli", category: "Strombolis" });
  const sausage = item({ display_name: "Sausage Stromboli", category: "Strombolis" });
  const { items: compiled } = compileMenu([stromboli, sausage], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));
  assert(byId.get(stromboli.id)!.lexicon_terms.some(t => t.term === "pepperoni"));
  assert(byId.get(sausage.id)!.lexicon_terms.some(t => t.term === "sausage"));
});

Deno.test("lexicon rule 3: category noun singular + plural -> category target", () => {
  const terms = categoryLexiconTerms("Salads");
  assertEquals(terms.map(t => t.term).sort(), ["salad", "salads"]);
  assert(terms.every(t => t.target_type === "category" && t.target_id === "Salads"));
});

Deno.test("lexicon rule 6: slot choice names -> choice targets", () => {
  const beef = choice({ name: "Beef" });
  const chicken = choice({ name: "Chicken" });
  const it = item({ groups: [group({ slot_key: "protein", choices: [beef, chicken] })] });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "beef" && t.target_type === "choice" && t.target_id === beef.id));
  assert(terms.some(t => t.term === "chicken" && t.target_type === "choice" && t.target_id === chicken.id));
});

Deno.test("lexicon: modifier choices are NOT lexiconized (rule 5/step 4 explicitly out of scope)", () => {
  const it = item({ groups: [group({ kind: "modifier", ask_mode: "on_request", choices: [choice({ name: "Pepperoni" })] })] });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(!terms.some(t => t.term === "pepperoni"));
});

// ---- Overrides: empty = identity, present = last-write-wins -------------------

Deno.test("overrides: empty set is the identity case", () => {
  const it = item({ price_cents: 1234 });
  const next = applyOverrides(it, "item-key", new Map(), new Map(), []);
  assertEquals(next, it);
});

Deno.test("overrides: last write wins on item.price_cents", () => {
  const it = item({ price_cents: 1000 });
  const overrides: OverrideRow[] = [
    { entity_type: "item", entity_key: "item-key", field: "price_cents", value: 1200, created_at: "2026-09-01T00:00:00Z" },
    { entity_type: "item", entity_key: "item-key", field: "price_cents", value: 1500, created_at: "2026-09-02T00:00:00Z" },
  ];
  const next = applyOverrides(it, "item-key", new Map(), new Map(), overrides);
  assertEquals(next.price_cents, 1500);
});

Deno.test("overrides: field '*' on an item suppresses it (marks inactive)", () => {
  const it = item({ active: true });
  const overrides: OverrideRow[] = [{ entity_type: "item", entity_key: "item-key", field: "*", value: null, created_at: "2026-09-01T00:00:00Z" }];
  const next = applyOverrides(it, "item-key", new Map(), new Map(), overrides);
  assertEquals(next.active, false);
});

Deno.test("overrides: field '*' on a group removes it from the item", () => {
  const g = group({ id: "g1", slot_key: "bread" });
  const it = item({ groups: [g] });
  const groupKeys = new Map([[g.id, "group-key"]]);
  const overrides: OverrideRow[] = [{ entity_type: "group", entity_key: "group-key", field: "*", value: null, created_at: "2026-09-01T00:00:00Z" }];
  const next = applyOverrides(it, "item-key", groupKeys, new Map(), overrides);
  assertEquals(next.groups.length, 0);
});

// ---- Menu-level invariants (§8.2) ----------------------------------------------
//
// Item 5 (§11 item 5, the readiness gate): the two prior tests here (inv 3,
// inv 8) plus inv 4's pass case (see "compileMenu end-to-end" above) and
// inv 7's fail case were the only invariants with dedicated pass/fail
// coverage. The block below fills in explicit pass AND fail cases for every
// one of the 8. Invariants 2, 4, and 5 only ever fire on an item whose
// bot_state is `orderable` — but computeBotState's own checks (tested above)
// mean compileItem can never actually PRODUCE a nonconforming orderable
// item through the normal path. To test those three as the defense-in-depth
// checks they are (§8.2's own wording: the check is unconditional on the
// data, not on trusting bot_state), we call computeMenuInvariants directly
// against a hand-built CompiledItem map that force-marks bad data
// `orderable` — the same technique the existing invariant-7 test already
// uses in miniature (a hand-built inferred choice on an item whose real
// bot_state would be `blocked`).

function fakeAskPlan(displayName: string, basePriceCents = 1000): AskPlan {
  return { compiled_at: "t", compiler_version: 1, display_name: displayName, base_price_cents: basePriceCents, steps: [], recap_template: "", ticket_template: "" };
}

function forceOrderable(it: CompileItem, lexiconTerms: CompiledItem["lexicon_terms"] = []): CompiledItem {
  return { item_id: it.id, bot_state: "orderable", bot_state_reason: null, ask_plan: fakeAskPlan(it.display_name ?? it.name, it.price_cents ?? 1000), lexicon_terms: lexiconTerms };
}

Deno.test("invariant 1: a blocked item in an active category fails; passes when none are blocked", () => {
  const blockedItem = item({ display_name: null }); // missing display_name -> blocked
  const orderableItem = item({ display_name: "Cheese Pizza" });
  const failing = compileMenu([blockedItem, orderableItem], [], "t", false);
  assertEquals(failing.invariants.find(i => i.invariant === 1)!.pass, false);

  const passing = compileMenu([orderableItem], [], "t", false);
  assertEquals(passing.invariants.find(i => i.invariant === 1)!.pass, true);
});

Deno.test("invariant 2 (defense in depth): an item force-marked orderable with price_cents=0 fails; a real orderable item passes", () => {
  const badItem = item({ price_cents: 0 }); // real bot_state would be display_only ("source lacks a price")
  const compiledMap = new Map<string, CompiledItem>([[badItem.id, forceOrderable(badItem)]]);
  const failing = computeMenuInvariants([badItem], compiledMap, false);
  assertEquals(failing.find(i => i.invariant === 2)!.pass, false);

  const goodItem = item();
  const passing = compileMenu([goodItem], [], "t", false);
  assertEquals(passing.invariants.find(i => i.invariant === 2)!.pass, true);
});

Deno.test("invariant 3 pass: two orderable items with distinct display_names", () => {
  const items = [item({ display_name: "Cheese Pizza" }), item({ display_name: "Pepperoni Pizza" })];
  const { invariants } = compileMenu(items, [], "t", false);
  assertEquals(invariants.find(i => i.invariant === 3)!.pass, true);
});

Deno.test("invariant 3: two orderable items sharing a display_name fails", () => {
  const items = [item({ display_name: "Cheese Pizza" }), item({ display_name: "Cheese Pizza" })];
  const { invariants } = compileMenu(items, [], "t", false);
  const inv3 = invariants.find(i => i.invariant === 3)!;
  assertEquals(inv3.pass, false);
});

Deno.test("invariant 4 (defense in depth): two orderable items whose only lexicon term collides (non-unique) fails", () => {
  const itemA = item({ display_name: "Pizza A" });
  const itemB = item({ display_name: "Pizza B" });
  const collidingTerm = (targetId: string) => [{ term: "pizza", target_type: "item" as const, target_id: targetId, provenance: "stated" as const }];
  const compiledMap = new Map<string, CompiledItem>([
    [itemA.id, forceOrderable(itemA, collidingTerm(itemA.id))],
    [itemB.id, forceOrderable(itemB, collidingTerm(itemB.id))],
  ]);
  const invariants = computeMenuInvariants([itemA, itemB], compiledMap, false);
  assertEquals(invariants.find(i => i.invariant === 4)!.pass, false);
});
// invariant 4's pass case is covered above by "compileMenu end-to-end: the
// Zio's/Shrimp Parmigiana/Eggplant Parmigiana collisions resolve and both
// items keep a unique term".

Deno.test("invariant 5 (defense in depth): an orderable item's slot group with zero active choices fails; a well-formed group passes", () => {
  const badGroup = group({ kind: "slot", choices: [] });
  const badItem = item({ groups: [badGroup] });
  const compiledMap = new Map<string, CompiledItem>([[badItem.id, forceOrderable(badItem)]]);
  const failing = computeMenuInvariants([badItem], compiledMap, false);
  assertEquals(failing.find(i => i.invariant === 5)!.pass, false);

  const goodItem = item({ groups: [group({ kind: "slot", choices: [choice()] })] });
  const passing = compileMenu([goodItem], [], "t", false);
  assertEquals(passing.invariants.find(i => i.invariant === 5)!.pass, true);
});

Deno.test("invariant 6: default_choice_id pointing at a nonexistent choice fails; a real reference passes", () => {
  const badGroup = group({ default_choice_id: "does-not-exist", choices: [choice()] });
  const badItem = item({ groups: [badGroup] });
  const failing = compileMenu([badItem], [], "t", false);
  assertEquals(failing.invariants.find(i => i.invariant === 6)!.pass, false);

  const realChoice = choice();
  const goodGroup = group({ default_choice_id: realChoice.id, choices: [realChoice, choice()] });
  const goodItem = item({ groups: [goodGroup] });
  const passing = compileMenu([goodItem], [], "t", false);
  assertEquals(passing.invariants.find(i => i.invariant === 6)!.pass, true);
});

Deno.test("invariant 7 pass: no active choice has inferred provenance", () => {
  const it = item({ groups: [group({ slot_key: "temp", choices: [choice(), choice()] })] });
  const { invariants } = compileMenu([it], [], "t", false);
  assertEquals(invariants.find(i => i.invariant === 7)!.pass, true);
});

Deno.test("invariant 7: an active inferred choice on an orderable item's group fails", () => {
  const it = item({ groups: [group({ slot_key: "temp", choices: [choice({ provenance: "inferred" }), choice()] })] });
  // Note: this item would itself be `blocked` (unconfirmed choice), so it
  // won't be `orderable` — invariant 7 still flags the raw inferred choice
  // regardless of the item's own state, since "no active inferred choice
  // anywhere" is unconditional per §8.2.
  const { invariants } = compileMenu([it], [], "t", false);
  assertEquals(invariants.find(i => i.invariant === 7)!.pass, false);
});

Deno.test("invariant 8: ratio below 90% fails without acknowledgement, passes with it", () => {
  const items = [
    item({ price_cents: 0 }), // display_only
    item({ price_cents: 0 }), // display_only
    item(), // orderable
  ];
  const withoutAck = compileMenu(items, [], "t", false);
  assertEquals(withoutAck.invariants.find(i => i.invariant === 8)!.pass, false);
  const withAck = compileMenu(items, [], "t", true);
  assertEquals(withAck.invariants.find(i => i.invariant === 8)!.pass, true);
});

// ---- Infer wiring (§3 stage 5, §11 item 3's own note: "item 4's compiler
// is the natural caller") ----------------------------------------------------

Deno.test("buildOwnerQuestionSummaries: no category -> no questions, not an error", () => {
  const items = [inferSourceItem({ category: null, name: "Burger" })];
  const summaries = buildOwnerQuestionSummaries(items);
  assertEquals(summaries.length, 0);
});

Deno.test("buildOwnerQuestionSummaries: burger category with no bound bread list produces a blocking question", () => {
  const items = [
    inferSourceItem({ category: "Burgers", name: "Cheeseburger" }),
    inferSourceItem({ category: "Burgers", name: "Bacon Burger" }),
  ];
  const summaries = buildOwnerQuestionSummaries(items);
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0].archetype, "burger");
  const tempQ = summaries[0].questions.find(q => q.slot_key === "temp");
  assert(tempQ, "expected a temp question for a burger category with no stated temp");
  assertEquals(tempQ!.blocking, true);
  assertEquals(tempQ!.scope_type, "category");
  assertEquals(tempQ!.scope_id, "Burgers");
  assertEquals(tempQ!.items_affected, 2);
});

Deno.test("buildOwnerQuestionSummaries: a real extracted list bound to the slot needs no question", () => {
  const items = [
    inferSourceItem({
      category: "Salads",
      name: "Greek Salad",
      extractedGroups: [{ name: "Dressing", required: true, choiceNames: ["Greek", "Ranch", "Balsamic"] }],
    }),
  ];
  const summaries = buildOwnerQuestionSummaries(items);
  const dressingQ = summaries[0].questions.find(q => q.slot_key === "dressing");
  assertEquals(dressingQ, undefined);
});

Deno.test("buildOwnerQuestionSummaries: sibling size rows resolve size without a question", () => {
  const items = [
    inferSourceItem({ category: "Pizza", name: "Cheese Pizza - Small", productKey: "pizza:cheese" }),
    inferSourceItem({ category: "Pizza", name: "Cheese Pizza - Large", productKey: "pizza:cheese" }),
  ];
  const summaries = buildOwnerQuestionSummaries(items);
  const sizeQ = summaries[0].questions.find(q => q.slot_key === "size");
  assertEquals(sizeQ, undefined);
});

Deno.test("infer end-to-end: a fresh menu with zero pre-existing owner_questions still blocks the right items once its questions are fed back into compileMenu", () => {
  const burgerItems = [
    inferSourceItem({ category: "Burgers", name: "Cheeseburger" }),
    inferSourceItem({ category: "Burgers", name: "Veggie Burger" }), // applies_when excludes veggie from temp
  ];
  const summaries = buildOwnerQuestionSummaries(burgerItems);
  const tempQ = summaries[0].questions.find(q => q.slot_key === "temp")!;
  assert(tempQ, "expected a blocking temp question");
  // Exactly one item (Cheeseburger) needs the question; Veggie Burger is
  // excluded by applies_when and shows up as an exclusion, not a blocker.
  assertEquals(tempQ.items_affected, 1);
  assertEquals(tempQ.proposal.exclusions, ["Veggie Burger"]);

  const pendingQuestions: PendingQuestion[] = [
    { scope_type: tempQ.scope_type, scope_id: tempQ.scope_id, slot_key: tempQ.slot_key, blocking: tempQ.blocking, status: "pending", question_text: tempQ.question_text, exclusions: tempQ.proposal.exclusions },
  ];
  const cheeseburger = item({ name: "Cheeseburger", display_name: "Cheeseburger", category: "Burgers" });
  const veggieBurger = item({ name: "Veggie Burger", display_name: "Veggie Burger", category: "Burgers" });
  const { items: compiled } = compileMenu([cheeseburger, veggieBurger], pendingQuestions, "t", false);
  const cheeseburgerState = compiled.find(c => c.item_id === cheeseburger.id)!;
  const veggieState = compiled.find(c => c.item_id === veggieBurger.id)!;
  // FIXED 2026-09-07 (was: both blocked menu-wide — see git history for the
  // "honest limitation" this used to document). Live incident on Zio's
  // exposed the real cost: the stated-provenance gate correctly reduced
  // Burgers/temp and Wraps/bread to 1 genuinely-unresolved item each, but 17
  // items stayed bot_state='blocked' because findBlockingQuestion's
  // category-scope match ignored the exclusions list the compiler itself
  // had already computed. Cheeseburger (needs_question) is still blocked;
  // Veggie Burger (excluded by applies_when, listed in the question's own
  // exclusions) is now correctly orderable.
  assertEquals(cheeseburgerState.bot_state, "blocked");
  assertEquals(veggieState.bot_state, "orderable");
});

// ---- planOwnerQuestionsRefresh (2026-09-08, real NJB incident) -------------
// A parser/archetype improvement changes what buildOwnerQuestionSummaries
// produces for a menu that's already been inferred once. The existing
// insert-if-not-exists step can only ADD a new (scope_type, scope_id,
// slot_key) key — it can't notice that an existing key's items_affected
// shrank, or that a key stopped being produced entirely. Real incident: a
// normalize.ts fix left 4 NJB owner_questions rows stale (one that should
// have been deleted, three with inflated items_affected) until caught and
// fixed by hand. This function is the reusable fix for that gap — the exact
// 3 cases below are the full contract, and case 3 (never touch a non-
// pending row) is the one that must never break.

function existingRow(overrides: Partial<ExistingOwnerQuestionRow> = {}): ExistingOwnerQuestionRow {
  return {
    id: crypto.randomUUID(),
    scope_type: "category",
    scope_id: "Breakfast Sandwiches",
    slot_key: "bread",
    status: "pending",
    question_text: "Do customers pick a bread on Breakfast Sandwiches?",
    items_affected: 20,
    priority: 80,
    blocking: true,
    proposal: { choices: [], source: "archetype:sandwich", exclusions: [] },
    ...overrides,
  };
}

function freshDraft(overrides: Partial<OwnerQuestionDraft> = {}): OwnerQuestionDraft {
  return {
    scope_type: "category",
    scope_id: "Breakfast Sandwiches",
    slot_key: "bread",
    kind: "exists",
    question_text: "Do customers pick a bread on Breakfast Sandwiches?",
    proposal: { choices: [], source: "archetype:sandwich", exclusions: [] },
    blocking: true,
    priority: 80,
    items_affected: 20,
    ...overrides,
  };
}

Deno.test("refresh case 1: a pending row whose key still exists gets its content updated to match the fresh draft", () => {
  const stale = existingRow({ items_affected: 20, priority: 80 });
  const fresh = freshDraft({ items_affected: 2, priority: 8 });
  const plan = planOwnerQuestionsRefresh([stale], [fresh]);
  assertEquals(plan.toDelete, []);
  assertEquals(plan.toUpdate, [{
    id: stale.id,
    question_text: fresh.question_text,
    items_affected: 2,
    priority: 8,
    blocking: fresh.blocking,
    proposal: fresh.proposal,
  }]);
});

Deno.test("refresh case 1 (no-op): a pending row's `proposal` with the SAME content but different JS key insertion order is not a change (real bug: Postgres JSONB doesn't preserve insertion order on round-trip — a naive JSON.stringify diff flagged every real NJB row as changed even when nothing differed)", () => {
  const row = existingRow({
    // as a DB round-trip actually returned it, real NJB data
    proposal: { source: "archetype:salad", choices: [], exclusions: ["Caesar Salad", "Greek Salad"] },
  });
  const fresh = freshDraft({
    // as buildOwnerQuestionSummaries actually constructs it (different key order)
    proposal: { choices: [], source: "archetype:salad", exclusions: ["Caesar Salad", "Greek Salad"] },
  });
  const plan = planOwnerQuestionsRefresh([row], [fresh]);
  assertEquals(plan.toUpdate, []);
  assertEquals(plan.toDelete, []);
});

Deno.test("refresh case 1: an `exclusions` array with the SAME items in a DIFFERENT order IS a real change (order is meaningful for a list, unlike object key order)", () => {
  const row = existingRow({ proposal: { choices: [], source: "archetype:salad", exclusions: ["Caesar Salad", "Greek Salad"] } });
  const fresh = freshDraft({ proposal: { choices: [], source: "archetype:salad", exclusions: ["Greek Salad", "Caesar Salad"] } });
  const plan = planOwnerQuestionsRefresh([row], [fresh]);
  assertEquals(plan.toUpdate.length, 1);
});

Deno.test("refresh case 1 (no-op): a pending row whose key still exists with IDENTICAL content produces an empty plan", () => {
  const row = existingRow();
  const fresh = freshDraft();
  const plan = planOwnerQuestionsRefresh([row], [fresh]);
  assertEquals(plan.toUpdate, []);
  assertEquals(plan.toDelete, []);
});

Deno.test("refresh case 2: a pending row whose key no longer appears in the fresh computation at all gets deleted (real NJB 'Omelette & Egg Platters'/toast — fully resolved by the parser fix, not just shrunk)", () => {
  const stale = existingRow({ scope_id: "Omelette & Egg Platters", slot_key: "toast", items_affected: 3 });
  // fresh computation only produced OTHER keys this round -- toast's key is
  // simply absent, not present-with-zero.
  const fresh = freshDraft({ scope_id: "Omelette & Egg Platters", slot_key: "egg_side", items_affected: 11 });
  const plan = planOwnerQuestionsRefresh([stale], [fresh]);
  assertEquals(plan.toDelete, [{ id: stale.id }]);
  assertEquals(plan.toUpdate, []);
});

Deno.test("refresh case 3 (the invariant): a row with any non-'pending' status is NEVER touched, even when its key would otherwise update or delete", () => {
  for (const status of ["answered", "dismissed", "asked", "expired"] as const) {
    const answered = existingRow({ status, items_affected: 20 });
    // Would be an update if this row were pending (items_affected differs).
    const updateCandidate = planOwnerQuestionsRefresh([answered], [freshDraft({ items_affected: 2 })]);
    assertEquals(updateCandidate.toUpdate, [], `status=${status} must not be updated`);
    assertEquals(updateCandidate.toDelete, [], `status=${status} must not be deleted (update case)`);

    // Would be a delete if this row were pending (key absent from fresh set).
    const deleteCandidate = planOwnerQuestionsRefresh([answered], [freshDraft({ scope_id: "Other Category" })]);
    assertEquals(deleteCandidate.toUpdate, [], `status=${status} must not be updated (delete case)`);
    assertEquals(deleteCandidate.toDelete, [], `status=${status} must not be deleted`);
  }
});

Deno.test("refresh: a brand-new fresh draft with no matching existing row is not this function's concern (no update, no delete, no crash) -- that's the separate insert-if-not-exists step's job", () => {
  const row = existingRow({ scope_id: "Salads", slot_key: "dressing", items_affected: 2 });
  const fresh = [
    freshDraft({ scope_id: "Salads", slot_key: "dressing", items_affected: 2 }), // unchanged, matches `row`
    freshDraft({ scope_id: "Wraps", slot_key: "bread", items_affected: 10 }), // brand new key, no existing row
  ];
  const plan = planOwnerQuestionsRefresh([row], fresh);
  assertEquals(plan.toUpdate, []);
  assertEquals(plan.toDelete, []);
});

Deno.test("refresh: mixed batch — one update, one delete, one untouched non-pending, one untouched matching-pending, all in a single call (real NJB shape)", () => {
  const breadStale = existingRow({ scope_id: "Cold Sandwiches", slot_key: "bread", items_affected: 15, priority: 60 });
  const toastStale = existingRow({ scope_id: "Omelette & Egg Platters", slot_key: "toast", items_affected: 3, priority: 12 });
  const dressingAnswered = existingRow({ scope_id: "Salads", slot_key: "dressing", status: "answered", items_affected: 2 });
  const eggSidePending = existingRow({ scope_id: "Omelette & Egg Platters", slot_key: "egg_side", items_affected: 11, priority: 44 });

  const fresh = [
    freshDraft({ scope_id: "Cold Sandwiches", slot_key: "bread", items_affected: 2, priority: 8 }),
    // no "toast" draft at all -- fully resolved this round
    freshDraft({ scope_id: "Salads", slot_key: "dressing", items_affected: 99 }), // would differ, but row is answered
    freshDraft({ scope_id: "Omelette & Egg Platters", slot_key: "egg_side", items_affected: 11, priority: 44 }), // unchanged
  ];

  const plan = planOwnerQuestionsRefresh(
    [breadStale, toastStale, dressingAnswered, eggSidePending],
    fresh,
  );
  assertEquals(plan.toUpdate.map(u => u.id), [breadStale.id]);
  assertEquals(plan.toUpdate[0].items_affected, 2);
  assertEquals(plan.toDelete, [{ id: toastStale.id }]);
});

// ============================================================
// buildDerivedRows — D1 compile-time derived rows (§11 item 4 stream D1)
//
// Mirrors real Zio's Pizzeria shape:
//   - Neapolitan Cheese Pizza in 3 sizes (the dominant family)
//   - Sicilian Cheese Pizza single-size (inferior family by variant count)
//   - Toppings: 9 composable + 1 not_composable (Extra Cheese)
//   - Price: base $15.25 (small), $16.75 (med), $17.99 (large) + $3.00 delta/topping
// ============================================================

const T_COMPILED_AT = "2026-09-09T00:00:00.000Z";

const TOPPING_CHOICE_NAMES = [
  "Pepperoni", "Sausage", "Mushrooms", "Onions", "Bacon",
  "Peppers", "Hot Peppers", "Roasted Red Peppers", "Fresh Garlic",
];
const NOT_COMPOSABLE_NAME = "Extra Cheese";

function toppingChoice(name: string, idx: number): CompileGroup["choices"][0] {
  return {
    id: `topping-choice-${idx}`,
    name,
    display_name: name,
    price_cents: 300,
    is_default: false,
    provenance: "stated",
    not_composable: name === NOT_COMPOSABLE_NAME,
  };
}

function toppingsGroup(choices: string[]): CompileGroup {
  return {
    id: "toppings-group-id",
    name: "Add Toppings",
    kind: "modifier",
    slot_key: "toppings",
    min_select: 0,
    max_select: 10,
    kitchen_critical: false,
    price_critical: false,
    default_choice_id: null,
    ask_mode: "offer_once",
    provenance: "stated",
    display_order: 10,
    choices: choices.map((n, i) => toppingChoice(n, i)),
  };
}

function pizzaItem(
  overrides: Partial<CompileItem> & { name: string; price_cents: number; size_label: string | null },
): CompileItem {
  return {
    id: `item-${overrides.name.replace(/\W+/g, "-").toLowerCase()}`,
    display_name: overrides.name, // simplified for tests
    category: "Pizza",
    active: true,
    price_provenance: "stated",
    product_key: null,
    missing_from_source_since: null,
    import_key: `import-${overrides.name.replace(/\W+/g, "-").toLowerCase()}`,
    groups: [toppingsGroup([...TOPPING_CHOICE_NAMES, NOT_COMPOSABLE_NAME])],
    ...overrides,
  };
}

function orderable(itemId: string): [string, CompiledItem] {
  return [itemId, {
    item_id: itemId,
    bot_state: "orderable",
    bot_state_reason: null,
    ask_plan: { compiled_at: T_COMPILED_AT, compiler_version: 1, display_name: "", base_price_cents: 0, steps: [], recap_template: "", ticket_template: "" },
    lexicon_terms: [],
  }];
}

function buildTestMenu() {
  const small  = pizzaItem({ name: "Neapolitan Cheese Pizza - Small 14''",  price_cents: 1525, size_label: "Small 14''" });
  const medium = pizzaItem({ name: "Neapolitan Cheese Pizza - Medium 16''", price_cents: 1675, size_label: "Medium 16''" });
  const large  = pizzaItem({ name: "Neapolitan Cheese Pizza - Large 18''",  price_cents: 1799, size_label: "Large 18''" });
  const sicilian = pizzaItem({ name: "Sicilian Cheese Pizza", price_cents: 1999, size_label: null,
    id: "item-sicilian", import_key: "import-sicilian" });

  const compiled = new Map([
    orderable(small.id),
    orderable(medium.id),
    orderable(large.id),
    orderable(sicilian.id),
  ]);

  return { small, medium, large, sicilian, compiled };
}

Deno.test("buildDerivedRows: row count — 9 composable toppings × 3 Neapolitan sizes = 27 rows (Sicilian single-size family is inferior)", () => {
  const { small, medium, large, sicilian, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large, sicilian], compiled, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 27);
});

Deno.test("buildDerivedRows: not_composable choice (Extra Cheese) is excluded from all derived rows", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const hasExtraCheese = rows.some(r => r.name.toLowerCase().includes("extra cheese"));
  assertEquals(hasExtraCheese, false);
});

Deno.test("buildDerivedRows: row shape — name, display_name, product_key, is_derived, derived_from", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const pepp = rows.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("large"));
  assert(pepp !== undefined, "should have a large pepperoni derived row");
  assertEquals(pepp!.name, "Pepperoni Pizza - Large 18''");
  assertEquals(pepp!.display_name, "Large Pepperoni Pizza");
  assertEquals(pepp!.product_key, "pizza:pepperoni");
  assertEquals(pepp!.is_derived, true);
  assertEquals(pepp!.derived_from.base_item_id, large.id);
  assertEquals(pepp!.derived_from.choice_ids.length, 1);
  assertEquals(pepp!.provenance, "derived");
});

Deno.test("buildDerivedRows: price arithmetic — base + topping delta (exact)", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  // Small base = 1525, topping delta = 300 → 1825
  const smallPepp = rows.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("small"));
  assertEquals(smallPepp?.price_cents, 1525 + 300);
  // Large base = 1799, topping delta = 300 → 2099
  const largePepp = rows.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("large"));
  assertEquals(largePepp?.price_cents, 1799 + 300);
});

Deno.test("buildDerivedRows: cap — 40 choices max per size (all 9 composable fit well under cap)", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  // Build an item with 50 toppings — only 40 should appear
  const manyToppings = Array.from({ length: 50 }, (_, i) => `Topping${i}`);
  const bigItem = pizzaItem({
    name: "Neapolitan Cheese Pizza - Large 18''",
    price_cents: 1799,
    size_label: "Large 18''",
    groups: [toppingsGroup(manyToppings)],
  });
  const compiledBig = new Map([orderable(bigItem.id)]);
  const rows = buildDerivedRows([bigItem], compiledBig, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 40);
});

Deno.test("buildDerivedRows: regeneration is idempotent — identical inputs produce byte-identical output except compiled_at", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const r1 = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const r2 = buildDerivedRows([small, medium, large], compiled, new Map(), "2026-09-10T00:00:00.000Z");
  assertEquals(r1.length, r2.length);
  for (let i = 0; i < r1.length; i++) {
    const a = { ...r1[i], ask_plan: { ...r1[i].ask_plan, compiled_at: "x" } };
    const b = { ...r2[i], ask_plan: { ...r2[i].ask_plan, compiled_at: "x" } };
    assertEquals(a, b, `row ${i} (${r1[i].entity_key}) should be identical across recompile`);
  }
});

Deno.test("buildDerivedRows: owner override survives recompile — provenance flips to owner_confirmed, derived_from preserved", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const largePepp = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT)
    .find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("large"))!;

  // Simulate an owner override for display_name on the large pepperoni row
  const overrides = new Map([[largePepp.entity_key, { display_name: "Large Pepperoni Pie" }]]);
  const withOverride = buildDerivedRows([small, medium, large], compiled, overrides, T_COMPILED_AT);
  const overridden = withOverride.find(r => r.entity_key === largePepp.entity_key)!;

  assertEquals(overridden.provenance, "owner_confirmed");
  assertEquals(overridden.display_name, "Large Pepperoni Pie");
  // derived_from is intact — the ticket still resolves to base + topping
  assertEquals(overridden.derived_from.base_item_id, large.id);
  assertEquals(overridden.derived_from.choice_ids.length, 1);

  // Other rows (non-overridden) stay "derived"
  const smallPepp = withOverride.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("small"))!;
  assertEquals(smallPepp.provenance, "derived");
});

Deno.test("buildDerivedRows: ticket_template renders base item name + topping, not the derived label", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const pepp = rows.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("large"))!;
  // ticket_template must reference the base item's own name (kitchen-facing)
  assert(pepp.ask_plan.ticket_template.includes(large.name), "ticket_template must embed base item name");
  assert(pepp.ask_plan.ticket_template.includes("Pepperoni"), "ticket_template must embed topping name");
  // Must NOT just be the derived display_name alone
  assert(!pepp.ask_plan.ticket_template.startsWith("Large Pepperoni Pizza"), "ticket_template must not be the derived label");
});

Deno.test("buildDerivedRows: lexicon — three entries per row ('{choice} pizza', '{choice} pie', bare choice)", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const pepp = rows.find(r => r.entity_key.includes("pepperoni") && r.entity_key.includes("large"))!;
  const terms = pepp.lexicon_terms.map(t => t.term);
  assert(terms.includes("pepperoni pizza"), "should have '{choice} pizza' term");
  assert(terms.includes("pepperoni pie"), "should have '{choice} pie' term");
  assert(terms.includes("pepperoni"), "should have bare choice term");
});

Deno.test("buildDerivedRows: never active if topping choice has inferred provenance", () => {
  const { large } = buildTestMenu();
  const inferredItem = pizzaItem({
    name: "Neapolitan Cheese Pizza - Large 18''",
    price_cents: 1799,
    size_label: "Large 18''",
    id: large.id,
    import_key: large.import_key,
    groups: [{
      ...toppingsGroup(["Pepperoni"]),
      choices: [{
        id: "inferred-choice-id",
        name: "Pepperoni",
        display_name: "Pepperoni",
        price_cents: 300,
        is_default: false,
        provenance: "inferred",
      }],
    }],
  });
  const compiled = new Map([orderable(large.id)]);
  const rows = buildDerivedRows([inferredItem], compiled, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].active, false);
  assertEquals(rows[0].bot_state, "display_only");
});

Deno.test("buildDerivedRows: family tie (two single-size families, same priority and price) returns empty — missing beats wrong", () => {
  // Both families match /cheese/ (same priority) and have the same price — a
  // genuine toss-up that the compiler cannot resolve; must emit zero rows.
  const sicilian = pizzaItem({ name: "Sicilian Cheese Pizza", price_cents: 1999, size_label: null,
    id: "item-sicilian", import_key: "import-sicilian" });
  const grandma = pizzaItem({ name: "Grandma Cheese Pizza", price_cents: 1999, size_label: null,
    id: "item-grandma", import_key: "import-grandma" });
  const compiled = new Map([orderable(sicilian.id), orderable(grandma.id)]);
  const rows = buildDerivedRows([sicilian, grandma], compiled, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 0, "tied families must produce no derived rows");
});

Deno.test("buildDerivedRows: base item not orderable → skipped (no derived rows for that size)", () => {
  const { small, medium, large, compiled } = buildTestMenu();
  // Mark large as blocked
  const compiledWithBlock = new Map([...compiled]);
  compiledWithBlock.set(large.id, { ...compiled.get(large.id)!, bot_state: "blocked" });
  const rows = buildDerivedRows([small, medium, large], compiledWithBlock, new Map(), T_COMPILED_AT);
  // Only small and medium should produce rows (9 × 2 = 18)
  assertEquals(rows.length, 18);
  const hasLarge = rows.some(r => r.entity_key.includes("large"));
  assertEquals(hasLarge, false);
});
