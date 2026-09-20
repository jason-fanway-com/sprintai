// PO dispatch (2026-09-19), MONEY BUG N1, real live conv 624967ed (#16):
// a "Bleu Cheese or Ranch?" dressing slot is open on 2x Medium Buffalo
// Chicken Pizza. Customer replies "I'd like ranch with the Buffalo Chicken
// pizzas, please! Don't forget the Medium Gluten-Free Pizza too." Actual
// (broken): the bot removed the ENTIRE Buffalo Chicken line ("Medium Buffalo
// Chicken Pizza removed"), dropping the subtotal from $55.48 to $15.50 —
// error_log confirms no PROPOSE call happened this turn, so this is entirely
// the slot-answer path's own isNamedSlotItemRejection (turn-engine.ts): its
// SLOT_ITEM_REJECTION_CUES matched "forget" (and "don't") anywhere in the
// message, and its name-stem check ran against the WHOLE message rather than
// the clause the cue actually came from, so "Buffalo"/"Chicken" — named
// affirmatively in an EARLIER, unrelated clause — satisfied the stem match
// for a cue that was actually about a totally different item (the
// Gluten-Free pizza) and was itself a NEGATED verb ("don't forget" means
// keep, not decline).
//
// Fix: isNamedSlotItemRejection now (1) never treats a negated decline verb
// ("don't forget"/"don't remove"/"never mind removing") as removal language,
// and (2) scopes the name/category-stem match to the SAME clause the decline
// cue itself appears in, never the whole message.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch uses — never answer() called directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const BUFFALO_ID = "buffalo-chicken-med";
const GLUTEN_FREE_ID = "gluten-free-med";
const DRESSING_GROUP_ID = "buffalo-dressing-group";
const BUFFALO_LINE_KEY = "line-buffalo-1";
const GLUTEN_FREE_LINE_KEY = "line-gf-1";

const MENU: TurnEngineMenuItem[] = [
  {
    id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", category: "Pizza", price_cents: 1999,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Medium Buffalo Chicken Pizza", base_price_cents: 1999,
      recap_template: "", ticket_template: "",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: DRESSING_GROUP_ID, slot_key: "dressing", prompt_template: "dressing.ask",
          choices: [
            { id: "dressing-bleu-cheese", display: "Bleu Cheese", price_delta_cents: 0 },
            { id: "dressing-ranch", display: "Ranch", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
  {
    id: GLUTEN_FREE_ID, name: "Medium Gluten-Free Pizza", category: "Pizza", price_cents: 1550,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Medium Gluten-Free Pizza", base_price_cents: 1550,
      recap_template: "", ticket_template: "", steps: [],
    },
  },
];

function cartBefore(): TurnEngineCartLine[] {
  return [
    { menu_item_id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", quantity: 2, price_cents: 1999, modifiers: [], line_key: BUFFALO_LINE_KEY, ask_plan_selections: {} } as unknown as TurnEngineCartLine,
    { menu_item_id: GLUTEN_FREE_ID, name: "Medium Gluten-Free Pizza", quantity: 1, price_cents: 1550, modifiers: [], line_key: GLUTEN_FREE_LINE_KEY } as unknown as TurnEngineCartLine,
  ];
}

const DRESSING_SLOT_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "slot", line_key: BUFFALO_LINE_KEY, group_id: DRESSING_GROUP_ID },
  upsell_offered: false, asked_message_id: null,
};

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-624967ed-repro",
    shopId: "shop-1",
    tenantId: "shop-1",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: cartBefore(),
    dialogueState: DRESSING_SLOT_STATE,
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
      range() { return Promise.resolve({ data: [], error: null }); },
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

Deno.test("N1 runner-level (real conv 624967ed #16): \"don't forget the Medium Gluten-Free Pizza too\" never removes the Buffalo Chicken line the open dressing slot is about", async () => {
  const supabase = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
    },
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "I'd like ranch with the Buffalo Chicken pizzas, please! Don't forget the Medium Gluten-Free Pizza too." }),
    deps,
  );
  assertEquals(proposeCalls, 0, "the dressing slot answer must resolve deterministically, never reaching PROPOSE");
  assertEquals(result.cart.length, 2, `both lines must survive: ${JSON.stringify(result.cart)}`);
  const buffalo = result.cart.find(l => l.menu_item_id === BUFFALO_ID);
  const glutenFree = result.cart.find(l => l.menu_item_id === GLUTEN_FREE_ID);
  assert(buffalo, `Buffalo Chicken Pizza line must NOT be removed: ${JSON.stringify(result.cart)}`);
  assert(glutenFree, `Gluten-Free Pizza line must still be present: ${JSON.stringify(result.cart)}`);
  assertEquals(buffalo!.quantity, 2, "quantity must stay at 2");
  assertEquals(
    (buffalo as unknown as { ask_plan_selections?: Record<string, string> }).ask_plan_selections?.[DRESSING_GROUP_ID],
    "dressing-ranch",
    "the dressing slot must resolve to Ranch",
  );
  assert(!/removed/i.test(result.reply), `reply must never say anything was removed: ${JSON.stringify(result.reply)}`);
  // $19.99 x 2 + $15.50 = $55.48, exactly the real live subtotal before the bug fired.
  assert(result.reply.includes("55.48") || /subtotal/i.test(result.reply), `subtotal must reflect both lines still present: ${JSON.stringify(result.reply)}`);
});

Deno.test("N1 regression (unaffected): a genuine named decline of the open slot's own item still removes it", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "No, forget the buffalo chicken pizza" }),
    deps,
  );
  assertEquals(result.cart.length, 1, `Buffalo Chicken line must be removed, Gluten-Free untouched: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, GLUTEN_FREE_ID);
});
