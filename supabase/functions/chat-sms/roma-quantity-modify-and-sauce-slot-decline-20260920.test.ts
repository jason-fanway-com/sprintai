// 2026-09-20 PO addendum (rules 4 & 5, same branch as the House Salad
// no-dressing fix, fix/replacement-targets-named-line-and-holds-removal-20260919).
//
// RULE 4 — REAL LIVE MONEY BUG (v566 50-run, conv 0a4f967d #1): cart = 2x
// Large Roma pizza ($22.99 each, $45.98). Customer: "Actually, can I change
// that to 1 large Roma pizza and add 1 large Buffalo Chicken pizza instead?"
// Actual (broken): Buffalo Chicken added correctly, but the Roma quantity
// stayed at 2 -- total $68.97 instead of $45.98. Root cause: decide()'s
// replacement-execution block always reused the OLD line's quantity when
// re-adding Y, even when the customer's own Y phrase ("1 large Roma pizza")
// explicitly states a NEW quantity. This is a quantity-modify on X's own
// line (Y resolves to the SAME item as X here), a different shape from the
// existing rule 1/2 item-swap work.
//
// RULE 5 — required-slot loop (same fixture, real conv 0a4f967d follow-up):
// once the Buffalo Chicken pizza's required Sauce slot (Mild/BBQ/Hot) is
// open, "Can I just get it without any sauce instead?" was read as a
// garbled attempted CHOICE, echoed back verbatim ("We don't have 'any sauce
// instead?' for ... options: Mild, BBQ, Hot"), and re-asked identically —
// nothing in that shape could ever match a real choice, so it never
// resolves. Fixed: a genuine decline of the slot VALUE (not the whole item)
// resolves deterministically using the group's configured default, or the
// first listed choice when none is configured -- every real choice here
// prices at $0 delta, so this never changes the total.
//
// REQUIRED METHODOLOGY: runner-level, driving the real turn-engine-runner.ts
// runTurnEngineTurn. MENU/LEXICON constants are Vito's own real active
// menu_items rows for shop_id e0000000-0000-0000-0000-000000000001 (menu_id
// 54a42842-32be-43b5-9e0c-00fae0ce48fc), queried live via the Supabase REST
// API: "Roma - Large (16\")" (id 36b788c1-6bbf-44a0-9bf1-07eeb8b07c54,
// $22.99) and "Buffalo Chicken - Large (16\")" (id
// d00325b6-fe25-46d8-8827-55acd7794228, $22.99, real required Sauce slot
// with choices Mild/BBQ/Hot, all $0 delta, option_groups row
// 79fdcc23-d8a9-4cbb-89b3-77ff436e8253 confirmed default_choice_id: null).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";
import { decide } from "./turn-engine.ts";

// ── Real Vito's data (queried live, 2026-09-20, shop_id e0000000-0000-0000-0000-000000000001, menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc) ──

const ROMA_LARGE = "36b788c1-6bbf-44a0-9bf1-07eeb8b07c54";
const BUFFALO_CHICKEN_LARGE = "d00325b6-fe25-46d8-8827-55acd7794228";
const SAUCE_GROUP_ID = "79fdcc23-d8a9-4cbb-89b3-77ff436e8253";
const SAUCE_MILD = "61c7cee1-978c-4d5a-b507-38f6ac509455";
const SAUCE_BBQ = "6cce6b3f-5856-4ea9-81db-3b8a28d14a3c";
const SAUCE_HOT = "e205d8a4-2b0e-462c-bcd8-76b4398d56cb";

