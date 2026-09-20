// PO dispatch 2026-09-20, THIRD attempt at this same money bug tonight (the
// prior two, fix/hoagie-compound-addon-fresh-add-20260920 and
// fix/half-anchovies-fresh-add-not-dropped-20260920, both landed zero live
// effect for the hoagie shape and left R4 half-anchovies still broken live).
//
// ROOT CAUSE, proven with literal PROPOSE output captured live tonight from
// the `error_log` table (stage `propose_success`), pasted verbatim below —
// NOT a hand-constructed fixture:
//
//   conv cv-hoagie-v571-* — customer_message: "I want an Italian hoagie with
//   shrimp and blackened salmon on wheat bread."
//   proposal.adds: [{"choices": [], "quantity": 1, "item_span": "Italian hoagie"}]
//
//   conv cv-hoagie2-v571-* — customer_message: "I'd like a Tuna Hoagie on
//   wheat bread, please. Can you add shrimp to that?"
//   proposal.adds: [{"choices": [], "quantity": 1, "item_span": "Tuna Hoagie"}]
//
//   conv fec9ae0b-d331-44fe-9a66-3ccf36ca5484 — customer_message: "Can I get
//   a Chicken Bacon Ranch pizza, medium, with half anchovies on it?"
//   proposal.adds: [{"choices": [], "quantity": 1, "item_span": "Chicken Bacon
//   Ranch pizza, medium"}]
//
// The model NEVER puts the add-on/topping text in item_span for this common
// shape, and choices is always empty. Both prior fixes (fc1be11d's
// decomposeSpanIntoChoicesOfMenuItem call site, ba1d45f4's phrase-split
// connector fix) only ever fire when item_span OR the phrase-split machinery
// happens to retain the add-on words — neither ever does here, which is why
// their own test suites are green while live traffic never changed: every
// prior fixture hand-constructed an item_span/phrase shape the real model
// does not produce.
//
// FIX (turn-engine.ts, decide()'s 00-BF fresh-add modifier floor): a new
// `soleAddThisTurn` flag (true only when this add is the ONE item-shaped
// thing anywhere in the turn — no other add, no other pending
// disambiguation) widens the floor's text scope to the FULL raw
// customerMessage instead of trusting phrase-boundary attribution, and lifts
// recoverAssertedChoicesFromText's plural-tie ambiguity guard — safe only
// because with no other item in the turn, two real named Add-ons choices in
// one breath can only mean "add both," never a modifier-plus-second-item
// tie. Confirmed this also fixes R4 (half anchovies): the real captured
// item_span "Chicken Bacon Ranch pizza, medium" made resolveClaimedPhraseIndex
// uniquely (and wrongly) match the bare "medium" comma-phrase alone against
// the real message, scoping the floor down to just that word and erasing
// "half anchovies" before recoverPlacementHits ever saw it.
//
// Runner-level test (runTurnEngineTurn) drives the full path index.ts's
// turn_engine_enabled branch actually uses, per standing methodology — real
// Vito's data only (shop_id e0000000-0000-0000-0000-000000000001, menu_id
// 54a42842-32be-43b5-9e0c-00fae0ce48fc), mocked proposeTurnFn returns EXACTLY
// the captured proposal shapes above, never a hand-improved one.
// index.ts itself is untouched — 0 diff vs main.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── Real Vito's data (shop_id e0000000-0000-0000-0000-000000000001, menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc) ──
// Fetched live 2026-09-20 directly from menu_items.ask_plan / lexicon.

const ITALIAN_HOAGIE_ID = "79de41b9-9418-4cb4-b2a4-4ad73a5fb20f";
const TUNA_HOAGIE_ID = "a5dfc61b-31e0-4936-8a8b-3b0fbf0971eb";
const CBR_MEDIUM_ID = "dca6fae3-2d94-4a18-b0a9-760474cec7c1";

const ITALIAN_HOAGIE: TurnEngineMenuItem = {
  id: ITALIAN_HOAGIE_ID, name: "Italian Hoagie", category: "Cold Sandwiches", price_cents: 999, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Italian Hoagie",
    base_price_cents: 999, recap_template: "", ticket_template: "",
    steps: [
      {
        group_id: "07c7a1b0-4981-439c-9dcc-4b2c6cac3b05", slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
        prompt_template: "bread.ask",
        choices: [
          { id: "1a71cf48-9e05-47dc-95b2-e559f16a0e88", display: "White", price_delta_cents: 0 },
          { id: "9bce3123-885f-4aa5-a225-f7380abf533b", display: "Rye", price_delta_cents: 0 },
          { id: "a49d7c18-752e-4fce-95cc-23c80d2ce76e", display: "Wheat", price_delta_cents: 0 },
        ],
      },
      {
        group_id: "8b9b8e54-9528-4b5b-8ee8-977df125a98f", slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "add-ons.on_request",
        choices: [
          { id: "52e2b62b-03f2-4334-9bd5-5fbcce5112cc", display: "Blackened Salmon", price_delta_cents: 800 },
          { id: "630f6da3-cfe7-4376-9d00-fc4b839a506b", display: "Chicken", price_delta_cents: 400 },
          { id: "e54d4054-60ed-46fc-84d6-b49b4a178379", display: "Black Diamond Steak", price_delta_cents: 800 },
          { id: "fae796b7-8c2c-4264-8c30-4acab394d183", display: "Shrimp", price_delta_cents: 600 },
        ],
      },
    ],
  },
  option_groups: [
    { id: "07c7a1b0-4981-439c-9dcc-4b2c6cac3b05", name: "Bread" },
    { id: "8b9b8e54-9528-4b5b-8ee8-977df125a98f", name: "Add-ons" },
  ],
} as unknown as TurnEngineMenuItem;

