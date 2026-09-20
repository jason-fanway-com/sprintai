// PO dispatch (2026-09-19), TWO REAL, LIVE-CONFIRMED MONEY BUGS.
//
// BUG 1 (real conv 22b1a95a, v550 #10): a "which one" disambiguation was
// open for "cheesesteak" (this shop's cheesesteak family tied). The customer
// answered:
//   "I said I want 1 Cheesesteak homemade panini, that's option 1. I already
//   told you the full order! It's 2x Large Chicken Bacon Ranch with onions,
//   1 Cheesesteak panini, 1 Medium Sausage Pizza."
// Two independent defects in the SAME turn:
//   (a) "that's option 1" — the pick — sits past the first 6 words of the
//       message, the only window matchLeadingOrdinal (pending-
//       disambiguation.ts) ever scanned, so it was never seen at all.
//   (b) With the real pick unrecognized, the rest of the message (the
//       customer reciting their WHOLE order to make a point, including two
//       lines ALREADY in the cart) fell into messageNamesItemOutsideCandidates
//       (turn-engine.ts's "disambiguation" case) — which had no cart-
//       restatement check at all — and silently re-added a THIRD Chicken
//       Bacon Ranch pizza. Live, this repeated 5 more times before the PO
//       caught it: a real $27.49+ overcharge.
//
// BUG 2 (real conv 498f24dd, v550 #47): a "Sure — what kind?" disambiguation
// was open for fries. The customer answered:
//   "Can you confirm my order? Just to recap: 1 Garlic Cheesesteak on wheat
//   with blackened salmon and a side of fries"
// The SAME missing-restatement-check defect: "1 Garlic Cheesesteak..." (a
// line ALREADY in the cart) resolved as an "outside" item via
// messageNamesItemOutsideCandidates and was silently re-added as a SECOND
// Garlic Cheesesteak.
//
// Root cause (one defect, two call sites): decide()'s own PROPOSE-path
// restatement guard (isRestatementOfExistingOrder + "already in cart" —
// see turn-engine.ts's `restating` flag, 00-BD) was NEVER applied on the
// ANSWER path's own "outside item" add (messageNamesItemOutsideCandidates,
// both the "disambiguation" and "multi_size" cases) — the exact same shape
// of add, the exact same risk, checked in one place and not the other.
//
// FIX (pending-disambiguation.ts + turn-engine.ts):
//  1. matchExplicitOptionPickAnywhere (pending-disambiguation.ts): "option
//     N"/"number N"/"option number N" ANYWHERE in the message (not just the
//     first 6 words) is now an unambiguous pick, checked before the
//     outside-item gate and the facet-narrowing tiers — so a real pick
//     buried in a long restated sentence is never missed, and (just as
//     important) short-circuits BEFORE the rest of that same sentence ever
//     gets a chance to be misread as a fresh add.
//  2. isAnswerRestatementOfCartLine (turn-engine.ts): the "outside item" add
//     (both call sites) is now suppressed whenever that item is ALREADY a
//     real cart line AND the resolved clause carries a restatement marker
//     (isRestatementOfExistingOrder, the same function/vocabulary decide()
//     already trusts on the PROPOSE path) — checked against the exact
//     clause messageNamesItemOutsideCandidates itself resolved from
//     (`matchedText`), never the whole raw message, since the whole message
//     can carry an unrelated ADDITION_MARKERS word from text this function
//     already scoped away.
//
// REQUIRED METHODOLOGY: both tests below drive the real turn-engine-
// runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly. Data provenance: unlike conv22-live-runner-gap-20260919.test.ts
// (which had a live Supabase query available), this task had no DB access —
// the menu/lexicon rows below are a representative reconstruction of the
// real shapes named in the PO's dispatch (a tied cheesesteak family, a tied
// fries family, both real named entrees), not a live query. The customer
// messages themselves ARE copied verbatim from the PO's dispatch.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const CHEESESTEAK_PANINI = "11111111-1111-1111-1111-111111111111";
const CHEESESTEAK_HOAGIE = "22222222-2222-2222-2222-222222222222";
const CHICKEN_BACON_RANCH_LARGE = "33333333-3333-3333-3333-333333333333";
const SAUSAGE_PIZZA_MEDIUM = "44444444-4444-4444-4444-444444444444";

