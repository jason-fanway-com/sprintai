// X3 addon-decline follow-up (2026-09-20), live repro v580, real Vito's data:
// Customer: "House - Personal calzone ... can I get a chicken add-on for
// that too?" -> bot asked the House/Calzone naming question (X3's own
// e079000c fix working correctly) but never declined the chicken add-on,
// on THIS turn or on the customer's next bare follow-up ("and the chicken
// add-on?") once the item was confirmed into the cart. Two separate, real
// gaps in the X3 follow-up's own two mechanisms:
//
// Gap A (findFreshAddCategoryMismatch / findFreshAddSiblingNameMismatch,
// turn-engine.ts): when PROPOSE folds an add-on request directly onto the
// SAME add whose item_span ALSO collides on naming (the exact "House -
// Personal calzone" shape), the naming-collision hold's own `continue`
// (categoryMismatchPending) runs BEFORE the 00-BF modifier floor a few
// hundred lines below ever gets a chance to decline the add-on — the
// add-on is silently discarded with the hold's own `continue`, never
// declined, never mentioned again. Confirmed via direct decide() probing:
// identical `choices` on an add with NO naming collision correctly
// declines; the ONLY difference that suppresses the decline is the
// naming-collision hold intervening first.
//
// Gap B (findAnaphoricAddOnTargetWithNoModifiers's own referent regex):
// the existing X3 mechanism only recognized a demonstrative pointer ("for/
// to/on that/it/this"). A customer's real bare follow-up, once the item is
// already confirmed into the cart, just as often has no pointer at all
// ("and the chicken add-on?") — the referent regex missed this shape
// entirely and the request fell through to an ordinary (and, on the real
// 50+-chicken-item menu, silently unopened) ambiguous tie instead of the
// spoken decline the PO's own rule requires on "any follow-up."
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ask, decide, render, type AskShopContext, type AskTurnEvents, type DialogueState, type Proposal, type TurnEngineMenuItem } from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const HOUSE_PERSONAL_ID = "house-personal-stromboli";
const CALZONE_PERSONAL_ID = "calzone-personal-stromboli";
const CAJUN_CHICKEN_SALAD_ID = "cajun-chicken-salad";
const BUFFALO_CHICKEN_WRAP_ID = "buffalo-chicken-wrap";

// Same real-menu shape as house-calzone-naming-and-invalid-addon-decline-
// 20260920.test.ts (X3's own fixture) — two distinct, real, zero-modifier
// "<Type> - <Size>" Stromboli siblings, plus enough real "chicken" items to
// make a bare "chicken" span genuinely ambiguous.
const MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_PERSONAL_ID, name: "House - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Personal House Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CALZONE_PERSONAL_ID, name: "Calzone - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Personal Calzone Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CAJUN_CHICKEN_SALAD_ID, name: "Cajun Chicken", category: "Salads", price_cents: 995, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cajun Chicken", base_price_cents: 995, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: BUFFALO_CHICKEN_WRAP_ID, name: "Buffalo Chicken", category: "Wraps", price_cents: 895, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Buffalo Chicken Wrap", base_price_cents: 895, recap_template: "", ticket_template: "", steps: [] },
  },
];

const LEXICON: LexiconTerm[] = [
  { term: "house", target_id: HOUSE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "calzone", target_id: CALZONE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "personal calzone", target_id: CALZONE_PERSONAL_ID, category: "Stromboli", size_label: "Personal" },
  { term: "chicken", target_id: CAJUN_CHICKEN_SALAD_ID, category: "Salads" },
  { term: "chicken", target_id: BUFFALO_CHICKEN_WRAP_ID, category: "Wraps" },
];

const SHOP_CONTEXT: AskShopContext = {
  deliveryEnabled: false, orderTypeKnown: true, orderTypeIsDelivery: false,
  deliveryAddressKnown: true, upsellEnabled: false, pickupNameKnown: true,
} as unknown as AskShopContext;

function turnEventsFromDecide(result: ReturnType<typeof decide>): AskTurnEvents {
  return {
    qualifyingAddMenuItemId: result.qualifyingAddMenuItemId,
    disambiguationCandidateIds: result.disambiguationCandidateIds,
    disambiguationQuantity: result.disambiguationQuantity,
    disambiguationSpanText: result.disambiguationSpanText,
    carriedDisambiguationCandidateIds: result.carriedDisambiguationCandidateIds,
    heldModifierText: result.heldModifierText,
    replacementSourceLineKey: result.replacementSourceLineKey,
    categoryMismatchPending: result.categoryMismatchPending,
  } as unknown as AskTurnEvents;
}

// ── Gap A: add-on folded onto the SAME add as a naming collision ─────────

Deno.test("decide (X3 addon-decline follow-up, gap A): sibling-name collision AND an add-on request on the SAME add — both the decline and the naming question fire", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "House - Personal calzone", quantity: 1, choices: [{ group_id: "bogus-addon-group", choice_id: "chicken" }] },
    ],
    removes: [], modifies: [],
  };
  const message = "House - Personal calzone ... can I get a chicken add-on for that too?";
  const result = decide(proposal, [], MENU, LEXICON, undefined, message);
  assertEquals(result.cart.length, 0, `item must still be held, not silently added: ${JSON.stringify(result.cart)}`);
  assertEquals(result.declines, [{ reason: "The Personal Calzone Stromboli doesn't take add-ons." }]);
  assertEquals(result.categoryMismatchPending, {
    menu_item_id: CALZONE_PERSONAL_ID,
    quantity: 1,
    message: "We have both House and Calzone as a personal stromboli — added the Calzone one. Keep it, or take it off?",
  });
});

