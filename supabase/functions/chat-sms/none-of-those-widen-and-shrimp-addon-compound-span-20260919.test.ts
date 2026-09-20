// PO dispatch 2026-09-19 night, real live bug, v565 50-run, conv 6de8bd13
// #4 -- TWO parts, both against real Vito's data (shop_id e0000000-0000-
// 0000-0000-000000000001, menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc,
// queried live 2026-09-20).
//
// PART 1: "I don't want either of those. Just the hoagie, cheeseburgers,
// and cheesesteak." did not drop an open shrimp disambiguation (wrap vs
// appetizer) -- the SAME list got shown again, the conversation never
// reached payment. Fixed by widening pending-disambiguation.ts's existing
// isDisambiguationListDropSignal prefix mechanism (own unit tests in
// pending-disambiguation.test.ts) -- covered here at the RUNNER level to
// prove the widened signal actually drops a REAL persisted disambiguation
// and lets PROPOSE run fresh, per the standing methodology rule tonight.
//
// PART 2: "Italian hoagie with shrimp and blackened salmon on wheat bread"
// -- real error_log capture (propose_success row 25af74fb, conv 6de8bd13,
// customer_message verbatim) shows PROPOSE split this into TWO separate
// `adds`: one for "Italian hoagie" and a SECOND, independent one for
// "shrimp and blackened salmon on wheat bread". Real Vito's data confirms
// this ISN'T a separate item -- "Shrimp" ($6) and "Blackened Salmon" ($8)
// are both real, listed choices of the Italian Hoagie's own "Add-ons"
// modifier group (ask_mode on_request), and "Wheat" is a real choice of its
// "bread" slot. But resolveItem ties the second span across Vito's two real
// active "shrimp" lexicon items (Southwest Shrimp / Boom Boom Shrimp --
// real wrap/appetizer collision), opening a phantom item disambiguation
// instead of ever reaching the hoagie's own modifier floor -- ROOT CAUSE IS
// A GENUINELY SEPARATE GAP from W2 (fix/addons-named-with-item-not-dropped-
// 20260919, EXPLICIT_MULTI_ADDON_RE keyed on the literal word "added"),
// not the same mechanism reaching a new limit: this bug never even reaches
// 00-BF's plural modifier floor, because the compound add-on text is split
// into its OWN top-level `add` and swallowed by resolve-item's ambiguity
// tie before decide()'s per-add loop ever processes it as a modifier
// candidate. Fixed in turn-engine.ts by generalizing the pre-existing
// spanIsWholeChoiceOfAnyAdd family (decomposeSpanIntoChoicesOfMenuItem /
// spanFoldTargetForAmbiguousOrUnresolvedSpan) from "the span IS one
// choice's whole name" to "the span fully decomposes into several of one
// sibling add's own real choices, zero leftover" -- see that function's own
// header for the full reasoning, including why it deliberately never
// weakens the pre-existing "sausage and onions" tie-guard (a DIFFERENT
// function, recoverAssertedChoicesFromText, untouched here).
//
// STANDING METHODOLOGY RULE TONIGHT (real Vito's data only, runner-level
// proof, not decide()/answer() fixtures alone): every menu_item_id, price,
// ask_plan shape, and lexicon term below is copied verbatim from a live
// Supabase REST query against the real shop, not invented. T1's real
// PROPOSE proposal is the exact captured tool call from error_log row
// 25af74fb. Part 1's T2 message is the PO's own dispatch text; no real
// error_log row exists for it — that absence IS the bug (same as this
// codebase's own conv22 precedent: the buggy turn is swallowed by answer()'s
// deterministic disambiguation path and never reaches PROPOSE at all), so
// its own T2 PROPOSE reprocessing is modeled directly on the customer's
// stated words and flagged as such, not claimed as a real capture.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type DialogueState,
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

// ── Real Vito's data (queried live, 2026-09-20, shop_id e0000000-0000-0000-0000-000000000001) ──

const ITALIAN_HOAGIE_ID = "79de41b9-9418-4cb4-b2a4-4ad73a5fb20f";
const SOUTHWEST_SHRIMP_ID = "15d09f9d-66e3-4f6a-88b4-27b1b9f83696"; // Wraps — real active "shrimp" lexicon collision
const BOOM_BOOM_SHRIMP_ID = "31b9e812-51d0-4732-93bb-10a7ed3769bb"; // Appetizers — the other real "shrimp" collision
const CHEESE_BURGER_ID = "442f650d-dc96-4a95-9762-f6b571a4dd8c";

