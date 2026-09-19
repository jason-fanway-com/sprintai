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
  canonicalizeSizeTokens,
  categoryLexiconTerms,
  compileItem,
  compileMenu,
  computeMenuInvariants,
  normaliseTermVariants,
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

Deno.test("lexicon rule 2: product_key's bare base name is indexed alongside the qualified display_name", () => {
  const it = item({ display_name: "Chicken Caesar Salad", category: "Salads", product_key: "salads:chicken-caesar" });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "chicken caesar salad"));
  assert(terms.some(t => t.term === "chicken caesar"));
});

Deno.test("lexicon rule 2: no alias when product_key is absent, or when its base already equals the full display_name (nothing to strip)", () => {
  const noKey = item({ display_name: "Gyro", category: "Sandwiches", product_key: null });
  const noKeyTerms = compileItem(noKey, [], "t").lexicon_terms;
  assertEquals(noKeyTerms.length, 1, "only the Rule-1 term, no Rule-2 alias, when there is no product_key to read");

  const unqualified = item({ display_name: "Gyro", category: "Sandwiches", product_key: "sandwiches:gyro" });
  const terms = compileItem(unqualified, [], "t").lexicon_terms;
  assertEquals(terms.filter(t => t.term === "gyro").length, 1, "must not double-emit when the base name already IS the full name");
});

Deno.test("lexicon rule 2 (2026-09-18 PO dispatch, real Zio's/Shrimp Parmigiana fix): product_key is read instead of guessing from display_name, so an item whose real name simply happens to end in a category word no longer falsely collides with a genuinely different item", () => {
  // OLD bug: a regex strip of display_name's trailing category noun treated
  // "Zio's Salad" (category Salads) as if "Salad" were an added qualifier,
  // producing a false alias "zios" that collided with the real, unrelated
  // entree literally named "Zio's" — so BOTH lost the term (invariant 4
  // regression) under the old guard, or both became falsely ambiguous
  // without it. product_key's base segment carries the truth directly:
  // "Zio's Salad" was never derived from "Zio's" at all — it's its own
  // dish, base "zios-salad", not "zios".
  const entree = item({ display_name: "Zio's", category: "Chicken or Veal", product_key: "chicken-or-veal:zios" });
  const salad = item({ display_name: "Zio's Salad", category: "Salads", product_key: "salads:zios-salad" });
  const seafood = item({ display_name: "Shrimp Parmigiana", category: "Seafood", product_key: "seafood:shrimp-parmigiana" });
  const sub = item({ display_name: "Shrimp Parmigiana Sub", category: "Hot Subs", product_key: "hot-subs:shrimp-parmigiana-sub" });
  const { items: compiled } = compileMenu([entree, salad, seafood, sub], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(byId.get(entree.id)!.lexicon_terms.some(t => t.term === "zios"), "the entree uniquely owns its own real name");
  assert(!byId.get(salad.id)!.lexicon_terms.some(t => t.term === "zios"), "the salad's base name is 'zios salad', not 'zios' — no false alias");
  assert(!byId.get(seafood.id)!.lexicon_terms.some(t => t.term === "shrimp parmigiana sub"));
  assert(!byId.get(sub.id)!.lexicon_terms.some(t => t.term === "shrimp parmigiana"), "the sub's base name is 'shrimp parmigiana sub', not 'shrimp parmigiana' — no false alias");

  const inv4 = compileMenu([entree, salad, seafood, sub], [], "t", false).invariants.find(i => i.invariant === 4)!;
  assert(inv4.pass, `invariant 4 should pass, violations: ${inv4.violations.join(", ")}`);
});

Deno.test("lexicon rule 2 (2026-09-18 PO dispatch): a bare base name shared by TWO different items across categories is KEPT for both, ambiguous, one row each, no tiebreak (real Vito's 'cheesesteak'/'italian'/'blt' shape)", () => {
  // Real Vito's shape: "BLT Panini" and "BLT Sandwich" share product_key
  // base "blt" across two categories — genuinely the same dish, not a
  // regex coincidence. Per the 2026-09-18 PO ruling this is the same
  // "never silently drop, let resolveItem ask" principle already applied
  // to derived candidates ("burger", "fries") on 2026-09-15.
  const panini = item({ display_name: "BLT Panini", category: "Homemade Paninis", product_key: "homemade-paninis:blt" });
  const sandwich = item({ display_name: "BLT Sandwich", category: "Cold Sandwiches", product_key: "cold-sandwiches:blt" });
  const { items: compiled } = compileMenu([panini, sandwich], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const bltTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "blt").map(t => t.target_id)),
  );
  assertEquals(bltTargets, new Set([panini.id, sandwich.id]),
    "'blt' must carry exactly one row per claimant — both ids, no more, no fewer");
  assertEquals(byId.get(panini.id)!.lexicon_terms.filter(t => t.term === "blt").length, 1);
  assertEquals(byId.get(sandwich.id)!.lexicon_terms.filter(t => t.term === "blt").length, 1);
  // Each item's own full name (Rule 1) is still generated too.
  assert(byId.get(panini.id)!.lexicon_terms.some(t => t.term === "blt panini"));
  assert(byId.get(sandwich.id)!.lexicon_terms.some(t => t.term === "blt sandwich"));
});

Deno.test("lexicon rule 2: a bare base name claimed by only ONE item is generated normally", () => {
  const stromboli = item({ display_name: "Pepperoni Stromboli", category: "Strombolis", product_key: "strombolis:pepperoni" });
  const sausage = item({ display_name: "Sausage Stromboli", category: "Strombolis", product_key: "strombolis:sausage" });
  const { items: compiled } = compileMenu([stromboli, sausage], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));
  assert(byId.get(stromboli.id)!.lexicon_terms.some(t => t.term === "pepperoni"));
  assert(byId.get(sausage.id)!.lexicon_terms.some(t => t.term === "sausage"));
});

// ── Data fix (a), 2026-09-19: "plain"/"regular" aliases for the Cheese pizza ─

Deno.test("lexicon data fix (a): 'plain'/'plain cheese'/'regular' resolve to a Pizza-category item literally named 'Cheese', every sized row", () => {
  const small = item({ name: 'Cheese - Small (10")', display_name: 'Cheese - Small (10")', category: "Pizza", size_label: 'Small (10")', product_key: "pizza:cheese" });
  const large = item({ name: 'Cheese - Large (16")', display_name: 'Cheese - Large (16")', category: "Pizza", size_label: 'Large (16")', product_key: "pizza:cheese" });
  const { items: compiled } = compileMenu([small, large], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));
  for (const alias of ["plain", "plain cheese", "regular"]) {
    assert(byId.get(small.id)!.lexicon_terms.some(t => t.term === alias && t.target_type === "item"), `small must carry "${alias}"`);
    assert(byId.get(large.id)!.lexicon_terms.some(t => t.term === alias && t.target_type === "item"), `large must carry "${alias}"`);
  }
});

Deno.test("lexicon data fix (a): 'plain'/'regular' are NOT emitted for a 'Cheese' item outside the Pizza category", () => {
  const cheeseFries = item({ name: "Cheese Fries", display_name: "Cheese Fries", category: "Appetizers", product_key: "appetizers:cheese-fries" });
  const { items: compiled } = compileMenu([cheeseFries], [], "t", false);
  const terms = compiled.find(c => c.item_id === cheeseFries.id)!.lexicon_terms.map(t => t.term);
  assert(!terms.includes("plain"), `must not carry "plain": ${JSON.stringify(terms)}`);
  assert(!terms.includes("regular"), `must not carry "regular": ${JSON.stringify(terms)}`);
});