const TUNA_HOAGIE: TurnEngineMenuItem = {
  id: TUNA_HOAGIE_ID, name: "Tuna Hoagie", category: "Cold Sandwiches", price_cents: 999, bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "Tuna Hoagie",
    base_price_cents: 999, recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [
      {
        group_id: "7343bc04-5790-4f51-8f1c-44cd7dbdc0b4", slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
        prompt_template: "bread.ask",
        choices: [
          { id: "668f7a60-11e8-4078-94ed-cad60da5c65f", display: "Wheat", price_delta_cents: 0 },
          { id: "740cdbba-5fce-4f89-8eac-aea88fbbd66b", display: "White", price_delta_cents: 0 },
          { id: "d31c4ce2-61c4-4b05-9b95-e4e9b50667e8", display: "Rye", price_delta_cents: 0 },
        ],
      },
      {
        group_id: "bbb27f32-44aa-48cf-b9b4-0e51d677b86b", slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "add-ons.on_request",
        choices: [
          { id: "550d7696-333e-417e-b1dc-11a281d080ea", display: "Blackened Salmon", price_delta_cents: 800 },
          { id: "946ab115-6907-4dc5-9f9e-b30edb562f0a", display: "Black Diamond Steak", price_delta_cents: 800 },
          { id: "a8ab19d1-f2e7-4606-bb52-490b4c505b48", display: "Chicken", price_delta_cents: 400 },
          { id: "c23e3165-b5f2-49c5-a599-971a7663f6ef", display: "Shrimp", price_delta_cents: 600 },
        ],
      },
    ],
  },
  option_groups: [
    { id: "7343bc04-5790-4f51-8f1c-44cd7dbdc0b4", name: "Bread" },
    { id: "bbb27f32-44aa-48cf-b9b4-0e51d677b86b", name: "Add-ons" },
  ],
} as unknown as TurnEngineMenuItem;