const BUFFALO_CHICKEN_MENU_ITEM: TurnEngineMenuItem = {
  id: BUFFALO_CHICKEN_LARGE, name: "Buffalo Chicken - Large (16\")", category: "Pizza", price_cents: 2299, bot_state: "orderable",
  option_groups: [{ id: SAUCE_GROUP_ID, name: "Sauce", default_choice_id: null }],
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Large Buffalo Chicken Pizza", base_price_cents: 2299,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: SAUCE_GROUP_ID, slot_key: null, kind: "slot", ask_mode: "ask",
      prompt_template: "sauce.ask",
      choices: [
        { id: SAUCE_MILD, display: "Mild", price_delta_cents: 0 },
        { id: SAUCE_BBQ, display: "BBQ", price_delta_cents: 0 },
        { id: SAUCE_HOT, display: "Hot", price_delta_cents: 0 },
      ],
    }],
  },
};

function romaItem(): TurnEngineMenuItem {
  return {
    id: ROMA_LARGE, name: "Roma - Large (16\")", category: "Pizza", price_cents: 2299, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Large Roma Pizza", base_price_cents: 2299,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [romaItem(), BUFFALO_CHICKEN_MENU_ITEM];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "roma", target_id: ROMA_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "roma pizza", target_id: ROMA_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "large roma pizza", target_id: ROMA_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "buffalo chicken pizza", target_id: BUFFALO_CHICKEN_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "large buffalo chicken pizza", target_id: BUFFALO_CHICKEN_LARGE, category: "Pizza", size_label: "Large (16\")" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-0a4f967d-repro",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: 0,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function makeFakeSupabase() {
  const state: { orderCartsUpdates: Array<Record<string, unknown>> } = { orderCartsUpdates: [] };
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
        const all = table === "lexicon" ? LEXICON : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = MENU
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: LEXICON.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
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

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function twoRomaCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: ROMA_LARGE, name: "Roma - Large (16\")", quantity: 2, price_cents: 2299, modifiers: [], line_key: "roma-line" },
  ];
}

function anythingElseState(): DialogueState {
  return { phase: "ordering", open: null, upsell_offered: true, asked_message_id: null, openRepeatCount: 0 };
}

Deno.test("decide() unit (RULE 4, RED pre-fix / GREEN post-fix): 'change that to 1 large Roma pizza and add 1 large Buffalo Chicken pizza instead' reduces the Roma line to quantity 1, not 2", () => {
  const proposal = {
    intent: "order" as const,
    // Modeled on the real live propose_success shape: the model correctly
    // proposed the Buffalo Chicken add but never proposed any modify/remove
    // for the Roma line at all -- decide()'s own deterministic replacement
    // parser is what must catch the quantity change, not PROPOSE.
    adds: [{ item_span: "1 large Buffalo Chicken pizza", quantity: 1, choices: [] }],
    removes: [],
    modifies: [],
  };
  const message = "Actually, can I change that to 1 large Roma pizza and add 1 large Buffalo Chicken pizza instead?";
  const result = decide(proposal, twoRomaCart(), MENU, LEXICON, undefined, message);
  const romaLines = result.cart.filter(l => l.menu_item_id === ROMA_LARGE);
  const buffaloLines = result.cart.filter(l => l.menu_item_id === BUFFALO_CHICKEN_LARGE);
  assertEquals(romaLines.length, 1, `exactly one Roma line: ${JSON.stringify(result.cart)}`);
  assertEquals(romaLines[0]?.quantity, 1, `Roma quantity must drop to 1, not stay at 2: ${JSON.stringify(result.cart)}`);
  assertEquals(buffaloLines.length, 1, `Buffalo Chicken must be added: ${JSON.stringify(result.cart)}`);
  assertEquals(buffaloLines[0]?.quantity, 1);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 2299 + 2299, `total must be $45.98 (1 Roma + 1 Buffalo Chicken), never $68.97: got ${subtotal}`);
});

