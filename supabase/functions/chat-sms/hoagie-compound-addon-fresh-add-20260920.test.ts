// PO dispatch 2026-09-20, real live bug, confirmed directly against real
// Vito's data (shop_id e0000000-0000-0000-0000-000000000001, menu_id
// 54a42842-32be-43b5-9e0c-00fae0ce48fc): "I want an Italian hoagie with
// shrimp and blackened salmon on wheat bread." -- bot replied "Italian
// Hoagie added" at $9.99, then asked "What bread for the Italian Hoagie?"
// -- the shrimp and blackened salmon add-ons named in the SAME phrase were
// completely dropped: no mention, no charge, no decline.
//
// A DIFFERENT, ALREADY-LANDED bug in the SAME real conversation (6de8bd13,
// fix/none-of-those-widen-decline-and-w2-addons-20260919, merged d7f0720b)
// fixed this exact wording -- but only for the PROPOSE SHAPE actually
// captured live that night, where PROPOSE split the add-ons into a SEPARATE
// top-level `add` (item_span "shrimp and blackened salmon on wheat bread").
// That fix (decomposeSpanIntoChoicesOfMenuItem / spanFoldTargetForAmbiguous-
// OrUnresolvedSpan) only ever runs on an ambiguous/unresolved SIBLING add's
// own span -- it never reaches an add whose item_span already names the
// host item directly, so it can't cover THIS repro's shape (confirmed by
// tracing spanFoldTargetForAmbiguousOrUnresolvedSpan's own call site: it is
// only invoked against ambiguousSpansFiltered, never against a resolved
// add's own item_span).
//
// THIS repro's PROPOSE shape keeps everything in ONE combined item_span
// ("Italian hoagie with shrimp and blackened salmon on wheat bread"),
// exactly like the W2 fix's own shape (fix/addons-named-with-item-not-
// dropped-20260919, EXPLICIT_MULTI_ADDON_RE) -- but W2's own tie-guard
// relaxation requires the literal word "added" in the text
// ("...and Chicken added"), which this message never contains, so W2 leaves
// the two plain (non-placement) Add-ons choices ("Shrimp", "Blackened
// Salmon") tied and drops both, silently -- the same "sausage and onions"
// shape recoverAssertedChoicesFromText's own plural tie-guard deliberately
// still protects (unit-pinned in pepperoni-warts-20260919.test.ts and
// addon-named-with-item-20260919.test.ts, both still passing, untouched by
// this fix).
//
// FIX: widens the SAME B2 mechanism (decomposeSpanIntoChoicesOfMenuItem) to
// also run, as a first-pass check, against THIS add's own item_span (not a
// sibling's), inside decide()'s 00-BF fresh-add modifier floor. When the
// item_span fully decomposes -- zero leftover, against every one of the
// SAME item's own real ask_plan choices (Add-ons AND its bread slot, so
// "wheat" accounts for "on wheat bread") -- that is stronger, more specific
// proof of intentional enumeration than a bare 2-choice tie, and the
// decomposed choices are applied directly, bypassing the per-step loop's
// plural tie-guard for this add only. When decomposition does NOT fully
// succeed (a leftover word, or nothing to decompose), the existing per-step
// loop runs exactly as before -- the "sausage and onions" contract is
// untouched, since that call is unreached whenever decomposition fails.
//
// Root cause difference, precisely: the B2 fix's decomposition call site is
// gated on span-level ITEM ambiguity (a sibling add whose own item_span
// never resolved to a real item or tied across several); this fix's call
// site is gated on nothing but the host add's own item_span, because in
// THIS shape there never was a second, separate, ambiguous add to begin
// with -- the whole compound phrase already resolved to ONE add, ONE real
// item, on its first pass through resolveItem.
//
// Real Vito's data used throughout, copied verbatim from the B2 fix's own
// test file (none-of-those-widen-and-shrimp-addon-compound-span-20260919
// .test.ts, itself pulled live 2026-09-20): Italian Hoagie's real ask_plan
// (Bread slot: White/Rye/Wheat; Add-ons modifier group, ask_mode
// "on_request": Blackened Salmon $8.00, Chicken $4.00, Black Diamond Steak
// $8.00, Shrimp $6.00), and the real "shrimp" lexicon collision (Southwest
// Shrimp / Boom Boom Shrimp) -- confirming this fix does NOT open a phantom
// item disambiguation either, even though bare "shrimp" genuinely ties two
// other real items on the live menu.
//
// Runner-level test (runTurnEngineTurn) drives the full path index.ts's
// turn_engine_enabled branch actually uses, per standing methodology
// (real Vito's data only, no synthetic menus, runner-level proof).
// index.ts itself is untouched -- 0 diff vs main.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  recoverAssertedChoicesFromText,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";
import {
  runTurnEngineTurn,
  type RunTurnDeps,
  type RunTurnInput,
  type RunTurnShopContext,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── Real Vito's data (shop_id e0000000-0000-0000-0000-000000000001, menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc) ──

const ITALIAN_HOAGIE_ID = "79de41b9-9418-4cb4-b2a4-4ad73a5fb20f";
const SOUTHWEST_SHRIMP_ID = "15d09f9d-66e3-4f6a-88b4-27b1b9f83696"; // Wraps — real active "shrimp" lexicon collision
const BOOM_BOOM_SHRIMP_ID = "31b9e812-51d0-4732-93bb-10a7ed3769bb"; // Appetizers — the other real "shrimp" collision

const BREAD_GROUP = "07c7a1b0-4981-439c-9dcc-4b2c6cac3b05";
const ADDONS_GROUP = "8b9b8e54-9528-4b5b-8ee8-977df125a98f";

const ITALIAN_HOAGIE: TurnEngineMenuItem = {
  id: ITALIAN_HOAGIE_ID, name: "Italian Hoagie", category: "Cold Sandwiches", price_cents: 999, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Italian Hoagie",
    base_price_cents: 999, recap_template: "", ticket_template: "",
    steps: [
      {
        group_id: BREAD_GROUP, slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
        prompt_template: "bread.ask",
        choices: [
          { id: "1a71cf48-9e05-47dc-95b2-e559f16a0e88", display: "White", price_delta_cents: 0 },
          { id: "9bce3123-885f-4aa5-a225-f7380abf533b", display: "Rye", price_delta_cents: 0 },
          { id: "a49d7c18-752e-4fce-95cc-23c80d2ce76e", display: "Wheat", price_delta_cents: 0 },
        ],
      },
      {
        group_id: ADDONS_GROUP, slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
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
    { id: BREAD_GROUP, name: "Bread" },
    { id: ADDONS_GROUP, name: "Add-ons" },
  ],
};

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const SOUTHWEST_SHRIMP = realItem(SOUTHWEST_SHRIMP_ID, "Southwest Shrimp", "Wraps", 1299);
const BOOM_BOOM_SHRIMP = realItem(BOOM_BOOM_SHRIMP_ID, "Boom Boom Shrimp", "Appetizers", 1199);

const MENU: TurnEngineMenuItem[] = [ITALIAN_HOAGIE, SOUTHWEST_SHRIMP, BOOM_BOOM_SHRIMP];

const LEXICON = [
  { term: "italian hoagie", target_id: ITALIAN_HOAGIE_ID },
  { term: "italian hoagies", target_id: ITALIAN_HOAGIE_ID },
  { term: "shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "southwest shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "boom boom shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
];

const MESSAGE = "I want an Italian hoagie with shrimp and blackened salmon on wheat bread.";

// This exact combined-span shape (NOT the B2 fix's split-add shape) is what
// I confirmed directly, live, against real Vito's data before writing this
// fix -- PROPOSE keeps the add-ons in the SAME item_span as the host item.
const PROPOSAL: Proposal = {
  intent: "order", removes: [], modifies: [],
  adds: [{ item_span: "Italian hoagie with shrimp and blackened salmon on wheat bread", quantity: 1, choices: [] }],
};

Deno.test("decide() (real fresh-add repro): both real add-ons land on the hoagie, priced, no phantom shrimp item, bread still asked normally", () => {
  const out = decide(PROPOSAL, [], MENU, LEXICON, () => "line-1", MESSAGE);

  assertEquals(out.disambiguationCandidateIds, null,
    `a compound add-on mention must never open a phantom item disambiguation — got ${JSON.stringify(out.disambiguationCandidateIds)}`);

  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  const hoagieLines = lines.filter(l => l.menu_item_id === ITALIAN_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Italian Hoagie line — got ${JSON.stringify(out.cart)}`);

  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]>; pending_options?: string[] };
  assertEquals(hoagie.price_cents, 999 + 800 + 600,
    `both add-on price deltas (Blackened Salmon $8.00 + Shrimp $6.00) must be applied on top of the $9.99 base — got ${JSON.stringify(hoagie)}`);
  const addonTexts = hoagie.options?.["Add-ons"] ?? [];
  assertEquals([...addonTexts].sort(), ["Blackened Salmon", "Shrimp"].sort(),
    `both named add-ons must appear in the recap, neither silently dropped — got ${JSON.stringify(hoagie.options)}`);

  // Bread is a SLOT, never inferred from the same breath — "slots are
  // ASKED, never inferred" is a standing, repeatedly-tested invariant of
  // this codebase (00-BF's own rule, unchanged by this fix). The bot asking
  // "What bread for the Italian Hoagie?" separately is correct, expected
  // behavior, not part of this bug.
  assert(hoagie.pending_options?.includes("Bread"),
    `Bread must still be asked as its own question, unchanged — got ${JSON.stringify(hoagie.pending_options)}`);

  assert(
    !lines.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may ever land in the cart — got ${JSON.stringify(out.cart)}`,
  );
  assertEquals(out.declines, [], `no decline should fire — every named thing is real — got ${JSON.stringify(out.declines)}`);
});

Deno.test("decide() (regression): the SAME hoagie with NO add-ons named at all still adds cleanly, unaffected by the new decomposition call site", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Italian hoagie", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [], MENU, LEXICON, () => "line-1", "just an Italian hoagie please");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1);
  const hoagie = lines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999, `plain hoagie, no add-on charges — got ${JSON.stringify(hoagie)}`);
  assertEquals(hoagie.options?.["Add-ons"] ?? [], []);
  assertEquals(out.disambiguationCandidateIds, null);
});

Deno.test("decide() (regression): a span naming ONE real choice plus a word that is NOT any real choice never decomposes — falls through to the existing per-step floor exactly as before (recovers the one real choice it can)", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Italian hoagie with shrimp and mayonnaise", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [], MENU, LEXICON, () => "line-1", "Italian hoagie with shrimp and mayonnaise");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  const hoagie = lines.find(l => l.menu_item_id === ITALIAN_HOAGIE_ID) as unknown as
    { price_cents: number; options?: Record<string, string[]> } | undefined;
  assert(hoagie, `hoagie must still land even though decomposition fails on the leftover "mayonnaise" — got ${JSON.stringify(out.cart)}`);
  assertEquals(hoagie!.price_cents, 999 + 600,
    `the single real named choice (Shrimp) still recovers via the pre-existing per-step floor, unaffected by this fix — got ${JSON.stringify(hoagie)}`);
});