const FRIES_REGULAR = "55555555-5555-5555-5555-555555555555";
const FRIES_CHEESE = "66666666-6666-6666-6666-666666666666";
const GARLIC_CHEESESTEAK = "77777777-7777-7777-7777-777777777777";
const GREEK_SALAD = "88888888-8888-8888-8888-888888888888";
const PEPPERONI_MEDIUM = "99999999-9999-9999-9999-999999999999";
const WINGS_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

// Real modifier step — needed so the WART test below actually exercises the
// "slot" open-question / echo-rendering path, not just a bare item with no
// steps. Deliberately a WINGS flavor slot, not the Greek Salad's own dressing
// slot the PO's literal dispatch names: while building this repro, a
// restated "...just the greek salad..." sharing a word-stem with the OPEN
// slot's OWN line (Greek Salad) trips a SEPARATE, pre-existing mechanism
// (isNamedSlotItemRejection, this file's turn-engine.ts) that reads the
// decline cue "no" (from "no stromboli") plus that shared stem as a request
// to REMOVE the Greek Salad line outright — a real, still-open defect this
// task did not fix (see this file's own header and the final report for
// why). Scoped here to a slot whose own item/category shares no word with
// the restated text, so this test isolates the ECHO fix this task DID make
// without also asserting anything about that separate mechanism.
const WINGS: TurnEngineMenuItem = {
  id: WINGS_ID, name: "10 Pieces Wings", category: "Appetizers", price_cents: 1099, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "10 Pieces Wings", base_price_cents: 1099,
    recap_template: "", ticket_template: "",
    steps: [{
      // kind MUST be "slot" (a REQUIRED choice), not "modifier" — ask()'s
      // own priority-1 (turn-engine.ts) only ever force-reopens an
      // unresolved "slot"-kind step; a "modifier"-kind step is optional and
      // is never reopened this way, so using "modifier" here would silently
      // let a HIGHER-priority question (order_type) win the render instead
      // of genuinely reopening this one — confirmed by hand while building
      // this repro, not a guess.
      group_id: "flavor", slot_key: "flavor", kind: "slot", ask_mode: "ask",
      prompt_template: "What flavor on the wings?",
      choices: [
        { id: "f-bbq", display: "BBQ", price_delta_cents: 0 },
        { id: "f-buffalo", display: "Buffalo", price_delta_cents: 0 },
      ],
    }],
  },
};