Deno.test("lexicon data fix (a): 'plain'/'regular' are NOT emitted for a Pizza item that isn't named 'Cheese'", () => {
  const buffalo = item({ name: 'Buffalo Chicken - Large (16")', display_name: 'Buffalo Chicken - Large (16")', category: "Pizza", size_label: 'Large (16")', product_key: "pizza:buffalo-chicken" });
  const { items: compiled } = compileMenu([buffalo], [], "t", false);
  const terms = compiled.find(c => c.item_id === buffalo.id)!.lexicon_terms.map(t => t.term);
  assert(!terms.includes("plain"), `must not carry "plain": ${JSON.stringify(terms)}`);
  assert(!terms.includes("regular"), `must not carry "regular": ${JSON.stringify(terms)}`);
});

Deno.test("lexicon rule 2 vs. derived pass (2026-09-18 PO dispatch, real Vito's 'cheesesteak' bug): a shared bare base name is never shadowed by an unrelated item's derived trailing-run candidate", () => {
  // Real bug: "Cheesesteak Sandwich"/"Panini"/"Roll" all share base
  // "cheesesteak" and, under the OLD (display_name-regex) rule, had that
  // alias dropped for all three — freeing the word "cheesesteak" for
  // "Garlic Cheesesteak"'s own derived trailing-run candidate to claim
  // uncontested. A customer saying just "cheesesteak" got Garlic, never any
  // of the three real items. Garlic's own base is "garlic-cheesesteak" — a
  // genuinely different dish, not qualified from "Cheesesteak" at all.
  const sandwich = item({ display_name: "Cheesesteak Sandwich", category: "Hot Sandwiches", product_key: "hot-sandwiches:cheesesteak" });
  const panini = item({ display_name: "Cheesesteak Panini", category: "Homemade Paninis", product_key: "homemade-paninis:cheesesteak" });
  const roll = item({ display_name: "Cheesesteak Roll", category: "Stromboli Rolls", product_key: "stromboli-rolls:cheesesteak" });
  const garlic = item({ display_name: "Garlic Cheesesteak", category: "Hot Sandwiches", product_key: "hot-sandwiches:garlic-cheesesteak" });
  const { items: compiled } = compileMenu([sandwich, panini, roll, garlic], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const cheesesteakTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "cheesesteak").map(t => t.target_id)),
  );
  assertEquals(cheesesteakTargets, new Set([sandwich.id, panini.id, roll.id]),
    "'cheesesteak' must resolve to the three real Cheesesteak items, and Garlic must never claim it");
  assert(!byId.get(garlic.id)!.lexicon_terms.some(t => t.term === "cheesesteak"),
    "Garlic Cheesesteak's own derived candidate must be excluded — the bare name already belongs to real items");
  assert(byId.get(garlic.id)!.lexicon_terms.some(t => t.term === "garlic cheesesteak"));
});

Deno.test("lexicon rule 2 (2026-09-18 PO dispatch, real Vito's 'chicken parmesan' bug): a folded, size-varying sibling shares its base name with unsized siblings across OTHER categories, even though its own display_name carries a leading size word display_name-regex could never strip", () => {
  // Real Vito's shape: "Chicken Parmesan Entree" and "Chicken Parmesan
  // Sandwich" are unsized, so their display_name never carries a size
  // prefix — but the Stromboli-category sibling is a folded, sized
  // product, so ITS display_name is "14\" Chicken Parmesan Stromboli":
  // BOTH a leading size word AND a trailing category noun, neither of
  // which the old display_name-regex approach could strip back down to
  // the shared dish name. product_key's base segment ("chicken-parmesan")
  // is computed by normalize.ts from the raw import name before either
  // qualification is ever applied, so all three items land on the exact
  // same bare term regardless of which qualification(s) fired.
  const entree = item({ display_name: "Chicken Parmesan Entree", category: "Entrees", product_key: "entrees:chicken-parmesan" });
  const sandwich = item({ display_name: "Chicken Parmesan Sandwich", category: "Hot Sandwiches", product_key: "hot-sandwiches:chicken-parmesan" });
  const stromboli14 = item({ display_name: "14\" Chicken Parmesan Stromboli", category: "Stromboli", size_label: "14\"", product_key: "stromboli:chicken-parmesan" });
  const stromboli16 = item({ display_name: "16\" Chicken Parmesan Stromboli", category: "Stromboli", size_label: "16\"", product_key: "stromboli:chicken-parmesan" });
  const stromboliPersonal = item({ display_name: "Personal Chicken Parmesan Stromboli", category: "Stromboli", size_label: "Personal", product_key: "stromboli:chicken-parmesan" });
  const { items: compiled } = compileMenu([entree, sandwich, stromboli14, stromboli16, stromboliPersonal], [], "t", false);

  const chickenParmTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "chicken parmesan").map(t => t.target_id)),
  );
  assertEquals(chickenParmTargets, new Set([entree.id, sandwich.id, stromboli14.id, stromboli16.id, stromboliPersonal.id]),
    "'chicken parmesan' must be ambiguous across all 5 real items sharing the dish, not just the unsized two");
});

Deno.test("lexicon rule 2 (2026-09-18 PO decision, item 1 — supersedes this same day's earlier ≥2-unsized-siblings rule): a sized family's base key shared by even ONE unsized item ties them ALL under the bare term, ambiguous, never a guess (real Vito's 'Bruschetta' appetizer vs 'Bruschetta Pizza')", () => {
  // The superseded rule kept these apart on purpose, reasoning they were
  // "genuinely two different foods that just happen to share a name."
  // Jason's ruling: resolving bare "bruschetta" straight to the appetizer
  // because the name matches exactly is a GUESS that happens to be right
  // for one dish and wrong for the pizza — the same shape as the $2.50
  // cheeseburger bug. The bare word must tie all four; resolve-item.ts's
  // own narrowing (category "pizza", a stated size) picks the one meant,
  // and a truly bare "bruschetta" asks instead of guessing.
  const appetizer = item({ display_name: "Bruschetta", category: "Appetizers", product_key: "appetizers:bruschetta" });
  const small = item({ display_name: "Small Bruschetta Pizza", category: "Pizza", size_label: "Small (10\")", product_key: "pizza:bruschetta" });
  const medium = item({ display_name: "Medium Bruschetta Pizza", category: "Pizza", size_label: "Medium (14\")", product_key: "pizza:bruschetta" });
  const large = item({ display_name: "Large Bruschetta Pizza", category: "Pizza", size_label: "Large (16\")", product_key: "pizza:bruschetta" });
  const { items: compiled } = compileMenu([appetizer, small, medium, large], [], "t", false);

  const bruschettaTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "bruschetta").map(t => t.target_id)),
  );
  assertEquals(bruschettaTargets, new Set([appetizer.id, small.id, medium.id, large.id]),
    "bare 'bruschetta' must tie the appetizer and all 3 pizza sizes — narrowing, not this compiler, decides which one");
});

Deno.test("lexicon rule 2 (2026-09-18 PO decision, item 1): the shared-base-key rule is keyed on product_key, not a name list — a same-named item with a DIFFERENT base key does not join", () => {
  // Negative case for the same rule: an item whose product_key base is
  // genuinely different text must NOT be pulled in just because its
  // DISPLAY name happens to contain the same word — the rule's own basis
  // is the shared key, never a name match.
  const flatbread = item({ display_name: "Chicken Bacon Ranch", category: "Flatbreads", product_key: "flatbreads:chicken-bacon-ranch" });
  const pizza = item({ display_name: "Medium Chicken Bacon Ranch Pizza", category: "Pizza", size_label: "Medium (14\")", product_key: "pizza:chicken-bacon-ranch" });
  const wrap = item({ display_name: "Grilled Chicken Bacon & Ranch", category: "Wraps", product_key: "wraps:grilled-chicken-bacon-ranch" });
  const { items: compiled } = compileMenu([flatbread, pizza, wrap], [], "t", false);

  const cbrTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "chicken bacon ranch").map(t => t.target_id)),
  );
  assertEquals(cbrTargets, new Set([flatbread.id, pizza.id]),
    "the wrap's own base key is 'grilled-chicken-bacon-ranch', not 'chicken-bacon-ranch' — it does not share the family key, so it is not pulled in by this rule");
});