Deno.test("decide (X3 addon-decline follow-up, gap A regression): the SAME choices with no naming collision still decline exactly as before (ff729ce4 unaffected)", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "Calzone - Personal", quantity: 1, choices: [{ group_id: "bogus-addon-group", choice_id: "chicken" }] },
    ],
    removes: [], modifies: [],
  };
  const message = "Calzone - Personal, and can I get a chicken add-on for that too?";
  const result = decide(proposal, [], MENU, LEXICON, undefined, message);
  assertEquals(result.categoryMismatchPending, null);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, CALZONE_PERSONAL_ID);
  assertEquals(result.declines, [{ reason: "The Personal Calzone Stromboli doesn't take add-ons." }]);
});

Deno.test("decide (X3 addon-decline follow-up, gap A regression): a naming collision with NO add-on request still holds silently, no phantom decline", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "House - Personal calzone", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], MENU, LEXICON, undefined, "House - Personal calzone");
  assertEquals(result.declines, [], "no add-on was ever asked for -- must not invent one");
  assertEquals(result.categoryMismatchPending?.menu_item_id, CALZONE_PERSONAL_ID);
});

Deno.test("render (X3 addon-decline follow-up, gap A end-to-end): full decide+ask+render for the ORIGINAL live turn 1 says the decline AND asks the naming question", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "House - Personal calzone", quantity: 1, choices: [{ group_id: "bogus-addon-group", choice_id: "chicken" }] },
    ],
    removes: [], modifies: [],
  };
  const message = "House - Personal calzone ... can I get a chicken add-on for that too?";
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const result = decide(proposal, [], MENU, LEXICON, undefined, message);
  const nextState = ask([], priorState, turnEventsFromDecide(result), SHOP_CONTEXT, MENU);
  const rendered = render([], result.cart, nextState, result.declines, MENU, {});
  assertEquals(
    rendered.startsWith(
      "The Personal Calzone Stromboli doesn't take add-ons.\n\nWe have both House and Calzone as a personal stromboli — added the Calzone one. Keep it, or take it off?",
    ),
    true,
    `both the decline and the naming question must be said together: ${rendered}`,
  );
});

// ── Gap B: bare add-on follow-up with no demonstrative pointer ───────────

Deno.test("decide (X3 addon-decline follow-up, gap B): 'and the chicken add-on?' against an item already in the cart declines, no pointer word needed", () => {
  const cart = [{ menu_item_id: CALZONE_PERSONAL_ID, quantity: 1, name: "Personal Calzone Stromboli", price_cents: 1295, ask_plan_selections: {} }];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken add-on", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const message = "and the chicken add-on?";
  const result = decide(proposal, cart as never, MENU, LEXICON, undefined, message);
  assertEquals(result.disambiguationCandidateIds, null, "must not open a menu-wide chicken disambiguation");
  assertEquals(result.declines, [{ reason: "The Personal Calzone Stromboli doesn't take add-ons." }]);
});

Deno.test("decide (X3 addon-decline follow-up, gap B regression): the SAME bare phrasing with an extra clause after the add-on still opens the real disambiguation, unchanged", () => {
  const cart = [{ menu_item_id: CALZONE_PERSONAL_ID, quantity: 1, name: "Personal Calzone Stromboli", price_cents: 1295, ask_plan_selections: {} }];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken add-on", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const message = "and the chicken add-on for my second pizza?";
  const result = decide(proposal, cart as never, MENU, LEXICON, undefined, message);
  assertEquals(result.declines, [], "trailing clause names something else -- must not auto-decline");
  assertEquals(
    [...(result.disambiguationCandidateIds ?? [])].sort(),
    [BUFFALO_CHICKEN_WRAP_ID, CAJUN_CHICKEN_SALAD_ID].sort(),
  );
});

Deno.test("render (X3 addon-decline follow-up, gap B end-to-end): full decide+ask+render for the ISOLATED follow-up case says the decline, not a bare 'Anything else?'", () => {
  const cart = [{ menu_item_id: CALZONE_PERSONAL_ID, quantity: 1, name: "Personal Calzone Stromboli", price_cents: 1295, ask_plan_selections: {} }];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken add-on", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const message = "and the chicken add-on?";
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const result = decide(proposal, cart as never, MENU, LEXICON, undefined, message);
  const nextState = ask(cart as never, priorState, turnEventsFromDecide(result), SHOP_CONTEXT, MENU);
  const rendered = render(cart as never, result.cart, nextState, result.declines, MENU, {});
  assertEquals(
    rendered.startsWith("The Personal Calzone Stromboli doesn't take add-ons.\n\nAnything else?"),
    true,
    `must speak the decline, not a bare "Anything else?": ${rendered}`,
  );
});
