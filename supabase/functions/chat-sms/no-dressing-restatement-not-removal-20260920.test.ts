// 2026-09-20 PO addendum (rule 3, same branch as
// replacement-named-line-and-hold-20260919.test.ts's rules 1/2) — REAL LIVE
// MONEY BUG, v564 rerun #41 (slang_abbrev).
//
// Cart: 2x House Salad (with Black Diamond Steak add-ons) + Medium Mikes Hot
// n Honey pizza. Customer: "oh wait, just the house salads no dressing. sry!
// so just 2x house salads. thx!"
//
// Actual (broken): bot replies "House removed." — BOTH House Salad lines are
// deleted from the cart entirely, leaving only the pizza.
//
// Two independent misreads in the SAME clause ("just the house salads no
// dressing") are responsible:
//   (a) "no dressing" — "no" is scoped to DRESSING, a modifier choice on a
//       line the customer just named, never to the line itself. removeHasRemovalLanguage
//       (and isNamedSlotItemRejection, same class of bug as N1's "forget"
//       fix) previously matched "no" ANYWHERE in the clause against the
//       item's name ANYWHERE in the clause, with no requirement that the two
//       actually attach to each other.
//   (b) "so just 2x house salads" is a RESTATEMENT of the salads (the
//       customer confirming what they still want), never removal language,
//       even when it directly follows a "no".
//
// REQUIRED METHODOLOGY: runner-level, driving the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch actually uses. MENU/LEXICON-shaped constants below are Vito's own
// real active menu_items rows for shop_id e0000000-0000-0000-0000-000000000001,
// queried live via the Supabase REST API (menu_id
// 54a42842-32be-43b5-9e0c-00fae0ce48fc): "House" (id
// a9f637bb-8264-44ef-b6c1-a5ffb4a83391, category "Salads", price_cents 899,
// ask_plan carries a "Dressing" ask-mode slot and a "Black Diamond Steak"
// on-request add-on) and "Mikes Hot n Honey - Medium (14\")" (id
// 0c4c4803-77dc-4543-bb5f-e6c0c19df7fe, category "Pizza", price_cents 1999).
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

const HOUSE_SALAD = "a9f637bb-8264-44ef-b6c1-a5ffb4a83391";
const MIKES_MEDIUM = "0c4c4803-77dc-4543-bb5f-e6c0c19df7fe";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  realItem(HOUSE_SALAD, "House", "Salads", 899),
  realItem(MIKES_MEDIUM, "Mikes Hot n Honey - Medium (14\")", "Pizza", 1999),
];

// Real active item_lexicon-shaped rows for shop e0000000-0000-0000-0000-000000000001.
const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "house", target_id: HOUSE_SALAD, category: "Salads", size_label: null },
  { term: "house salad", target_id: HOUSE_SALAD, category: "Salads", size_label: null },
  { term: "house salads", target_id: HOUSE_SALAD, category: "Salads", size_label: null },
  { term: "mikes hot n honey", target_id: MIKES_MEDIUM, category: "Pizza", size_label: "Medium (14\")" },
  { term: "medium mikes hot n honey", target_id: MIKES_MEDIUM, category: "Pizza", size_label: "Medium (14\")" },
  { term: "medium mikes hot n honey pizza", target_id: MIKES_MEDIUM, category: "Pizza", size_label: "Medium (14\")" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-v564-rerun41-repro",
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

interface FakeState {
  orderCartsUpdates: Array<Record<string, unknown>>;
}

function makeFakeSupabase() {
  const state: FakeState = { orderCartsUpdates: [] };
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

// Both salads already fully built (dressing resolved, Black Diamond Steak
// add-on applied) -- the customer is CORRECTING an already-placed order, not
// answering an open slot question.
function baseCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: HOUSE_SALAD, name: "House", quantity: 1, price_cents: 899, modifiers: ["Ranch", "Black Diamond Steak"], line_key: "salad-1" },
    { menu_item_id: HOUSE_SALAD, name: "House", quantity: 1, price_cents: 899, modifiers: ["Ranch", "Black Diamond Steak"], line_key: "salad-2" },
    { menu_item_id: MIKES_MEDIUM, name: "Mikes Hot n Honey - Medium (14\")", quantity: 1, price_cents: 1999, modifiers: [], line_key: "pizza-1" },
  ];
}