// Real ask_plan pulled live from Vito's menu_items.ask_plan (trimmed to the
// choices this fixture exercises — every kept choice/price is verbatim real
// data, same rows the R4 fix (ba1d45f4) already used for this item).
const CBR_MEDIUM: TurnEngineMenuItem = {
  id: CBR_MEDIUM_ID, name: "Chicken Bacon Ranch - Medium (14\")", category: "Pizza", price_cents: 1999,
  size_label: "Medium (14\")", bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T03:45:32.014Z", compiler_version: 1, display_name: "Medium Chicken Bacon Ranch Pizza",
    base_price_cents: 1999, recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [{
      group_id: "4c31b9ef-a2c3-45f7-8a2c-5e70d8af899d", slot_key: null, kind: "modifier", ask_mode: "on_request",
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
  option_groups: [{ id: "4c31b9ef-a2c3-45f7-8a2c-5e70d8af899d", name: "Toppings" }],
} as unknown as TurnEngineMenuItem;

const MENU: TurnEngineMenuItem[] = [ITALIAN_HOAGIE, TUNA_HOAGIE, CBR_MEDIUM];

// Real, active lexicon rows for all three target ids (fetched live 2026-09-20).
const LEXICON = [
  { term: "italian hoagie", target_id: ITALIAN_HOAGIE_ID },
  { term: "tuna hoagie", target_id: TUNA_HOAGIE_ID },
  { term: "chicken bacon ranch pizza", target_id: CBR_MEDIUM_ID },
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
  return { from: (table: string) => builder(table) } as any as SupabaseClient;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-repro",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-repro",
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
    // deno-lint-ignore no-explicit-any
  } as any;
}

function proposeExactly(proposal: unknown): RunTurnDeps["proposeTurnFn"] {
  // deno-lint-ignore no-explicit-any
  return (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: proposal as any });
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Real captured conv cv-hoagie-v571-*: "I want an Italian hoagie with
//    shrimp and blackened salmon on wheat bread." — item_span "Italian
//    hoagie", choices: [] verbatim.
// ═══════════════════════════════════════════════════════════════════════
Deno.test("runner-level (real captured PROPOSE output, cv-hoagie-v571-*): Italian Hoagie lands with BOTH Shrimp and Blackened Salmon applied, correct total", async () => {
  const supabase = makeFakeSupabase();
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "I want an Italian hoagie with shrimp and blackened salmon on wheat bread." }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeExactly({
        adds: [{ choices: [], quantity: 1, item_span: "Italian hoagie" }],
        intent: "order", removes: [], modifies: [],
      }),
    },
  );

  const lines = t1.cart.filter(l => l.menu_item_id === ITALIAN_HOAGIE_ID);
  assertEquals(lines.length, 1, `expected exactly one Italian Hoagie line — got ${JSON.stringify(t1.cart)}`);
  const hoagie = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  const addonTexts = hoagie.options?.["Add-ons"] ?? [];
  assertEquals([...addonTexts].sort(), ["Blackened Salmon", "Shrimp"].sort(),
    `both real add-ons named in the raw message must land, neither silently dropped — got ${JSON.stringify(hoagie.options)}`);
  assertEquals(hoagie.price_cents, 999 + 800 + 600,
    `$9.99 base + Shrimp $6.00 + Blackened Salmon $8.00 = $23.99 — got ${JSON.stringify(hoagie)}`);

  // Bonus (not mandatory): bread slot from the same message. Slots are
  // ASKED, never inferred — a standing invariant elsewhere in this
  // codebase — so this is flagged, not asserted, as expected non-coverage.
  const optionsJson = JSON.stringify(hoagie.options ?? {});
  if (!optionsJson.includes("Wheat")) {
    console.log("NOTE (bonus, not covered by this fix): bread slot ('on wheat bread') is not inferred from the raw message — slots are ASKED, never inferred, unchanged by this fix. Reply:", t1.reply);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Real captured conv cv-hoagie2-v571-*: "I'd like a Tuna Hoagie on
//    wheat bread, please. Can you add shrimp to that?" — item_span "Tuna
//    Hoagie", choices: [] verbatim. The add-on words sit in a SEPARATE
//    sentence, referenced by pronoun ("that"), never in the same
//    comma-phrase as the item name at all.
// ═══════════════════════════════════════════════════════════════════════
Deno.test("runner-level (real captured PROPOSE output, cv-hoagie2-v571-*): Tuna Hoagie lands with Shrimp applied even though the add-on is a separate, pronoun-referenced sentence", async () => {
  const supabase = makeFakeSupabase();
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "I'd like a Tuna Hoagie on wheat bread, please. Can you add shrimp to that?" }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeExactly({
        adds: [{ choices: [], quantity: 1, item_span: "Tuna Hoagie" }],
        intent: "order", removes: [], modifies: [],
      }),
    },
  );

  const lines = t1.cart.filter(l => l.menu_item_id === TUNA_HOAGIE_ID);
  assertEquals(lines.length, 1, `expected exactly one Tuna Hoagie line — got ${JSON.stringify(t1.cart)}`);
  const hoagie = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  const addonTexts = hoagie.options?.["Add-ons"] ?? [];
  assertEquals(addonTexts, ["Shrimp"],
    `Shrimp, named in a later sentence via "add shrimp to that," must still land — got ${JSON.stringify(hoagie.options)}`);
  assertEquals(hoagie.price_cents, 999 + 600, `$9.99 base + Shrimp $6.00 = $15.99 — got ${JSON.stringify(hoagie)}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Real captured conv fec9ae0b-d331-44fe-9a66-3ccf36ca5484 (R4, half
//    anchovies, reopened): "Can I get a Chicken Bacon Ranch pizza, medium,
//    with half anchovies on it?" — item_span "Chicken Bacon Ranch pizza,
//    medium", choices: [] verbatim, pulled directly from error_log
//    (stage propose_success) tonight.
// ═══════════════════════════════════════════════════════════════════════
Deno.test("runner-level (real captured PROPOSE output, conv fec9ae0b, R4 half-anchovies reopened): Medium CBR pizza lands with Anchovies applied as HALF, correct total", async () => {
  const supabase = makeFakeSupabase();
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "Can I get a Chicken Bacon Ranch pizza, medium, with half anchovies on it?" }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeExactly({
        adds: [{ choices: [], quantity: 1, item_span: "Chicken Bacon Ranch pizza, medium" }],
        intent: "order", removes: [], modifies: [],
      }),
    },
  );

  const lines = t1.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(lines.length, 1, `expected exactly one Medium CBR line — got ${JSON.stringify(t1.cart)}`);
  const cbr = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  const optionsJson = JSON.stringify(cbr.options ?? {});
  assert(optionsJson.includes("Anchovies (Half pizza)"),
    `Anchovies must be applied as HALF, matching "half anchovies" in the raw message — got ${optionsJson}`);
  assert(!optionsJson.includes("Anchovies (Whole pizza)"), `Anchovies must NOT be applied as whole — got ${optionsJson}`);
  assertEquals(cbr.price_cents, 1999 + 350, `$19.99 base + Anchovies Half $3.50 = $23.49 — got ${JSON.stringify(cbr)}`);
});
