// PO dispatch (2026-09-20): corrects an earlier dispatch tonight
// ("dropDisambiguationList"/"disambiguationMessageIsOrderShaped", GAP (a) —
// see narrowing-exit-order-shaped-answer-20260919.test.ts) that assumed
// "chicken calzone"/"gyro calzone" resolve to real menu items. Confirmed
// against real Vito's data (menu_id 54a42842-32be-43b5-9e0c-00fae0ce48fc,
// shop e0000000-0000-0000-0000-000000000001): neither term has ANY lexicon
// rows — calzones are plain (Calzone - 16"/14"/Personal, category
// "Stromboli"), and gyro exists as a Pizza, a Stromboli, a Hot Sandwich, or
// a Salad, never a "calzone". So the runner-level order-shaped mechanism
// (GAP (a)) correctly finds nothing to grab onto for this message, and the
// bug lives inside answer()'s own "disambiguation" case in turn-engine.ts:
//
//   1. the facet-mismatch branch (`if (!matched) ...`) returned bare
//      UNRESOLVED with no connection to the noProgress/numbered-list-then-
//      cap escalation ladder the "matched everything, zero exclusion" branch
//      a few lines below it already uses — the SAME facet question got
//      re-asked forever.
//   2. the bottom `if (!resolved) ...` branch's own give-up check
//      (`state.open.noProgress && openRepeatCount>=2`) never fires the FIRST
//      time a noProgress-tier numbered-list answer fails, since nothing on
//      either dead-end path had ever set `noProgress` before this dispatch.
//
// Fix: (1) unifies into the same disambiguation_narrowed/noProgress outcome
// the "matched everything" branch already returns; (2) adds a message-driven
// exit (disambiguation_offmenu_declined) that fires on the FIRST noProgress-
// tier failure when the failing answer's own words resolve, via the shop's
// real lexicon, to real items entirely outside the open candidates — see
// findRealOffMenuTermsOutsideCandidates's own header in turn-engine.ts.
//
// METHODOLOGY (mandatory, per tonight's standing rule): every fixture below
// drives the real production call path, turn-engine-runner.ts's own
// runTurnEngineTurn — never decide()/answer() called directly. Fixtures 1
// and 2 use failingPropose: neither should ever need a model call, since the
// whole point is these are handled deterministically by the pending-answer
// resolver. Fixture 3 legitimately needs PROPOSE ("large cheese pizza" is a
// genuinely new, resolvable order).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Real Vito's data (read-only probe, 2026-09-20) ─────────────────────────
// Bare lexicon term "fries" resolves ambiguously to exactly these 8 real
// Appetizers items (no shared "Fries" category — Vito's files them under
// "Appetizers").
const CALI_FRIES = "f327154c-b18d-466e-b92d-e2bc059b0a33";
const TEXAS_FRIES = "b4e82cea-0ef8-466a-87ca-e79a30dc8c57";
const FRENCH_FRIES = "1d0ad29e-7b35-4824-9a5a-1e17fecdd355";
const CRAB_FRIES = "76b08c64-fa1e-4807-835c-34464aa2ccaf";
const NACHO_CHEESE_FRIES = "e06d3c81-87c7-43c0-83cd-69d0e963124b";
const CRAZY_FRIES = "1d5534e4-39ea-4025-ae98-a31b0233e453";
const SWEET_POTATO_FRIES = "f6ae4b2a-69d8-4137-8126-ff07f9ce7751";
const BACON_CHEESE_FRIES = "1cc3493a-b681-4eb5-931f-20bda140d5d4";

// Real Vito's calzones — category "Stromboli", plain only (no "chicken" or
// "gyro" variant exists as a calzone).
const CALZONE_16 = "7a69a23f-2dca-4522-97cf-d6b90efbb662";
const CALZONE_14 = "9048bf9f-0a86-4a56-b53b-ec368b823641";
const CALZONE_PERSONAL = "ad850a9f-1911-44a6-a389-e5636ad4fa6d";

// Real Vito's gyro items — spans 4 categories, never a "calzone".
const GYRO_SANDWICH = "7d457415-b011-4182-86a1-5869aab665c3"; // Hot Sandwiches
const GYRO_SALAD = "9369c1e7-38df-45da-985e-36d278d7a12c"; // Salads
const GYRO_PIZZA_SMALL = "8b7a1ec8-1288-4199-82d0-a0dbf58fc22d"; // Pizza
const GYRO_PIZZA_MEDIUM = "9932435f-bb6d-4bcc-b975-9a89ad552cfe"; // Pizza
const GYRO_PIZZA_LARGE = "713b447f-9798-4188-8930-967f03cb3678"; // Pizza
const GYRO_STROMBOLI_16 = "4795c606-527e-4d63-a8c0-48be646fc91a"; // Stromboli
const GYRO_STROMBOLI_14 = "b756d6df-122c-4cba-9f10-9ecc994dd5c5"; // Stromboli
const GYRO_STROMBOLI_PERSONAL = "1913e08d-f189-4b50-9a96-f696ba47541f"; // Stromboli