Deno.test("lexicon rule 2 (2026-09-18 PO decision, item 1 — REGRESSION FIX): a size-folded family with NO unsized namesake at all still gets its bare base-key term (real Vito's 'calzone' bug)", () => {
  // This is the exact live regression: the first version of item 1's rule
  // required >=1 unsized sibling sharing the bare name before a sized
  // family could claim it -- which silently failed every family that has
  // no unsized member at all. Real Vito's "Calzone" is sized-only (Small/
  // Medium/Large or similar; no standalone "Calzone" appetizer or entree
  // exists anywhere on the menu), so the >=1 version emitted NOTHING for
  // "calzone" and a live customer asking for one got "Sorry, I didn't
  // catch that" instead of a size question (conversations 45b0f2e4,
  // 0a8b4ffa). The rule has no sibling-count condition at all now.
  const small = item({ display_name: "Small Calzone", category: "Stromboli", size_label: "Personal", product_key: "stromboli:calzone" });
  const medium = item({ display_name: "14\" Calzone", category: "Stromboli", size_label: "14\"", product_key: "stromboli:calzone" });
  const large = item({ display_name: "16\" Calzone", category: "Stromboli", size_label: "16\"", product_key: "stromboli:calzone" });
  const { items: compiled } = compileMenu([small, medium, large], [], "t", false);

  const calzoneTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "calzone").map(t => t.target_id)),
  );
  assertEquals(calzoneTargets, new Set([small.id, medium.id, large.id]),
    "bare 'calzone' must tie all 3 sizes even though no unsized 'Calzone' item exists anywhere");
});

// ============================================================
// 2026-09-18 PO decision, item 2 (real Vito's "sauce"/"onions"/"fries"
// collisions — the choice/group-vocabulary rule originally proposed for
// this was rejected: it collided with the 2026-09-15 fix that keeps
// "pasta"/"bagel"/"rye" reachable as real derived item terms even though
// they're also choice names). Codable, narrower basis instead: strip a
// prepositional tail before deriving trailing word-runs / head nouns at
// all, so the generic word after "with"/"w/"/"and"/"on"/"in" is never a
// candidate in the first place — the item's own stated Rule 1/2 terms are
// untouched.
// ============================================================

Deno.test("lexicon surface forms (2026-09-18 PO decision, item 2): a prepositional tail is stripped before deriving trailing word-runs — 'sauce'/'clam sauce' are never candidates for 'Pasta with Clam Sauce'", () => {
  const pasta = item({ display_name: "Pasta With Clam Sauce", category: "Entrees", product_key: "entrees:pasta-with-clam-sauce" });
  const { items: compiled } = compileMenu([pasta], [], "t", false);
  const terms = compiled[0].lexicon_terms.map(t => t.term);
  assert(terms.includes("pasta with clam sauce"), "the item's own stated Rule 1 name is untouched");
  assert(!terms.includes("sauce"), "must never derive the generic word after 'with'");
  assert(!terms.includes("clam sauce"), "must never derive any trailing run rooted past the preposition");
  assert(!terms.includes("with clam sauce"));
});

Deno.test("lexicon surface forms (2026-09-18 PO decision, item 2): the same fix, for free, on 'and'/'in' tails — 'onions' and a competing 'fries' are never derived", () => {
  const pierogies = item({ display_name: "Sauteed Pierogies with onions", category: "Appetizers", product_key: "appetizers:sauteed-pierogies-with-onions" });
  const fingersWithFries = item({ display_name: "Chicken Fingers (5) with french fries", category: "Appetizers", product_key: "appetizers:chicken-fingers-5-with-french-fries" });
  const realFries = item({ display_name: "French Fries", category: "Appetizers", product_key: "appetizers:french-fries" });
  const { items: compiled } = compileMenu([pierogies, fingersWithFries, realFries], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(!byId.get(pierogies.id)!.lexicon_terms.some(t => t.term === "onions"), "'onions' must never be derived from the pierogies' own prepositional tail");

  const friesTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "fries").map(t => t.target_id)),
  );
  assertEquals(friesTargets, new Set([realFries.id]),
    "'fries' must resolve uniquely to the real French Fries item — the chicken fingers combo's tail must never compete for it");
});

