// 2026-09-20 PO dispatch — real live money bug, conv 37700efe, v583 50-run.
//
// Real transcript (pulled from the DB, error_log/conversations, not guessed):
//   bot read-back: "2x 16\" Chicken Parmesan Stromboli"
//   customer: "Looks good, but I wanted 2 Chicken Parmesan *not* Stromboli!
//     Please correct that."
//   bot (BROKEN): "Which one would you like — 1) the Chicken Parmesan
//     entree ... 5) the Chicken Parmesan - 16\" stromboli? Reply 1-5."
//   customer: "I meant option 1) the Chicken Parmesan entree for $17.95."
//   bot (BROKEN): "Chicken Parmesan Entree added." — cart now $112.77: BOTH
//     the 2x Stromboli line AND the new 2x entree line, double-charged.
//
// Root cause, two compounding bugs in the SAME "<X>, not <Y>" read-back
// replace rule (mechanism 2, 2026-09-18 dispatch):
//
//   1. REPLACEMENT_NOT_SUFFIX_RE required whitespace touching "not" on both
//      sides. The customer's own SMS emphasis markup ("*not*") put an
//      asterisk directly against "not", so the regex never matched at all —
//      parseReplacementCorrection returned null and mechanism 2 never even
//      attempted this message. (Fixed: the regex now tolerates [*_]* around
//      "not".)
//
//   2. Even with the regex fixed, "Chicken Parmesan" (X) itself names FIVE
//      real menu items at Vito's (entree, sandwich, three stromboli sizes).
//      findMenuItemByNamePhrase collapses "ambiguous" and "doesn't exist"
//      into the same null, and the confirm-case code declined by name for
//      both — except in production this message fell through mechanism 2
//      entirely (bug 1) and reached PROPOSE's own ambiguous-add handling
//      instead, which has no notion that a Y line was ever supposed to be
//      replaced: answering the "which one?" question just ADDED X, leaving
//      Y sitting in the cart, both charged.
//
// Fix: mechanism 2 now distinguishes "0 hits" (declines by name, unchanged)
// from "2+ hits" (opens the SAME disambiguation a fresh ambiguous add would,
// but carries replacementSourceLineKey — see AnswerOutcome's own
// "line_replacement_ambiguous" doc) — reusing decide()'s own, already-tested
// ambiguous-replacement-target resolver (replacement-ambiguous-target-
// 20260919.test.ts) rather than inventing a second one.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
} from "./turn-engine.ts";
import { runTurnEngineTurn, type RunTurnDeps, type RunTurnInput } from "./turn-engine-runner.ts";

// ── Real Vito's Chicken Parmesan family (pulled 2026-09-20 from menu_items,
// menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc) — all five items real
// customers are actually offered when "Chicken Parmesan" is ambiguous. ──────
const CP_ENTREE_ID = "0e2db319-d015-43e1-8786-c22007453f6b";
const CP_SANDWICH_ID = "4e184b21-388b-4869-92ba-8b6d3f073e17";
const CP_PERSONAL_STROMBOLI_ID = "257bb828-c0b3-4c9f-b7c5-be3b0a4c9fa8";
const CP_14_STROMBOLI_ID = "b0914280-9c71-4908-905d-7bdf5de33fbd";
const CP_16_STROMBOLI_ID = "ded942e7-040b-4531-8814-82ba1c9ed49f";
// Real Vito's Cheese Burger (VITOS_MENU's own fixture elsewhere in this
// suite) — reused here only as an untouched-line control, not the fix's
// own subject.
const CHEESE_BURGER_ID = "442f650d-dc96-4a95-9762-f6b571a4dd8c";

const MENU: TurnEngineMenuItem[] = [
  {
    id: CP_ENTREE_ID, name: "Chicken Parmesan", category: "Entrees", price_cents: 1795, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Chicken Parmesan Entree", base_price_cents: 1795,
      recap_template: "", ticket_template: "",
      steps: [{
        kind: "slot", group_id: "cp-pasta-group", slot_key: null, ask_mode: "ask", prompt_template: "pasta.ask",
        choices: [
          { id: "cp-pasta-penne", display: "Penne", price_delta_cents: 0 },
          { id: "cp-pasta-angel-hair", display: "Angel Hair", price_delta_cents: 0 },
          { id: "cp-pasta-spaghetti", display: "Spaghetti", price_delta_cents: 0 },
          { id: "cp-pasta-linguine", display: "Linguine", price_delta_cents: 0 },
        ],
      }],
    },
  },
  {
    id: CP_SANDWICH_ID, name: "Chicken Parmesan", category: "Hot Sandwiches", price_cents: 1199, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Chicken Parmesan Sandwich", base_price_cents: 1199, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CP_PERSONAL_STROMBOLI_ID, name: "Chicken Parmesan - Personal", category: "Stromboli", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Personal Chicken Parmesan Stromboli", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CP_14_STROMBOLI_ID, name: "Chicken Parmesan - 14\"", category: "Stromboli", price_cents: 1895, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "14\" Chicken Parmesan Stromboli", base_price_cents: 1895, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CP_16_STROMBOLI_ID, name: "Chicken Parmesan - 16\"", category: "Stromboli", price_cents: 2295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "16\" Chicken Parmesan Stromboli", base_price_cents: 2295, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CHEESE_BURGER_ID, name: "Cheese Burger", category: "Angus Burgers & Specialty", price_cents: 849, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849, recap_template: "", ticket_template: "", steps: [] },
  },
];