// Real Vito's "Chicken" quesadilla — the only real target of the bare term
// "chicken" (confirmed: NOT a broad protein modifier on this menu — just
// this one item, whose own name IS "Chicken").
const CHICKEN_QUESADILLA = "ca76b6d2-351e-437a-a33b-b9a6ab6b23b2";

// Real Vito's cheese pizza sizes (fixture 3 — a clean, resolvable answer
// while fries is pending must still apply normally via GAP (a)'s existing
// runner-level mechanism).
const CHEESE_PIZZA_LARGE = "cheese-pizza-large-real";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  realItem(CALI_FRIES, "Cali Fries", "Appetizers", 999),
  realItem(TEXAS_FRIES, "Texas Fries", "Appetizers", 999),
  realItem(FRENCH_FRIES, "French Fries", "Appetizers", 499),
  realItem(CRAB_FRIES, "Crab Fries", "Appetizers", 899),
  realItem(NACHO_CHEESE_FRIES, "Nacho Cheese Fries", "Appetizers", 699),
  realItem(CRAZY_FRIES, "Crazy Fries", "Appetizers", 999),
  realItem(SWEET_POTATO_FRIES, "Sweet Potato Fries", "Appetizers", 649),
  realItem(BACON_CHEESE_FRIES, "Bacon Cheese Fries", "Appetizers", 849),
  realItem(CALZONE_16, "Calzone - 16\"", "Stromboli", 2295),
  realItem(CALZONE_14, "Calzone - 14\"", "Stromboli", 1895),
  realItem(CALZONE_PERSONAL, "Calzone - Personal", "Stromboli", 1295),
  realItem(GYRO_SANDWICH, "Gyro (Beef or Chicken)", "Hot Sandwiches", 1099),
  realItem(GYRO_SALAD, "Gyro (Beef or Chicken)", "Salads", 1499),
  realItem(GYRO_PIZZA_SMALL, "Gyro - Small (10\")", "Pizza", 1295),
  realItem(GYRO_PIZZA_MEDIUM, "Gyro - Medium (14\")", "Pizza", 1999),
  realItem(GYRO_PIZZA_LARGE, "Gyro - Large (16\")", "Pizza", 2299),
  realItem(GYRO_STROMBOLI_16, "Gyro - 16\"", "Stromboli", 2295),
  realItem(GYRO_STROMBOLI_14, "Gyro - 14\"", "Stromboli", 1895),
  realItem(GYRO_STROMBOLI_PERSONAL, "Gyro - Personal", "Stromboli", 1295),
  realItem(CHICKEN_QUESADILLA, "Chicken", "Quesadillas", 1249),
  realItem(CHEESE_PIZZA_LARGE, "Cheese Pizza - Large (16\")", "Pizza", 1699),
];

const FRIES_IDS = [
  CALI_FRIES, TEXAS_FRIES, FRENCH_FRIES, CRAB_FRIES,
  NACHO_CHEESE_FRIES, CRAZY_FRIES, SWEET_POTATO_FRIES, BACON_CHEESE_FRIES,
];

