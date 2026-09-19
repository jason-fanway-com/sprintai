// 2026-09-19 PO dispatch — acceptance tests for the ambiguous-target hole in
// the replacement rule.
//
// Bug (sim #21, PO repro): cart = Sauteed Pierogies (5) + Grilled Cheese.
// "Hmm, actually can I change the Grilled Cheese to a Chicken Fingers (5)
// instead?" There are TWO Chicken Fingers items at Vito's — a (5) appetizer
// with fries and a (3) kids'-menu version — so the Y span is ambiguous.
// Broken behaviour: Grilled Cheese was removed (the remove side went through)
// and nothing was added (the ambiguous add was silently dropped), AND a stray
// "That item wasn't in your order." line appeared because PROPOSE also sent a
// `modifies` entry for the same line that was already removed.
//
// Fix: the replacement is one atomic unit. When Y is ambiguous, X is HELD
// (replacementHandledLineKey prevents PROPOSE's own remove/modify from
// touching it), the same narrowing-question machinery a plain ambiguous add
// uses is reused verbatim (disambiguationCandidateIds), and
// replacementSourceLineKey rides alongside so that once the customer answers
// the narrowing question, answer() removes X and adds Y atomically.
//
// These tests work at the decide() / answer() level (unit, no model call).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  decide,
  type DialogueState,
  type Proposal,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
} from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

// ── Menu and lexicon ──────────────────────────────────────────────────────────

const PIEROGIES_ID = "pierogies-0000-0000-0000-000000000000";
const GRILLED_CHEESE_ID = "grilled-ch-0000-0000-0000-000000000000";
// Vito's two Chicken Fingers items — same lexicon term, two distinct menu items.
const CF5_FRIES_ID = "cf5-fries--0000-0000-0000-000000000000"; // appetizer: (5) with fries
const CF3_KIDS_ID = "cf3-kids---0000-0000-0000-000000000000"; // kids': (3)

function askPlan(displayName: string, priceCents: number) {
  return {
    compiled_at: "", compiler_version: 1, display_name: displayName,
    base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [],
  };
}

const MENU: TurnEngineMenuItem[] = [
  { id: PIEROGIES_ID, name: "Sauteed Pierogies (5)", category: "Appetizers", price_cents: 895, bot_state: "orderable", ask_plan: askPlan("Sauteed Pierogies (5)", 895) },
  { id: GRILLED_CHEESE_ID, name: "Grilled Cheese", category: "Sandwiches", price_cents: 599, bot_state: "orderable", ask_plan: askPlan("Grilled Cheese", 599) },
  { id: CF5_FRIES_ID, name: "Chicken Fingers (5) with French Fries", category: "Appetizers", price_cents: 1095, bot_state: "orderable", ask_plan: askPlan("Chicken Fingers (5) with French Fries", 1095) },
  { id: CF3_KIDS_ID, name: "Chicken Fingers (3)", category: "Kids", price_cents: 649, bot_state: "orderable", ask_plan: askPlan("Chicken Fingers (3)", 649) },
];

const LEXICON: LexiconTerm[] = [
  { term: "sauteed pierogies", target_id: PIEROGIES_ID },
  { term: "grilled cheese", target_id: GRILLED_CHEESE_ID },
  // Both Chicken Fingers share the same term → ambiguous
  { term: "chicken fingers", target_id: CF5_FRIES_ID },
  { term: "chicken fingers", target_id: CF3_KIDS_ID },
];

function baseCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: PIEROGIES_ID, name: "Sauteed Pierogies (5)", quantity: 1, price_cents: 895, modifiers: [], line_key: "pierogies-line" },
    { menu_item_id: GRILLED_CHEESE_ID, name: "Grilled Cheese", quantity: 1, price_cents: 599, modifiers: [], line_key: "gc-line" },
  ];
}

// ── Turn 1: ambiguous Y — X held, narrowing question opened ──────────────────

Deno.test("sim #21 turn 1: 'change the Grilled Cheese to Chicken Fingers (5)' with ambiguous target — GC held in cart, narrowing question opened, no false decline", () => {
  const cart = baseCart();
  // PROPOSE's likely output for this message: remove Grilled Cheese + add Chicken Fingers
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "Chicken Fingers (5)", quantity: 1, choices: [] }],
    removes: [{ line_key: "gc-line" }],
    modifies: [],
  };
  const result = decide(
    proposal, cart, MENU, LEXICON, () => "cf-line",
    "Hmm, actually can I change the Grilled Cheese to a Chicken Fingers (5) instead?",
  );

  // Cart is untouched — X held while Y is ambiguous
  assertEquals(result.cart.filter(l => l.menu_item_id === GRILLED_CHEESE_ID).length, 1, "Grilled Cheese must still be in the cart");
  assertEquals(result.cart.filter(l => l.menu_item_id === PIEROGIES_ID).length, 1, "Sauteed Pierogies must be untouched");
  assertEquals(result.cart.filter(l => l.menu_item_id === CF5_FRIES_ID).length, 0, "CF5 must not be added yet");
  assertEquals(result.cart.filter(l => l.menu_item_id === CF3_KIDS_ID).length, 0, "CF3 must not be added yet");
  assertEquals(result.cart.length, 2, "cart must have exactly 2 lines");

  // Narrowing question is open
  assert(result.disambiguationCandidateIds !== null, "a narrowing question must be opened for the ambiguous target");
  assert(
    result.disambiguationCandidateIds!.includes(CF5_FRIES_ID) && result.disambiguationCandidateIds!.includes(CF3_KIDS_ID),
    "both Chicken Fingers candidates must be in the disambiguation list",
  );

  // replacementSourceLineKey threads GC's key through so turn 2 knows what to remove
  assertEquals(result.replacementSourceLineKey, "gc-line", "replacementSourceLineKey must be GC's line_key");

  // No false "That item wasn't in your order." decline — GC is still in the cart
  assert(
    !result.declines.some(d => d.reason.includes("wasn't in your order")),
    `no false-decline line must appear — got: ${result.declines.map(d => d.reason).join("; ")}`,
  );
});

