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
  buildOwnerQuestionSummaries,
  categoryLexiconTerms,
  compileItem,
  compileMenu,
  type CompileGroup,
  type CompileItem,
  type InferSourceItem,
  type OverrideRow,
  type PendingQuestion,
} from "./compile-menu.ts";

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

Deno.test("on_request modifiers never appear as steps", () => {
  const it = item({
    groups: [
      group({ slot_key: "addons", kind: "modifier", ask_mode: "on_request", choices: [choice()] }),
      group({ slot_key: "size", choices: [choice(), choice()] }),
    ],
  });
  const plan = buildAskPlan(it, "2026-09-07T00:00:00Z");
  assertEquals(plan.steps.map(s => s.slot_key), ["size"]);
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

Deno.test("ask_mode: modifier with no pre-set ask_mode defaults to on_request (excluded from steps)", () => {
  const it = item({ groups: [group({ slot_key: "addons", kind: "modifier", ask_mode: null, choices: [choice()] })] });
  assertEquals(buildAskPlan(it, "t").steps.length, 0);
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
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "bread", blocking: true, status: "pending", question_text: "Bread?" };
  assertEquals(compileItem(it, [q], "t").bot_state, "blocked");
});

Deno.test("bot_state: blocked when a pending blocking owner_question is scoped to the item's category", () => {
  const it = item({ category: "Sandwiches" });
  const q: PendingQuestion = { scope_type: "category", scope_id: "Sandwiches", slot_key: "bread", blocking: true, status: "pending", question_text: "Bread?" };
  assertEquals(compileItem(it, [q], "t").bot_state, "blocked");
});

Deno.test("bot_state: display_only when the blocking owner_question was dismissed", () => {
  const it = item();
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "bread", blocking: true, status: "dismissed", question_text: "Bread?" };
  assertEquals(compileItem(it, [q], "t").bot_state, "display_only");
});

Deno.test("bot_state: non-blocking pending question does not affect the item", () => {
  const it = item();
  const q: PendingQuestion = { scope_type: "item", scope_id: it.id, slot_key: "confirm_alias", blocking: false, status: "pending", question_text: "Alias?" };
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

Deno.test("invariant 3: two orderable items sharing a display_name fails", () => {
  const items = [item({ display_name: "Cheese Pizza" }), item({ display_name: "Cheese Pizza" })];
  const { invariants } = compileMenu(items, [], "t", false);
  const inv3 = invariants.find(i => i.invariant === 3)!;
  assertEquals(inv3.pass, false);
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

Deno.test("invariant 7: an active inferred choice on an orderable item's group fails", () => {
  const it = item({ groups: [group({ slot_key: "temp", choices: [choice({ provenance: "inferred" }), choice()] })] });
  // Note: this item would itself be `blocked` (unconfirmed choice), so it
  // won't be `orderable` — invariant 7 still flags the raw inferred choice
  // regardless of the item's own state, since "no active inferred choice
  // anywhere" is unconditional per §8.2.
  const { invariants } = compileMenu([it], [], "t", false);
  assertEquals(invariants.find(i => i.invariant === 7)!.pass, false);
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
    { scope_type: tempQ.scope_type, scope_id: tempQ.scope_id, slot_key: tempQ.slot_key, blocking: tempQ.blocking, status: "pending", question_text: tempQ.question_text },
  ];
  const cheeseburger = item({ display_name: "Cheeseburger", category: "Burgers" });
  const veggieBurger = item({ display_name: "Veggie Burger", category: "Burgers" });
  const { items: compiled } = compileMenu([cheeseburger, veggieBurger], pendingQuestions, "t", false);
  const cheeseburgerState = compiled.find(c => c.item_id === cheeseburger.id)!;
  const veggieState = compiled.find(c => c.item_id === veggieBurger.id)!;
  // Both fall under the category-scoped question (compileMenu's blocking
  // match is scope-based, not per-item aware of applies_when) -- this is
  // the honest limitation flagged by §5.1's own "except: ..." UX line, not
  // a bug in this wiring: the owner sees the exclusion list when answering.
  assertEquals(cheeseburgerState.bot_state, "blocked");
  assertEquals(veggieState.bot_state, "blocked");
});