const STROMBOLI_LINE_KEY = "stromboli-line";

function realTranscriptCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 2, price_cents: 849, modifiers: [], line_key: "burger-line" },
    { menu_item_id: CP_16_STROMBOLI_ID, name: "16\" Chicken Parmesan Stromboli", quantity: 2, price_cents: 2295, modifiers: [], line_key: STROMBOLI_LINE_KEY },
  ];
}

const CONFIRM_STATE: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };

// The real customer message, verbatim (conv 37700efe, turn at 2026-09-20T09:47:12Z).
const REAL_CORRECTION_MESSAGE = "Looks good, but I wanted 2 Chicken Parmesan *not* Stromboli! Please correct that.";

Deno.test("answer (real conv 37700efe): '2 Chicken Parmesan *not* Stromboli' opens a replacement disambiguation — Stromboli held, not removed yet, not duplicated", () => {
  const cart = realTranscriptCart();
  const result = answer(CONFIRM_STATE, cart, REAL_CORRECTION_MESSAGE, MENU);

  assert(result.resolved, "the asterisk-emphasized 'not' must still be recognized as mechanism 2");
  assertEquals(result.outcome.kind, "line_replacement_ambiguous");
  if (result.outcome.kind === "line_replacement_ambiguous") {
    // Four candidates, not five: the 16" Stromboli itself (the line being
    // replaced, excludeMenuItemId) is deliberately never offered as its own
    // replacement — findMenuItemMatchesByNamePhrase's own convention,
    // unchanged by this fix. The real (broken) transcript offered all 5,
    // including the Stromboli the customer just said they didn't want, only
    // because that reply came from the OTHER, unrelated ambiguous-add path
    // this fix bypasses entirely.
    assertEquals(new Set(result.outcome.candidates), new Set([CP_ENTREE_ID, CP_SANDWICH_ID, CP_PERSONAL_STROMBOLI_ID, CP_14_STROMBOLI_ID]), "the four OTHER real Chicken Parmesan items must be offered — never the Stromboli being replaced");
    assertEquals(result.outcome.quantity, 2, "quantity must carry over from the Stromboli line (2x)");
    assertEquals(result.outcome.replacementSourceLineKey, STROMBOLI_LINE_KEY, "must remember the Stromboli line as the one to replace");
  }
  assertEquals(result.cartChanged, false, "nothing is touched until the customer picks one");
  assertEquals(cart.map(l => l.menu_item_id), [CHEESE_BURGER_ID, CP_16_STROMBOLI_ID], "cart must be completely unchanged — no duplicate, no premature removal");
});

Deno.test("answer (real conv 37700efe, turn 2): 'option 1' resolves the held replacement — Stromboli GONE, entree in, no duplicate", () => {
  const cart = realTranscriptCart();
  const disambiguationState: DialogueState = {
    phase: "ordering",
    open: {
      kind: "disambiguation",
      candidates: [CP_ENTREE_ID, CP_SANDWICH_ID, CP_PERSONAL_STROMBOLI_ID, CP_14_STROMBOLI_ID, CP_16_STROMBOLI_ID],
      quantity: 2,
      spanText: "2 Chicken Parmesan",
      replacementSourceLineKey: STROMBOLI_LINE_KEY,
    },
    upsell_offered: false,
    asked_message_id: null,
    openRepeatCount: 0,
  };

  const result = answer(disambiguationState, cart, "I meant option 1) the Chicken Parmesan entree for $17.95. Sorry for the confusion!", MENU);

  assert(result.resolved);
  assertEquals(result.outcome.kind, "disambiguation_resolved");
  if (result.outcome.kind === "disambiguation_resolved") {
    assertEquals(result.outcome.menuItemId, CP_ENTREE_ID);
  }
  assert(result.cartChanged);

  assertEquals(cart.filter(l => l.menu_item_id === CP_16_STROMBOLI_ID).length, 0, "the Stromboli line must be GONE — the exact real-money bug (it stayed, doubled-charged) must not reproduce");
  assertEquals(cart.filter(l => l.menu_item_id === CP_ENTREE_ID).length, 1, "exactly one Chicken Parmesan Entree line, never a duplicate");
  const entreeLine = cart.find(l => l.menu_item_id === CP_ENTREE_ID);
  assertEquals(entreeLine?.quantity, 2, "quantity carries over from the replaced Stromboli line (2x)");
  assertEquals(cart.length, 2, "cart must have exactly 2 lines — burger untouched, one Chicken Parmesan line, never 3");
});