const LEXICON = [
  ...FRIES_IDS.map(id => ({ term: "fries", target_id: id })),
  { term: "calzone", target_id: CALZONE_16 },
  { term: "calzone", target_id: CALZONE_14 },
  { term: "calzone", target_id: CALZONE_PERSONAL },
  { term: "gyro", target_id: GYRO_SANDWICH },
  { term: "gyro", target_id: GYRO_SALAD },
  { term: "gyro", target_id: GYRO_PIZZA_SMALL },
  { term: "gyro", target_id: GYRO_PIZZA_MEDIUM },
  { term: "gyro", target_id: GYRO_PIZZA_LARGE },
  { term: "gyro", target_id: GYRO_STROMBOLI_16 },
  { term: "gyro", target_id: GYRO_STROMBOLI_14 },
  { term: "gyro", target_id: GYRO_STROMBOLI_PERSONAL },
  { term: "chicken", target_id: CHICKEN_QUESADILLA },
  { term: "cheese pizza", target_id: CHEESE_PIZZA_LARGE },
  { term: "cheese", target_id: CHEESE_PIZZA_LARGE },
  { term: "large cheese pizza", target_id: CHEESE_PIZZA_LARGE },
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
  return { from: (table: string) => builder(table) } as any;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-offmenu-20260920",
    shopId: "shop-vitos-real",
    tenantId: "shop-vitos-real",
    cartId: "cart-offmenu-20260920",
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

function failingPropose(label: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => {
    throw new Error(`${label}: PROPOSE must never be called — this turn must resolve deterministically`);
  };
}

function cartMenuItemIds(cart: TurnEngineCartLine[]): string[] {
  return cart.filter(l => typeof l.menu_item_id === "string").map(l => l.menu_item_id as string);
}

// ── Fixture 1: facet exists, the failing answer matches NOTHING in the
// facet at all, twice running, against REAL data (no synthetic menu). ──────
Deno.test("Fixture 1, turn 1: 'a side of fries' opens the real 8-candidate fries narrowing ('Sure — what kind?')", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "fries", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const t1 = await runTurnEngineTurn(baseInput({ message: "a side of fries" }), deps);
  assertEquals(t1.reply, "Sure — what kind?", `turn 1 must ask the plain facet question: ${t1.reply}`);
  assertEquals(t1.dialogueState.open?.kind, "disambiguation");
  assertEquals(cartMenuItemIds(t1.cart).length, 0, "nothing added while still ambiguous");
});

Deno.test("Fixture 1, turn 2: an answer matching NO fries kind at all falls back to the numbered list, never repeats 'Sure — what kind?'", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateAfterTurn1: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: FRIES_IDS, quantity: 1, spanText: "a side of fries" },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("Fixture 1 turn 2"),
  };
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "oh my bad, can i get one chicken and one gyro calzone?", dialogueState: dialogueStateAfterTurn1 }),
    deps,
  );
  assert(/which one would you like/i.test(t2.reply), `turn 2 must fall back to the numbered list: "${t2.reply}"`);
  assert(!/what kind/i.test(t2.reply), `turn 2 must never repeat the facet question's own wording: "${t2.reply}"`);
  for (let i = 1; i <= 8; i++) assert(t2.reply.includes(`${i})`), `numbered list must enumerate all 8 fries, missing #${i}: ${t2.reply}`);
  assertEquals(t2.dialogueState.open?.kind, "disambiguation", "the fries narrowing must still be open — this was only the first failed attempt");
  assertEquals((t2.dialogueState.open as Extract<DialogueState["open"], { kind: "disambiguation" }>).noProgress, true);
  assertEquals(cartMenuItemIds(t2.cart).length, 0, "nothing real was cleanly named — nothing added");
});

Deno.test("Fixture 1, turn 3: a second failed answer that names REAL off-menu calzone/gyro shapes gets a terminal off-menu reply — never the same list, never an add, fries dropped", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateAfterTurn2: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: FRIES_IDS, quantity: 1, noProgress: true, facetNarrowed: true },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("Fixture 1 turn 3"),
  };
  const t3 = await runTurnEngineTurn(
    baseInput({ message: "the chicken calzone and the gyro calzone, pls", dialogueState: dialogueStateAfterTurn2 }),
    deps,
  );
  assert(!/which one would you like/i.test(t3.reply), `turn 3 must never repeat the numbered list: "${t3.reply}"`);
  assert(!/what kind/i.test(t3.reply), `turn 3 must never repeat the facet question: "${t3.reply}"`);
  assert(/calzone/i.test(t3.reply), `turn 3 must name the real calzone shape: "${t3.reply}"`);
  assert(/gyro/i.test(t3.reply), `turn 3 must name the real gyro shape: "${t3.reply}"`);
  assert(/16"|14"|Personal/i.test(t3.reply), `turn 3 must name a real calzone size: "${t3.reply}"`);
  assert(/pizza|stromboli/i.test(t3.reply), `turn 3 must name a real gyro shape (pizza or stromboli): "${t3.reply}"`);
  assert(
    !cartMenuItemIds(t3.cart).some(id => [CALZONE_16, CALZONE_14, CALZONE_PERSONAL].includes(id)),
    `no calzone must be added — "chicken calzone"/"gyro calzone" are not real items: ${JSON.stringify(t3.cart)}`,
  );
  assert(
    !cartMenuItemIds(t3.cart).some(id => FRIES_IDS.includes(id)),
    `no fries candidate was ever cleanly named — none must be guessed into the cart: ${JSON.stringify(t3.cart)}`,
  );
  assertEquals(cartMenuItemIds(t3.cart).length, 0, "nothing at all added this turn");
  assertEquals(t3.dialogueState.open?.kind !== "disambiguation", true, "the fries narrowing must be dropped, not left open forever");
});