// ── Turn 1 variant: PROPOSE also sends a modifies entry for GC ───────────────

Deno.test("sim #21 — PROPOSE modifies[gc-line] alongside the replacement: no 'wasn't in your order' line from the modifies loop", () => {
  const cart = baseCart();
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "Chicken Fingers (5)", quantity: 1, choices: [] }],
    removes: [{ line_key: "gc-line" }],
    // Stray modify for the same line — real model behaviour observed in sim #21
    modifies: [{ line_key: "gc-line", quantity: 1, choices: [] }],
  };
  const result = decide(
    proposal, cart, MENU, LEXICON, () => "cf-line",
    "Hmm, actually can I change the Grilled Cheese to a Chicken Fingers (5) instead?",
  );

  assert(
    !result.declines.some(d => d.reason.includes("wasn't in your order")),
    `modifies loop must skip GC (held by replacement) — stray false decline: ${result.declines.map(d => d.reason).join("; ")}`,
  );
  // GC still in cart, not modified
  assertEquals(result.cart.filter(l => l.menu_item_id === GRILLED_CHEESE_ID).length, 1);
});

// ── Turn 2: customer answers the narrowing question — swap executes ───────────

Deno.test("sim #21 turn 2: 'the one with fries' resolves CF5, removes GC, leaves Pierogies untouched", () => {
  // Reconstruct the cart as decide() left it after turn 1 (GC still in)
  const cart = baseCart();

  // Dialogue state after ask() opened the disambiguation question in turn 1
  const state: DialogueState = {
    phase: "ordering",
    open: {
      kind: "disambiguation",
      candidates: [CF5_FRIES_ID, CF3_KIDS_ID],
      quantity: 1,
      spanText: "Chicken Fingers (5) instead",
      replacementSourceLineKey: "gc-line",
    },
    upsell_offered: false,
    asked_message_id: null,
  };

  const result = answer(state, cart, "the one with fries", MENU);

  assert(result.resolved, "answer must resolve");
  assertEquals(result.outcome.kind, "disambiguation_resolved");
  if (result.outcome.kind === "disambiguation_resolved") {
    assertEquals(result.outcome.menuItemId, CF5_FRIES_ID, "must resolve to the Chicken Fingers (5) with French Fries");
  }
  assert(result.cartChanged, "cart must have changed (Y added, X removed)");

  // Swap is atomic: Y in, X out
  assertEquals(cart.filter(l => l.menu_item_id === CF5_FRIES_ID).length, 1, "Chicken Fingers (5) with French Fries must be in the cart");
  assertEquals(cart.filter(l => l.menu_item_id === GRILLED_CHEESE_ID).length, 0, "Grilled Cheese must be gone");
  assertEquals(cart.filter(l => l.menu_item_id === PIEROGIES_ID).length, 1, "Sauteed Pierogies must be untouched");
  assertEquals(cart.length, 2, "cart must have exactly 2 lines after the swap");
});

// ── Regression: false "wasn't in your order" on a clean resolved swap ─────────
// sim #46 and sim #12 are already covered in
// remove-guard-pronoun-replacement-20260919.test.ts. This test pins that the
// modifies-loop guard (added alongside the removes-loop guard) does not break
// a cleanly-resolved replacement when PROPOSE sends a modifies entry.

Deno.test("regression: 'switch that to a Cheesesteak' where PROPOSE also modifies the swapped-out line — no false decline, swap still executes", () => {
  const SLICE_ID = "slice-001-0000-0000-0000-000000000000";
  const STEAK_ID = "steak-001-0000-0000-0000-000000000000";
  const sliceMenu: TurnEngineMenuItem[] = [
    { id: SLICE_ID, name: "The Slice", category: "Sandwiches", price_cents: 899, bot_state: "orderable", ask_plan: askPlan("The Slice", 899) },
    { id: STEAK_ID, name: "Cheesesteak", category: "Sandwiches", price_cents: 999, bot_state: "orderable", ask_plan: askPlan("Cheesesteak", 999) },
  ];
  const sliceLexicon: LexiconTerm[] = [
    { term: "the slice", target_id: SLICE_ID },
    { term: "cheesesteak", target_id: STEAK_ID },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: SLICE_ID, name: "The Slice", quantity: 1, price_cents: 899, modifiers: [], line_key: "slice-line" },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [],
    removes: [{ line_key: "slice-line" }],
    modifies: [{ line_key: "slice-line", quantity: 1, choices: [] }],
  };
  const result = decide(
    proposal, cart, sliceMenu, sliceLexicon, () => "steak-line",
    "I want to switch that to a Cheesesteak instead",
  );

  // Swap happened cleanly
  assertEquals(result.cart.filter(l => l.menu_item_id === SLICE_ID).length, 0, "The Slice must be gone");
  assertEquals(result.cart.filter(l => l.menu_item_id === STEAK_ID).length, 1, "one Cheesesteak must be in the cart");
  assertEquals(result.cart.length, 1);
  assert(
    !result.declines.some(d => d.reason.includes("wasn't in your order")),
    `no false-decline from the modifies loop — got: ${result.declines.map(d => d.reason).join("; ")}`,
  );
});