Deno.test("lexicon surface forms (2026-09-18 PO decision, item 2): the two 2026-09-15 choice-collision tests still pass unchanged — this fix must not reintroduce that regression", () => {
  // Same fixtures as the two protected tests above (Family Meal/'pizza',
  // Baked Ziti/'penne') — re-asserted here as a single guard so a future
  // change to this same derivation path can't silently break them without
  // this test naming the exact regression it would be.
  const familyMeal = item({
    display_name: "Family Meal", category: "Combos",
    groups: [group({ slot_key: "extra", choices: [choice({ name: "Pizza" })] })],
  });
  const tomatoPizza = item({ display_name: "Large Tomato Pizza", category: "Sides" });
  const choosePasta = item({
    display_name: "Baked Ziti", category: "Entrees",
    groups: [group({ slot_key: "pasta", choices: [choice({ name: "Fettuccine" }), choice({ name: "Penne" }), choice({ name: "Rigatoni" })] })],
  });
  const chickenPenne = item({ display_name: "Chicken Penne", category: "Entrees" });
  const { items: compiled } = compileMenu([familyMeal, tomatoPizza, choosePasta, chickenPenne], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(byId.get(tomatoPizza.id)!.lexicon_terms.some(t => t.term === "pizza" && t.target_type === "item"),
    "'pizza' must still reach Large Tomato Pizza as an item term despite also being a choice name");
  assert(byId.get(chickenPenne.id)!.lexicon_terms.some(t => t.term === "penne" && t.target_type === "item"),
    "'penne' must still reach Chicken Penne as an item term despite also being a choice name");
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

// ---- Commit 2 (2026-09-19, real Vito's "Grandma's" pizza): apostrophe
// lexicon gap + size-token canonicalization ------------------------------
//
// Live repro: "grandma's medium 14"" and "medium grandma's" both came back
// completely unresolved; only "grandmas" (customer typed with NO apostrophe
// at all) worked. Root cause: normaliseTerm always strips an apostrophe
// entirely, so that was the ONLY form ever stored — resolve-item.ts's own
// normalize() turns a customer's literal apostrophe into a SPACE instead
// ("grandma's" -> "grandma s", two words), which can never word-align
// against the single stored word "grandmas".

Deno.test("canonicalizeSizeTokens: the three squished spellings all canonicalize to the same '<digits> inch' form", () => {
  assertEquals(canonicalizeSizeTokens(`14"`), "14 inch");
  assertEquals(canonicalizeSizeTokens("14in"), "14 inch");
  assertEquals(canonicalizeSizeTokens("14-inch"), "14 inch");
  assertEquals(canonicalizeSizeTokens("14-inches"), "14 inch");
});

Deno.test("canonicalizeSizeTokens: the already-spaced form is left alone (already tokenizes correctly)", () => {
  assertEquals(canonicalizeSizeTokens("14 inch"), "14 inch");
  assertEquals(canonicalizeSizeTokens("14 inches"), "14 inches");
});

Deno.test("canonicalizeSizeTokens: never misfires on unrelated text that merely contains a number then the word 'in'", () => {
  assertEquals(canonicalizeSizeTokens("Wings (10 in a box)"), "Wings (10 in a box)",
    "a real space before 'in' is a plausible, unrelated shop description ('10 in a box'), never a size — must not rewrite it");
  assertEquals(canonicalizeSizeTokens("10 Pins"), "10 Pins", "'Pins' must never be misread as containing the word 'in'");
});

Deno.test("canonicalizeSizeTokens: applied inside a full name, in context", () => {
  assertEquals(canonicalizeSizeTokens(`Grandma's - Medium (14")`), "Grandma's - Medium (14 inch)");
});

Deno.test("normaliseTermVariants: a term with no apostrophe at all is completely unaffected — exactly the one row it always produced", () => {
  assertEquals(normaliseTermVariants("Gyro"), ["gyro"]);
  assertEquals(normaliseTermVariants("Cheese Burger"), ["cheese burger"]);
});

Deno.test("normaliseTermVariants: an apostrophe emits the stripped, as-typed, and curly-quote forms", () => {
  const variants = normaliseTermVariants("Grandma's Pizza");
  assert(variants.includes("grandmas pizza"), "stripped form must still be present (unchanged existing behavior)");
  assert(variants.includes("grandma's pizza"), "as-typed straight-apostrophe form must be present");
  assert(variants.includes("grandma’s pizza"), "curly-quote form must be present");
  assertEquals(variants.length, 3, "no duplicates, no extra forms");
});

Deno.test("normaliseTermVariants: already-curly input still yields all three forms, deduplicated", () => {
  const variants = normaliseTermVariants("Grandma’s Pizza");
  assertEquals(new Set(variants), new Set(["grandmas pizza", "grandma's pizza", "grandma’s pizza"]));
});

function sizedGrandmaItem(overrides: Partial<CompileItem> = {}): CompileItem {
  return item({
    name: `Grandma's - Medium (14")`,
    display_name: "Medium Grandma's Pizza",
    category: "Pizza",
    product_key: "pizza:grandmas",
    size_label: `Medium (14")`,
    ...overrides,
  });
}

Deno.test("lexicon (Commit 2): Rule 1's display_name term gets apostrophe variants alongside the existing stripped form", () => {
  const it = sizedGrandmaItem();
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "medium grandmas pizza"), "existing stripped form must still be present");
  assert(terms.some(t => t.term === "medium grandma's pizza"), "as-typed form must now also be present");
  assert(terms.some(t => t.term === "medium grandma’s pizza"), "curly-quote form must now also be present");
});

Deno.test("lexicon (Commit 2): an apostrophe-preserving BARE term is emitted for every member of a sized family, alongside the stripped bare term", () => {
  const medium = sizedGrandmaItem();
  const large = sizedGrandmaItem({ id: crypto.randomUUID(), name: `Grandma's - Large (16")`, display_name: "Large Grandma's Pizza", size_label: `Large (16")` });
  const { items: compiled } = compileMenu([medium, large], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  for (const it of [medium, large]) {
    const terms = byId.get(it.id)!.lexicon_terms;
    assert(terms.some(t => t.term === "grandmas"), "existing stripped bare term must still be present");
    assert(terms.some(t => t.term === "grandma's"), "as-typed bare term must now also be present");
    assert(terms.some(t => t.term === "grandma’s"), "curly-quote bare term must now also be present");
  }
});

Deno.test("lexicon (Commit 2): a sized item with NO apostrophe in its base name is completely unaffected — no extra rows", () => {
  const small = item({ name: "Cheese - Small (10\")", display_name: "Small Cheese Pizza", category: "Pizza", product_key: "pizza:cheese", size_label: "Small (10\")" });
  const terms = compileItem(small, [], "t").lexicon_terms;
  assertEquals(terms.filter(t => t.term.includes("'") || t.term.includes("’")).length, 0);
});

Deno.test("lexicon (Commit 2): Rule 6 choice names also get apostrophe variants (general rule, not item-name-only)", () => {
  const it = item({
    display_name: "Gyro",
    groups: [group({ kind: "slot", choices: [choice({ name: "Chef's Special" }), choice({ name: "Regular" })] })],
  });
  const terms = compileItem(it, [], "t").lexicon_terms;
  assert(terms.some(t => t.term === "chefs special" && t.target_type === "choice"));
  assert(terms.some(t => t.term === "chef's special" && t.target_type === "choice"));
  assert(terms.some(t => t.term === "chef’s special" && t.target_type === "choice"));
});

// ---- Lexicon surface-form variants (space-collapsed + plural) -----------------

Deno.test("lexicon surface forms: a space-collapsed item term is emitted and kept when it resolves uniquely (real Vito's cheeseburger gap, 2026-09-14)", () => {
  // Real bug: Vito's had "cheese burger" ($8.49) and "bacon cheeseburger"
  // ($10.99) but no term for the bare word "cheeseburger" a customer
  // actually types — it fell through to the only term containing that
  // substring, the dearer item, on 11/17 live calls.
  const cheeseBurger = item({ display_name: "Cheese Burger", category: "Burgers" });
  const baconCheeseburger = item({ display_name: "Bacon Cheeseburger", category: "Burgers" });
  const { items: compiled } = compileMenu([cheeseBurger, baconCheeseburger], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const cheeseburgerTerm = byId.get(cheeseBurger.id)!.lexicon_terms.find(t => t.term === "cheeseburger");
  assert(cheeseburgerTerm, "bare 'cheeseburger' must resolve to the Cheese Burger item");
  assertEquals(cheeseburgerTerm!.target_type, "item");
  assertEquals(cheeseburgerTerm!.target_id, cheeseBurger.id);
  assertEquals(cheeseburgerTerm!.provenance, "derived");
  assert(!byId.get(baconCheeseburger.id)!.lexicon_terms.some(t => t.term === "cheeseburger"),
    "the dearer item must not also claim the bare term");
});

Deno.test("lexicon surface forms: a variant that would resolve to two different items is KEPT for every claimant, one row each, no tiebreak", () => {
  // "Meatball" pluralizes to "meatballs"; "Meat Balls" space-collapses to
  // the identical string "meatballs" — two independently-derived candidates
  // landing on the same term, same shape as the real Zio's collisions.
  // Per PO ruling 2026-09-15: dropping was the wrong half of the design —
  // the invariant is "never silently pick one item for the customer", and
  // keeping every claimant so the resolver can ask is what protects that.
  const meatball = item({ display_name: "Meatball", category: "Appetizers" });
  const meatBalls = item({ display_name: "Meat Balls", category: "Appetizers" });
  const { items: compiled } = compileMenu([meatball, meatBalls], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const meatballsTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "meatballs").map(t => t.target_id)),
  );
  assertEquals(meatballsTargets, new Set([meatball.id, meatBalls.id]),
    "'meatballs' must carry exactly one row per claimant — both ids, no more, no fewer");
  assertEquals(byId.get(meatball.id)!.lexicon_terms.filter(t => t.term === "meatballs").length, 1,
    "Meatball claims 'meatballs' exactly once");
  assertEquals(byId.get(meatBalls.id)!.lexicon_terms.filter(t => t.term === "meatballs").length, 1,
    "Meat Balls claims 'meatballs' exactly once");
  for (const t of compiled.flatMap(c => c.lexicon_terms.filter(x => x.term === "meatballs"))) {
    assertEquals(t.target_type, "item");
    assertEquals(t.provenance, "derived");
  }
  // Each item's own stated (rule 1) term is untouched.
  assert(byId.get(meatball.id)!.lexicon_terms.some(t => t.term === "meatball"));
  assert(byId.get(meatBalls.id)!.lexicon_terms.some(t => t.term === "meat balls"));
});

Deno.test("lexicon surface forms: an already-plural source term is not pluralized (Zio's 'meatballses'/'sausages'/'spinaches' naive-pluralization junk)", () => {
  const fries = item({ display_name: "Curly Fries", category: "Sides" });
  const terms = compileMenu([fries], [], "t", false).items[0].lexicon_terms.map(t => t.term);
  assert(!terms.includes("curly frieses"), "an already-plural term must never be pluralized");
  assert(!terms.includes("curly friess"));
});

// ---- Lexicon surface forms: trailing portion-count stripping (2026-09-18
// PO dispatch, real Vito's "chicken fingers (3)" gap) ------------------------

Deno.test("lexicon surface forms: a trailing portion count is stripped and the bare name resolves uniquely when only one item carries it", () => {
  // Source import carries "Chicken Fingers (3)"; normaliseTerm's punctuation
  // strip turns the parens into a bare trailing digit word ("chicken
  // fingers 3"), which the compiler was otherwise treating as part of the
  // dish's name — a customer who says "chicken fingers" with no count never
  // matched anything.
  const fingers = item({ display_name: "Chicken Fingers (3)", category: "Appetizers" });
  const fries = item({ display_name: "French Fries", category: "Sides" });
  const { items: compiled } = compileMenu([fingers, fries], [], "t", false);
  const fingersTerms = compiled.find(c => c.item_id === fingers.id)!.lexicon_terms;

  const bare = fingersTerms.find(t => t.term === "chicken fingers 3");
  assert(bare, "sanity: the un-stripped stated term carries the count word");
  const stripped = fingersTerms.find(t => t.term === "chicken fingers");
  assert(stripped, "'chicken fingers' must resolve after stripping the trailing count");
  assertEquals(stripped!.target_type, "item");
  assertEquals(stripped!.target_id, fingers.id);
  assertEquals(stripped!.provenance, "derived");
});

Deno.test("lexicon surface forms: a trailing portion count stripped from TWO different sizes of the same dish is KEPT for both, ambiguous, no tiebreak", () => {
  const fingers3 = item({ display_name: "Chicken Fingers (3)", category: "Appetizers" });
  const fingers5 = item({ display_name: "Chicken Fingers (5)", category: "Appetizers" });
  const { items: compiled } = compileMenu([fingers3, fingers5], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const bareTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "chicken fingers").map(t => t.target_id)),
  );
  assertEquals(bareTargets, new Set([fingers3.id, fingers5.id]),
    "'chicken fingers' must carry exactly one row per claimant — both ids, no more, no fewer");
  assertEquals(byId.get(fingers3.id)!.lexicon_terms.filter(t => t.term === "chicken fingers").length, 1);
  assertEquals(byId.get(fingers5.id)!.lexicon_terms.filter(t => t.term === "chicken fingers").length, 1);
  // Each item's own stated (count-qualified) term is untouched.
  assert(byId.get(fingers3.id)!.lexicon_terms.some(t => t.term === "chicken fingers 3"));
  assert(byId.get(fingers5.id)!.lexicon_terms.some(t => t.term === "chicken fingers 5"));
});

