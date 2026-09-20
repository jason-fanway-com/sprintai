// PO dispatch (2026-09-20), real live money bug, v572 50-run, conv 6365b84d
// #16. REQUIRED METHODOLOGY: every test below drives the real turn-engine-
// runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly. proposeTurnFn is set to THROW: this dispatch's fix must prove no
// fresh item search/PROPOSE call of any kind can EVER run once a slot
// resolves this turn, not merely that it handles some particular mocked
// response well.
//
// BUG (V1's own sibling, one turn later — "the other phrasing"): V1
// (slot-value-narrowing-bleed-20260920.test.ts, same night) generalized S1's
// fix from one call site to another, but both V1 and S1 keep the remainder-
// only PROPOSE call ALIVE for a resolved slot and only scope/guard the exact
// consumed-answer TEXT it can see (turn-engine-runner.ts's
// extractRemainderAfterAnswer excludeBefore param; turn-engine.ts's decide()
// slotAnswerConsumedText/isSlotAnswerBleed check). Real repro: a "Ranch or
// Bleu Cheese?" dressing slot open on 2x Large Buffalo Chicken Pizza (one
// cart line, quantity 2). Customer: "Yes, please add ranch for both pizzas!"
// — Ranch correctly answers the slot (good), but the SAME turn also opened a
// "which one?" (Chicken Bacon Ranch Medium/Large/Small/Flatbreads/Wraps)
// disambiguation, as if a fresh item search also ran. A real live money bug:
// the customer's very next message ("I just want the 2 Large Buffalo Chicken
// pizzas for now, thanks!") got read as an answer to THAT phantom question,
// landing a $91.96 total for what should have been a $45.98 order.
//
// PO's own rule, verbatim: "The slot-value guard must key on the CHOICE that
// was applied (ranch), not on the exact phrasing of the answer: once a turn
// sets a slot, no item search runs on that turn, full stop." Generalized fix
// (turn-engine-runner.ts): "slot_resolved" is removed from
// REMAINDER_ELIGIBLE_OUTCOME_KINDS entirely — see that dispatch's own doc
// there. No remainder PROPOSE call of any kind runs once a slot resolves,
// unconditionally — there is no consumed-text boundary left to get wrong.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Shared minimal harness (same shape as slot-value-narrowing-bleed-20260920.test.ts) ──

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-6365b84d", shopId: "e0000000-0000-0000-0000-000000000001", tenantId: "tenant-1", cartId: "cart-repro",
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

// Real ask_plan shape (dressing step only, same shape V1's own fixture used
// for the Small Buffalo Chicken Pizza — this dispatch's real repro is the
// Large size, same dressing step).
const BUFFALO_LARGE_ASK_PLAN = {
  compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1,
  display_name: "Large Buffalo Chicken Pizza", base_price_cents: 2299,
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
// Real, exact "ranch" item-lexicon rows (the five distinct real Vito's
// Chicken-Bacon-Ranch items the term ties across — same set V1's own fixture
// used, matching production).
const MENU: TurnEngineMenuItem[] = [
  { id: "1aa10696-753c-4595-bc0e-c4ca1956805a", name: "Large Buffalo Chicken Pizza", category: "Pizza", price_cents: 2299, bot_state: "orderable", ask_plan: BUFFALO_LARGE_ASK_PLAN, option_groups: [{ id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a", name: "Dressing" }] },
  { id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d", name: "Chicken Bacon Ranch Flatbreads", category: "Flatbreads", price_cents: 1050, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch Flatbreads", 1050) },
  { id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4", name: "Grilled Chicken Bacon & Ranch Wraps", category: "Wraps", price_cents: 999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Grilled Chicken Bacon & Ranch Wraps", 999) },
  { id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1", name: "Chicken Bacon Ranch - Medium (14\")", category: "Pizza", price_cents: 1999, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Medium (14\")", 1999) },
  { id: "edac128c-c963-495a-8e4a-ec09a9787267", name: "Chicken Bacon Ranch - Large (16\")", category: "Pizza", price_cents: 2299, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Large (16\")", 2299) },
  { id: "f320da06-15d2-4503-97b2-001c17b444bf", name: "Chicken Bacon Ranch - Small (10\")", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: EMPTY_ASK_PLAN("Chicken Bacon Ranch - Small (10\")", 1295) },
];
const RANCH_LEXICON = [
  { term: "ranch", target_id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d" },
  { term: "ranch", target_id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4" },
  { term: "ranch", target_id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1" },
  { term: "ranch", target_id: "edac128c-c963-495a-8e4a-ec09a9787267" },
  { term: "ranch", target_id: "f320da06-15d2-4503-97b2-001c17b444bf" },
];

function buffaloCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: "1aa10696-753c-4595-bc0e-c4ca1956805a", name: "Large Buffalo Chicken Pizza", quantity: 2, price_cents: 2299, modifiers: [], line_key: "line-1" },
  ];
}
function dressingSlotOpen(): DialogueState {
  return { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "33e3599d-41b8-4ffa-b7b2-333efcdf3b6a" }, upsell_offered: false, asked_message_id: null };
}
const throwingProposeFn = () => {
  throw new Error("FORBIDDEN: proposeTurnFn must never be called this turn — a resolved slot answer blocks ALL fresh item search/PROPOSE processing, full stop");
};

Deno.test("runTurnEngineTurn (acceptance, real conv 6365b84d #16): 'Yes, please add ranch for both pizzas!' resolves the dressing slot only — no which-one list opens, no PROPOSE call of any kind", async () => {
  const supabase = makeFakeSupabase(RANCH_LEXICON);
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: throwingProposeFn };
  const input = baseInput({ message: "Yes, please add ranch for both pizzas!", cart: buffaloCart(), menu: MENU, dialogueState: dressingSlotOpen() });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `no phantom second line may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.["33e3599d-41b8-4ffa-b7b2-333efcdf3b6a"], "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8", "the dressing slot must resolve to Ranch");
  assertEquals(result.dialogueState.open, null, `no disambiguation/narrowing may ever open: ${JSON.stringify(result.dialogueState.open)}`);
});

Deno.test("runTurnEngineTurn (widening check, V1's own original fixture, real conv 090a3864 #16): 'I'll go with the Ranch for both, please!' still resolves the dressing slot only — strict widening, not a narrowing", async () => {
  const supabase = makeFakeSupabase(RANCH_LEXICON);
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: throwingProposeFn };
  const input = baseInput({ message: "I'll go with the Ranch for both, please!", cart: buffaloCart(), menu: MENU, dialogueState: dressingSlotOpen() });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `no phantom second line may ever land: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.["33e3599d-41b8-4ffa-b7b2-333efcdf3b6a"], "cd1ff3f4-73d0-4ffa-b8b0-230d1a2e7bc8", "the dressing slot must resolve to Ranch");
  assertEquals(result.dialogueState.open, null, `no disambiguation/narrowing may ever open: ${JSON.stringify(result.dialogueState.open)}`);
});