function anythingElseState(): DialogueState {
  return { phase: "ordering", open: null, upsell_offered: true, asked_message_id: null, openRepeatCount: 0 };
}

const MESSAGE = "oh wait, just the house salads no dressing. sry! so just 2x house salads. thx!";

Deno.test("decide() unit (RED pre-fix / GREEN post-fix): 'no dressing' inside a clause naming the salads never removes the salad lines, even when PROPOSE itself hallucinates removes for both", () => {
  const proposal = {
    intent: "order" as const,
    adds: [],
    // Modeled on the real live propose_success shape for this exact turn
    // (v564 #41): the model read "no dressing"/"just the ... no dressing" as
    // full removal of both salad lines -- this is exactly the shape the
    // remove-guard (removeHasRemovalLanguage) must catch and refuse.
    removes: [{ line_key: "salad-1" }, { line_key: "salad-2" }],
    modifies: [],
  };
  const result = decide(proposal, baseCart(), MENU, LEXICON, undefined, MESSAGE);
  assert(result.cart.some(l => l.line_key === "salad-1"), `salad-1 must survive -- the customer never asked to remove either salad: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.line_key === "salad-2"), `salad-2 must survive: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.line_key === "pizza-1"), `the pizza must remain untouched: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart.length, 3, `no line may vanish: ${JSON.stringify(result.cart)}`);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 899 + 899 + 1999, `subtotal must reflect both salads plus the pizza: got ${subtotal}`);
});

Deno.test("runTurnEngineTurn (RED pre-fix / GREEN post-fix, real live money bug, v564 rerun #41): 'oh wait, just the house salads no dressing. sry! so just 2x house salads. thx!' must never delete either House Salad line", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [],
        removes: [{ line_key: "salad-1" }, { line_key: "salad-2" }],
        modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: MESSAGE,
      cart: baseCart(),
      dialogueState: anythingElseState(),
    }),
    deps,
  );
  assert(
    result.cart.filter(l => l.menu_item_id === HOUSE_SALAD).length === 2,
    `BOTH House Salad lines must survive -- got: ${JSON.stringify(result.cart)}`,
  );
  assert(
    result.cart.some(l => l.menu_item_id === MIKES_MEDIUM),
    `the Medium Mikes Hot N Honey pizza must remain untouched: ${JSON.stringify(result.cart)}`,
  );
  assertEquals(result.cart.length, 3, `no line may vanish from the cart: ${JSON.stringify(result.cart)}`);
  const subtotal = result.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 899 + 899 + 1999, `total must reflect both salads plus the pizza, never just the pizza: got ${subtotal}`);
  assert(!/house removed/i.test(result.reply), `reply must never claim the House salad was removed: ${JSON.stringify(result.reply)}`);
});

Deno.test("isNamedSlotItemRejection path (RED pre-fix / GREEN post-fix): the SAME 'no dressing' language answering an OPEN dressing slot must decline the slot, not delete the salad line", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called -- an open slot resolves deterministically")),
  };
  const openDressingSlotCart: TurnEngineCartLine[] = [
    { menu_item_id: HOUSE_SALAD, name: "House", quantity: 1, price_cents: 899, modifiers: ["Black Diamond Steak"], line_key: "salad-1" },
    { menu_item_id: HOUSE_SALAD, name: "House", quantity: 1, price_cents: 899, modifiers: ["Ranch", "Black Diamond Steak"], line_key: "salad-2" },
    { menu_item_id: MIKES_MEDIUM, name: "Mikes Hot n Honey - Medium (14\")", quantity: 1, price_cents: 1999, modifiers: [], line_key: "pizza-1" },
  ];
  const dressingOpenState: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: "salad-1", group_id: "dressing-group" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: MESSAGE,
      cart: openDressingSlotCart,
      dialogueState: dressingOpenState,
    }),
    deps,
  );
  assert(
    result.cart.filter(l => l.menu_item_id === HOUSE_SALAD).length === 2,
    `the customer declined DRESSING, not the salad itself -- both House Salad lines must survive: ${JSON.stringify(result.cart)}`,
  );
  assert(
    result.cart.some(l => l.menu_item_id === MIKES_MEDIUM),
    `the pizza must remain untouched: ${JSON.stringify(result.cart)}`,
  );
});