Deno.test("lexicon surface forms: a bare digit trailing-run off a portion-count suffix is never itself a lexicon term (round 2 addendum item A, 2026-09-19, live Vito's repro)", () => {
  // The real live bug: "3 small pizzas" -> the numbered list offered
  // Chicken Fingers (3) / Nonas Meatballs (3) / Pierogies (3) — the digit
  // "3" in the customer's own bare quantity matched the "(3)" portion
  // suffix shared by three unrelated items, because trailingWordRuns (fed
  // the un-stripped "chicken fingers 3" stated term) derived the bare
  // digit "3" as its own one-word candidate and every item sharing that
  // suffix claimed it.
  const fingers = item({ display_name: "Chicken Fingers (3)", category: "Appetizers" });
  const meatballs = item({ display_name: "Nonas Meatballs (3)", category: "Appetizers" });
  const pierogies = item({ display_name: "Pierogies (3)", category: "Appetizers" });
  const { items: compiled } = compileMenu([fingers, meatballs, pierogies], [], "t", false);

  const bareDigitClaimants = compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "3"));
  assertEquals(bareDigitClaimants.length, 0, "a bare digit must never be a matchable lexicon term at all");

  // The count-suffix stripping this fix sits alongside (already landed,
  // covered above) is unaffected: each item's own bare dish name still
  // resolves, ambiguous across the real claimants, same as before.
  const bareNameTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "nonas meatballs").map(t => t.target_id)),
  );
  assertEquals(bareNameTargets, new Set([meatballs.id]));
});

Deno.test("lexicon surface forms: a trailing run that merely CONTAINS a digit alongside real words is unaffected by the bare-digit exclusion", () => {
  const wings = item({ display_name: "Boneless Wings 6 Pieces", category: "Wings" });
  const { items: compiled } = compileMenu([wings], [], "t", false);
  const terms = compiled[0].lexicon_terms.map(t => t.term);
  assert(terms.includes("pieces") || terms.includes("6 pieces") || terms.includes("wings 6 pieces"),
    "a multi-word trailing run containing a digit is still derived normally, only a PURELY numeric run is excluded");
});

Deno.test("lexicon surface forms: output is byte-identical across two separate compileMenu runs on the same input", () => {
  const items = [
    item({ display_name: "Cheese Burger", category: "Burgers" }),
    item({ display_name: "Bacon Cheeseburger", category: "Burgers" }),
    item({ display_name: "Meatball", category: "Appetizers" }),
    item({ display_name: "Meat Balls", category: "Appetizers" }),
    item({ display_name: "Curly Fries", category: "Sides" }),
  ];
  const r1 = compileMenu(items, [], "2026-09-07T00:00:00Z", false);
  const r2 = compileMenu(items, [], "2026-09-08T00:00:00Z", false);
  const strip = (r: typeof r1) => r.items.map(i => ({ item_id: i.item_id, lexicon_terms: i.lexicon_terms }));
  assertEquals(strip(r1), strip(r2));
});

// ---- Lexicon surface-form variants: plural of the collapsed form + trailing
// word-runs (docs/specs/2026-09-15-code-owned-resolution.md §3 work item 1) --

Deno.test("lexicon surface forms: plural of the collapsed form is emitted and kept when it resolves uniquely (the single most likely customer phrasing)", () => {
  const cheeseBurger = item({ display_name: "Cheese Burger", category: "Burgers" });
  const baconCheeseburger = item({ display_name: "Bacon Cheeseburger", category: "Burgers" });
  const { items: compiled } = compileMenu([cheeseBurger, baconCheeseburger], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const term = byId.get(cheeseBurger.id)!.lexicon_terms.find(t => t.term === "cheeseburgers");
  assert(term, "'cheeseburgers' (plural of the collapsed form) must resolve to Cheese Burger");
  assertEquals(term!.target_type, "item");
  assertEquals(term!.target_id, cheeseBurger.id);
  assertEquals(term!.provenance, "derived");
  assert(!byId.get(baconCheeseburger.id)!.lexicon_terms.some(t => t.term === "cheeseburgers"),
    "the dearer item must not also claim the bare plural");
});

Deno.test("lexicon surface forms: plural of the collapsed form is KEPT for both claimants when it collides with another candidate, no tiebreak", () => {
  // "Egg Roll" -> plural-of-collapsed "eggrolls"; "Egg Rolls" -> plain
  // collapse "eggrolls" (the already-committed rule). Same candidate pool,
  // same gate — two independently-derived candidates landing on one term.
  // Per PO ruling 2026-09-15: keep every claimant, no tiebreak.
  const eggRoll = item({ display_name: "Egg Roll", category: "Appetizers" });
  const eggRolls = item({ display_name: "Egg Rolls", category: "Appetizers" });
  const { items: compiled } = compileMenu([eggRoll, eggRolls], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const eggrollsTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "eggrolls").map(t => t.target_id)),
  );
  assertEquals(eggrollsTargets, new Set([eggRoll.id, eggRolls.id]),
    "'eggrolls' must carry exactly one row per claimant — both ids, no more, no fewer");
  assertEquals(byId.get(eggRoll.id)!.lexicon_terms.filter(t => t.term === "eggrolls").length, 1);
  assertEquals(byId.get(eggRolls.id)!.lexicon_terms.filter(t => t.term === "eggrolls").length, 1);
  for (const t of compiled.flatMap(c => c.lexicon_terms.filter(x => x.term === "eggrolls"))) {
    assertEquals(t.target_type, "item");
    assertEquals(t.provenance, "derived");
  }
  // Each item's own stated (rule 1) term is untouched.
  assert(byId.get(eggRoll.id)!.lexicon_terms.some(t => t.term === "egg roll"));
  assert(byId.get(eggRolls.id)!.lexicon_terms.some(t => t.term === "egg rolls"));
});