// ── Full end-to-end reproduction via runTurnEngineTurn, run 3 times for
// determinism (per the PO's own verification bar: "reproduce the real
// transcript 3 times, confirm deterministic"). Fake Supabase client mirrors
// turn-engine.test.ts's own makeMinimalFakeSupabase() (not exported from
// there, so duplicated here verbatim) — every read resolves to an empty/null
// result, which is exactly what loadItemLexicon/loadHoursLine's own
// non-fatal-on-failure contracts expect. ─────────────────────────────────────
function makeDeps(): RunTurnDeps {
  function builder() {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: (_cols: unknown) => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void, reject?: (e: unknown) => void) {
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void, reject?: (e: unknown) => void) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (_table: string) => builder() } as any;
  return {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — the correction resolves deterministically")),
  };
}

for (let run = 1; run <= 3; run++) {
  Deno.test(`runTurnEngineTurn (real conv 37700efe, run ${run}/3): full transcript never duplicates the entree/Stromboli lines, Stromboli gone once the customer says what they want instead`, async () => {
    const turn1Input: RunTurnInput = {
      conversationId: "conv-37700efe", shopId: "shop-vitos", tenantId: "tenant-1", cartId: "cart-1",
      message: REAL_CORRECTION_MESSAGE,
      history: [], menu: MENU, cart: realTranscriptCart(), dialogueState: CONFIRM_STATE,
      shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Alex", deliveryFeeCents: null },
    };
    const turn1 = await runTurnEngineTurn(turn1Input, makeDeps());

    assertEquals(turn1.cart.map(l => l.menu_item_id).sort(), [CHEESE_BURGER_ID, CP_16_STROMBOLI_ID].sort(), "turn 1 must not touch the cart — only opens the which-one question");
    assert(turn1.reply.includes("Which one would you like"), `turn 1 must ask which Chicken Parmesan: ${JSON.stringify(turn1.reply)}`);

    const turn2Input: RunTurnInput = {
      ...turn1Input,
      message: "I meant option 1) the Chicken Parmesan entree for $17.95. Sorry for the confusion!",
      cart: turn1.cart,
      dialogueState: turn1.dialogueState,
    };
    const turn2 = await runTurnEngineTurn(turn2Input, makeDeps());

    const stromboliLines = turn2.cart.filter(l => l.menu_item_id === CP_16_STROMBOLI_ID);
    const entreeLines = turn2.cart.filter(l => l.menu_item_id === CP_ENTREE_ID);
    assertEquals(stromboliLines.length, 0, `Stromboli must be gone by turn 2 — got cart: ${JSON.stringify(turn2.cart)}`);
    assertEquals(entreeLines.length, 1, `exactly one entree line, never a duplicate — got cart: ${JSON.stringify(turn2.cart)}`);
    assertEquals(entreeLines[0]?.quantity, 2);
    assertEquals(turn2.cart.length, 2, "burger + one Chicken Parmesan line, never 3");
  });
}

// ── Regression: the asterisk-tolerant regex must not break a PLAIN,
// unambiguous "X, not Y" (no ambiguity at all) — see the pre-existing
// "a real, distinct target item DOES replace the wrong line" test in
// turn-engine.test.ts for the no-markup version of this same case. ─────────
Deno.test("regression: '*not*' emphasis markup on an UNAMBIGUOUS replacement still resolves as a plain line_replaced, not ambiguous", () => {
  const cheeseId = "item-cheese-pizza-emphasis";
  const pepperoniId = "item-pepperoni-pizza-emphasis";
  const menu: TurnEngineMenuItem[] = [
    { id: cheeseId, name: "Cheese Pizza", category: "Pizza", price_cents: 1299, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Pizza", base_price_cents: 1299, recap_template: "", ticket_template: "", steps: [] } },
    { id: pepperoniId, name: "Pepperoni Pizza", category: "Pizza", price_cents: 1499, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Pepperoni Pizza", base_price_cents: 1499, recap_template: "", ticket_template: "", steps: [] } },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: cheeseId, name: "Cheese Pizza", quantity: 2, price_cents: 1299, modifiers: [], line_key: "cheese-line" },
  ];
  const result = answer(CONFIRM_STATE, cart, "I wanted a Pepperoni Pizza, *not* a Cheese Pizza.", menu);
  assertEquals(result, { resolved: true, outcome: { kind: "line_replaced" }, cartChanged: true });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, pepperoniId);
  assertEquals(cart[0].quantity, 2, "quantity must carry over from the replaced line");
});
