// X3 follow-up (2026-09-20), live repro v575, real Vito's data:
// Customer: "I'd like to try the House - Personal calzone, please. Oh, and
// can I get a chicken add-on for that too?"
// Live result: "Personal Calzone Stromboli added. Sure - what kind?" —
// "House" silently dropped resolving the item name (gap 1), AND "chicken
// add-on" opened a narrowing/disambiguation question instead of a clean
// decline (gap 2). Confirmed against real menu_items rows: "Calzone -
// Personal" and "House - Personal" are two distinct, real, separately-priced
// Stromboli items (product_key stromboli:calzone / stromboli:house), both
// with zero modifier groups (ask_plan.steps === []), and the shop's menu
// carries 50+ real items containing "chicken" — see turn-engine.ts's own
// findFreshAddSiblingNameMismatch / findAnaphoricAddOnTargetWithNoModifiers
// headers for the full analysis.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decide, type Proposal, type TurnEngineMenuItem } from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const HOUSE_PERSONAL_ID = "house-personal-stromboli";
const CALZONE_PERSONAL_ID = "calzone-personal-stromboli";
const HOUSE_16_ID = "house-16-stromboli";
const CHICKEN_PARM_PERSONAL_ID = "chicken-parm-personal-stromboli";
const CAJUN_CHICKEN_SALAD_ID = "cajun-chicken-salad";
const BUFFALO_CHICKEN_WRAP_ID = "buffalo-chicken-wrap";
const SIDE_SALAD_ID = "side-salad";

// Mirrors the real shop's own naming convention ("<Type> - <Size>") for
// every sized Stromboli item — confirmed against real menu_items rows.
const MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_PERSONAL_ID, name: "House - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Personal House Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CALZONE_PERSONAL_ID, name: "Calzone - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Personal Calzone Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  },
  // Control: a same-TYPE, different-size House sibling — must never be
  // treated as a naming-collision candidate (size half differs).
  {
    id: HOUSE_16_ID, name: "House - 16\"", category: "Stromboli", price_cents: 2295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "16\" House Stromboli", base_price_cents: 2295, recap_template: "", ticket_template: "", steps: [] },
  },
  // Real "chicken" items on the menu — enough to make "chicken" genuinely
  // ambiguous when resolved bare, same shape as Vito's real 50+-item tie.
  {
    id: CHICKEN_PARM_PERSONAL_ID, name: "Chicken Parmesan - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Personal Chicken Parmesan Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "",
      steps: [{ group_id: "g1", slot_key: null, kind: "modifier", ask_mode: "on_request", prompt_template: "add-ons.on_request", choices: [{ id: "c1", display: "Extra Cheese", price_delta_cents: 0 }] }],
    },
  },
  {
    id: CAJUN_CHICKEN_SALAD_ID, name: "Cajun Chicken", category: "Salads", price_cents: 995, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cajun Chicken", base_price_cents: 995, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: BUFFALO_CHICKEN_WRAP_ID, name: "Buffalo Chicken", category: "Wraps", price_cents: 895, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Buffalo Chicken Wrap", base_price_cents: 895, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: SIDE_SALAD_ID, name: "Side Salad", category: "Appetizers", price_cents: 495, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Side Salad", base_price_cents: 495, recap_template: "", ticket_template: "", steps: [] },
  },
];

// Mirrors the real, live lexicon rows for these exact items (fetched
// 2026-09-20): "house" ties across BOTH House sizes with no multi-word
// qualifier of its own, while "personal calzone" is a real, longer,
// two-word term that resolveItem's own longestMatch prefers over the
// shorter "house" tie — this is WHY the real repro resolves uniquely to
// Calzone - Personal instead of tying, exactly like acceptance 1's own
// "house"-ties-then-narrows-by-size shape one level up.
const LEXICON: LexiconTerm[] = [
  { term: "house", target_id: HOUSE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "house", target_id: HOUSE_16_ID, category: "Stromboli", size_label: "16\"" },
  { term: "calzone", target_id: CALZONE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "personal calzone", target_id: CALZONE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "chicken parmesan", target_id: CHICKEN_PARM_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "chicken", target_id: CAJUN_CHICKEN_SALAD_ID, category: "Salads" },
  { term: "chicken", target_id: BUFFALO_CHICKEN_WRAP_ID, category: "Wraps" },
  { term: "side salad", target_id: SIDE_SALAD_ID, category: "Appetizers" },
];

// ── Gap 1: sibling naming collision ─────────────────────────────────────

