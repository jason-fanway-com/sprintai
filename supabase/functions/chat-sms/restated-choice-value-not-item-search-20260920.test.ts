// PO dispatch (2026-09-20), real live money bug, v569 50-run — sibling of
// tonight's V1 fix (slot-value-narrowing-bleed-20260920.test.ts, merged
// ad68a0d2), same underlying defect class, one turn later. REQUIRED
// METHODOLOGY: every test below drives the real turn-engine-runner.ts
// runTurnEngineTurn -- the same call path index.ts's turn_engine_enabled
// branch actually uses -- never decide()/answer() called directly.
// proposeTurnFn is a hand-mocked stand-in for the real model call (same
// convention as turn-engine-runner.test.ts and both of tonight's sibling
// fixtures). Everything downstream of it (DECIDE, ASK, RENDER, persistTurn)
// is the real, unmodified production code.
//
// Menu/lexicon rows below are the SAME real Vito's Pizza data (shop
// e0000000-0000-0000-0000-000000000001) V1's own fixture used, fetched
// read-only 2026-09-20: menu_items "Small Buffalo Chicken Pizza"
// (0aa10696-753c-4595-bc0e-c4ca1956805a) and the five real, distinct,
// orderable menu items the exact lexicon term "ranch" ties across (Chicken
// Bacon Ranch Flatbreads/Wraps/Small/Medium/Large Pizza).
//
// BUG (V1's sibling, "a turn later"): V1 fixed the FIRST reply ("I'll go
// with the Ranch for both, please!") resolving the dressing slot cleanly.
// This closes what happens on the VERY NEXT, open-ended ("Anything else?")
// turn -- the customer restating the SAME already-resolved choice ("That's
// Ranch dressing for both. Thanks!") got read as a fresh, unrelated item
// search: "ranch" ties ambiguous among the same 5 real menu items V1's own
// fixture names, and -- with no slot open this turn and no size word
// anywhere in the message for narrowAmbiguousCandidatesBySpanSize to grab
// -- decide()'s ambiguous-add branch had nothing to stop it from opening a
// brand-new "which one?" disambiguation for a choice that was already
// settled, on a cart line already in the cart. PO's exact rule: "A restated
// choice value ('ranch dressing', 'hot sauce', 'wheat') on an open-ended
// turn, when that value is already set on a cart line, is an
// acknowledgement -- never an item search."
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Shared minimal harness (same shape as slot-value-narrowing-bleed-20260920.test.ts) ──

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-090a3864", shopId: "e0000000-0000-0000-0000-000000000001", tenantId: "tenant-1", cartId: "cart-repro",
    message: "", history: [], menu: [], cart: [], dialogueState: null,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
    ...overrides,
  };
}

function makeFakeSupabase(lexicon: Array<{ term: string; target_id: string }>) {
  // deno-lint-ignore no-explicit-any
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; }, eq() { return b; }, is() { return b; }, order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in() { return Promise.resolve({ data: [], error: null }); },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          // deno-lint-ignore no-explicit-any
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (table: string) => builder(table) } as any;
}

