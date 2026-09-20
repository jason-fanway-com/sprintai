// PO dispatch 2026-09-20, real live money bug (v569 50-run, conv #35): "Tuna
// Hoagie on wheat, can you add shrimp to that?" -> 1x Tuna Hoagie added, no
// shrimp add-on charge -- the customer's own follow-up request silently
// dropped, no decline, no trace. This is a DIFFERENT phrasing shape than the
// "with shrimp and blackened salmon" single-combined-span case fixed minutes
// earlier (fix/hoagie-compound-addon-fresh-add-20260920, merged ce53b66a):
// this repro's PROPOSE shape splits the hoagie and the shrimp request into
// TWO separate top-level adds, and the shrimp request is phrased as a
// trailing "can you add X to that?" question after a comma.
//
// PO's own framing for this dispatch was that AVAILABILITY_QUESTION_MARKER_RE
// / the question-clause exclusion (itemSpanNamedInMessage,
// questionClauseOnlyTokens) was misreading this REQUEST question as an
// AVAILABILITY question. Verified directly against real code (runner-level,
// decide()-level, and a plain regex probe of the actual message text against
// both AVAILABILITY_QUESTION_MARKER_RE and isQuestionPreambleClause): NEITHER
// of those functions ever flags "Tuna Hoagie on wheat, can you add shrimp to
// that?" as containing a question clause -- there is no "do you have"/"is
// there"/etc. marker anywhere in it, and it never contains the literal word
// "question". itemSpanNamedInMessage passes the "shrimp" span cleanly.
//
// The REAL root cause, confirmed by direct probe (decide() fed the exact
// real add shapes against real Vito's Tuna Hoagie/Shrimp data, with and
// without the trailing question): "shrimp" resolves AMBIGUOUS (a real,
// active "shrimp" lexicon collision -- Southwest Shrimp / Boom Boom Shrimp,
// same collision the just-merged hoagie fix's own test file documents), so
// Round 2's spanIsWholeChoiceOfAnyAdd correctly recognizes it as really
// naming the Tuna Hoagie's own "Shrimp" Add-ons choice and drops it from
// becoming a phantom disambiguation -- BY DESIGN, leaving the customer's own
// words in `customerMessage` for the host item's own 00-BF modifier-floor
// text scan to pick up (see that scan's own header, same file). That scan
// scopes its search to the host's OWN claimed phrase
// (scopedModifierText/resolveClaimedPhraseIndex) to stop ONE item's words
// leaking onto a DIFFERENT item -- but phrase-split.ts splits on the comma
// before "can you add shrimp to that?", so the shrimp request lands in its
// OWN phrase, one the host's scoped search never sees. A DIFFERENT, otherwise
// identical, non-question phrasing of the exact same two adds ("I want a
// Tuna Hoagie on wheat with shrimp added please.", no comma, one phrase) was
// directly confirmed to resolve correctly, proving the defect is the phrase
// boundary stranding the request clause, not question-vs-availability
// classification in AVAILABILITY_QUESTION_MARKER_RE's own territory.
//
// FIX: REQUEST_QUESTION_MARKER_RE (turn-engine.ts, next to
// AVAILABILITY_QUESTION_MARKER_RE) names the real distinction the PO's own
// framing intended -- "can/could/would you add/get/bring X",
// "can/could/may I add/get/have X" -- and the 00-BF modifier-floor scoping
// step folds an OTHER phrase into the host's scoped text when it (a) matches
// that pattern, (b) is not itself an availability question (never widens
// into AVAILABILITY_QUESTION_MARKER_RE's own territory), and (c) is not
// already claimed as some OTHER real add's own phrase this turn (a
// genuinely different item's own trailing request is left untouched,
// confirmed by its own regression test below).
//
// REQUIRED METHODOLOGY: runner-level (runTurnEngineTurn), real Vito's data
// (shop_id e0000000-0000-0000-0000-000000000001; Tuna Hoagie
// a5dfc61b-31e0-4936-8a8b-3b0fbf0971eb, real ask_plan/lexicon term pulled
// from the live menu snapshot; the "shrimp" collision against Southwest
// Shrimp/Boom Boom Shrimp copied verbatim from the just-merged hoagie fix's
// own test file, itself pulled live 2026-09-20). Confirmed RED against
// pre-fix code (both adds present, shrimp silently dropped, no decline, no
// phantom item) before writing this fix.
//
// FLAGGED, NOT FIXED HERE (separate real bug, different subsystem): the
// OTHER half of this dispatch, "Can you also add a side of Garlic Knots?"
// (conv 19608b5e #47), is NOT the same root cause and is NOT touched by this
// fix. Direct probe (decide(), real Vito's Garlic Cheesesteak/Garlic Knots
// IDs pulled from the live menu snapshot) confirmed the Garlic Knots add
// fails identically whether the message is phrased as a question OR a plain
// imperative with no question at all ("Also add a side of Garlic Knots.
// Thanks!") -- the actual defect is that Vito's compiled lexicon has NO bare
// "garlic knots" term for that item at all, only "garlic knots 6"/
// "garlic knots 6s"/"garlicknots6" (the item's own display name is "Garlic
// Knots (6)"), and resolve-item.ts's longestMatch requires an exact
// whole-word-run match -- a customer or model span that (overwhelmingly the
// common case) omits the parenthetical serving count can never match. This
// is a menu-compilation/lexicon-coverage gap, unrelated to question-vs-
// request classification, and touching resolve-item.ts's core matching
// primitive to paper over it risks real regressions on every OTHER
// count-suffixed item on every shop's menu (e.g. two differently-sized wing
// counts colliding into a false unique match) -- out of scope for this
// dispatch and flagged for its own, separately-considered fix.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
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