// ── Fixture 2 (regression guard): the quesadilla "matched everything, zero
// exclusion" shape (the noProgress mechanism ALREADY correctly handles this
// — real bare term "chicken" resolves to exactly ONE outside item on Vito's
// real menu, so findRealOffMenuTermsOutsideCandidates never fires here; this
// must still cap via the pre-existing openRepeatCount ladder, unchanged). ──
const QUESADILLA_KINDS = ["Buffalo", "BBQ", "Grilled", "Thai", "Ranch", "Spicy"];
const QUESADILLA_IDS = QUESADILLA_KINDS.map((_, i) => `q${i}-quesadilla-real`);
function quesadillaItem(id: string, kind: string, price: number): TurnEngineMenuItem {
  return realItem(id, `${kind} Chicken Quesadilla`, "Quesadillas", price);
}
const QUESADILLA_MENU: TurnEngineMenuItem[] = QUESADILLA_KINDS.map((k, i) => quesadillaItem(QUESADILLA_IDS[i], k, 999 + i * 10));
// The live term collision this mechanism exists for: "chicken" is a bare,
// single-word lexicon term whose target set is EVERY one of these — none
// are "outside" the open candidates, so the new off-menu exit never engages.
const QUESADILLA_LEXICON = QUESADILLA_IDS.map(id => ({ term: "chicken", target_id: id }));

function makeQuesadillaSupabase() {
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? QUESADILLA_LEXICON : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in() { return Promise.resolve({ data: [], error: null }); },
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

Deno.test("Fixture 2 (quesadilla, regression guard): 'chicken' x3 shows the numbered list on the 2nd ask, then something other than the identical list — cap still holds, no regression from the off-menu fix", async () => {
  const supabase = makeQuesadillaSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (input): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeCalls > 1) throw new Error(`PROPOSE must only be called once (the opening add) — called again for: "${input.message}"`);
      return Promise.resolve({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "chicken quesadilla", quantity: 1, choices: [] }], removes: [], modifies: [] },
      });
    },
  };

  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;
  const replies: string[] = [];

  for (const message of ["a chicken quesadilla", "chicken", "chicken", "chicken"]) {
    const r = await runTurnEngineTurn(
      baseInput({ message, menu: QUESADILLA_MENU, cart, dialogueState }),
      deps,
    );
    replies.push(r.reply);
    cart = r.cart;
    dialogueState = r.dialogueState;
  }

  const numberedListReplies = replies.filter(r => /\d+\)/.test(r));
  assert(numberedListReplies.length <= 2, `the identical numbered list must never be shown a 3rd time: ${JSON.stringify(replies)}`);
  assert(
    replies.slice(1).some(r => r.includes("I couldn't match that") || r.includes("leave that off")),
    `expected a real escalation (reworded fallback or give-up) within these 4 turns: ${JSON.stringify(replies)}`,
  );
  assertEquals(cartMenuItemIds(cart).length, 0, "no quesadilla kind was ever cleanly named — none should ever be guessed into the cart");
});

// ── Fixture 3: rule (a) still holds — an answer that DOES resolve while
// fries is pending is applied as a real order. Verified against the real
// runner rather than assumed: "actually make it a large cheese pizza"
// resolves via answer()'s own pre-existing messageNamesItemOutsideCandidates
// check (a clean, unique, outside-the-candidates resolution — never the
// runner-level GAP (a) drop-and-reprocess path, since answer() itself
// already resolves the turn before dropDisambiguationList is ever
// consulted) — PROPOSE is never called, and the ORIGINAL fries
// disambiguation is carried forward unresolved (disambiguation_new_item_added
// deliberately never drops it — see that outcome's own doc). Neither
// behavior is touched by this dispatch's fix; this test only proves it
// still holds.
Deno.test("Fixture 3 (no regression): 'actually make it a large cheese pizza' while fries is pending adds the real pizza, never guesses at fries", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: FRIES_IDS, quantity: 1, spanText: "a side of fries" },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("Fixture 3"),
  };

  const t = await runTurnEngineTurn(
    baseInput({ message: "actually make it a large cheese pizza", dialogueState: dialogueStateBefore }),
    deps,
  );
  assert(cartMenuItemIds(t.cart).includes(CHEESE_PIZZA_LARGE), `Large Cheese Pizza must be added: ${JSON.stringify(t.cart)}`);
  assertEquals(cartMenuItemIds(t.cart).length, 1, `exactly one real line — no fries candidate guessed alongside it: ${JSON.stringify(t.cart)}`);
  assert(/Cheese Pizza.*added/i.test(t.reply), `reply must confirm the real add: "${t.reply}"`);
});