// Real Vito's Pizza ask_plan, dressing step only -- identical fixture to
// V1's own (slot-value-narrowing-bleed-20260920.test.ts).
const DRESSING_GROUP_ID = "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a";
const RANCH_CHOICE_ID = "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8";
const BUFFALO_SMALL_ASK_PLAN = {
  compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1,
  display_name: "Small Buffalo Chicken Pizza", base_price_cents: 1295,
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
  steps: [{
    group_id: DRESSING_GROUP_ID, slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "bleu_cheese_or_ranch.ask",
    choices: [
      { id: "b39cfed5-a678-4534-b80f-0d0546a6b8c6", display: "Bleu Cheese", price_delta_cents: 0 },
      { id: RANCH_CHOICE_ID, display: "Ranch", price_delta_cents: 0 },
    ],
  }],
};
const EMPTY_ASK_PLAN = (name: string, price: number) => ({
  compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: price,
  recap_template: "", ticket_template: "", steps: [],
});
const MENU: TurnEngineMenuItem[] = [
  { id: "0aa10696-753c-4595-bc0e-c4ca1956805a", name: "Small Buffalo Chicken Pizza", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: BUFFALO_SMALL_ASK_PLAN, option_groups: [{ id: DRESSING_GROUP_ID, name: "Dressing" }] },
  { id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d", name: "Chicken Bacon Ranch Flatbreads", category: "Flatbreads", price_cents: 1050, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch Flatbreads", 1050) },
  { id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4", name: "Grilled Chicken Bacon & Ranch Wraps", category: "Wraps", price_cents: 999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Grilled Chicken Bacon & Ranch Wraps", 999) },
  { id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1", name: "Chicken Bacon Ranch - Medium (14\")", category: "Pizza", price_cents: 1999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Medium (14\")", 1999) },
  { id: "edac128c-c963-495a-8e4a-ec09a9787267", name: "Chicken Bacon Ranch - Large (16\")", category: "Pizza", price_cents: 2299, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Large (16\")", 2299) },
  { id: "f320da06-15d2-4503-97b2-001c17b444bf", name: "Chicken Bacon Ranch - Small (10\")", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Small (10\")", 1295) },
];
// Real, exact "ranch" item-lexicon rows (target_type=item, orderable only).
const RANCH_LEXICON = [
  { term: "ranch", target_id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d" },
  { term: "ranch", target_id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4" },
  { term: "ranch", target_id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1" },
  { term: "ranch", target_id: "edac128c-c963-495a-8e4a-ec09a9787267" },
  { term: "ranch", target_id: "f320da06-15d2-4503-97b2-001c17b444bf" },
];

// Cart shape AFTER V1's own fix has already applied: both units of the
// Small Buffalo Chicken Pizza resolved to Ranch dressing, dialogue back at
// the open-ended "Anything else?" state (open: null) -- exactly where V1's
// own acceptance test (#16) leaves off.
function cartWithRanchResolved(): TurnEngineCartLine[] {
  return [
    {
      menu_item_id: "0aa10696-753c-4595-bc0e-c4ca1956805a", name: "Small Buffalo Chicken Pizza",
      quantity: 2, price_cents: 1295, modifiers: [], line_key: "line-1",
      ask_plan_selections: { [DRESSING_GROUP_ID]: RANCH_CHOICE_ID },
    },
  ];
}

Deno.test("runTurnEngineTurn (acceptance, real conv 090a3864 #17, V1's sibling): 'That's Ranch dressing for both. Thanks!' on the open-ended turn is an acknowledgement, never a fresh CBR disambiguation", async () => {
  const cart = cartWithRanchResolved();
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const supabase = makeFakeSupabase(RANCH_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    // Faithful stand-in for the real model call: on this open-ended turn,
    // PROPOSE hallucinates the restated dressing word back as its own
    // ambiguous item add -- the exact real shape the PO's report describes
    // ("ranch"/something in the sentence ties ambiguously against the CBR
    // flatbread/wrap/pizza family) -- rather than recognizing it as pure
    // acknowledgement of an already-resolved choice.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "ranch", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const input = baseInput({ message: "That's Ranch dressing for both. Thanks!", cart, menu: MENU, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `no phantom second line may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].quantity, 2, "the two existing Buffalo Chicken pizzas must be untouched");
  assertEquals(result.cart[0].ask_plan_selections?.[DRESSING_GROUP_ID], RANCH_CHOICE_ID, "the already-resolved dressing choice must be untouched");
  assertEquals(result.dialogueState.open, null, `no disambiguation may ever open from a restated, already-resolved choice value: ${JSON.stringify(result.dialogueState.open)}`);
  assert(!/chicken bacon ranch|flatbread|wrap/i.test(result.reply), `the reply must never surface the phantom CBR which-one list: ${JSON.stringify(result.reply)}`);
});

Deno.test("runTurnEngineTurn (genuine new item still works, real Vito's data): 'also add a ranch flatbread' on the same open-ended turn still opens the real, unrelated disambiguation/order normally", async () => {
  const cart = cartWithRanchResolved();
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const supabase = makeFakeSupabase(RANCH_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    // A genuinely NEW item mention -- resolveItem ties "ranch flatbread"
    // among the same 5 real menu items (PROPOSE names the actual
    // distinguishing word the customer used, "flatbread" -- never collapsed
    // to the bare dressing word alone, since this is a real, deliberate
    // second request, not a restatement of the pizza's own dressing). Must
    // still surface the real disambiguation question exactly as before this
    // fix -- "flatbread" is not part of the resolved Ranch choice's own
    // display text, so the new "already-resolved choice" guard must never
    // match it.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "ranch flatbread", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const input = baseInput({ message: "Also can I get a ranch flatbread", cart, menu: MENU, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, "no line is added while the new item is still ambiguous");
  assertEquals(result.dialogueState.open?.kind, "disambiguation", "a genuine new ambiguous item mention must still open the real disambiguation");
});
