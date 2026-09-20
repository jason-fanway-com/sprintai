// PO dispatch (2026-09-19), two real live money bugs, v552 canary run.
// REQUIRED METHODOLOGY: both tests below drive the real turn-engine-
// runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly. proposeTurnFn is a hand-mocked stand-in for the real model call
// (as it is throughout turn-engine-runner.test.ts); everything downstream of
// it (ANSWER, DECIDE, ASK, RENDER, persistTurn) is the real, unmodified
// production code.
//
// S1 (real conv e456bf93 #16): a "Bleu Cheese or Ranch?" dressing slot is
// open on a quantity-2 salad line. The customer answers "Can I get Ranch for
// both, please? Also, is there a wait time for pickup?" — "Ranch" correctly
// answers the slot, but the SAME text ("Ranch") was also being fed into a
// second, remainder-only PROPOSE call (turn-engine-runner.ts's
// extractRemainderAfterAnswer) because one of REMAINDER_MARKERS ("can i
// get") matched at the very start of the message, taking the WHOLE message
// as "remainder". Ranch is also a real lexicon term on two unrelated menu
// items elsewhere on the menu, so this opened a spurious "which one?"
// disambiguation the customer never asked for. Same root cause, different
// word, hit again earlier the same night with "house balsamic" (#22).
//
// S2 (real conv 36eff7b9 #39): a Small Margherita pizza (bacon topping) is
// already in the cart. The customer says "I changed my mind about the bacon
// on the small one. Just keep the gyro meat for the small Margherita
// instead!" — a topping swap on the EXISTING line. Live, the whole line was
// removed ("Small Margherita Pizza removed. What would you like to order?").
// Root cause: turn-engine.ts's removeHasRemovalLanguage (the guard that
// validates a model-proposed `remove` really is supported by the customer's
// own words) treated the bare word "instead" as removal-verb support, and
// the line's own name ("Margherita") legitimately co-occurs in the very
// same clause that says what to KEEP — the guard had no way to tell that
// shape apart from a genuine whole-item replacement ("switch that to a
// Cheesesteak instead"), which produces an identical "soft verb + this
// line's own name in one clause" signature.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Shared minimal harness (same shape as conv22-live-runner-gap-20260919.test.ts) ──

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-repro",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: [],
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: false,
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: "Jason",
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function makeFakeSupabase(lexicon: Array<{ term: string; target_id: string }>) {
  const state = { orderCartsUpdates: [] as Array<Record<string, unknown>> };
  // deno-lint-ignore no-explicit-any
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in() { return Promise.resolve({ data: [], error: null }); },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

// ── S1 (real conv e456bf93 #16): slot-answer text must never bleed into item resolution ──

const DRESSING_ASK_PLAN = {
  compiled_at: "", compiler_version: 1, display_name: "Grilled Chicken Caesar Salad", base_price_cents: 999,
  recap_template: "", ticket_template: "",
  steps: [{
    group_id: "group-dressing", slot_key: "dressing", kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "Bleu Cheese or Ranch?",
    choices: [
      { id: "choice-bleu-cheese", display: "Bleu Cheese", price_delta_cents: 0 },
      { id: "choice-ranch", display: "Ranch", price_delta_cents: 0 },
    ],
  }],
};

const S1_MENU: TurnEngineMenuItem[] = [
  { id: "item-caesar-salad", name: "Grilled Chicken Caesar Salad", category: "Salads", price_cents: 999, bot_state: "orderable", ask_plan: DRESSING_ASK_PLAN, option_groups: [{ id: "group-dressing", name: "Dressing" }] },
  { id: "item-cbr-flatbread", name: "Chicken Bacon Ranch Flatbread", category: "Flatbreads", price_cents: 899, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Chicken Bacon Ranch Flatbread", base_price_cents: 899, recap_template: "", ticket_template: "", steps: [] } },
  { id: "item-gcbr-wrap", name: "Grilled Chicken Bacon & Ranch Wrap", category: "Wraps", price_cents: 949, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Grilled Chicken Bacon & Ranch Wrap", base_price_cents: 949, recap_template: "", ticket_template: "", steps: [] } },
];

// A genuine tie: "ranch" is a real lexicon term on TWO unrelated items —
// exactly the shape that opened a spurious disambiguation live.
const S1_LEXICON = [
  { term: "ranch", target_id: "item-cbr-flatbread" },
  { term: "ranch", target_id: "item-gcbr-wrap" },
];

Deno.test("runTurnEngineTurn (S1, real conv e456bf93 #16): 'Can I get Ranch for both, please? Also, is there a wait time for pickup?' resolves the dressing slot only — the answer text never re-enters item resolution", async () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-caesar-salad", name: "Grilled Chicken Caesar Salad", quantity: 2, price_cents: 999, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-dressing" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase(S1_LEXICON);

  // 2026-09-20 PO dispatch (slot-resolved blocks item search THIS TURN, V1's
  // own generalization one night later, real conv 6365b84d #16 money bug):
  // S1's own fix (this test, night of 2026-09-19) kept the remainder call
  // ALIVE for a resolved slot and only scoped what text it could see
  // (extractRemainderAfterAnswer's excludeBefore param) — proven, the same
  // night after this one, to still let a DIFFERENT phrasing ("Yes, please
  // add ranch for both pizzas!") slip a phantom disambiguation open. The
  // generalized fix removes "slot_resolved" from turn-engine-runner.ts's own
  // REMAINDER_ELIGIBLE_OUTCOME_KINDS entirely — see that dispatch's own doc
  // there — so NO remainder PROPOSE call of any kind runs once a slot
  // resolves, regardless of phrasing. This is a deliberate, known narrowing:
  // the genuine "is there a wait time for pickup?" follow-up asked in the
  // same breath as the slot answer no longer gets answered THIS turn either
  // — proposeTurnFn is now never called at all. The customer can just ask
  // again next turn; silence beats a phantom order every time, per the PO's
  // own standing rule. This test is UPDATED (not weakened) to assert the new,
  // intentional behavior — it still proves the load-bearing half of S1's own
  // fix (the dressing slot resolves to Ranch, no phantom line/disambiguation
  // ever opens), which the generalized fix only strengthens.
  const captured = { calls: 0, messages: [] as string[] };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: (): Promise<ProposeResult> => {
      throw new Error("FORBIDDEN: proposeTurnFn must never be called this turn — a resolved slot answer blocks ALL fresh item search/PROPOSE processing, full stop");
    },
  };
  const input = baseInput({
    message: "Can I get Ranch for both, please? Also, is there a wait time for pickup?",
    cart, menu: S1_MENU, dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(captured.calls, 0, "no remainder PROPOSE call at all — a resolved slot answer now blocks every fresh item search this same turn, full stop");
  assertEquals(result.cart[0].ask_plan_selections?.["group-dressing"], "choice-ranch", "the dressing slot must still resolve to Ranch");
  assertEquals(result.cart.length, 1, `no phantom second line / disambiguation add may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.dialogueState.open, null, `no disambiguation may ever open from the slot answer's own text: ${JSON.stringify(result.dialogueState.open)}`);
});

Deno.test("runTurnEngineTurn (S1 regression, real conv #22 shape, 'house balsamic'): a slot answer that itself contains a REMAINDER_MARKER word never opens on its own", async () => {
  // Same mechanism, different word: "balsamic" answers an open dressing
  // slot and also happens to contain no marker itself, but the customer's
  // full sentence starts with "add" ("add house balsamic please") — the
  // exact shape that made the OLD code take the entire message as
  // remainder. "house" is deliberately also a real, unrelated lexicon term.
  const balsamicAskPlan = {
    compiled_at: "", compiler_version: 1, display_name: "Side Salad", base_price_cents: 399,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: "group-dressing", slot_key: "dressing", kind: "slot" as const, ask_mode: "ask" as const,
      prompt_template: "What dressing?",
      choices: [
        { id: "choice-balsamic", display: "House Balsamic", price_delta_cents: 0 },
        { id: "choice-italian", display: "Italian", price_delta_cents: 0 },
      ],
    }],
  };
  const menu: TurnEngineMenuItem[] = [
    { id: "item-side-salad", name: "Side Salad", category: "Salads", price_cents: 399, bot_state: "orderable", ask_plan: balsamicAskPlan, option_groups: [{ id: "group-dressing", name: "Dressing" }] },
    { id: "item-house-stromboli", name: "House Stromboli", category: "Stromboli", price_cents: 1895, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "House Stromboli", base_price_cents: 1895, recap_template: "", ticket_template: "", steps: [] } },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-side-salad", name: "Side Salad", quantity: 1, price_cents: 399, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-dressing" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase([{ term: "house", target_id: "item-house-stromboli" }, { term: "house stromboli", target_id: "item-house-stromboli" }]);

  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: "house", quantity: 1, choices: [] }], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "add house balsamic please", cart, menu, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "the whole message is the slot answer plus filler — no remainder, no model call at all");
  assertEquals(result.cart[0].ask_plan_selections?.["group-dressing"], "choice-balsamic");
  assertEquals(result.cart.length, 1);
  assertEquals(result.dialogueState.open, null);
});