Deno.test("decide (X3 follow-up, gap 1): 'House - Personal calzone' resolves to Calzone but holds it back with a naming-collision question naming BOTH real items", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "House - Personal calzone", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], MENU, LEXICON, undefined, "House - Personal calzone");
  assertEquals(result.cart.length, 0, `item must NOT be silently added: ${JSON.stringify(result.cart)}`);
  assertEquals(result.categoryMismatchPending, {
    menu_item_id: CALZONE_PERSONAL_ID,
    quantity: 1,
    message: "We have both House and Calzone as a personal stromboli — added the Calzone one. Keep it, or take it off?",
  });
});

Deno.test("decide (X3 follow-up, gap 1 regression): a plain 'Calzone - Personal' order with no collision word adds normally, no question", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "Calzone - Personal", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], MENU, LEXICON, undefined, "Calzone - Personal");
  assertEquals(result.categoryMismatchPending, null);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, CALZONE_PERSONAL_ID);
});

Deno.test("decide (X3 follow-up, gap 1 regression): a different sized-item sharing the same category/size but naming neither sibling's own type word is untouched", () => {
  // "Chicken Parmesan - Personal" shares its category (Stromboli) and size
  // (Personal) with BOTH House - Personal and Calzone - Personal, but the
  // customer's own words never contain either sibling's own type word
  // ("house"/"calzone") -- only a genuine outside qualifier word triggers
  // the collision question, never merely sharing a category+size with
  // other items on the menu.
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "Chicken Parmesan - Personal", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], MENU, LEXICON, undefined, "Chicken Parmesan - Personal");
  assertEquals(result.categoryMismatchPending, null, "no stray collision word present -- must add normally");
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, CHICKEN_PARM_PERSONAL_ID);
});

// ── Gap 2: anaphoric add-on request on a no-modifier item ───────────────

Deno.test("decide (X3 follow-up, gap 2): 'a chicken add-on for that too' declines instead of opening a menu-wide 'which one?' question", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "House - Personal", quantity: 1, choices: [] },
      { item_span: "chicken add-on", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const message = "I'd like to try the House - Personal, please. Oh, and can I get a chicken add-on for that too?";
  const result = decide(proposal, [], MENU, LEXICON, undefined, message);
  assertEquals(result.cart.length, 1, `the House stromboli itself must still land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, HOUSE_PERSONAL_ID);
  assertEquals(result.disambiguationCandidateIds, null,
    `must never open a menu-wide chicken disambiguation — got ${JSON.stringify(result.disambiguationCandidateIds)}`);
  assertEquals(result.declines, [{ reason: "The Personal House Stromboli doesn't take add-ons." }]);
});

Deno.test("decide (X3 follow-up, gap 2): the same anaphoric add-on phrase against an EXISTING cart line (no fresh add this turn) still declines", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken add-on", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const cart = [{ menu_item_id: HOUSE_PERSONAL_ID, quantity: 1, name: "Personal House Stromboli", price_cents: 1295, ask_plan_selections: {} }];
  const message = "can I get a chicken add-on for that too?";
  const result = decide(proposal, cart as never, MENU, LEXICON, undefined, message);
  assertEquals(result.disambiguationCandidateIds, null);
  assertEquals(result.declines, [{ reason: "The Personal House Stromboli doesn't take add-ons." }]);
});

Deno.test("decide (X3 follow-up, gap 2 regression): a genuine standalone chicken order (no anaphoric wording) still opens the real disambiguation", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], MENU, LEXICON, undefined, "can I also get a chicken");
  assertEquals(result.declines, [], "must not be declined -- this is a genuine new-item request");
  assertEquals(
    [...(result.disambiguationCandidateIds ?? [])].sort(),
    [BUFFALO_CHICKEN_WRAP_ID, CAJUN_CHICKEN_SALAD_ID].sort(),
    `a real standalone chicken order must still tie normally, got ${JSON.stringify(result.disambiguationCandidateIds)}`,
  );
});

Deno.test("decide (X3 follow-up, gap 2 regression): an anaphoric add-on phrase targeting an item that DOES have real modifier groups still opens disambiguation, unchanged", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "Chicken Parmesan - Personal", quantity: 1, choices: [] },
      { item_span: "chicken add-on", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const message = "I'd like the Chicken Parmesan - Personal, and can I get a chicken add-on for that too?";
  const result = decide(proposal, [], MENU, LEXICON, undefined, message);
  assertEquals(
    [...(result.disambiguationCandidateIds ?? [])].sort(),
    [BUFFALO_CHICKEN_WRAP_ID, CAJUN_CHICKEN_SALAD_ID].sort(),
    `target item has real modifier groups -- this gap's decline must not fire, got ${JSON.stringify(result)}`,
  );
});
