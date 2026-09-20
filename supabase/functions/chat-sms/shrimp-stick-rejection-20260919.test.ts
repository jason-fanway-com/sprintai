// PO dispatch (2026-09-19), MONEY BUG, live conv 087abb8d (#41), now also
// confirmed deterministic offline on HEAD via probe-narrow2.
//
// A which-one list was open for "shrimp" (Southwest Shrimp wrap / Boom Boom
// Shrimp) and the customer declined it outright: "I didn't ask for any of
// those! Just the order I gave you. Let's stick to that, thanks!" error_log
// shows NO propose (model) call for that turn — the bug is entirely inside
// answer()'s own deterministic resolution, in TWO places at once:
//
//   1. isPendingDisambiguationDeclined (pending-disambiguation.ts) never
//      recognized "I didn't ask for..." as a decline at all — its own
//      DECLINE_CUES list matched "don't" but not the CONTRACTED "didn't",
//      so the message fell through to the free-text new-item resolver.
//   2. That resolver (messageNamesItemOutsideCandidates, turn-engine.ts)
//      used to run the text through a typo-correction pass
//      (fuzzyCorrectAgainstLexicon, now removed) before resolving it — which
//      treated "stick" (a real, complete, unrelated word — "let's STICK TO
//      that") as a typo of Vito's own active term "sticks" (Mozzarella
//      Sticks) purely because "sticks" starts with "stick". The bot replied
//      "Mozzarella Sticks (6) added" — an $8.99 item nobody ordered, one
//      leg of a live $107.43-vs-~$85 overcharge.
//
// Real Vito's data (queried directly from the live shop, not guessed, 2026-
// 09-19): Southwest Shrimp (Wraps, $12.99, id 15d09f9d-...), Boom Boom
// Shrimp (Appetizers, $11.99, id 31b9e812-...), Mozzarella Sticks (6)
// (Appetizers, $8.99, id 4ff5efef-...); lexicon has "shrimp" active for BOTH
// shrimp items (a genuine tie -> disambiguation), and "sticks" active for
// Mozzarella Sticks alone.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  render,
  extractSlotChoiceWords,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
} from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const SOUTHWEST_SHRIMP_ID = "15d09f9d-66e3-4f6a-88b4-27b1b9f83696";
const BOOM_BOOM_SHRIMP_ID = "31b9e812-51d0-4732-93bb-10a7ed3769bb";
const MOZZARELLA_STICKS_ID = "4ff5efef-4552-46e7-89ac-93218f218c65";
const WRAP_TYPE_GROUP_ID = "southwest-shrimp-wrap-type-group";

