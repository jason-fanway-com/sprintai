// M2 (2026-09-19 PO dispatch, TOP PRIORITY money bug, live conv d3539d12
// #5, real $91.30 overcharge including items the customer explicitly asked
// to have removed): a which-one list was open for "cheese pizza" (the
// sizes — real Vito's Cheese Pizza prices, same fixture shape
// pending-disambiguation.test.ts's SIZE_ONLY_CANDIDATES already uses: Small
// $12.95, Medium $14.99, Large $16.50). The customer answered "Please
// remove that small Pepperoni pizza. I want to stick with 2 Large
// Pepperoni pizzas, 2 Chicken Alfredo with linguine, and 1 Bleu Cheese."
//
// Confirmed offline (probe-narrow2) BEFORE this fix:
//   probe-narrow2 "cheese pizza" 1 "Please remove that small Pepperoni
//     pizza. I want to stick with 2 Large Pepperoni pizzas, 2 Chicken
//     Alfredo with linguine, and 1 Bleu Cheese."
//     -> disambiguation_resolved, CART: 1x Small Cheese Pizza $12.95
//
// The word "small" in "remove that small Pepperoni pizza" stem-matched the
// open list's Small Cheese Pizza candidate via resolvePendingDisambiguation's
// own category+name-narrowing tier (runCategoryNarrowingTier ->
// nameWordMatches, pending-disambiguation.ts) and got read as the
// customer's PICK — completely ignoring that the sentence opens with a
// removal verb against an item ALREADY IN THE CART, and restates an
// entirely different order. Root cause and fix: isDisambiguationAnswerRemovalRequest
// (pending-disambiguation.ts) is now checked in turn-engine.ts's answer()
// "disambiguation" case BEFORE any candidate-name/size matching tier runs —
// the exact same "checked first" discipline isPendingDisambiguationDeclined
// already gets for its own, different escape hatch (a decline) — and, when
// it fires, applies the removal against the real cart via
// applyNamedLineRemovals (the same primitive the order_type/confirm cases
// already trust for "no stromboli"-shaped removals) instead of ever
// treating the message as an answer to the open question.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
} from "./turn-engine.ts";

function m2MenuItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const M2_CHEESE_SMALL_ID = "m2-cheese-small";
const M2_CHEESE_MEDIUM_ID = "m2-cheese-medium";
const M2_CHEESE_LARGE_ID = "m2-cheese-large";
const M2_PEPPERONI_SMALL_ID = "m2-pepperoni-small";

// Real Vito's Cheese Pizza sizes/prices (same numbers as
// pending-disambiguation.test.ts's SIZE_ONLY_CANDIDATES) plus the real
// Small Pepperoni Pizza price ($17.45) already established for this same
// live customer/order a few turns earlier in turn-engine.test.ts's own
// QTY_PEPPERONI_MENU (conv 009de656 — the identical restated order, "2
// Large Pepperoni pizzas, 2 Chicken Alfredo with linguine, 1 Bleu Cheese").
const M2_MENU: TurnEngineMenuItem[] = [
  m2MenuItem(M2_CHEESE_SMALL_ID, 'Cheese - Small (10")', "Pizza", 1295),
  m2MenuItem(M2_CHEESE_MEDIUM_ID, 'Cheese - Medium (14")', "Pizza", 1499),
  m2MenuItem(M2_CHEESE_LARGE_ID, 'Cheese - Large (16")', "Pizza", 1650),
  m2MenuItem(M2_PEPPERONI_SMALL_ID, 'Pepperoni Pizza - Small (10")', "Pizza", 1745),
];

const M2_CHEESE_OPEN_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "disambiguation", candidates: [M2_CHEESE_SMALL_ID, M2_CHEESE_MEDIUM_ID, M2_CHEESE_LARGE_ID], quantity: 1 },
  upsell_offered: false,
  asked_message_id: null,
};

const M2_REMOVE_MESSAGE =
  "Please remove that small Pepperoni pizza. I want to stick with 2 Large Pepperoni pizzas, " +
  "2 Chicken Alfredo with linguine, and 1 Bleu Cheese.";

function m2PepperoniCartLine(): TurnEngineCartLine {
  return {
    menu_item_id: M2_PEPPERONI_SMALL_ID, name: 'Pepperoni Pizza - Small (10")',
    quantity: 1, price_cents: 1745, modifiers: [], options: {}, ask_plan_selections: {},
  };
}

// ── Acceptance 1 + 3: the exact repro — removal recognized, NEVER a list
// pick, and the real matching cart line is actually taken off ─────────────

