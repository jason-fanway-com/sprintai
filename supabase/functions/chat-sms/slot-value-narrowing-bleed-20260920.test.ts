// PO dispatch (2026-09-20), real live money bug, v566 50-run, conv 090a3864
// #16 (V1). REQUIRED METHODOLOGY: every test below drives the real
// turn-engine-runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly. proposeTurnFn is a hand-mocked stand-in for the real model call
// (as it is throughout turn-engine-runner.test.ts and S1's own
// slot-answer-item-bleed-and-topping-correction-20260919.test.ts, which this
// fix is the direct sibling of). Everything downstream of it (ANSWER,
// DECIDE, ASK, RENDER, persistTurn) is the real, unmodified production code.
//
// Menu/lexicon rows below are real Vito's Pizza data (shop
// e0000000-0000-0000-0000-000000000001), fetched read-only 2026-09-20:
// menu_items "Small Buffalo Chicken Pizza" (0aa10696-753c-4595-bc0e-
// c4ca1956805a, real ask_plan's dressing slot trimmed of its unrelated
// 32-choice toppings step for fixture brevity) and the five real, distinct,
// orderable menu items the exact lexicon term "ranch" ties across
// (Chicken Bacon Ranch Flatbreads/Wraps/Small/Medium/Large Pizza) — the
// display_only "Ranch [Pizza Finish]" row loadItemLexicon already drops in
// production is excluded here too, matching real behavior.
//
// BUG (S1's sibling, "on the other path"): S1 (2026-09-19,
// slot-answer-item-bleed-and-topping-correction-20260919.test.ts) stopped a
// slot's own answer text from being handed to a fresh, remainder-only
// PROPOSE call as new-item text in the first place (findSlotAnswerConsumedText
// scopes extractRemainderAfterAnswer past it). This closes the SAME defect
// one call site further downstream: decide()'s own ambiguous-add resolution
// never checked whether an ambiguous item_span IS the text that just
// answered a still-open slot (on an existing cart line) or a whole-span
// choice of one of THIS turn's own other adds, BEFORE
// narrowAmbiguousCandidatesBySpanSize got a chance to auto-resolve the tie
// using a completely unrelated size word sitting elsewhere in the same
// message. Real shape: "2 small buffalo chicken pizzas with ranch dressing
// please" — "ranch" is ambiguous among 5 real menu items, but is ALSO the
// Buffalo Chicken pizza's own about-to-be-asked dressing choice;
// narrowAmbiguousCandidatesBySpanSize picked up the unrelated word "small"
// (describing the PIZZA's own size) and silently added a phantom $12.95
// "Chicken Bacon Ranch - Small" pizza nobody ordered — worse than even
// asking, since it never surfaced as a question at all.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Shared minimal harness (same shape as slot-answer-item-bleed-and-topping-correction-20260919.test.ts) ──

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