// ── Real Vito's data (shop_id e0000000-0000-0000-0000-000000000001) ──

const TUNA_HOAGIE_ID = "a5dfc61b-31e0-4936-8a8b-3b0fbf0971eb";
// Real, active "shrimp" lexicon collision on this same shop -- copied
// verbatim from hoagie-compound-addon-fresh-add-20260920.test.ts.
const SOUTHWEST_SHRIMP_ID = "15d09f9d-66e3-4f6a-88b4-27b1b9f83696"; // Wraps
const BOOM_BOOM_SHRIMP_ID = "31b9e812-51d0-4732-93bb-10a7ed3769bb"; // Appetizers
const COKE_ID = "coke-real-id";

const BREAD_GROUP = "7343bc04-5790-4f51-8f1c-44cd7dbdc0b4";
const ADDONS_GROUP = "bbb27f32-44aa-48cf-b9b4-0e51d677b86b";

const TUNA_HOAGIE: TurnEngineMenuItem = {
  id: TUNA_HOAGIE_ID, name: "Tuna Hoagie", category: "Cold Sandwiches", price_cents: 999, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Tuna Hoagie",
    base_price_cents: 999, recap_template: "", ticket_template: "",
    steps: [
      {
        group_id: BREAD_GROUP, slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
        prompt_template: "bread.ask",
        choices: [
          { id: "668f7a60-11e8-4078-94ed-cad60da5c65f", display: "Wheat", price_delta_cents: 0 },
          { id: "740cdbba-5fce-4f89-8eac-aea88fbbd66b", display: "White", price_delta_cents: 0 },
          { id: "d31c4ce2-61c4-4b05-9b95-e4e9b50667e8", display: "Rye", price_delta_cents: 0 },
        ],
      },
      {
        group_id: ADDONS_GROUP, slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
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
const COKE = realItem(COKE_ID, "Coke", "Drinks", 199);

const MENU: TurnEngineMenuItem[] = [TUNA_HOAGIE, SOUTHWEST_SHRIMP, BOOM_BOOM_SHRIMP, COKE];

const LEXICON = [
  { term: "tuna hoagie", target_id: TUNA_HOAGIE_ID },
  { term: "tuna hoagies", target_id: TUNA_HOAGIE_ID },
  { term: "shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "southwest shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "boom boom shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "coke", target_id: COKE_ID },
];

const MESSAGE = "Tuna Hoagie on wheat, can you add shrimp to that?";

// PROPOSE's plausible real shape for this message: the hoagie and the
// trailing request read as two separate top-level adds (unlike the
// just-merged fix's own combined-span repro).
const PROPOSAL: Proposal = {
  intent: "order", removes: [], modifies: [],
  adds: [
    { item_span: "Tuna Hoagie on wheat", quantity: 1, choices: [] },
    { item_span: "shrimp", quantity: 1, choices: [] },
  ],
};

Deno.test("decide() (real fresh-add repro): 'Tuna Hoagie on wheat, can you add shrimp to that?' lands the hoagie WITH the shrimp add-on, no phantom shrimp item", () => {
  const out = decide(PROPOSAL, [], MENU, LEXICON, () => "line-1", MESSAGE);

  assertEquals(out.disambiguationCandidateIds, null,
    `the real shrimp add-on must never open a phantom item disambiguation — got ${JSON.stringify(out.disambiguationCandidateIds)}`);

  const hoagieLines = out.cart.filter(l => l.menu_item_id === TUNA_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Tuna Hoagie line — got ${JSON.stringify(out.cart)}`);
  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999 + 600, `the Shrimp add-on ($6.00) must be charged on top of the $9.99 base — got ${JSON.stringify(hoagie)}`);
  assertEquals(hoagie.options?.["Add-ons"] ?? [], ["Shrimp"], `Shrimp must appear in the recap, not silently dropped — got ${JSON.stringify(hoagie.options)}`);

  assert(
    !out.cart.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may ever land — got ${JSON.stringify(out.cart)}`,
  );
  assertEquals(out.declines, [], `no decline should fire — the shrimp request is real and lands — got ${JSON.stringify(out.declines)}`);
});

Deno.test("decide() (regression): a genuinely DIFFERENT item's own trailing request never bleeds into the host's Add-ons scan", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "Tuna Hoagie on wheat", quantity: 1, choices: [] },
      { item_span: "Coke", quantity: 1, choices: [] },
    ],
  };
  const out = decide(proposal, [], MENU, LEXICON, () => "line-1", "Tuna Hoagie on wheat, can you add a Coke?");
  const hoagie = out.cart.find(l => l.menu_item_id === TUNA_HOAGIE_ID) as unknown as { price_cents: number } | undefined;
  const coke = out.cart.find(l => l.menu_item_id === COKE_ID);
  assert(hoagie, `hoagie must still land — got ${JSON.stringify(out.cart)}`);
  assertEquals(hoagie!.price_cents, 999, `hoagie must stay plain — Coke is a separate real item, never folded in as a phantom Shrimp add-on — got ${JSON.stringify(hoagie)}`);
  assert(!!coke, `Coke must land as its own real line, unaffected — got ${JSON.stringify(out.cart)}`);
});