Deno.test("lexicon surface forms: plural of the collapsed form is not proposed when the term already exists as another item's own stated name", () => {
  const cheeseBurger = item({ display_name: "Cheese Burger", category: "Burgers" });
  const cheeseburgersPlatter = item({ display_name: "Cheeseburgers", category: "Party Trays" });
  const { items: compiled } = compileMenu([cheeseBurger, cheeseburgersPlatter], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(!byId.get(cheeseBurger.id)!.lexicon_terms.some(t => t.term === "cheeseburgers" && t.provenance === "derived"),
    "must not derive a duplicate of another item's own stated term");
  assert(byId.get(cheeseburgersPlatter.id)!.lexicon_terms.some(t => t.term === "cheeseburgers" && t.provenance === "stated"),
    "the real stated item keeps its own primary term, untouched");
});

Deno.test("lexicon surface forms: every proper trailing word-run (head noun) is emitted and kept when unique", () => {
  const wings = item({ display_name: "10 Pieces Wings Boneless", category: "Wings" });
  const fries = item({ display_name: "French Fries", category: "Sides" });
  const { items: compiled } = compileMenu([wings, fries], [], "t", false);
  const wingsTerms = compiled.find(c => c.item_id === wings.id)!.lexicon_terms;
  const wingsTermStrings = wingsTerms.map(t => t.term);

  for (const run of ["pieces wings boneless", "wings boneless", "boneless"]) {
    assert(wingsTermStrings.includes(run), `expected trailing run "${run}" to be kept`);
    const t = wingsTerms.find(t => t.term === run)!;
    assertEquals(t.target_type, "item");
    assertEquals(t.target_id, wings.id);
    assertEquals(t.provenance, "derived");
  }
  assertEquals(wingsTerms.filter(t => t.term === "10 pieces wings boneless").length, 1,
    "the full stated term must appear once (as 'stated'), never re-derived as its own 'proper' trailing run");
});

Deno.test("lexicon surface forms: an ambiguous trailing word-run is KEPT for every claimant, one row each, no tiebreak (real Vito's 'fries'/'burger' shape)", () => {
  // 2026-09-15 live incident: with the old drop-on-collision rule, "fries"
  // and "burger" were entirely absent from Vito's lexicon, so a customer
  // saying "a burger well done plus an order of fries" hit two dead-end
  // declines with an empty cart instead of a disambiguating question. Per
  // PO ruling: the invariant was never "drop the term" — it was "never
  // silently pick one item for the customer". Keeping every claimant lets
  // the resolver route to the ASK-and-name-the-candidates path instead.
  const frenchFries = item({ display_name: "French Fries", category: "Sides" });
  const curlyFries = item({ display_name: "Curly Fries", category: "Sides" });
  const { items: compiled } = compileMenu([frenchFries, curlyFries], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  const friesTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "fries").map(t => t.target_id)),
  );
  assertEquals(friesTargets, new Set([frenchFries.id, curlyFries.id]),
    "'fries' must carry exactly one row per claimant — both ids, no more, no fewer");
  assertEquals(byId.get(frenchFries.id)!.lexicon_terms.filter(t => t.term === "fries").length, 1);
  assertEquals(byId.get(curlyFries.id)!.lexicon_terms.filter(t => t.term === "fries").length, 1);
  for (const t of compiled.flatMap(c => c.lexicon_terms.filter(x => x.term === "fries"))) {
    assertEquals(t.target_type, "item");
    assertEquals(t.provenance, "derived");
  }
  // Each item's own stated term is untouched.
  assert(byId.get(frenchFries.id)!.lexicon_terms.some(t => t.term === "french fries"));
  assert(byId.get(curlyFries.id)!.lexicon_terms.some(t => t.term === "curly fries"));
});

Deno.test("lexicon surface forms: a trailing word-run is not proposed when the term already exists as another item's own stated primary name", () => {
  const buffaloWings = item({ display_name: "Buffalo Chicken Wings", category: "Appetizers" });
  const wings = item({ display_name: "Wings", category: "Party Trays" });
  const { items: compiled } = compileMenu([buffaloWings, wings], [], "t", false);
  const buffaloTerms = compiled.find(c => c.item_id === buffaloWings.id)!.lexicon_terms;

  assert(!buffaloTerms.some(t => t.term === "wings" && t.provenance === "derived"),
    "must not derive a duplicate of another item's real stated name");
  assert(buffaloTerms.some(t => t.term === "chicken wings" && t.provenance === "derived"),
    "a different, non-colliding trailing run is still kept");
});

Deno.test("lexicon surface forms: trailing word-runs are also derived off level-1 (collapse/plural) survivors, not just stated terms", () => {
  // "Cheese Sandwich" -> stated -> plural-of-stated "cheese sandwiches" (the
  // already-committed rule) -> this pass's own trailing-run should treat
  // that derived plural as a source too, surfacing the head noun
  // "sandwiches" -- not just "sandwich" off the singular stated term.
  // (Category deliberately isn't "Sandwiches" — that would make the category
  // noun itself claim "sandwich"/"sandwiches" first via rule 3, masking the
  // exact thing this test wants to observe.)
  const cheeseBurger = item({ display_name: "Cheese Sandwich", category: "Entrees" });
  const fries = item({ display_name: "French Fries", category: "Sides" });
  const { items: compiled } = compileMenu([cheeseBurger, fries], [], "t", false);
  const cbTerms = compiled.find(c => c.item_id === cheeseBurger.id)!.lexicon_terms;

  assert(cbTerms.some(t => t.term === "sandwich" && t.provenance === "derived"));
  assert(cbTerms.some(t => t.term === "sandwiches" && t.provenance === "derived"));
});

Deno.test("lexicon surface forms (part 2): output is byte-identical across two separate compileMenu runs on the same input", () => {
  const items = [
    item({ display_name: "Cheese Burger", category: "Burgers" }),
    item({ display_name: "Bacon Cheeseburger", category: "Burgers" }),
    item({ display_name: "10 Pieces Wings Boneless", category: "Wings" }),
    item({ display_name: "French Fries", category: "Sides" }),
    item({ display_name: "Curly Fries", category: "Sides" }),
  ];
  const r1 = compileMenu(items, [], "2026-09-07T00:00:00Z", false);
  const r2 = compileMenu(items, [], "2026-09-08T00:00:00Z", false);
  const strip = (r: typeof r1) => r.items.map(i => ({ item_id: i.item_id, lexicon_terms: i.lexicon_terms }));
  assertEquals(strip(r1), strip(r2));
});

// ---- Category-vs-item surface-form collisions (2026-09-15 PO dispatch,
// live Zio's 'pizza' incident) -------------------------------------------