const BREAD_GROUP = "07c7a1b0-4981-439c-9dcc-4b2c6cac3b05";
const ADDONS_GROUP = "8b9b8e54-9528-4b5b-8ee8-977df125a98f";

// Real menu_items row (id 79de41b9...), full ask_plan copied verbatim from
// a live query — description "Ham, provolone, salami, lettuce, tomatoes,
// onions, oil & vinegar", real bread slot (White/Rye/Wheat, ask_mode "ask")
// and real Add-ons modifier group (Blackened Salmon $8, Chicken $4, Black
// Diamond Steak $8, Shrimp $6, ask_mode "on_request").
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
const CHEESE_BURGER = realItem(CHEESE_BURGER_ID, "Cheese Burger", "Angus Burgers & Specialty", 849);

const MENU: TurnEngineMenuItem[] = [ITALIAN_HOAGIE, SOUTHWEST_SHRIMP, BOOM_BOOM_SHRIMP, CHEESE_BURGER];

// Real active `lexicon` rows (menu_id 54a42842..., target_type 'item',
// active true), copied verbatim from a live query — every row this repro's
// resolution actually depends on. Bare "shrimp" really does tie across BOTH
// Southwest Shrimp and Boom Boom Shrimp on the live shop — not invented,
// not simplified.
const LEXICON = [
  { term: "italian hoagie", target_id: ITALIAN_HOAGIE_ID },
  { term: "italian hoagies", target_id: ITALIAN_HOAGIE_ID },
  { term: "shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "southwest shrimp", target_id: SOUTHWEST_SHRIMP_ID },
  { term: "shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "boom boom shrimp", target_id: BOOM_BOOM_SHRIMP_ID },
  { term: "cheeseburger", target_id: CHEESE_BURGER_ID },
  { term: "cheeseburgers", target_id: CHEESE_BURGER_ID },
];

// ═══════════════════════════════════════════════════════════════════════
// PART 2 — decide()-level: the real captured T1 proposal (error_log row
// 25af74fb) must add ONE Italian Hoagie with BOTH real add-ons priced, no
// phantom shrimp item, no disambiguation.
// ═══════════════════════════════════════════════════════════════════════

const REAL_T1_MESSAGE =
  "I want an Italian hoagie with shrimp and blackened salmon on wheat bread. Also, can I get 2 cheeseburgers, medium well?";

// Real captured tool call, error_log row 25af74fb, conv 6de8bd13, verbatim:
// adds: [{item_span:"Italian hoagie",...}, {item_span:"shrimp and blackened
// salmon on wheat bread",...}, {item_span:"cheeseburgers",quantity:2,...}].
const REAL_T1_PROPOSAL: Proposal = {
  intent: "order",
  removes: [],
  modifies: [],
  adds: [
    { item_span: "Italian hoagie", quantity: 1, choices: [] },
    { item_span: "shrimp and blackened salmon on wheat bread", quantity: 1, choices: [] },
    { item_span: "cheeseburgers", quantity: 2, choices: [] },
  ],
};

Deno.test("decide() (PART 2 END TO END, real conv 6de8bd13 T1 capture): both real add-ons land on the hoagie, priced, no phantom shrimp item, no disambiguation", () => {
  const out = decide(REAL_T1_PROPOSAL, [], MENU, LEXICON, () => "line-1", REAL_T1_MESSAGE);

  assertEquals(out.disambiguationCandidateIds, null,
    `a compound add-on mention must never open a phantom item disambiguation — got ${JSON.stringify(out.disambiguationCandidateIds)}`);

  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  const hoagieLines = lines.filter(l => l.menu_item_id === ITALIAN_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Italian Hoagie line — got ${JSON.stringify(out.cart)}`);
  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999 + 800 + 600,
    `both add-on price deltas (Blackened Salmon $8.00 + Shrimp $6.00) must be applied on top of the $9.99 base — got ${JSON.stringify(hoagie)}`);
  const addonTexts = hoagie.options?.["Add-ons"] ?? [];
  assertEquals([...addonTexts].sort(), ["Blackened Salmon", "Shrimp"].sort(),
    `both named add-ons must appear in the recap, neither silently dropped — got ${JSON.stringify(hoagie.options)}`);

  assert(
    !lines.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may ever land in the cart — got ${JSON.stringify(out.cart)}`,
  );

  const burger = lines.find(l => l.menu_item_id === CHEESE_BURGER_ID);
  assert(burger, `2x Cheese Burger must still land, unaffected by the fix — got ${JSON.stringify(out.cart)}`);
  assertEquals(burger!.quantity, 2);

  assertEquals(out.declines, [], `no decline should fire — every named thing is real — got ${JSON.stringify(out.declines)}`);
});

Deno.test("decide() (PART 2 regression): the SAME hoagie with NO add-ons named at all still adds cleanly, unaffected by the new decomposition signal", () => {
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

Deno.test("decide() (PART 2 regression): a span naming a real choice PLUS a word that is NOT any real choice never decomposes — stays a genuine unresolved/ambiguous span, exactly as before", () => {
  // "shrimp and mayonnaise" — "mayonnaise" is not a real choice of the
  // Italian Hoagie's Add-ons group in this fixture, so the span must NOT
  // fully decompose (a leftover token survives) and the pre-existing
  // ambiguous-shrimp behavior must be left completely alone.
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "Italian hoagie", quantity: 1, choices: [] },
      { item_span: "shrimp and mayonnaise", quantity: 1, choices: [] },
    ],
  };
  const out = decide(proposal, [], MENU, LEXICON, () => "line-1", "Italian hoagie with shrimp and mayonnaise");
  assert(out.disambiguationCandidateIds !== null,
    `a leftover word that names no real choice must still open the pre-existing ambiguous-shrimp question, unchanged — got ${JSON.stringify(out.disambiguationCandidateIds)}`);
  assertEquals([...out.disambiguationCandidateIds!].sort(), [BOOM_BOOM_SHRIMP_ID, SOUTHWEST_SHRIMP_ID].sort());
});

// ═══════════════════════════════════════════════════════════════════════
// PART 2 — runner-level (mandatory methodology): drive the REAL captured
// T1 proposal through runTurnEngineTurn, the same call path index.ts's
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
    conversationId: "conv-6de8bd13-repro",
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

Deno.test("runTurnEngineTurn (PART 2 RUNNER-LEVEL, real conv 6de8bd13 T1 capture): full path lands both real add-ons on the hoagie, no phantom shrimp item, no disambiguation left open", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: REAL_T1_PROPOSAL }),
  };
  const t1 = await runTurnEngineTurn(baseInput({ message: REAL_T1_MESSAGE }), deps);

  assertEquals(t1.dialogueState.open?.kind === "disambiguation", false,
    `no phantom item disambiguation may be left open — got ${JSON.stringify(t1.dialogueState.open)}`);

  const hoagieLines = t1.cart.filter(l => l.menu_item_id === ITALIAN_HOAGIE_ID);
  assertEquals(hoagieLines.length, 1, `expected exactly one Italian Hoagie line — got ${JSON.stringify(t1.cart)}`);
  const hoagie = hoagieLines[0] as unknown as { price_cents: number; options?: Record<string, string[]> };
  assertEquals(hoagie.price_cents, 999 + 800 + 600, `both add-ons must be priced — got ${JSON.stringify(hoagie)}`);

  assert(
    !t1.cart.some(l => l.menu_item_id === SOUTHWEST_SHRIMP_ID || l.menu_item_id === BOOM_BOOM_SHRIMP_ID),
    `no phantom standalone shrimp item may land in the cart — got ${JSON.stringify(t1.cart)}`,
  );
  assert(!/wrap|appetizer|which one|did you mean/i.test(t1.reply),
    `the reply must never surface the phantom shrimp wrap/appetizer question — got ${JSON.stringify(t1.reply)}`);

  const burger = t1.cart.find(l => l.menu_item_id === CHEESE_BURGER_ID);
  assert(burger, `2x Cheese Burger must still land — got ${JSON.stringify(t1.cart)}`);
  assertEquals(burger!.quantity, 2);
});

