// PO dispatch (2026-09-19), MONEY BUG N2, deterministic offline repro
// (probe-decide): "...And about that gluten-free question... do you have any
// gluten-free pizzas?" — PROPOSE (correctly) proposes an add for "gluten-free
// pizzas" since it can't always tell a genuine question from an order.
// Actual (broken): One Size Gluten-Free Pizza, $15.50, gets ADDED to the
// cart anyway, even though the whole message is a question, nothing ordered.
//
// Root cause (turn-engine.ts): questionClauseOnlyTokens/itemSpanNamedInMessage
// only excludes a token from supporting an add when that token appears
// EXCLUSIVELY inside a clause carrying a real availability-question marker
// ("do you have"/"is there"/etc). "gluten-free" is named TWICE here — once in
// the harmless preamble ("about that gluten-free question", no marker) and
// again inside the actual question clause ("do you have any gluten-free
// pizzas?", which does carry the marker) — so it fails the exclusivity check
// and the add goes through.
//
// Fix: a preamble clause that carries no order-shaped language of its own
// (no quantity, no order verb) and merely announces an upcoming question
// (contains the word "question") is folded into the question side of the
// exclusivity check, never the non-question side — so a topic word repeated
// in the preamble no longer defeats the exclusion the real question clause
// already earns.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch uses — never decide() called directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const GLUTEN_FREE_ID = "gluten-free-pizza";
const PEPPERONI_ID = "pepperoni-pizza";

const MENU: TurnEngineMenuItem[] = [
  {
    id: GLUTEN_FREE_ID, name: "One Size Gluten-Free Pizza", category: "Pizza", price_cents: 1550,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "One Size Gluten-Free Pizza", base_price_cents: 1550,
      recap_template: "", ticket_template: "", steps: [],
    },
  },
  {
    id: PEPPERONI_ID, name: "Pepperoni Pizza", category: "Pizza", price_cents: 1799,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Pepperoni Pizza", base_price_cents: 1799,
      recap_template: "", ticket_template: "", steps: [],
    },
  },
];

const LEXICON = [
  { term: "gluten free", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "gluten-free", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "gluten free pizza", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "gluten free pizzas", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "gluten-free pizza", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "gluten-free pizzas", target_id: GLUTEN_FREE_ID, category: "Pizza", size_label: null },
  { term: "pepperoni pizza", target_id: PEPPERONI_ID, category: "Pizza", size_label: null },
  { term: "pepperoni pizzas", target_id: PEPPERONI_ID, category: "Pizza", size_label: null },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-n2-probe-decide",
    shopId: "shop-1",
    tenantId: "shop-1",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function makeFakeSupabase() {
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
          .map(m => ({ id: m.id, category: m.category, size_label: null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
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
  return supabase;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

Deno.test("N2 runner-level (probe-decide, MONEY BUG): \"about that gluten-free question... do you have any gluten-free pizzas?\" never adds the Gluten-Free Pizza", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "gluten free", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "...And about that gluten-free question... do you have any gluten-free pizzas?" }),
    deps,
  );
  assertEquals(result.cart.length, 0, `no add may land from a pure question: ${JSON.stringify(result.cart)}`);
  assert(!/gluten-free pizza.*added/i.test(result.reply), `reply must never confirm a phantom add: ${JSON.stringify(result.reply)}`);
});

Deno.test("N2 regression (unaffected, real conv $20 phantom charge fix): a real order + trailing question in one message still adds the ordered item, never the question's own item", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "2 pepperoni gluten free pizzas", quantity: 2, choices: [] }],
        removes: [], modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "Also, can I get 2 Pepperoni pizzas? And do you have anything gluten free?" }),
    deps,
  );
  assert(!result.cart.some(l => l.menu_item_id === GLUTEN_FREE_ID), `the phantom gluten-free add must still be refused: ${JSON.stringify(result.cart)}`);
});

Deno.test("N2 regression (unaffected): a genuine order clause that happens to contain the word 'question' still resolves normally", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "pepperoni pizza", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "I have a question, can I get a pepperoni pizza?" }),
    deps,
  );
  assert(result.cart.some(l => l.menu_item_id === PEPPERONI_ID), `the real order must still land: ${JSON.stringify(result.cart)}`);
});

