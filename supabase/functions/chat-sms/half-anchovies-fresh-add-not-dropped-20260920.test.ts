// PO dispatch (2026-09-20), REAL LIVE MONEY BUG (R4, reopened), conv
// 3ea2d604 #14. Real Vito's data: Medium Chicken Bacon Ranch Pizza $19.99
// (dca6fae3-2d94-4a18-b0a9-760474cec7c1, real Anchovies Half/Whole toppings),
// Veggie Wrap $9.99 (dc01181b-8e9c-4468-ba96-e32a51af5d89, real wrap-type
// slot + add-ons modifier). A FRESH order line (never a restatement of an
// existing cart line -- that is R1/R3's own territory) names a topping in
// the SAME phrase as the base item: "a Chicken Bacon Ranch pizza, medium
// size, with half anchovies? Also, a Veggie wrap on wheat tortilla." Actual
// (broken, confirmed RED against pre-fix code): Medium CBR added at $19.99
// flat, no anchovies, no decline, no trace -- silently dropped.
//
// ROOT CAUSE (confirmed via decide() directly against the FULL real Vito's
// menu + lexicon before writing this fixture -- see this dispatch's own
// warning that a synthetic/trimmed menu previously produced a false
// "doesn't reproduce"): phrase-split.ts's splitCustomerPhrases only ever
// split on a bare comma, so "...anchovies? Also, a Veggie wrap..." split
// into "...anchovies? Also" and "a Veggie wrap...", NOT the intended
// "...anchovies?" and "Also, a Veggie wrap...". The word "Also" fused onto
// the END of the topping phrase, so it no longer matched the model's
// item_span claim ("...with half anchovies", no "also") in
// resolveClaimedPhraseIndex's word-run test -- while the neighboring bare
// "medium size" phrase matched perfectly and won as the (wrongly) UNIQUE
// claimed phrase. scopedModifierText then scoped the 00-BF modifier floor
// down to just "medium size", erasing "half anchovies" before the floor
// (recoverAssertedChoicesFromText / recoverPlacementHits -- the same
// "half"-qualifier-reading machinery the gyro-guard fix, bc35b4cd, taught to
// read real customer text) ever saw it. This is the SAME class of gap as
// bc35b4cd (a placement/topping mention lost before the qualifier-reading
// machinery runs), but at a different call site: bc35b4cd's own bug was a
// phantom SECOND item stealing the qualifier read; this bug is a phrase-
// boundary defect on a genuinely fresh, single-item add that never involves
// a second phantom item at all.
//
// FIX: phrase-split.ts's PHRASE_SEPARATOR_RE now also splits BEFORE a
// trailing connector word ("also"/"additionally"/"plus") that sits directly
// before its own comma -- the same treatment "and" already gets before a
// quantity/article -- so the connector can never fuse onto the preceding
// phrase again. No new qualifier-reading logic was needed or duplicated:
// once the scoped text (or, on genuine ambiguity, the unscoped fallback
// text this function already had) actually contains "half anchovies",
// recoverPlacementHits' existing "half" read applies unchanged.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const CBR_MEDIUM_ID = "dca6fae3-2d94-4a18-b0a9-760474cec7c1";
const VEGGIE_WRAP_ID = "dc01181b-8e9c-4468-ba96-e32a51af5d89";
const TOPPINGS_GROUP_ID = "4c31b9ef-a2c3-45f7-8a2c-5e70d8af899d";
const WRAP_TYPE_GROUP_ID = "e84c2449-33ea-49ba-b4de-610dcd2f7dce";