// ═══════════════════════════════════════════════════════════════════════
// PART 1 — runner-level: a shrimp wrap/appetizer disambiguation that has
// ALREADY been shown at least once (openRepeatCount >= 1 — the gate
// turn-engine-runner.ts's own dropDisambiguationList check requires) must
// actually drop when the customer says "I don't want either of those."
// This state is constructed directly (no real error_log row exists for the
// swallowed turn — that absence is the bug itself, same as this codebase's
// pre-existing conv22 precedent for an identically-shaped swallowed turn).
// ═══════════════════════════════════════════════════════════════════════

Deno.test("runTurnEngineTurn (PART 1 RUNNER-LEVEL, real conv 6de8bd13 shape): 'I don't want either of those. Just the hoagie, cheeseburgers, and cheesesteak.' drops an already-repeated shrimp disambiguation and reprocesses via PROPOSE", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateWithOpenShrimpList: DialogueState = {
    phase: "ordering",
    open: {
      kind: "disambiguation",
      candidates: [SOUTHWEST_SHRIMP_ID, BOOM_BOOM_SHRIMP_ID],
      spanText: "shrimp and blackened salmon on wheat bread",
    },
    upsell_offered: false,
    asked_message_id: null,
    // Already shown at least once — the exact live symptom ("repeated at
    // least twice") and the exact gate isDisambiguationListDropSignal's
    // caller in turn-engine-runner.ts requires before it fires at all.
    openRepeatCount: 1,
  };

  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    // Modeled directly on the customer's own restated words (no real
    // error_log capture exists for this swallowed turn) — item_span "Italian
    // hoagie" rather than the customer's own shorthand "the hoagie" because
    // a real PROPOSE call has the full conversation history naming it
    // specifically a few turns earlier, and because bare "hoagie" is
    // genuinely, separately ambiguous on the real live menu too (4 active
    // same-bare-term candidates — confirmed live, out of scope for this
    // ticket). "cheesesteak" is ALSO genuinely, separately ambiguous (5
    // active same-bare-term candidates across Flatbreads/Paninis/Hot
    // Sandwiches/Stromboli Rolls/Salads — confirmed live, out of scope for
    // this ticket) so it is left out of this mock proposal rather than
    // guessed at.
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({
        ok: true, attempts: 1,
        proposal: {
          intent: "order",
          adds: [
            { item_span: "Italian hoagie", quantity: 1, choices: [] },
            { item_span: "cheeseburgers", quantity: 2, choices: [] },
          ],
          removes: [], modifies: [],
        },
      });
    },
  };

  const t2 = await runTurnEngineTurn(
    baseInput({
      message: "I don't want either of those. Just the hoagie, cheeseburgers, and cheesesteak.",
      dialogueState: dialogueStateWithOpenShrimpList,
    }),
    deps,
  );

  assertEquals(proposeCalls, 1,
    "dropping the list must reprocess the FULL message through PROPOSE, exactly like the pre-existing bare 'no'/'none' path — pre-fix this would stay 0 and the same list would be re-shown instead");

  // PRIMARY required assertion: the SAME shrimp list must never come back.
  const stillSameList = t2.dialogueState.open?.kind === "disambiguation" &&
    [...t2.dialogueState.open.candidates].sort().join(",") === [SOUTHWEST_SHRIMP_ID, BOOM_BOOM_SHRIMP_ID].sort().join(",");
  assert(!stillSameList,
    `the identical shrimp wrap/appetizer list must never be re-shown — got open=${JSON.stringify(t2.dialogueState.open)}`);
  // A one-line "Okay, no <what was declined>." acknowledgment (disambiguation-
  // DeclineNamesOutsideItem's own existing wording, unrelated to this fix)
  // may still mention "shrimp" in passing — that is a polite confirmation
  // of what was dropped, not the list itself. The actual list/question
  // wording ("wrap or appetizer", a "which one?"/numbered-candidates prompt)
  // must never reappear.
  assert(!/wrap or appetizer|which one|reply with a number|say "none of those"/i.test(t2.reply),
    `the reply must never re-surface the dropped shrimp wrap/appetizer question — got ${JSON.stringify(t2.reply)}`);

  // Bonus (not mandatory, per the dispatch's own scoping allowance — flagged
  // clearly, not claimed as fixed): the cheeseburgers land cleanly, proving
  // the reprocessed message genuinely reaches PROPOSE and decide() again.
  // The Italian Hoagie itself does NOT land in this mock: itemSpanNamedInMessage
  // (turn-engine.ts) correctly guard-drops item_span "Italian hoagie" here,
  // because THIS turn's own customer message says only "the hoagie" — "Italian"
  // is nowhere in it (it was said several turns earlier). Confirmed live
  // against the real menu that this is a genuine, separate, pre-existing
  // ambiguity: bare "hoagie" alone ties 4 ways across Vito's real active
  // lexicon (Italian Hoagie plus three other real hoagies), so neither a
  // "the hoagie" nor an "Italian hoagie" item_span resolves this cleanly
  // without deeper, out-of-scope surgery — exactly the kind of "requires
  // deeper surgery, flagged clearly" case the dispatch itself anticipated.
  const burger = t2.cart.find(l => l.menu_item_id === CHEESE_BURGER_ID);
  assert(burger, `Cheese Burger should land, proving the reprocessed message reaches decide() again — got ${JSON.stringify(t2.cart)}`);
  assertEquals(burger!.quantity, 2);
});