Deno.test("lexicon surface forms: a trailing word-run colliding ONLY with a category term is written as an item term, one row per claimant (real Zio's 'pizza' shape)", () => {
  // Zio's live incident 2026-09-15: category "Pizza" carries stated rule-3
  // terms "pizza"/"pizzas". Every pizza item's own stated term ("Large
  // Tomato Pizza", "Large Pepperoni Pizza") is multi-word, so this pass's
  // trailing-word-run derivation proposes the bare head noun "pizza" for
  // each of them -- but the OLD exclusion set treated the category's own
  // "pizza" term as blocking, same as a real item/choice term, so "pizza"
  // was silently withheld menu-wide. resolve-item.ts never reads
  // target_type='category' rows, so a customer typing "pizza" at a
  // pizzeria got zero candidates -- a dead end for the single most likely
  // word at that shop. Per PO ruling: a category term must not block a
  // derived item term the way a real item/choice term does; the two
  // coexist, and multiple item claimants keep one row each so resolveItem's
  // ambiguous-match ASK path has data to route on, exactly like the
  // item-vs-item collision case (see the "fries"/"burger" tests above).
  const tomatoPizza = item({ display_name: "Large Tomato Pizza", category: "Pizza" });
  const pepperoniPizza = item({ display_name: "Large Pepperoni Pizza", category: "Pizza" });
  const { items: compiled, categoryLexicon } = compileMenu([tomatoPizza, pepperoniPizza], [], "t", false);
  const byId = new Map(compiled.map(c => [c.item_id, c]));

  assert(categoryLexicon.some(t => t.term === "pizza" && t.target_type === "category"),
    "the category's own stated term must still exist, untouched");

  const pizzaTargets = new Set(
    compiled.flatMap(c => c.lexicon_terms.filter(t => t.term === "pizza").map(t => t.target_id)),
  );
  assertEquals(pizzaTargets, new Set([tomatoPizza.id, pepperoniPizza.id]),
    "'pizza' must now be written once per item claimant, alongside the untouched category row");
  assertEquals(byId.get(tomatoPizza.id)!.lexicon_terms.filter(t => t.term === "pizza").length, 1);
  assertEquals(byId.get(pepperoniPizza.id)!.lexicon_terms.filter(t => t.term === "pizza").length, 1);
  for (const t of compiled.flatMap(c => c.lexicon_terms.filter(x => x.term === "pizza"))) {
    assertEquals(t.target_type, "item");
    assertEquals(t.provenance, "derived");
  }
});

Deno.test("lexicon surface forms: a trailing word-run colliding with another item's own stated primary name is still suppressed (category fix must not widen item collisions)", () => {
  const frenchFries = item({ display_name: "French Fries", category: "Sides" });
  const friesItem = item({ display_name: "Fries", category: "Party Trays" });
  const { items: compiled } = compileMenu([frenchFries, friesItem], [], "t", false);
  const frenchFriesTerms = compiled.find(c => c.item_id === frenchFries.id)!.lexicon_terms;

  assert(!frenchFriesTerms.some(t => t.term === "fries" && t.provenance === "derived"),
    "an item-type collision must remain excluded, unchanged by the category fix");
});

// ---- Choice-vs-item surface-form collisions (2026-09-15 PO dispatch,
// extending the category fix above to rule 6 choice terms — Zio's 44,
// NJB 16, Vito's 39 suppressed head nouns) --------------------------------

Deno.test("lexicon surface forms: a trailing word-run colliding ONLY with an auto_single-mode CHOICE term is now written as an item term, one row per claimant (real Zio's/Vito's shape, e.g. 'bagel'/'rye')", () => {
  // group() defaults to a single choice with no default_choice_id set, which
  // deriveAskMode resolves to ask_mode "auto_single" — a slot the runner
  // fills automatically, never rendered as a question. This is the shape of
  // most of the 44/16/39 suppressed terms found in the live shops.
  const familyMeal = item({
    display_name: "Family Meal",
    category: "Combos",
    groups: [group({ slot_key: "extra", choices: [choice({ name: "Pizza" })] })],
  });
  assertEquals(familyMeal.groups[0].choices.length, 1, "sanity: single choice -> auto_single ask_mode");
  const tomatoPizza = item({ display_name: "Large Tomato Pizza", category: "Sides" }); // category noun != "pizza"
  const { items: compiled } = compileMenu([familyMeal, tomatoPizza], [], "t", false);
  const familyMealTerms = compiled.find(c => c.item_id === familyMeal.id)!.lexicon_terms;
  const tomatoPizzaTerms = compiled.find(c => c.item_id === tomatoPizza.id)!.lexicon_terms;

  assert(familyMealTerms.some(t => t.term === "pizza" && t.target_type === "choice" && t.provenance === "stated"),
    "the choice's own stated term must still exist, untouched");

  const derivedPizzaOnTomato = tomatoPizzaTerms.find(t => t.term === "pizza" && t.target_type === "item");
  assert(derivedPizzaOnTomato, "a choice-type collision must no longer block a derived item candidate");
  assertEquals(derivedPizzaOnTomato!.provenance, "derived");
  assertEquals(derivedPizzaOnTomato!.target_id, tomatoPizza.id);
});