Deno.test("runTurnEngineTurn (RULE 4, RED pre-fix / GREEN post-fix, real live money bug, conv 0a4f967d #1): total is $45.98, never $68.97", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "1 large Buffalo Chicken pizza", quantity: 1, choices: [] }],
        removes: [],
        modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "Actually, can I change that to 1 large Roma pizza and add 1 large Buffalo Chicken pizza instead?",
      cart: twoRomaCart(),
      dialogueState: anythingElseState(),
    }),
    deps,
  );
  const romaLines = result.cart.filter(l => l.menu_item_id === ROMA_LARGE);
  assertEquals(romaLines.length, 1);
  assertEquals(romaLines[0]?.quantity, 1, `Roma must drop to quantity 1: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.menu_item_id === BUFFALO_CHICKEN_LARGE), `Buffalo Chicken must be in the cart: ${JSON.stringify(result.cart)}`);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 4598, `total must be $45.98, never $68.97: got ${subtotal / 100}`);
});

Deno.test("runTurnEngineTurn (RULE 4 regression guard): 'change my Grilled Cheese to Chicken Fingers' (Y states NO quantity) still preserves X's original quantity, exactly as before this fix", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: ROMA_LARGE, name: "Roma - Large (16\")", quantity: 3, price_cents: 2299, modifiers: [], line_key: "roma-line" },
  ];
  const proposal = { intent: "order" as const, adds: [], removes: [], modifies: [] };
  // Y ("large Buffalo Chicken pizza") names no quantity at all -- must keep
  // reusing X's original quantity (3), the pre-existing rule 1/2 behavior,
  // completely unaffected by rule 4's new quantity-from-Y-phrase path.
  const result = decide(
    proposal, cart, MENU, LEXICON, undefined,
    "change that to a large Buffalo Chicken pizza instead",
  );
  const buffaloLines = result.cart.filter(l => l.menu_item_id === BUFFALO_CHICKEN_LARGE);
  assertEquals(buffaloLines.length, 1);
  assertEquals(buffaloLines[0]?.quantity, 3, `no quantity stated in Y -- must preserve X's original quantity 3: ${JSON.stringify(result.cart)}`);
});

Deno.test("isSlotValueDecline path (RULE 5, RED pre-fix / GREEN post-fix, real conv 0a4f967d follow-up): 'Can I just get it without any sauce instead?' resolves the required Sauce slot instead of looping the identical question", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called -- an open required slot resolves deterministically")),
  };
  const cartWithOpenSauceSlot: TurnEngineCartLine[] = [
    { menu_item_id: ROMA_LARGE, name: "Roma - Large (16\")", quantity: 1, price_cents: 2299, modifiers: [], line_key: "roma-line" },
    { menu_item_id: BUFFALO_CHICKEN_LARGE, name: "Buffalo Chicken - Large (16\")", quantity: 1, price_cents: 2299, modifiers: [], line_key: "buffalo-line" },
  ];
  const sauceOpenState: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: "buffalo-line", group_id: SAUCE_GROUP_ID },
    upsell_offered: false,
    asked_message_id: null,
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "Can I just get it without any sauce instead?",
      cart: cartWithOpenSauceSlot,
      dialogueState: sauceOpenState,
    }),
    deps,
  );
  assertEquals(result.dialogueState.open, null, `the sauce slot must actually resolve, not stay open forever: ${JSON.stringify(result.dialogueState)}`);
  const buffaloLine = result.cart.find(l => l.menu_item_id === BUFFALO_CHICKEN_LARGE);
  assert(buffaloLine, `the Buffalo Chicken line must still be in the cart: ${JSON.stringify(result.cart)}`);
  assert(
    buffaloLine!.options !== undefined || (buffaloLine as unknown as { ask_plan_selections?: Record<string, string> }).ask_plan_selections !== undefined,
    `a sauce choice must actually be recorded on the line (deterministic default), not left unresolved: ${JSON.stringify(buffaloLine)}`,
  );
  assert(!/We don't have/i.test(result.reply), `reply must never echo the customer's decline words back as if they were an unmatched choice: ${JSON.stringify(result.reply)}`);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 2299 + 2299, `sauce choice is a $0-delta modifier -- resolving it deterministically must never change the total: got ${subtotal}`);
});
