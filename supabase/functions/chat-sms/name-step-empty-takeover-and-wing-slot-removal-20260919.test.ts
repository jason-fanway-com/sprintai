// PO dispatch (2026-09-19), MONEY BUG (W1), real live conv 0db63161 (#28),
// deploy v549, order never paid.
//
//   bot: "What's the name for the order?"
//   customer: "It's under my name. Just put it in my name."
//   bot: "10 Pieces Wings (Bone-In) added. What wing flavor would you like...?"
//   (then FOUR separate attempts to cancel: "I didn't order wings!", "No
//    wings!", "cancel the wings", "Forget the wings" -- ALL FOUR got fed to
//    the wing-flavor slot question: "We don't have '...' for 10 Pieces
//    Wings." The order never completed/paid.)
//
// Two independent defects, fixed together (rule 1/2's runner-level tests
// live in turn-engine-runner.test.ts, alongside its own makeFakeSupabase/
// baseInput fixtures -- this file covers everything reachable through
// answer()/render() directly):
//
//  Rule 1/2 (turn-engine-runner.ts, ~line 1878 / ~line 1955): the name
//  question's own deterministic extractor (extractCustomerName,
//  dialogue-signals.ts) already correctly refuses to read a name out of
//  "It's under my name. Just put it in my name." -- "my"/"name" are both in
//  NOT_NAME_TOKENS, so acceptName rejects every carrier match. answer()
//  therefore returns UNRESOLVED and the turn falls through to PROPOSE (the
//  model). Nothing in PROPOSE's contract stops the model from reading that
//  same UNRESOLVED reply as an order anyway -- neither the code-side
//  "order-shaped empty-adds" takeover (which re-reads the raw message
//  against the menu whenever the model returns zero adds) nor the model's
//  own adds/removes/modifies were ever gated on what question was actually
//  open. name/address/order_type/confirm are each a question with a narrow,
//  specific expected answer shape (a name, an address, pickup-or-delivery,
//  yes-or-no) -- a reply to any of them being read as "maybe the customer
//  is ordering something" is categorically wrong, the same reasoning
//  00-AT's slot/multi_size/disambiguation branch already applies by
//  skipping PROPOSE's cart-shaped output entirely. Fixed by gating both the
//  order-shaped-message re-run AND the raw proposal's adds/removes/modifies
//  off whenever priorState.open.kind is one of those four -- the model is
//  still consulted (00-BL/00-BM's answer_value extraction for name/address
//  needs the call to happen), only its cart mutation is discarded.
//  See turn-engine-runner.test.ts's own "rule 1+2"/"rule 2" tests for the
//  full end-to-end proof, including the model itself hallucinating Wings.
//
//  Rule 3 (turn-engine.ts, answer()'s "slot" case, ~line 2029):
//  DECLINE_OPEN_ITEM_RE already reads a BARE PRONOUN decline ("take it
//  off"/"remove it") as declining the slot's own item rather than a literal
//  slot value (fixed earlier tonight, conv 087abb8d). It never covered a
//  NAMED decline ("no wings"/"cancel the wings"/"forget the wings"/"I
//  didn't order wings") -- all four of the live conv 0db63161 cancellation
//  attempts name the item outright and were fed straight into
//  matchChoiceInText as if each were a wing flavor. Fixed with a new
//  isNamedSlotItemRejection helper: a real decline verb (forget/never
//  mind/cancel/didn't/don't/not/no) AND a whole-word stem match against the
//  slot's own line name/category -- never a substring, so a short word
//  elsewhere in an unrelated message (rule 1's own "in" from "put it in my
//  name") can never fire this by matching a fragment of a real item/
//  modifier name like "Bone-In".
//
// Scoped deliberately narrow, per the PO's dispatch: rule 3 here is the
// SLOT-open case only. The order_type/confirm removal mechanism
// (applyNamedLineRemovals, cb37bda9) that a separate, parallel fix is
// reopening at the runner level tonight is untouched by this file.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  render,
  extractSlotChoiceWords,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
} from "./turn-engine.ts";

// ============================================================
// Shared fixture: the real repro's item -- "10 Pieces Wings (Bone-In)", a
// single required "wing flavor" slot left open.
// ============================================================
const WINGS_ID = "wings-10pc-bone-in";
const WINGS_FLAVOR_GROUP_ID = "wings-flavor-group";
const WINGS_LINE_KEY = "line-wings-1";

const WINGS_MENU: TurnEngineMenuItem[] = [
  {
    id: WINGS_ID, name: "10 Pieces Wings (Bone-In)", category: "Wings", price_cents: 1699,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "10 Pieces Wings (Bone-In)", base_price_cents: 1699,
      recap_template: "", ticket_template: "",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: WINGS_FLAVOR_GROUP_ID, slot_key: "flavor", prompt_template: "flavor.ask",
          choices: [
            { id: "wings-mild", display: "Mild", price_delta_cents: 0 },
            { id: "wings-hot", display: "Hot", price_delta_cents: 0 },
            { id: "wings-bbq", display: "BBQ", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

function wingsCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: WINGS_ID, name: "10 Pieces Wings (Bone-In)", quantity: 10, price_cents: 1699, modifiers: [], line_key: WINGS_LINE_KEY },
  ];
}

const WINGS_FLAVOR_SLOT_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "slot", line_key: WINGS_LINE_KEY, group_id: WINGS_FLAVOR_GROUP_ID },
  upsell_offered: false, asked_message_id: null,
};