// Real ask_plan pulled live from Vito's menu_items.ask_plan for both ids
// (fetched 2026-09-20 against the live shop). Trimmed to the choices this
// fixture actually exercises -- every kept choice/price is verbatim real
// data.
const CBR_MEDIUM: TurnEngineMenuItem = {
  id: CBR_MEDIUM_ID,
  name: "Chicken Bacon Ranch - Medium (14\")",
  category: "Pizza",
  price_cents: 1999,
  size_label: "Medium (14\")",
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T03:45:32.014Z",
    compiler_version: 1,
    display_name: "Medium Chicken Bacon Ranch Pizza",
    base_price_cents: 1999,
    recap_template: "{qty} {display_name}{, with {modifiers}}",
    ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [{
      group_id: TOPPINGS_GROUP_ID,
      slot_key: null,
      kind: "modifier",
      ask_mode: "on_request",
      prompt_template: "toppings.on_request",
      choices: [
        { id: "549cdbca-dc74-4125-ba5f-e48feb66d0f2", display: "Pepperoni (Half pizza)", price_delta_cents: 350 },
        { id: "a4baa5c2-be0f-4d02-b437-be6ff7bfcc12", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
        { id: "8c2f3afe-2477-4d84-9d0e-78e4512f2bac", display: "Bacon (Half pizza)", price_delta_cents: 350 },
        { id: "d75aa2c2-0469-4d2b-8256-c3260d663e03", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
        { id: "6f9cefbb-fec7-4d9d-9b9c-b55984d60a77", display: "Anchovies (Half pizza)", price_delta_cents: 350 },
        { id: "ebbb1eba-80e0-48e7-a5cb-5eb4ed7940e3", display: "Anchovies (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPINGS_GROUP_ID, name: "Toppings" }],
} as unknown as TurnEngineMenuItem;

const VEGGIE_WRAP: TurnEngineMenuItem = {
  id: VEGGIE_WRAP_ID,
  name: "Veggie",
  category: "Wraps",
  price_cents: 999,
  size_label: null,
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T04:42:49.794Z",
    compiler_version: 1,
    display_name: "Veggie Wrap",
    base_price_cents: 999,
    recap_template: "{qty} {display_name}{, with {modifiers}}",
    ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [
      {
        group_id: WRAP_TYPE_GROUP_ID,
        slot_key: null,
        kind: "slot",
        ask_mode: "ask",
        prompt_template: "wrap_type.ask",
        choices: [
          { id: "22b37115-9392-4667-aa55-37a06c501a40", display: "Wheat Tortilla", price_delta_cents: 0 },
          { id: "ba66a52f-37ff-4498-84eb-a8ab73921217", display: "Flour Tortilla", price_delta_cents: 0 },
        ],
      },
    ],
  },
  option_groups: [{ id: WRAP_TYPE_GROUP_ID, name: "Wrap Type" }],
} as unknown as TurnEngineMenuItem;

const MENU: TurnEngineMenuItem[] = [CBR_MEDIUM, VEGGIE_WRAP];

// Real lexicon rows for both target ids (fetched live 2026-09-20).
const LEXICON = [
  { term: "chicken bacon ranch", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "medium chicken bacon ranch pizza", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "veggie", target_id: VEGGIE_WRAP_ID, category: "Wraps", size_label: null },
  { term: "veggie wrap", target_id: VEGGIE_WRAP_ID, category: "Wraps", size_label: null },
];

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
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
          .map(m => ({ id: m.id, category: m.category, size_label: (m as unknown as { size_label?: string }).size_label ?? null, bot_state: m.bot_state }));
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
  return { from: (table: string) => builder(table) } as any;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-3ea2d604",
    shopId: "shop-vitos",
    tenantId: "shop-vitos",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 },
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function proposeAdds(spans: Array<{ item_span: string; quantity?: number }>): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true,
    attempts: 1,
    proposal: {
      intent: "order",
      adds: spans.map(s => ({ item_span: s.item_span, quantity: s.quantity ?? 1, choices: [] })),
      removes: [], modifies: [],
    },
  });
}

Deno.test("runner-level (real live money bug, real Vito's data, conv 3ea2d604 #14): fresh add 'a Chicken Bacon Ranch pizza, medium size, with half anchovies? Also, a Veggie wrap...' must apply Anchovies HALF, never silently drop it", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "Hey! Can I get a Chicken Bacon Ranch pizza, medium size, with half anchovies? Also, a Veggie wrap on wheat tortilla. Thanks!" }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "a Chicken Bacon Ranch pizza, medium size, with half anchovies" },
        { item_span: "a Veggie wrap on wheat tortilla" },
      ]),
    },
  );

  const cbrLines = turn1.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrLines.length, 1, `must be exactly ONE Medium CBR line: ${JSON.stringify(turn1.cart)}`);
  const optionsJson = JSON.stringify(cbrLines[0].options ?? {});
  assert(optionsJson.includes("Anchovies (Half pizza)"), `Anchovies must be applied as HALF, matching the customer's own words, never silently dropped: ${optionsJson}, price=${cbrLines[0].price_cents}`);
  assert(!optionsJson.includes("Anchovies (Whole pizza)"), `Anchovies must NOT be applied as whole: ${optionsJson}`);
  assertEquals(cbrLines[0].price_cents, 2349, `Medium CBR ($19.99) + Anchovies Half ($3.50) = $23.49 exactly: ${JSON.stringify(cbrLines[0])}`);
  assertEquals(cbrLines[0].quantity, 1);

  const wrapLines = turn1.cart.filter(l => l.menu_item_id === VEGGIE_WRAP_ID);
  assertEquals(wrapLines.length, 1, "the unrelated Veggie Wrap line must still be seeded, untouched by the CBR fix");
  assertEquals(wrapLines[0].price_cents, 999);
});

// The PO's own single-item repro shape (no second item, no "Also,"
// connector) -- confirmed to already pass before this fix (the phrase-split
// defect above only triggers with a second item's connector word fusing
// onto the topping phrase) and must keep passing after it.
Deno.test("runner-level (single-item fresh add, real Vito's data): 'a Chicken Bacon Ranch pizza, medium, with half anchovies on it' with no second item applies Anchovies HALF", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "a Chicken Bacon Ranch pizza, medium, with half anchovies on it" }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "a Chicken Bacon Ranch pizza, medium, with half anchovies on it" },
      ]),
    },
  );

  const cbrLines = turn1.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrLines.length, 1, `must be exactly ONE Medium CBR line: ${JSON.stringify(turn1.cart)}`);
  const optionsJson = JSON.stringify(cbrLines[0].options ?? {});
  assert(optionsJson.includes("Anchovies (Half pizza)"), `Anchovies must be applied as HALF: ${optionsJson}`);
  assertEquals(cbrLines[0].price_cents, 2349, `$19.99 + $3.50 half anchovies = $23.49: ${JSON.stringify(cbrLines[0])}`);
});