const SHRIMP_MENU: TurnEngineMenuItem[] = [
  {
    id: SOUTHWEST_SHRIMP_ID, name: "Southwest Shrimp", category: "Wraps", price_cents: 1299,
    bot_state: "orderable",
    // The real live shape rule 3's repro needs: a required "wrap type" slot,
    // unresolved, so a "take it off" reply arrives while it's still open.
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Southwest Shrimp", base_price_cents: 1299,
      recap_template: "", ticket_template: "",
      steps: [
        {
          group_id: WRAP_TYPE_GROUP_ID, slot_key: "wrap_type", kind: "slot", ask_mode: "ask",
          prompt_template: "wrap_type.ask",
          choices: [
            { id: "choice-flour", display: "Flour Tortilla", price_delta_cents: 0 },
            { id: "choice-spinach", display: "Spinach Tortilla", price_delta_cents: 0 },
            { id: "choice-wheat", display: "Wheat Tortilla", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
  {
    id: BOOM_BOOM_SHRIMP_ID, name: "Boom Boom Shrimp", category: "Appetizers", price_cents: 1199,
    bot_state: "orderable",
  },
  {
    id: MOZZARELLA_STICKS_ID, name: "Mozzarella Sticks (6)", category: "Appetizers", price_cents: 899,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Mozzarella Sticks (6)", base_price_cents: 899,
      recap_template: "", ticket_template: "", steps: [],
    },
  },
];

const SHRIMP_LEXICON: LexiconTerm[] = [
  { term: "shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "boom boom shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "southwest shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "sticks", target_id: MOZZARELLA_STICKS_ID },
  { term: "mozzarella sticks", target_id: MOZZARELLA_STICKS_ID },
];

const SHRIMP_DISAMBIG_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "disambiguation", candidates: [SOUTHWEST_SHRIMP_ID, BOOM_BOOM_SHRIMP_ID], quantity: 1 },
  upsell_offered: false, asked_message_id: null,
};

// ============================================================
// ACCEPTANCE 1 (PRIMARY): the exact #41 repro -> cart empty, pending list
// cleared, no item line at all.
// ============================================================
Deno.test("answer (rule 1+2, real conv 087abb8d, PRIMARY ACCEPTANCE): 'I didn't ask for any of those! ... Let's stick to that, thanks!' adds NOTHING and clears the list", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(
    SHRIMP_DISAMBIG_STATE, cart,
    "I didn't ask for any of those! Just the order I gave you. Let's stick to that, thanks!",
    SHRIMP_MENU, { lexicon: SHRIMP_LEXICON },
  );
  // BEFORE this fix (verified directly against the pre-fix code): this same
  // call returned `{ resolved: true, outcome: { kind: "disambiguation_new_item_added",
  // menuItemId: "4ff5efef-4552-46e7-89ac-93218f218c65", quantity: 1 } }` and
  // left Mozzarella Sticks (6) sitting in the cart at $8.99 — the exact live
  // defect. AFTER: the decline clears the list outright, nothing added.
  assertEquals(result, { resolved: true, outcome: { kind: "closure" }, cartChanged: false });
  assertEquals(cart.length, 0, "cart must be completely empty — no phantom Mozzarella Sticks line");
});

// ============================================================
// ACCEPTANCE 2 (regression): standalone "sticks" — not inside "stick to" —
// on a fresh-add turn still correctly resolves to Mozzarella Sticks. Rule 1
// is about the SUBSTRING/STEM match on an unrelated word, never about
// banning "sticks" itself as a real, valid trigger.
// ============================================================
Deno.test("answer (rule 1 regression): standalone 'sticks' still resolves to Mozzarella Sticks", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SHRIMP_DISAMBIG_STATE, cart, "sticks", SHRIMP_MENU, { lexicon: SHRIMP_LEXICON });
  assert(result.resolved && result.outcome.kind === "disambiguation_new_item_added",
    `expected disambiguation_new_item_added, got: ${JSON.stringify(result)}`);
  assertEquals(result.resolved && result.outcome.kind === "disambiguation_new_item_added" ? result.outcome.menuItemId : null, MOZZARELLA_STICKS_ID);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, MOZZARELLA_STICKS_ID);
  assertEquals(cart[0].quantity, 1);
});

// ============================================================
// ACCEPTANCE 3 (regression, distinct from #1): plain rejection language,
// standalone, adds nothing. "no wraps or whatever" is the shape of a
// SEPARATE, already-being-fixed defect (a rejection misread as an
// acceptance) in a parallel worktree — this only asserts the money-safe
// half still holds here: neither message ever adds an item.
// ============================================================
Deno.test("answer (rule 2 regression): 'no wraps or whatever' adds nothing", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SHRIMP_DISAMBIG_STATE, cart, "no wraps or whatever", SHRIMP_MENU, { lexicon: SHRIMP_LEXICON });
  assertEquals(cart.length, 0, "nothing must ever be added on a plain rejection");
  assert(!result.resolved || !result.cartChanged, `must never mutate the cart, got: ${JSON.stringify(result)}`);
});

Deno.test("answer (rule 2 regression): 'no extras' adds nothing", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SHRIMP_DISAMBIG_STATE, cart, "no extras", SHRIMP_MENU, { lexicon: SHRIMP_LEXICON });
  assertEquals(cart.length, 0, "nothing must ever be added on a plain rejection");
  assert(!result.resolved || !result.cartChanged, `must never mutate the cart, got: ${JSON.stringify(result)}`);
});

// ============================================================
// ACCEPTANCE 4 (rule 3): "take it off, just the original order please! no
// extras!" while a SLOT question is open (wrap type for Southwest Shrimp)
// reads as declining the item outright, never as a literal slot value.
// ============================================================
const SOUTHWEST_SHRIMP_LINE_KEY = "line-southwest-shrimp";
function southwestShrimpCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: SOUTHWEST_SHRIMP_ID, name: "Southwest Shrimp", quantity: 1, price_cents: 1299, modifiers: [], line_key: SOUTHWEST_SHRIMP_LINE_KEY },
  ];
}
const WRAP_TYPE_SLOT_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "slot", line_key: SOUTHWEST_SHRIMP_LINE_KEY, group_id: WRAP_TYPE_GROUP_ID },
  upsell_offered: false, asked_message_id: null,
};
const TAKE_IT_OFF_MESSAGE = "take it off, just the original order please! no extras!";

Deno.test("answer (rule 3, real conv 087abb8d): 'take it off, ...' while the wrap-type slot is open declines the item, never feeds the slot", () => {
  const cart = southwestShrimpCart();
  const result = answer(WRAP_TYPE_SLOT_STATE, cart, TAKE_IT_OFF_MESSAGE, SHRIMP_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "slot_item_declined" }, cartChanged: true });
  assertEquals(cart.length, 0, "Southwest Shrimp must be removed, not left half-configured");
});