Deno.test("recoverAssertedChoicesFromText (unchanged contract): 'with sausage and onions' still resolves to nothing without the W2 'added' signal — this fix never touches that function, only adds a NEW call site ahead of it", () => {
  const plain = [
    { id: "c-sausage", display: "Sausage" },
    { id: "c-onions", display: "Onions" },
  ];
  assertEquals(recoverAssertedChoicesFromText("with sausage and onions", plain), []);
});

// ═══════════════════════════════════════════════════════════════════════
// Runner-level (mandatory methodology): drive the exact repro message
// through runTurnEngineTurn, the same call path index.ts's
// turn_engine_enabled branch actually uses.
// ═══════════════════════════════════════════════════════════════════════

function baseShopContext(): RunTurnShopContext {
  return {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: null, pickupName: null, deliveryFeeCents: null,
  };
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-hoagie-compound-repro",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: baseShopContext(),
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
      update(row: Record<string, unknown>) {
        void row;
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
  const supabase = { from: (table: string) => builder(table) } as any as SupabaseClient;
  return supabase;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

Deno.test("runTurnEngineTurn (RUNNER-LEVEL, real fresh-add repro): full path lands both real add-ons on the hoagie, no phantom shrimp item, no disambiguation, bread still asked", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: PROPOSAL }),
  };
  const t1 = await runTurnEngineTurn(baseInput({ message: MESSAGE }), deps);

  assertEquals(t1.dialogueState.open?.kind === "disambiguation", false,
    `no phantom item disambiguation may be left open — got ${JSON.stringify(t1.dialogueState.open)}`);

  const hoagieLines = t1.cart.filter(l => l.menu_item_id === ITALIAN_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Italian Hoagie line — got ${JSON.stringify(t1.cart)}`);
  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999 + 800 + 600, `both add-ons must be priced — got ${JSON.stringify(hoagie)}`);
  const addonTexts = hoagie.options?.["Add-ons"] ?? [];
  assertEquals([...addonTexts].sort(), ["Blackened Salmon", "Shrimp"].sort(),
    `both named add-ons must appear, neither silently dropped — got ${JSON.stringify(hoagie.options)}`);

  assert(
    !t1.cart.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may land in the cart — got ${JSON.stringify(t1.cart)}`,
  );
  assert(!/wrap|appetizer|which one|did you mean/i.test(t1.reply),
    `the reply must never surface a phantom shrimp wrap/appetizer question — got ${JSON.stringify(t1.reply)}`);

  // Bread is still a real, open, pending question this turn — a genuinely
  // separate, legitimate slot question, unaffected by this fix.
  assert(/bread/i.test(t1.reply),
    `the bot must still ask for bread this turn (a real, separate slot question) — got ${JSON.stringify(t1.reply)}`);
});