Deno.test("lexicon surface forms: a trailing word-run colliding with an ask_mode:'ask' CHOICE term is now written as an item term, one row per claimant (real Zio's 'Choose Pasta' shape)", () => {
  // Modeled on Zio's actual rendered "Choose Pasta" question: six choices,
  // no default_choice_id -> deriveAskMode resolves to ask_mode "ask", a
  // real question customers see. This is the one REAL rendered-question
  // collision found live (the other 43+16+39 are all auto_single).
  const choosePasta = item({
    display_name: "Baked Ziti",
    category: "Entrees",
    groups: [group({
      slot_key: "pasta",
      choices: [
        choice({ name: "Fettuccine" }),
        choice({ name: "Rigatoni" }),
        choice({ name: "Penne" }),
        choice({ name: "Spaghetti" }),
        choice({ name: "Angel Hair" }),
        choice({ name: "Linguine" }),
      ],
    })],
  });
  assert(!choosePasta.groups[0].default_choice_id, "sanity: no default -> ask_mode 'ask'");
  const chickenPenne = item({ display_name: "Chicken Penne", category: "Entrees" });
  const { items: compiled } = compileMenu([choosePasta, chickenPenne], [], "t", false);
  const askPlanStep = compiled.find(c => c.item_id === choosePasta.id)!.ask_plan.steps
    .find(s => s.slot_key === "pasta")!;
  assertEquals(askPlanStep.ask_mode, "ask", "sanity: this is the real rendered-question shape");

  const choosePastaTerms = compiled.find(c => c.item_id === choosePasta.id)!.lexicon_terms;
  const chickenPenneTerms = compiled.find(c => c.item_id === chickenPenne.id)!.lexicon_terms;

  assert(choosePastaTerms.some(t => t.term === "penne" && t.target_type === "choice" && t.provenance === "stated"),
    "the choice's own stated term must still exist, untouched");

  const derivedPenneOnEntree = chickenPenneTerms.find(t => t.term === "penne" && t.target_type === "item");
  assert(derivedPenneOnEntree, "an ask_mode:'ask' choice collision must no longer block a derived item candidate");
  assertEquals(derivedPenneOnEntree!.provenance, "derived");
  assertEquals(derivedPenneOnEntree!.target_id, chickenPenne.id);
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

Deno.test("buildDerivedRows: row count — of 9 composable toppings, only the 4 on the standard single-topping list (Pepperoni, Sausage, Mushrooms, Onions) derive × 3 Neapolitan sizes = 12 rows (Bacon/Peppers/Hot Peppers/Roasted Red Peppers/Fresh Garlic do not; Sicilian single-size family is inferior)", () => {
  const { small, medium, large, sicilian, compiled } = buildTestMenu();
  const rows = buildDerivedRows([small, medium, large, sicilian], compiled, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 12);
  const toppingsDerived = new Set(rows.map(r => r.product_key));
  assertEquals(toppingsDerived, new Set(["pizza:pepperoni", "pizza:sausage", "pizza:mushrooms", "pizza:onions"]));
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

Deno.test("buildDerivedRows: cap — capPerSize still limits the standard-topping list (all 6 fit well under the default 40)", () => {
  // All 6 standard toppings present, none not_composable (unlike the shared
  // helper's NOT_COMPOSABLE_NAME special-case for "Extra Cheese") — default
  // cap (40) keeps all of them.
  const allStandardNames = ["Pepperoni", "Sausage", "Mushrooms", "Onions", "Green Peppers", "Extra Cheese"];
  const allStandardGroup: CompileGroup = {
    ...toppingsGroup([]),
    choices: allStandardNames.map((name, i) => ({
      id: `standard-choice-${i}`, name, display_name: name, price_cents: 300, is_default: false,
      provenance: "stated", not_composable: false,
    })),
  };
  const bigItem = pizzaItem({
    name: "Neapolitan Cheese Pizza - Large 18''",
    price_cents: 1799,
    size_label: "Large 18''",
    groups: [allStandardGroup],
  });
  const compiledBig = new Map([orderable(bigItem.id)]);
  const rows = buildDerivedRows([bigItem], compiledBig, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 6);

  // A tighter cap still truncates, in STANDARD_SINGLE_TOPPING_ORDER order
  // (pepperoni, sausage, mushroom, ...) — not source/insertion order.
  const capped = buildDerivedRows([bigItem], compiledBig, new Map(), T_COMPILED_AT, { capPerSize: 2 });
  assertEquals(capped.length, 2);
  assertEquals(new Set(capped.map(r => r.product_key)), new Set(["pizza:pepperoni", "pizza:sausage"]));
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
  // Only small and medium should produce rows (4 standard toppings × 2 = 8)
  assertEquals(rows.length, 8);
  const hasLarge = rows.some(r => r.entity_key.includes("large"));
  assertEquals(hasLarge, false);
});

// ============================================================
// buildDerivedRows — Vito's-shaped fixture (2026-09-19 PO dispatch, "pepperoni
// pizza" root cause): real Vito's data has a "Cheese" pizza item with a
// modifier group literally named "Toppings", slot_key NULL (owner_edited,
// never ran through archetypes.ts's bind_to_list_named classifier), 16
// toppings each with a not_composable=false "(Half pizza)" AND
// "(Whole pizza)" choice pair. Live probe 2026-09-19 confirmed both gaps:
// zero derived rows existed at all (slot_key gap), and a naive fix deriving
// from every composable choice would have produced a "Bacon (Half pizza)
// Pizza" beside "Bacon (Whole pizza) Pizza" for all 16 toppings.
// ============================================================

function vitosPortionChoice(base: string, portion: "half" | "whole", id: string): CompileGroup["choices"][0] {
  const portionLabel = portion === "half" ? "Half pizza" : "Whole pizza";
  const name = `${base} (${portionLabel})`;
  return {
    id, name, display_name: name,
    price_cents: portion === "half" ? 350 : 450,
    is_default: false, provenance: "owner_confirmed", not_composable: false,
  };
}

function vitosToppingsGroup(): CompileGroup {
  const toppingBases = ["Pepperoni", "Sausage", "Mushrooms", "Onions", "Green Peppers", "Steak", "Gyro Meat", "Bacon"];
  const choices = toppingBases.flatMap((base, i) => [
    vitosPortionChoice(base, "half", `vito-${i}-half`),
    vitosPortionChoice(base, "whole", `vito-${i}-whole`),
  ]);
  return {
    id: "vito-toppings-group", name: "Toppings", kind: "modifier", slot_key: null,
    min_select: 0, max_select: 32, kitchen_critical: false, price_critical: false,
    default_choice_id: null, ask_mode: null, provenance: "owner_confirmed", display_order: 0,
    choices,
  };
}

function vitosCheeseItem(overrides: Partial<CompileItem> & { name: string; price_cents: number; size_label: string | null }): CompileItem {
  return {
    id: `vito-item-${overrides.name.replace(/\W+/g, "-").toLowerCase()}`,
    display_name: overrides.name,
    category: "Pizza",
    active: true,
    price_provenance: "stated",
    product_key: null,
    missing_from_source_since: null,
    import_key: `vito-import-${overrides.name.replace(/\W+/g, "-").toLowerCase()}`,
    groups: [vitosToppingsGroup()],
    ...overrides,
  };
}

function buildVitosTestMenu() {
  const small = vitosCheeseItem({ name: "Cheese - Small (10\")", price_cents: 849, size_label: "Small (10\")" });
  const medium = vitosCheeseItem({ name: "Cheese - Medium (14\")", price_cents: 1250, size_label: "Medium (14\")" });
  const large = vitosCheeseItem({ name: "Cheese - Large (16\")", price_cents: 1650, size_label: "Large (16\")" });
  const compiled = new Map([orderable(small.id), orderable(medium.id), orderable(large.id)]);
  return { small, medium, large, compiled };
}

Deno.test("buildDerivedRows: Vito's shape — a 'Toppings' group with slot_key null still qualifies (name-pattern fallback)", () => {
  const { small, medium, large, compiled } = buildVitosTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  assert(rows.length > 0, "a null-slot_key group literally named 'Toppings' must still produce derived rows");
});

Deno.test("buildDerivedRows: Vito's shape — only the 5 standard toppings present (Pepperoni/Sausage/Mushrooms/Onions/Green Peppers) derive, not Steak/Gyro Meat/Bacon, × 3 sizes = 15 rows", () => {
  const { small, medium, large, compiled } = buildVitosTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  assertEquals(rows.length, 15);
  const productKeys = new Set(rows.map(r => r.product_key));
  assertEquals(productKeys, new Set(["pizza:pepperoni", "pizza:sausage", "pizza:mushrooms", "pizza:onions", "pizza:green peppers"]));
});

Deno.test("buildDerivedRows: Vito's shape — the derived Large Pepperoni Pizza uses the WHOLE-pizza price delta, not the half", () => {
  const { large, compiled } = buildVitosTestMenu();
  const rows = buildDerivedRows([large], compiled, new Map(), T_COMPILED_AT);
  const largePepp = rows.find(r => r.product_key === "pizza:pepperoni")!;
  assert(largePepp, "should have a large pepperoni derived row");
  assertEquals(largePepp.price_cents, 1650 + 450, "must use the (Whole pizza) $4.50 delta, not the (Half pizza) $3.50 one");
  assertEquals(largePepp.name, "Pepperoni Pizza - Large (16\")");
  assertEquals(largePepp.display_name, "Large Pepperoni Pizza");
  // Neither the row name nor its lexicon terms leak the "(Whole pizza)" qualifier.
  assert(!largePepp.name.includes("Whole"), "derived row name must not include the portion qualifier");
  for (const t of largePepp.lexicon_terms) assert(!t.term.includes("whole"), `lexicon term "${t.term}" must not include the portion qualifier`);
});

Deno.test("buildDerivedRows: Vito's shape — no 'Pepperoni (Half pizza) Pizza' or 'Pepperoni (Whole pizza) Pizza' row is ever produced, only one clean 'Pepperoni Pizza' per size", () => {
  const { small, medium, large, compiled } = buildVitosTestMenu();
  const rows = buildDerivedRows([small, medium, large], compiled, new Map(), T_COMPILED_AT);
  const pepperoniRows = rows.filter(r => r.product_key === "pizza:pepperoni");
  assertEquals(pepperoniRows.length, 3, "exactly one pepperoni derived row per size, not two (half + whole)");
  for (const r of pepperoniRows) {
    assert(!/half|whole/i.test(r.name), `row name "${r.name}" must not carry a half/whole qualifier`);
  }
});

Deno.test("buildDerivedRows: Vito's shape — lexicon carries a size-qualified term ('large pepperoni pizza') alongside the bare and unqualified terms", () => {
  const { large, compiled } = buildVitosTestMenu();
  const rows = buildDerivedRows([large], compiled, new Map(), T_COMPILED_AT);
  const largePepp = rows.find(r => r.product_key === "pizza:pepperoni")!;
  const terms = largePepp.lexicon_terms.map(t => t.term);
  assert(terms.includes("pepperoni pizza"), "bare '{topping} pizza' term");
  assert(terms.includes("pepperoni"), "bare topping term");
  assert(terms.includes("large pepperoni pizza"), "size-qualified '{size} {topping} pizza' term — needed because derived rows carry no size_label of their own");
});