Deno.test("render (rule 3, real conv 087abb8d): BEFORE vs AFTER reply text for the exact live message", () => {
  const cartBefore = southwestShrimpCart();

  // BEFORE (verified directly against the pre-fix code, same fixture, same
  // message): answer() returned UNRESOLVED, the slot stayed open, and
  // turn-engine-runner.ts echoed back extractSlotChoiceWords' own fragment
  // of the customer's decline as if it were an attempted (wrong) slot
  // value — the exact live wording.
  const beforeUnmatchedText = extractSlotChoiceWords(TAKE_IT_OFF_MESSAGE);
  assertEquals(beforeUnmatchedText, "please! no extras");
  const beforeReply = render(cartBefore, cartBefore, WRAP_TYPE_SLOT_STATE, [], SHRIMP_MENU, {
    unmatchedSlotChoiceText: beforeUnmatchedText,
  });
  assertEquals(
    beforeReply,
    "We don't have \"please! no extras\" for Southwest Shrimp. The options are: Flour Tortilla, Spinach Tortilla, or Wheat Tortilla.\n\nSubtotal: $12.99\nService fee: $0.99\nTotal: $13.98",
    "documents the exact live-bug wording this fix closes",
  );

  // AFTER: answer() removes the line outright; render() reports the real
  // cart mutation instead of echoing a bogus slot value.
  const cartAfter = southwestShrimpCart();
  const result = answer(WRAP_TYPE_SLOT_STATE, cartAfter, TAKE_IT_OFF_MESSAGE, SHRIMP_MENU);
  assert(result.resolved && result.cartChanged, `expected a resolved cart mutation, got: ${JSON.stringify(result)}`);
  const afterState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const afterReply = render(cartBefore, cartAfter, afterState, [], SHRIMP_MENU);
  assertEquals(afterReply, "Southwest Shrimp removed.\n\nAnything else?");
});

// Generalization check: the SAME "take it off" language while a keep-or-drop
// question ("category_confirm") is open is that question's own "drop"
// answer too, not left unresolved.
Deno.test("answer (rule 3 generalization): 'take it off' declines a keep-or-drop (category_confirm) question the same way a bare 'no' does", () => {
  const state: DialogueState = {
    phase: "ordering",
    open: { kind: "category_confirm", menu_item_id: MOZZARELLA_STICKS_ID, quantity: 1, message: "We only have Mozzarella Sticks as an appetizer. Keep it, or take it off?" },
    upsell_offered: false, asked_message_id: null,
  };
  const cart: TurnEngineCartLine[] = [];
  const result = answer(state, cart, "take it off", SHRIMP_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "category_confirm_declined" }, cartChanged: false });
});

// ============================================================
// ACCEPTANCE 5 (rule 4): a quantity attached to a NEW item resolved out of
// an answer turn's free text (the messageNamesItemOutsideCandidates path)
// must be honored, exactly as it already is on the which-one/resolved path
// (extractAnswerQuantity, fixed earlier tonight for that sibling path).
//
// Scope note: this closes the concrete, code-fixable half of the PO's
// follow-up repro — the "2x" quantity no longer silently drops to 1 when a
// fresh item is named on this path. The OTHER half of that repro (a
// restated order naming THREE separate dishes across three different
// categories in one message, one of which needs its own brand-new which-one
// question) is a genuine multi-item list-parsing capability this single-
// target resolver does not have and was not asked to grow tonight — see
// po-inbox-result.md for why that's flagged separately rather than
// silently declared done.
// ============================================================
Deno.test("answer (rule 4, real conv 087abb8d follow-up): an explicit 'Nx' quantity on a fresh item named during a decline is honored, not dropped to 1", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(
    SHRIMP_DISAMBIG_STATE, cart,
    "None of those, I want 2x Mozzarella Sticks instead",
    SHRIMP_MENU, { lexicon: SHRIMP_LEXICON },
  );
  // BEFORE this fix (verified directly against the pre-fix code): quantity
  // came back 1 — the "2x" was silently dropped, same shape as the live
  // "1x Large Pepperoni $21.00" undercharge this mirrors.
  assert(result.resolved && result.outcome.kind === "disambiguation_new_item_added",
    `expected disambiguation_new_item_added, got: ${JSON.stringify(result)}`);
  assertEquals(result.resolved && result.outcome.kind === "disambiguation_new_item_added" ? result.outcome.quantity : null, 2);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, MOZZARELLA_STICKS_ID);
  assertEquals(cart[0].quantity, 2, "the customer's own '2x' must survive onto the cart line");
});