// ============================================================
// ACCEPTANCE 1 (rule 1): the name question's own deterministic extractor
// already correctly refuses "It's under my name. Just put it in my name."
// as a name -- BEFORE/AFTER are identical here (no change was needed in
// extractCustomerName itself; see turn-engine-runner.test.ts for the real
// leak, which is downstream in PROPOSE, not here). Locked down as a
// regression test so nothing later loosens NOT_NAME_TOKENS ("my"/"name")
// into accepting it.
// ============================================================
const NAME_STATE: DialogueState = {
  phase: "name",
  open: { kind: "name" },
  upsell_offered: false, asked_message_id: null,
};
const LIVE_NAME_REPLY = "It's under my name. Just put it in my name.";

Deno.test("answer (rule 1, real conv 0db63161 #28): \"It's under my name. Just put it in my name.\" with the name question open never extracts a name and never touches the cart -- falls through to UNRESOLVED, never a menu-item add", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(NAME_STATE, cart, LIVE_NAME_REPLY, WINGS_MENU);
  assertEquals(result, { resolved: false });
  assertEquals(cart.length, 0, "no cart mutation of any kind from the name step itself");
});

// ============================================================
// ACCEPTANCE 2 (rule 3, PRIMARY): all four real live cancellation attempts
// against the open wing-flavor slot remove the Wings line, instead of being
// fed to matchChoiceInText as a (wrong) flavor.
// ============================================================
const LIVE_REJECTION_MESSAGES = [
  "I didn't order wings!",
  "No wings!",
  "cancel the wings",
  "Forget the wings",
];

for (const message of LIVE_REJECTION_MESSAGES) {
  Deno.test(`answer (rule 3, real conv 0db63161 #28): "${message}" while the wing-flavor slot is open removes the Wings line, never feeds the slot`, () => {
    const cart = wingsCart();
    const result = answer(WINGS_FLAVOR_SLOT_STATE, cart, message, WINGS_MENU);
    assertEquals(result, { resolved: true, outcome: { kind: "slot_item_declined" }, cartChanged: true });
    assertEquals(cart.length, 0, `Wings must be removed outright, not left half-configured for: "${message}"`);
  });
}

// Real before/after reply text for the first live attempt.
Deno.test("render (rule 3, real conv 0db63161 #28): BEFORE vs AFTER reply text for \"I didn't order wings!\"", () => {
  const message = "I didn't order wings!";
  const cartBefore = wingsCart();

  // BEFORE (verified directly against the pre-fix code, same fixture, same
  // message): answer() returned UNRESOLVED (DECLINE_OPEN_ITEM_RE only
  // matches a bare pronoun, never a named item), the slot stayed open, and
  // turn-engine-runner.ts's own unmatched-slot-choice echo rendered the
  // customer's decline back as if it were an attempted (wrong) flavor --
  // the exact live wording, four times running across all four attempts.
  const beforeUnmatchedText = extractSlotChoiceWords(message) || undefined;
  const beforeReply = render(cartBefore, cartBefore, WINGS_FLAVOR_SLOT_STATE, [], WINGS_MENU, {
    unmatchedSlotChoiceText: beforeUnmatchedText,
  });
  assert(
    beforeReply.includes("10 Pieces Wings (Bone-In)"),
    `pre-fix reply must echo the unmatched text against the Wings line, got: ${beforeReply}`,
  );

  // AFTER: answer() removes the line outright; render() reports the real
  // cart mutation instead of echoing a bogus flavor.
  const cartAfter = wingsCart();
  const result = answer(WINGS_FLAVOR_SLOT_STATE, cartAfter, message, WINGS_MENU);
  assert(result.resolved && result.cartChanged, `expected a resolved cart mutation, got: ${JSON.stringify(result)}`);
  const afterState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const afterReply = render(cartBefore, cartAfter, afterState, [], WINGS_MENU);
  assertEquals(afterReply, "10 Pieces Wings (Bone-In) removed.\n\nAnything else?");
});

// ============================================================
// ACCEPTANCE 3 (rule 3 regression): a genuine flavor answer while the same
// slot is open still resolves normally -- rule 3 is about NAMED rejection
// language, never about blocking a real answer that happens to also
// contain the item's own name.
// ============================================================
Deno.test("answer (rule 3 regression): a genuine flavor answer ('BBQ please') while the wing-flavor slot is open still resolves the slot, never misread as a rejection", () => {
  const cart = wingsCart();
  const result = answer(WINGS_FLAVOR_SLOT_STATE, cart, "BBQ please", WINGS_MENU);
  assert(result.resolved && result.outcome.kind === "slot_resolved", `expected slot_resolved, got: ${JSON.stringify(result)}`);
  assertEquals(cart.length, 1, "the Wings line must still be in the cart, just resolved");
});
