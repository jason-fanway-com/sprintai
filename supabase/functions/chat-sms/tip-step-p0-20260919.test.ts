// P0 (2026-09-19, live money bug, deploy v528): two deterministic live
// repros —
//
// 1. Delivery order, tip question open, "I don't want a driver tip. Is it
//    really $19.99 for that?" charged "Driver tip: $19.99" — the code
//    scanned the WHOLE message for any dollar figure and used the
//    delivery-fee number from an unrelated second sentence, ahead of ever
//    checking the explicit decline in the first sentence.
// 2. Pickup order, "I don't want a driver tip. Can you just do the two
//    pizzas for pickup?" both charged a $19.99 driver tip AND re-asked the
//    tip question — on a pickup order, which must never have a tip step at
//    all.
//
// See turn-engine.ts's readTipReply / TIP_DECLINE_ANYWHERE_RE headers and
// the "tip" case's own pickup-override note, plus turn-engine-runner.ts's
// "order_type_resolved" case (zeros any tip once order type is pickup) for
// the fixes these tests exercise end-to-end.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runTurnEngineTurn, type RunTurnDeps, type RunTurnInput, type RunTurnShopContext } from "./turn-engine-runner.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const BURGER_ID = "p0-tip-burger";
const MENU: TurnEngineMenuItem[] = [
  {
    id: BURGER_ID, name: "Cheese Burger", category: "Burgers", price_cents: 849, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849, recap_template: "", ticket_template: "", steps: [] },
  },
];

function burgerCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: undefined, ask_plan_selections: {} },
  ];
}

const TIP_OPEN_STATE: DialogueState = { phase: "tip", open: { kind: "tip" }, upsell_offered: false, asked_message_id: null };

function makeFakeSupabase() {
  const state = { orderCartsUpdates: [] as Array<Record<string, unknown>> };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert(row: Record<string, unknown>) {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

function baseInput(overrides: Partial<RunTurnInput> & { shopContext: RunTurnShopContext }): RunTurnInput {
  return {
    conversationId: "conv-1",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: burgerCart(),
    dialogueState: TIP_OPEN_STATE,
    ...overrides,
  };
}

Deno.test("P0 repro 1: decline + unrelated dollar figure never charges a phantom tip (delivery order)", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must never be called — this resolves deterministically")),
  };
  const input = baseInput({
    message: "I don't want a driver tip. Is it really $19.99 for that?",
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: true, driverTipCents: null, pickupName: null, deliveryFeeCents: 1999 },
  });
  const result = await runTurnEngineTurn(input, deps);

  const lastUpdate = state.orderCartsUpdates.at(-1);
  assertEquals(lastUpdate?.driver_tip_cents, 0, `no phantom tip: ${JSON.stringify(lastUpdate)}`);
  assert(!/tip:\s*\$19\.99/i.test(result.reply), `reply must not carry a phantom $19.99 TIP line (the $19.99 delivery fee is legitimately shown separately): ${result.reply}`);
});

Deno.test("P0 repro 2: stating pickup while tip is open switches order type, zeros any tip, and never re-asks the tip question", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must never be called — this resolves deterministically")),
  };
  // Order type is already "delivery" (that's WHY tip is open) and a tip was
  // already (wrongly) set on a prior turn — the exact live-repro shape.
  const input = baseInput({
    message: "I don't want a driver tip. Can you just do the two pizzas for pickup?",
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: true, driverTipCents: 1999, pickupName: null, deliveryFeeCents: 499 },
  });
  const result = await runTurnEngineTurn(input, deps);

  const lastUpdate = state.orderCartsUpdates.at(-1);
  assertEquals(lastUpdate?.order_type, "pickup", `order type must switch to pickup: ${JSON.stringify(lastUpdate)}`);
  assertEquals(lastUpdate?.driver_tip_cents, 0, `pickup must never carry a tip: ${JSON.stringify(lastUpdate)}`);
  assert(!/tip/i.test(result.reply), `pickup order must never ask about a tip: ${result.reply}`);
  assert(result.dialogueState.open?.kind !== "tip", `dialogue state must not re-open tip on a pickup order: ${JSON.stringify(result.dialogueState.open)}`);
});

Deno.test("P0 regression: explicit tip phrases still resolve to $5.00 exactly", async () => {
  for (const message of ["$5 tip", "tip the driver 5"]) {
    const { supabase, state } = makeFakeSupabase();
    const deps: RunTurnDeps = {
      supabase,
      apiKey: "test-key",
      proposeTurnFn: () => Promise.reject(new Error("PROPOSE must never be called — this resolves deterministically")),
    };
    const input = baseInput({
      message,
      shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: true, driverTipCents: null, pickupName: null, deliveryFeeCents: 499 },
    });
    await runTurnEngineTurn(input, deps);
    const lastUpdate = state.orderCartsUpdates.at(-1);
    assertEquals(lastUpdate?.driver_tip_cents, 500, `"${message}" must resolve to exactly $5.00: ${JSON.stringify(lastUpdate)}`);
  }
});

// Item 9 (2026-09-19, live repro, lower priority same run): a closure
// message sent while a narrowing "what kind?" question is open used to be
// silently ignored (impliesClosure's own cartHasItems gate treated the
// pending, not-yet-materialized disambiguation as "nothing in the cart",
// suppressing the embedded "that's it" reading) and the same question
// re-asked forever. See closureOrAffirmationFallback's own P0 header.
const MK_CHEESE_ID = "p0-mk-pizza-cheese";
const MK_PEPPERONI_ID = "p0-mk-pizza-pepperoni";
const MK_MEATLOVERS_ID = "p0-mk-pizza-meatlovers";
const MK_HAWAIIAN_ID = "p0-mk-pizza-hawaiian";
const mkPizza = (id: string, name: string, price: number): TurnEngineMenuItem => ({
  id, name: `${name} - Large`, category: "Pizza", price_cents: price, bot_state: "orderable",
  ask_plan: { compiled_at: "", compiler_version: 1, display_name: `${name} - Large`, base_price_cents: price, recap_template: "", ticket_template: "", steps: [] },
});
const MULTI_KIND_PIZZA_MENU: TurnEngineMenuItem[] = [
  mkPizza(MK_CHEESE_ID, "Cheese Pizza", 1499),
  mkPizza(MK_PEPPERONI_ID, "Pepperoni Pizza", 1699),
  mkPizza(MK_MEATLOVERS_ID, "Meat Lovers Pizza", 1999),
  mkPizza(MK_HAWAIIAN_ID, "Hawaiian Pizza", 1799),
];
const NARROWING_OPEN_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "disambiguation", candidates: MULTI_KIND_PIZZA_MENU.map(m => m.id), quantity: 2, spanText: "2 large pizzas" },
  upsell_offered: false,
  asked_message_id: null,
};

Deno.test('item 9: "Nope, that\'s it for now" while a "what kind?" narrowing question is open proceeds to checkout instead of looping', async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must never be called for a closure while a narrowing question is open")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-1",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message: "Nope, that's it for now",
    history: [],
    menu: MULTI_KIND_PIZZA_MENU,
    cart: [], // nothing materialized yet — only the pending "what kind?" question exists
    dialogueState: NARROWING_OPEN_STATE,
    shopContext: { deliveryEnabled: true, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };
  const result = await runTurnEngineTurn(input, deps);

  assert(result.dialogueState.open?.kind !== "disambiguation", `the narrowing question must be dropped, not re-asked: ${JSON.stringify(result.dialogueState.open)}`);
});