const MENU: TurnEngineMenuItem[] = [
  realItem(CHEESESTEAK_PANINI, "Cheesesteak - Homemade Panini", "Sandwiches", 999),
  realItem(CHEESESTEAK_HOAGIE, "Cheesesteak - Hoagie Roll", "Sandwiches", 949),
  realItem(CHICKEN_BACON_RANCH_LARGE, "Chicken Bacon Ranch - Large (16\")", "Pizza", 1899),
  realItem(SAUSAGE_PIZZA_MEDIUM, "Sausage Pizza - Medium (14\")", "Pizza", 1699),
  realItem(FRIES_REGULAR, "Regular Fries", "Sides", 399),
  realItem(FRIES_CHEESE, "Cheese Fries", "Sides", 499),
  realItem(GARLIC_CHEESESTEAK, "Garlic Cheesesteak", "Sandwiches", 1099),
  WINGS,
  realItem(PEPPERONI_MEDIUM, "Pepperoni Pizza - Medium (14\")", "Pizza", 1499),
  realItem(GREEK_SALAD, "Greek Salad", "Salads", 1099),
];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "chicken bacon ranch", target_id: CHICKEN_BACON_RANCH_LARGE, category: "Pizza", size_label: "Large" },
  { term: "large chicken bacon ranch", target_id: CHICKEN_BACON_RANCH_LARGE, category: "Pizza", size_label: "Large" },
  { term: "chicken bacon ranch pizza", target_id: CHICKEN_BACON_RANCH_LARGE, category: "Pizza", size_label: "Large" },
  { term: "sausage pizza", target_id: SAUSAGE_PIZZA_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "medium sausage pizza", target_id: SAUSAGE_PIZZA_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "cheesesteak", target_id: CHEESESTEAK_PANINI, category: "Sandwiches", size_label: null },
  { term: "cheesesteak panini", target_id: CHEESESTEAK_PANINI, category: "Sandwiches", size_label: null },
  { term: "cheesesteak", target_id: CHEESESTEAK_HOAGIE, category: "Sandwiches", size_label: null },
  { term: "cheesesteak hoagie", target_id: CHEESESTEAK_HOAGIE, category: "Sandwiches", size_label: null },
  { term: "fries", target_id: FRIES_REGULAR, category: "Sides", size_label: null },
  { term: "regular fries", target_id: FRIES_REGULAR, category: "Sides", size_label: null },
  { term: "fries", target_id: FRIES_CHEESE, category: "Sides", size_label: null },
  { term: "cheese fries", target_id: FRIES_CHEESE, category: "Sides", size_label: null },
  { term: "garlic cheesesteak", target_id: GARLIC_CHEESESTEAK, category: "Sandwiches", size_label: null },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-repro",
    shopId: "shop-repro",
    tenantId: "shop-repro",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: null,
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: null,
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
          .map(m => ({ id: m.id, category: m.category, size_label: LEXICON.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update(row: Record<string, unknown>) {
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
  return supabase;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function failingPropose(label: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => {
    throw new Error(`${label}: PROPOSE must never be called — this turn must resolve deterministically`);
  };
}

Deno.test("BUG 1 runner-level (real conv 22b1a95a): 'that's option 1' buried mid-sentence resolves the cheesesteak disambiguation, and the same message's restated Chicken Bacon Ranch / Sausage Pizza (already in the cart) are never re-added", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: CHICKEN_BACON_RANCH_LARGE, name: "Chicken Bacon Ranch - Large (16\")", quantity: 2, price_cents: 1899, modifiers: [], line_key: `${CHICKEN_BACON_RANCH_LARGE}::` },
    { menu_item_id: SAUSAGE_PIZZA_MEDIUM, name: "Sausage Pizza - Medium (14\")", quantity: 1, price_cents: 1699, modifiers: [], line_key: `${SAUSAGE_PIZZA_MEDIUM}::` },
  ];
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [CHEESESTEAK_PANINI, CHEESESTEAK_HOAGIE], quantity: 1 },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("BUG 1"),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "I said I want 1 Cheesesteak homemade panini, that's option 1. I already told you the full order! It's 2x Large Chicken Bacon Ranch with onions, 1 Cheesesteak panini, 1 Medium Sausage Pizza.",
      cart: cartBefore,
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  assertEquals(result.cart.length, 3, `must be exactly 3 lines (2 unchanged + 1 new Cheesesteak Panini): ${JSON.stringify(result.cart)}`);
  const cbr = result.cart.find(l => l.menu_item_id === CHICKEN_BACON_RANCH_LARGE);
  const sausage = result.cart.find(l => l.menu_item_id === SAUSAGE_PIZZA_MEDIUM);
  const panini = result.cart.find(l => l.menu_item_id === CHEESESTEAK_PANINI);
  const hoagie = result.cart.find(l => l.menu_item_id === CHEESESTEAK_HOAGIE);
  assert(cbr, "Chicken Bacon Ranch must still be in the cart");
  assertEquals(cbr!.quantity, 2, `Chicken Bacon Ranch must stay at quantity 2, never grow to 4 — the live money bug: ${JSON.stringify(result.cart)}`);
  assert(sausage, "Sausage Pizza must still be in the cart");
  assertEquals(sausage!.quantity, 1, `Sausage Pizza must stay at quantity 1, never double: ${JSON.stringify(result.cart)}`);
  assert(panini, `the disambiguation must resolve to the Cheesesteak Panini via 'option 1': ${JSON.stringify(result.cart)}`);
  assertEquals(panini!.quantity, 1);
  assert(!hoagie, "the Cheesesteak Hoagie (option 2) must never be added");
  assert(
    result.dialogueState.open?.kind !== "disambiguation",
    `the cheesesteak disambiguation must be closed, not left open, once 'option 1' resolves it: ${JSON.stringify(result.dialogueState.open)}`,
  );
});

