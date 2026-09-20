// PO dispatch (2026-09-20, real live conv, Vito's v580): 2x Medium Buffalo
// Chicken Pizza, dressing slot already resolved to Ranch, sauce slot ("Hot,
// Mild, or BBQ") still open. Customer: "The ranch is good, no bleu cheese,
// just the ranch on both." Actual (broken): the bot replied `We don't have
// "both" for Medium Buffalo Chicken Pizza. The options are: Hot, Mild, or
// BBQ.` — turn-engine-runner.ts's own slot-miss echo path
// (extractSlotChoiceWords, turn-engine.ts) extracted "both" via its
// with/on-clause branch ("ranch ON both" -> "both") and quoted it back as an
// attempted (invalid) sauce choice, even though the customer was reaffirming
// ranch across both units and never named a sauce at all.
//
// Fix: extractSlotChoiceWords now recognizes a bare "both"/"each"/"all"
// (optionally "... of them") as a QUANTIFIER — how many cart units a choice
// applies to, never a candidate slot value — and returns "" instead, which
// the caller (turn-engine-runner.ts) treats identically to no candidate
// found: no echoed rejection, the slot stays open unresolved.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch uses — never answer() or extractSlotChoiceWords called in
// isolation for the end-to-end case.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import { extractSlotChoiceWords } from "./turn-engine.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const BUFFALO_ID = "buffalo-chicken-med";
const DRESSING_GROUP_ID = "buffalo-dressing-group";
const SAUCE_GROUP_ID = "buffalo-sauce-group";
const BUFFALO_LINE_KEY = "line-buffalo-1";

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
        {
          kind: "slot", ask_mode: "ask", group_id: SAUCE_GROUP_ID, slot_key: "sauce", prompt_template: "sauce.ask",
          choices: [
            { id: "sauce-hot", display: "Hot", price_delta_cents: 0 },
            { id: "sauce-mild", display: "Mild", price_delta_cents: 0 },
            { id: "sauce-bbq", display: "BBQ", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

function cartBefore(): TurnEngineCartLine[] {
  return [
    {
      menu_item_id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", quantity: 2, price_cents: 1999,
      modifiers: [], line_key: BUFFALO_LINE_KEY,
      ask_plan_selections: { [DRESSING_GROUP_ID]: "dressing-ranch" },
    } as unknown as TurnEngineCartLine,
  ];
}

const SAUCE_SLOT_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "slot", line_key: BUFFALO_LINE_KEY, group_id: SAUCE_GROUP_ID },
  upsell_offered: false, asked_message_id: null,
};

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-both-quantifier-repro",
    shopId: "shop-1",
    tenantId: "shop-1",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: cartBefore(),
    dialogueState: SAUCE_SLOT_STATE,
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

Deno.test("runner-level (real conv, Vito's v580): 'ranch on both' never rejected as a sauce value, sauce slot stays open, ranch untouched", async () => {
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
    baseInput({ message: "The ranch is good, no bleu cheese, just the ranch on both." }),
    deps,
  );
  assertEquals(proposeCalls, 0, "must resolve deterministically inside ANSWER, never reach PROPOSE");
  assert(!/we don't have/i.test(result.reply), `must never produce a rejection reply: ${JSON.stringify(result.reply)}`);
  assert(!/"both"/i.test(result.reply), `must never echo "both" back: ${JSON.stringify(result.reply)}`);
  assert(
    result.dialogueState.open?.kind === "slot" &&
    (result.dialogueState.open as { group_id: string }).group_id === SAUCE_GROUP_ID,
    `sauce slot must remain open exactly as it was: ${JSON.stringify(result.dialogueState.open)}`,
  );
  const buffalo = result.cart[0] as unknown as { ask_plan_selections?: Record<string, string> };
  assertEquals(buffalo.ask_plan_selections?.[DRESSING_GROUP_ID], "dressing-ranch", "ranch must remain untouched");
  assertEquals(buffalo.ask_plan_selections?.[SAUCE_GROUP_ID], undefined, "sauce must remain unresolved");
});

Deno.test("extractSlotChoiceWords: bare 'both' (via the on-clause) returns '' — a quantifier, never an attempted slot value", () => {
  assertEquals(extractSlotChoiceWords("just the ranch on both"), "");
});

Deno.test("extractSlotChoiceWords: bare 'each'/'all' and the 'of them' variant also return ''", () => {
  assertEquals(extractSlotChoiceWords("put it on each"), "");
  assertEquals(extractSlotChoiceWords("ranch on all"), "");
  assertEquals(extractSlotChoiceWords("ranch on both of them"), "");
});

Deno.test("extractSlotChoiceWords regression: a real value that merely CONTAINS 'all' as a substring is untouched — 'on a small' -> 'a small'", () => {
  assertEquals(extractSlotChoiceWords("Can I get that on a small"), "a small");
});

Deno.test("extractSlotChoiceWords regression: prior with/for/on and filler-strip behavior is unchanged", () => {
  assertEquals(extractSlotChoiceWords("creamy italian dressing for the house salad"), "creamy italian dressing");
  assertEquals(extractSlotChoiceWords("cream dressin"), "cream dressin");
  assertEquals(extractSlotChoiceWords("Can I get that on a regular hoagie roll?"), "a regular hoagie roll");
  assertEquals(extractSlotChoiceWords("Got it! I already said ranch, thanks!"), "ranch");
});

Deno.test("regression: a genuine listed choice literally named 'Both' still resolves normally — the quantifier strip never runs, because the direct match already succeeds before extractSlotChoiceWords is ever reached", async () => {
  const BOTH_GROUP_ID = "toppings-both-group";
  const menuWithBothChoice: TurnEngineMenuItem[] = [
    {
      id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", category: "Pizza", price_cents: 1999,
      bot_state: "orderable",
      ask_plan: {
        compiled_at: "", compiler_version: 1, display_name: "Medium Buffalo Chicken Pizza", base_price_cents: 1999,
        recap_template: "", ticket_template: "",
        steps: [
          {
            kind: "slot", ask_mode: "ask", group_id: BOTH_GROUP_ID, slot_key: "toppings_side", prompt_template: "toppings_side.ask",
            choices: [
              { id: "side-left", display: "Left Half", price_delta_cents: 0 },
              { id: "side-right", display: "Right Half", price_delta_cents: 0 },
              { id: "side-both", display: "Both", price_delta_cents: 0 },
            ],
          },
        ],
      },
    },
  ];
  const openBothState: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: BUFFALO_LINE_KEY, group_id: BOTH_GROUP_ID },
    upsell_offered: false, asked_message_id: null,
  };
  const cart: TurnEngineCartLine[] = [
    {
      menu_item_id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", quantity: 1, price_cents: 1999,
      modifiers: [], line_key: BUFFALO_LINE_KEY, ask_plan_selections: {},
    } as unknown as TurnEngineCartLine,
  ];
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> =>
      Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } }),
  };
  const result = await runTurnEngineTurn(
    {
      conversationId: "conv-both-real-choice",
      shopId: "shop-1", tenantId: "shop-1", cartId: "cart-1",
      message: "both", history: [], menu: menuWithBothChoice, cart,
      dialogueState: openBothState,
      shopContext: {
        deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
        driverTipCents: null, pickupName: null, deliveryFeeCents: null,
      },
    },
    deps,
  );
  const line = result.cart[0] as unknown as { ask_plan_selections?: Record<string, string> };
  assertEquals(line.ask_plan_selections?.[BOTH_GROUP_ID], "side-both", `a real 'Both' choice must still resolve: ${JSON.stringify(result.reply)}`);
  assert(!/we don't have/i.test(result.reply), `a genuine match must never be rejected: ${JSON.stringify(result.reply)}`);
});