// Real Vito's Pizza ask_plan, dressing step only (trimmed of its own
// unrelated 32-choice toppings modifier step for fixture brevity — that
// step never participates in this bug).
const BUFFALO_SMALL_ASK_PLAN = {
  compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1,
  display_name: "Small Buffalo Chicken Pizza", base_price_cents: 1295,
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
  steps: [{
    group_id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a", slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "bleu_cheese_or_ranch.ask",
    choices: [
      { id: "b39cfed5-a678-4534-b80f-0d0546a6b8c6", display: "Bleu Cheese", price_delta_cents: 0 },
      { id: "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8", display: "Ranch", price_delta_cents: 0 },
    ],
  }],
};
const EMPTY_ASK_PLAN = (name: string, price: number) => ({
  compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: price,
  recap_template: "", ticket_template: "", steps: [],
});
const MENU: TurnEngineMenuItem[] = [
  { id: "0aa10696-753c-4595-bc0e-c4ca1956805a", name: "Small Buffalo Chicken Pizza", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: BUFFALO_SMALL_ASK_PLAN, option_groups: [{ id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a", name: "Dressing" }] },
  { id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d", name: "Chicken Bacon Ranch Flatbreads", category: "Flatbreads", price_cents: 1050, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch Flatbreads", 1050) },
  { id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4", name: "Grilled Chicken Bacon & Ranch Wraps", category: "Wraps", price_cents: 999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Grilled Chicken Bacon & Ranch Wraps", 999) },
  { id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1", name: "Chicken Bacon Ranch - Medium (14\")", category: "Pizza", price_cents: 1999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Medium (14\")", 1999) },
  { id: "edac128c-c963-495a-8e4a-ec09a9787267", name: "Chicken Bacon Ranch - Large (16\")", category: "Pizza", price_cents: 2299, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Large (16\")", 2299) },
  { id: "f320da06-15d2-4503-97b2-001c17b444bf", name: "Chicken Bacon Ranch - Small (10\")", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Small (10\")", 1295) },
];
// Real, exact "ranch" item-lexicon rows (target_type=item, orderable only —
// the display_only "Ranch [Pizza Finish]" row loadItemLexicon drops in
// production is excluded here too).
const RANCH_LEXICON = [
  { term: "ranch", target_id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d" },
  { term: "ranch", target_id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4" },
  { term: "ranch", target_id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1" },
  { term: "ranch", target_id: "edac128c-c963-495a-8e4a-ec09a9787267" },
  { term: "ranch", target_id: "f320da06-15d2-4503-97b2-001c17b444bf" },
];
const BUFFALO_LEXICON = [
  { term: "buffalo chicken small", target_id: "0aa10696-753c-4595-bc0e-c4ca1956805a" },
];
const FULL_LEXICON = [...RANCH_LEXICON, ...BUFFALO_LEXICON];

// ── Main acceptance shape, as dispatched: slot open, single message ──

Deno.test("runTurnEngineTurn (acceptance, real conv 090a3864 #16): 'I'll go with the Ranch for both, please!' resolves the dressing slot only — no disambiguation/narrowing ever opens", async () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "0aa10696-753c-4595-bc0e-c4ca1956805a", name: "Small Buffalo Chicken Pizza", quantity: 2, price_cents: 1295, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a" }, upsell_offered: false, asked_message_id: null };
  const supabase = makeFakeSupabase(FULL_LEXICON);
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "question", adds: [], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "I'll go with the Ranch for both, please!", cart, menu: MENU, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "the whole message is the slot answer plus filler — no remainder marker, no model call at all");
  assertEquals(result.cart.length, 1, `no phantom second line may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.["33e3599d-41b8-4ffa-b7b2-333efcdf3b6a"], "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8", "the dressing slot must resolve to Ranch");
  assertEquals(result.dialogueState.open, null, `no disambiguation/narrowing may ever open from the slot answer's own text: ${JSON.stringify(result.dialogueState.open)}`);
  assert(!/what kind|what size|which one/i.test(result.reply), `the reply must never open a narrowing/disambiguation question: ${JSON.stringify(result.reply)}`);
});

// ── Real root-cause repro: decide()'s ambiguous-add resolution, real Vito's data ──

Deno.test("runTurnEngineTurn (real root cause, real Vito's data): adding 'Small Buffalo Chicken Pizza' while the model ALSO proposes the inline dressing word 'ranch' as its own ambiguous item add — no phantom pizza is ever silently added", async () => {
  const cart: TurnEngineCartLine[] = [];
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const supabase = makeFakeSupabase(FULL_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    // A faithful stand-in for the real model call: PROPOSE fused "2 small
    // buffalo chicken pizzas" and the inline "ranch dressing" mention into
    // TWO separate adds instead of pre-filling the dressing choice — the
    // exact real shape that let "ranch" reach decide()'s ambiguous-add
    // resolver as if it were a second, unrelated item request.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { item_span: "buffalo chicken small", quantity: 2, choices: [] },
          { item_span: "ranch", quantity: 1, choices: [] },
        ],
        removes: [], modifies: [],
      },
    }),
  };
  const input = baseInput({ message: "2 small buffalo chicken pizzas with ranch dressing please", cart, menu: MENU, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `no phantom "Chicken Bacon Ranch" pizza (or any second line) may ever be silently added: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, "0aa10696-753c-4595-bc0e-c4ca1956805a");
  assertEquals(result.cart[0].quantity, 2);
  assert(!/chicken bacon ranch/i.test(result.reply), `the reply must never confirm a phantom Chicken Bacon Ranch pizza: ${JSON.stringify(result.reply)}`);
  assertEquals(result.dialogueState.open?.kind, "slot", "the real dressing slot on the real pizza must still be the open question");
});

// ── Same defect, reached via the remainder-only decide() call (S1's own call site) ──

Deno.test("runTurnEngineTurn (remainder path, real Vito's data): a slot answer plus a genuine remainder that ALSO echoes 'ranch' never opens a phantom disambiguation", async () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "0aa10696-753c-4595-bc0e-c4ca1956805a", name: "Small Buffalo Chicken Pizza", quantity: 2, price_cents: 1295, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a" }, upsell_offered: false, asked_message_id: null };
  const supabase = makeFakeSupabase(FULL_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: (input): Promise<ProposeResult> => {
      // The remainder-only PROPOSE call receives ONLY the text after the
      // marker "also" (S1's own scoping) — it should never see "Ranch"
      // capitalized as the slot's own answer, but it CAN still echo the
      // bare word back as its own (hallucinated) ambiguous add, which is
      // exactly the shape this fix closes.
      if (/ranch/i.test(input.message)) {
        return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: "ranch", quantity: 1, choices: [] }], removes: [], modifies: [] } });
      }
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "question", adds: [], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "I'll go with the Ranch for both, please! Also, can I get a side of ranch?", cart, menu: MENU, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `no phantom second line / disambiguation add may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.["33e3599d-41b8-4ffa-b7b2-333efcdf3b6a"], "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8", "the dressing slot must still resolve to Ranch");
  assertEquals(result.dialogueState.open, null, `no disambiguation may ever open from the slot answer's own text bleeding into the remainder call: ${JSON.stringify(result.dialogueState.open)}`);
});