Deno.test("BUG 2 runner-level (real conv 498f24dd): a restated 'Just to recap: 1 Garlic Cheesesteak...' while a fries disambiguation is open never re-adds the Garlic Cheesesteak already in the cart", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: GARLIC_CHEESESTEAK, name: "Garlic Cheesesteak", quantity: 1, price_cents: 1099, modifiers: [], line_key: `${GARLIC_CHEESESTEAK}::` },
  ];
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [FRIES_REGULAR, FRIES_CHEESE], quantity: 1 },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("BUG 2"),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "Can you confirm my order? Just to recap: 1 Garlic Cheesesteak on wheat with blackened salmon and a side of fries",
      cart: cartBefore,
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  const garlicLines = result.cart.filter(l => l.menu_item_id === GARLIC_CHEESESTEAK);
  assertEquals(garlicLines.length, 1, `must be exactly ONE Garlic Cheesesteak line, never a duplicate second line: ${JSON.stringify(result.cart)}`);
  assertEquals(garlicLines[0].quantity, 1, `Garlic Cheesesteak must stay at quantity 1, never double to 2: ${JSON.stringify(result.cart)}`);
});

// WART (2026-09-19, PO dispatch, same family, lower priority): a live
// refused-item sequence — "no stromboli, just the greek salad and 2 medium
// pepperonis" — arrived while a modifier slot was open on a DIFFERENT cart
// line. The cart stayed correct (nothing in this text matches a real slot
// choice, so the slot genuinely didn't resolve, exactly as before this fix)
// but the reply quoted the restated order back as if it were an attempted
// (failed) slot value — confusing, even though nothing was actually wrong.
// Fixed in turn-engine-runner.ts's slot-echo branch: a message carrying a
// restatement marker is never echoed as an attempted slot value.
//
// Scoped to a Wings flavor slot rather than the PO's own literal "what
// dressing on the Greek?" example — see WINGS's own header comment above for
// why: when the open slot's OWN line shares a word with the restated text
// ("greek salad" restated while the OPEN line is itself named "Greek"), a
// separate, pre-existing mechanism (isNamedSlotItemRejection) reads the
// decline cue "no" (aimed at "stromboli") as also declining that shared-name
// line, and REMOVES it — a real, further bug this task did not fix. Using
// Wings (no shared word with anything in the restated text) isolates the
// echo fix this task DID make.
Deno.test("WART runner-level: a restated order while a modifier slot is open (on a DIFFERENT line) is never echoed back as an attempted (failed) slot value", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: WINGS_ID, name: "10 Pieces Wings", quantity: 1, price_cents: 1099, modifiers: [], line_key: `${WINGS_ID}::` },
    { menu_item_id: GREEK_SALAD, name: "Greek Salad", quantity: 1, price_cents: 1099, modifiers: [], line_key: `${GREEK_SALAD}::` },
    { menu_item_id: PEPPERONI_MEDIUM, name: "Pepperoni Pizza - Medium (14\")", quantity: 2, price_cents: 1499, modifiers: [], line_key: `${PEPPERONI_MEDIUM}::` },
  ];
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: `${WINGS_ID}::`, group_id: "flavor" },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("WART"),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "no stromboli, just the greek salad and 2 medium pepperonis",
      cart: cartBefore,
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  assert(
    !/we don'?t have/i.test(result.reply),
    `the restated order must never be echoed back as a failed slot value: ${JSON.stringify(result.reply)}`,
  );
  assert(
    !result.reply.includes("2 medium pepperonis"),
    `the customer's restated words must never be quoted back: ${JSON.stringify(result.reply)}`,
  );
  assertEquals(result.cart.length, 3, `the cart must stay exactly as it was — this turn resolves nothing: ${JSON.stringify(result.cart)}`);
  const wings = result.cart.find(l => l.menu_item_id === WINGS_ID);
  const greek = result.cart.find(l => l.menu_item_id === GREEK_SALAD);
  const pep = result.cart.find(l => l.menu_item_id === PEPPERONI_MEDIUM);
  assert(wings, "the Wings line (the open slot's own line) must never be removed");
  assertEquals(greek!.quantity, 1);
  assertEquals(pep!.quantity, 2, "no duplicate pepperoni line, cart was already correct before this fix too");
});