Deno.test("decide() (regression): the SAME hoagie with NO trailing request at all still adds cleanly", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Tuna Hoagie on wheat", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [], MENU, LEXICON, () => "line-1", "Just a Tuna Hoagie on wheat please");
  const hoagie = out.cart.find(l => l.menu_item_id === TUNA_HOAGIE_ID) as unknown as { price_cents: number; options?: Record<string, string[]> } | undefined;
  assert(hoagie, `hoagie must land — got ${JSON.stringify(out.cart)}`);
  assertEquals(hoagie!.price_cents, 999, `plain hoagie, no add-on charge — got ${JSON.stringify(hoagie)}`);
  assertEquals(hoagie!.options?.["Add-ons"] ?? [], []);
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
    conversationId: "conv-request-phrased-as-question-repro",
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
      then(resolve: (v: { data: unknown; error: null }) => void) { return Promise.resolve({ data: null, error: null }).then(resolve); },
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

Deno.test("runTurnEngineTurn (RUNNER-LEVEL, real fresh-add repro): 'Tuna Hoagie on wheat, can you add shrimp to that?' lands both, shrimp priced, no phantom item, bread still asked", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: PROPOSAL }),
  };
  const t1 = await runTurnEngineTurn(baseInput({ message: MESSAGE }), deps);

  assertEquals(t1.dialogueState.open?.kind === "disambiguation", false,
    `no phantom item disambiguation may be left open — got ${JSON.stringify(t1.dialogueState.open)}`);

  const hoagieLines = t1.cart.filter(l => l.menu_item_id === TUNA_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Tuna Hoagie line — got ${JSON.stringify(t1.cart)}`);
  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999 + 600, `the Shrimp add-on must be priced — got ${JSON.stringify(hoagie)}`);
  assertEquals(hoagie.options?.["Add-ons"] ?? [], ["Shrimp"], `Shrimp must appear, not silently dropped — got ${JSON.stringify(hoagie.options)}`);

  assert(
    !t1.cart.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may land — got ${JSON.stringify(t1.cart)}`,
  );
  assert(!/wrap|appetizer|which one|did you mean/i.test(t1.reply),
    `the reply must never surface a phantom shrimp wrap/appetizer question — got ${JSON.stringify(t1.reply)}`);
  assert(/bread/i.test(t1.reply), `the bot must still ask for bread this turn — got ${JSON.stringify(t1.reply)}`);
});