// ── S2 (real conv 36eff7b9 #39): a topping correction must never remove the whole line ──

const MARGHERITA_ASK_PLAN = {
  compiled_at: "", compiler_version: 1, display_name: "Small Margherita Pizza", base_price_cents: 999,
  recap_template: "", ticket_template: "",
  steps: [{
    group_id: "group-toppings", slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
    prompt_template: "toppings.ask",
    choices: [
      { id: "choice-bacon", display: "Bacon", price_delta_cents: 150 },
      { id: "choice-gyro-meat", display: "Gyro Meat", price_delta_cents: 200 },
    ],
  }],
};

const S2_MENU: TurnEngineMenuItem[] = [
  { id: "item-margherita-small", name: "Small Margherita Pizza", category: "Pizza", price_cents: 999, bot_state: "orderable", ask_plan: MARGHERITA_ASK_PLAN, option_groups: [{ id: "group-toppings", name: "Toppings" }] },
];

Deno.test("runTurnEngineTurn (S2, real conv 36eff7b9 #39): 'I changed my mind about the bacon... keep the gyro meat for the small Margherita instead!' swaps toppings, the line is never removed", async () => {
  const cart: TurnEngineCartLine[] = [
    {
      menu_item_id: "item-margherita-small", name: "Small Margherita Pizza", quantity: 1, price_cents: 999 + 150,
      modifiers: [], line_key: "line-1",
      ask_plan_selections: { "group-toppings": "choice-bacon" },
      options: { Toppings: ["Bacon"] },
    },
  ];
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase([]);

  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    // A faithful stand-in for the real model call: this is the exact
    // confused shape ("false 'wasn't in your order'" — see turn-engine.ts's
    // own comment on its modifies loop) a model produces when a correction
    // reads ambiguously as replacement — it proposes BOTH a remove for the
    // line AND a modify (drop bacon, add gyro meat) on that same line. Code,
    // not the model, is the backstop that must refuse the wrongful remove.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [],
        removes: [{ line_key: "line-1" }],
        modifies: [{ line_key: "line-1", remove_choices: ["choice-bacon"], choices: [{ group_id: "group-toppings", choice_id: "choice-gyro-meat" }] }],
      },
    }),
  };
  const input = baseInput({
    message: "I changed my mind about the bacon on the small one. Just keep the gyro meat for the small Margherita instead!",
    cart, menu: S2_MENU, dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `the Small Margherita line must survive a topping correction, never be wholesale removed: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, "item-margherita-small");
  assertEquals(result.cart[0].ask_plan_selections?.["group-toppings"], "choice-gyro-meat", "bacon must be dropped and gyro meat applied to the SAME line");
  assertEquals(result.cart[0].options?.Toppings, ["Gyro Meat"]);
  assert(!/removed/i.test(result.reply), `the reply must never claim the pizza was removed: ${JSON.stringify(result.reply)}`);
});

Deno.test("runTurnEngineTurn (S2 regression): an explicit hard removal verb still removes the named line even when 'keep' appears elsewhere in the message", async () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-margherita-small", name: "Small Margherita Pizza", quantity: 1, price_cents: 999, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase([]);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [], removes: [{ line_key: "line-1" }], modifies: [] },
    }),
  };
  const input = baseInput({
    message: "scratch the small Margherita, keep everything else the same",
    cart, menu: S2_MENU, dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "an explicit hard removal verb ('scratch') must still remove the named line — 'keep' elsewhere is not a blanket override");
});