Deno.test("M2 (real repro, conv d3539d12 #5): 'remove that small Pepperoni pizza' while the cheese-pizza which-one is open never resolves as a Small Cheese Pizza pick, and actually removes the matching cart line", () => {
  const cart: TurnEngineCartLine[] = [m2PepperoniCartLine()];
  const cartBefore = cart.map(l => ({ ...l }));

  const result = answer(M2_CHEESE_OPEN_STATE, cart, M2_REMOVE_MESSAGE, M2_MENU);

  assert(result.resolved, `expected a resolved (removal) outcome, got unresolved: ${JSON.stringify(result)}`);
  assert(
    result.resolved && result.outcome.kind === "disambiguation_removal_applied",
    `expected disambiguation_removal_applied, got: ${JSON.stringify(result.resolved ? result.outcome : null)} -- ` +
      `BEFORE this fix this was "disambiguation_resolved" with menuItemId ${M2_CHEESE_SMALL_ID} (the wrong $12.95 Small Cheese Pizza pick)`,
  );
  assert(
    result.resolved && result.outcome.kind === "disambiguation_removal_applied" && result.outcome.removed,
    "the Small Pepperoni Pizza line was genuinely in the cart and must be reported as removed",
  );

  // Never a Small Cheese Pizza pick, at any price, anywhere in the cart.
  assert(
    !cart.some(l => l.menu_item_id === M2_CHEESE_SMALL_ID),
    `Small Cheese Pizza must never land in the cart: BEFORE=${JSON.stringify(cartBefore)} AFTER=${JSON.stringify(cart)}`,
  );

  // The actual removal: the Small Pepperoni Pizza line is gone.
  assertEquals(
    cart.length, 0,
    `BEFORE=${JSON.stringify(cartBefore)} (1x Small Pepperoni Pizza $17.45) AFTER=${JSON.stringify(cart)} (expected empty — the line was removed, nothing else was added)`,
  );
});

// ── Acceptance 2: a genuine size-word answer with NO removal language is a
// completely unaffected regression — still resolves as the pick ──────────

Deno.test("M2 regression: 'small please' (no removal language) while the cheese-pizza which-one is open still resolves as the Small Cheese Pizza pick, unchanged", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(M2_CHEESE_OPEN_STATE, cart, "small please", M2_MENU);
  assert(
    result.resolved && result.outcome.kind === "disambiguation_resolved",
    `expected disambiguation_resolved, got: ${JSON.stringify(result.resolved ? result.outcome : null)}`,
  );
  assertEquals(result.resolved && result.outcome.kind === "disambiguation_resolved" ? result.outcome.menuItemId : null, M2_CHEESE_SMALL_ID);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, M2_CHEESE_SMALL_ID);
});

Deno.test("M2 regression: 'the small one' (no removal language) while the cheese-pizza which-one is open still resolves as the Small Cheese Pizza pick, unchanged", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(M2_CHEESE_OPEN_STATE, cart, "the small one", M2_MENU);
  assert(result.resolved && result.outcome.kind === "disambiguation_resolved");
  assertEquals(result.resolved && result.outcome.kind === "disambiguation_resolved" ? result.outcome.menuItemId : null, M2_CHEESE_SMALL_ID);
});

// ── Acceptance 4: "remove X" naming something NOT in the cart declines
// gracefully — no error, and the which-one list is never silently resolved
// as a pick either ──────────────────────────────────────────────────────

Deno.test("M2: 'remove that small Pepperoni pizza' with an EMPTY cart (nothing to remove) declines gracefully -- no error, no silent list-pick", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(M2_CHEESE_OPEN_STATE, cart, M2_REMOVE_MESSAGE, M2_MENU);

  assert(result.resolved, `expected a resolved (removal-attempted) outcome, got unresolved: ${JSON.stringify(result)}`);
  assert(
    result.resolved && result.outcome.kind === "disambiguation_removal_applied",
    `expected disambiguation_removal_applied even when nothing matched, got: ${JSON.stringify(result.resolved ? result.outcome : null)}`,
  );
  assert(
    result.resolved && result.outcome.kind === "disambiguation_removal_applied" && result.outcome.removed === false,
    "nothing was in the cart to remove -- reported as removed:false, same graceful no-op contract applyNamedLineRemovals already has everywhere else it's called",
  );
  assertEquals(result.cartChanged, false, "no cart mutation when nothing matched");
  // The critical regression this whole fix exists to prevent: never falls
  // through to a candidate pick just because the removal found no target.
  assertEquals(cart.length, 0, "the Small Cheese Pizza must never be silently added just because there was nothing to remove");
});
