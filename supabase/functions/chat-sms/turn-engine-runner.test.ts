// Turn Engine, Phase 3b gate (docs/specs/2026-09-14-turn-engine-oversight.md
// §4 Phase 3). Exercises turn-engine-runner.ts's own orchestration with
// injected fakes for every I/O dependency — zero network, zero real
// Postgres writes. propose.ts's own parse/failure paths are already
// exhaustively covered by propose.test.ts; here it's exercised through the
// runner either via a direct fake (proposeTurnFn) for the happy paths, or
// via the REAL proposeTurn with a stubbed fetchImpl for the one test that
// must prove the runner's own terminal-failure behavior (fallback reply,
// cart/dialogue_state left untouched, error_log row written).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  runTurnEngineTurn,
  FALLBACK_REPLY,
  INITIAL_DIALOGUE_STATE,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";
import { appendComplianceDisclosureIfFirstContact } from "./index.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MENU: TurnEngineMenuItem[] = [
  {
    id: "item-cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: "item-bacon-cheeseburger", name: "Bacon Cheeseburger", category: "Burgers", price_cents: 1099,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Bacon Cheeseburger", base_price_cents: 1099, recap_template: "", ticket_template: "", steps: [] },
  },
];

const LEXICON = [
  { term: "cheese burger", target_id: "item-cheeseburger" },
  { term: "bacon cheeseburger", target_id: "item-bacon-cheeseburger" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-1",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message: "cheeseburger",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: false,
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: "Jason",
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

// ── Fake Supabase — records every write, answers every read, zero real I/O ─

interface FakeState {
  orderCartsUpdates: Array<Record<string, unknown>>;
  messagesInserted: Array<Record<string, unknown>>;
  errorLogInserted: Array<Record<string, unknown>>;
  shopSettings: { upsell_enabled?: boolean } | null;
  lexicon: Array<{ term: string; target_id: string }>;
}

interface FakeSupabaseOverrides extends Partial<Pick<FakeState, "shopSettings" | "lexicon">> {
  // Makes the .range() call starting at this offset resolve as a PostgREST
  // error (data: null, error) instead of a page of rows — reproduces a real
  // fetch failure on page N>0, distinct from a clean short/empty-page finish.
  lexiconPageErrorAtOffset?: number;
  // Overrides what the count-only query (.select(..., {count:"exact",
  // head:true})) reports, independent of state.lexicon.length — reproduces
  // the count query disagreeing with what pagination actually loaded even
  // though pagination itself completed with no error.
  lexiconCountOverride?: number;
}

function makeFakeSupabase(overrides: FakeSupabaseOverrides = {}) {
  const { lexiconPageErrorAtOffset, lexiconCountOverride, ...stateOverrides } = overrides;
  const state: FakeState = {
    orderCartsUpdates: [],
    messagesInserted: [],
    errorLogInserted: [],
    shopSettings: null,
    lexicon: LEXICON,
    ...stateOverrides,
  };

  // Real PostgREST caps an unbounded select at 1000 rows by default, silently
  // — the exact defect loadItemLexicon's paging fix exists to close. Mirror
  // that here: a chain that never calls .range() (the old, unpaged code
  // path) gets the first 1000 rows; a chain that does call .range(from, to)
  // (the fixed, paged code path) gets exactly the slice it asked for.
  const POSTGREST_DEFAULT_ROW_CAP = 1000;

  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select(_cols: unknown, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === "exact") b.__isCount = true;
        return b;
      },
      eq() { return b; },
      order() { return b; },
      maybeSingle() {
        if (table === "shop_settings") return Promise.resolve({ data: state.shopSettings, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      range(from: number, to: number) {
        if (table === "lexicon" && lexiconPageErrorAtOffset === from) {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
        const all = table === "lexicon" ? state.lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert(row: Record<string, unknown>) {
        if (table === "messages") state.messagesInserted.push(row);
        if (table === "error_log") state.errorLogInserted.push(row);
        return Promise.resolve({ error: null });
      },
      // Thenable, for a chain that awaits the builder directly rather than
      // terminating with .maybeSingle()/.range() — mirrors PostgREST's own
      // silent default-cap behavior when no explicit Range header is sent,
      // and also serves the count-only query (.select(..., {count:"exact",
      // head:true})), which never calls .range() either.
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void, reject?: (e: unknown) => void) {
        if (table === "lexicon" && b.__isCount) {
          const count = lexiconCountOverride ?? state.lexicon.length;
          return Promise.resolve({ data: null, error: null, count }).then(resolve, reject);
        }
        const data = table === "lexicon" ? state.lexicon.slice(0, POSTGREST_DEFAULT_ROW_CAP) : null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

function baseDeps(overrides: Partial<RunTurnDeps> = {}): RunTurnDeps {
  const { supabase } = makeFakeSupabase();
  return { supabase, apiKey: "test-key", ...overrides };
}

// ── ANSWER resolves deterministically -> PROPOSE never called ────────────

Deno.test("runTurnEngineTurn: a bare closure with no open question resolves via ANSWER, PROPOSE is never called", async () => {
  const { supabase, state } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("must not be called")); },
  };
  const input = baseInput({ message: "no", cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "PROPOSE must be skipped when ANSWER resolves the turn deterministically");
  assertEquals(result.cart, []);
  assert(result.reply.length > 0, "RENDER must always produce a non-empty reply");
  assertEquals(state.orderCartsUpdates.length, 1, "cart + dialogue_state must be persisted exactly once");
  assertEquals(state.orderCartsUpdates[0].cart_json, []);
  assertEquals((state.orderCartsUpdates[0].dialogue_state as DialogueState).open, null);
  assertEquals(state.messagesInserted.length, 1);
  assertEquals(state.messagesInserted[0].role, "assistant");
  assertEquals(state.messagesInserted[0].content, result.reply);
});

Deno.test("runTurnEngineTurn: an open slot question resolves via ANSWER against the cart line, no PROPOSE call", async () => {
  const askPlanWithSlot = {
    compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: "group-temp", slot_key: "temperature", kind: "slot" as const, ask_mode: "ask" as const,
      prompt_template: "How would you like that cooked?",
      choices: [
        { id: "choice-medium", display: "Medium", price_delta_cents: 0 },
        { id: "choice-well-done", display: "Well Done", price_delta_cents: 0 },
      ],
    }],
  };
  const menuWithSlot: TurnEngineMenuItem[] = [
    { id: "item-cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849, bot_state: "orderable", ask_plan: askPlanWithSlot, option_groups: [{ id: "group-temp", name: "Temperature" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-temp" }, upsell_offered: false, asked_message_id: null };

  const { supabase, state } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("must not be called")); } };
  const input = baseInput({ message: "medium", menu: menuWithSlot, cart, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0);
  assertEquals(result.cart[0].ask_plan_selections, { "group-temp": "choice-medium" });
  assertEquals(result.dialogueState.open, null, "the slot question is resolved, nothing else is open (anything-else falls through)");
  assertEquals(state.orderCartsUpdates.length, 1);
  assertEquals(state.orderCartsUpdates[0].cart_json, result.cart);
});

// ── ANSWER has structural priority over PROPOSE/DECIDE/the lexicon ───────
//
// compile-menu.ts (2026-09-15 PO dispatch, choice-collision extension)
// stops suppressing a derived item head noun that collides only with a
// rule 6 CHOICE term — e.g. "penne" now exists both as Zio's "Choose
// Pasta" slot's own stated choice term AND as a derived item term on some
// other pasta dish. The justification for not splitting that fix by
// ask_mode rests entirely on THIS test: with a real, rendered "Choose
// Pasta"-shaped question open (ask_mode "ask", modeled on Zio's actual
// Fettuccine/Rigatoni/Penne/Spaghetti/Angel Hair/Linguine group), answer()
// resolves "penne" directly against the open slot's own compiled choices
// (applyCompiledModifyItem, called with the raw customer text) BEFORE
// PROPOSE/DECIDE — and therefore the lexicon — are ever reached. If this
// assertion (proposeCalls === 0) ever fails, PROPOSE has become reachable
// while a choice question is open, the priority argument is wrong, and the
// compile-menu.ts fix must be redesigned to split by ask_mode.
Deno.test("runTurnEngineTurn: 'penne' against an open 'Choose Pasta' ask_mode:'ask' slot resolves via ANSWER (existing line mutated, not a new line added), PROPOSE is never called", async () => {
  const askPlanWithPastaSlot = {
    compiled_at: "", compiler_version: 1, display_name: "Baked Ziti", base_price_cents: 1295,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: "group-pasta", slot_key: "pasta", kind: "slot" as const, ask_mode: "ask" as const,
      prompt_template: "Choose Pasta",
      choices: [
        { id: "choice-fettuccine", display: "Fettuccine", price_delta_cents: 0 },
        { id: "choice-rigatoni", display: "Rigatoni", price_delta_cents: 0 },
        { id: "choice-penne", display: "Penne", price_delta_cents: 0 },
        { id: "choice-spaghetti", display: "Spaghetti", price_delta_cents: 0 },
        { id: "choice-angel-hair", display: "Angel Hair", price_delta_cents: 0 },
        { id: "choice-linguine", display: "Linguine", price_delta_cents: 0 },
      ],
    }],
  };
  const menuWithPastaSlot: TurnEngineMenuItem[] = [
    { id: "item-baked-ziti", name: "Baked Ziti", category: "Entrees", price_cents: 1295, bot_state: "orderable", ask_plan: askPlanWithPastaSlot, option_groups: [{ id: "group-pasta", name: "Pasta" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-baked-ziti", name: "Baked Ziti", quantity: 1, price_cents: 1295, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-pasta" }, upsell_offered: false, asked_message_id: null };

  const { supabase, state } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("must not be called — PROPOSE must never be reachable while a choice question is open")); } };
  const input = baseInput({ message: "penne", menu: menuWithPastaSlot, cart, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "THE priority assertion: PROPOSE must never be called while the Choose Pasta question is open");
  assertEquals(result.cart.length, 1, "the existing Baked Ziti line must be mutated, not a second line added");
  assertEquals(result.cart[0].menu_item_id, "item-baked-ziti");
  assertEquals(result.cart[0].ask_plan_selections, { "group-pasta": "choice-penne" }, "ANSWER resolved Penne onto the existing line's slot");
  assertEquals(result.dialogueState.open, null, "the pasta question is resolved, nothing else is open");
  assertEquals(state.orderCartsUpdates.length, 1);
  assertEquals(state.orderCartsUpdates[0].cart_json, result.cart);
});

// ── PROPOSE runs when ANSWER cannot resolve, DECIDE resolves the item ────

Deno.test("runTurnEngineTurn: ANSWER cannot resolve a fresh order message, PROPOSE runs, DECIDE resolves item_span via resolve-item.ts", async () => {
  const { supabase, state } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      // "cheese burger" — matches the LEXICON fixture's whole-word term
      // exactly (resolve-item.ts requires a whole-word run; the one-word
      // "cheeseburger" would not match the two-word lexicon term).
      return Promise.resolve({
        ok: true,
        attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "cheese burger", quantity: 2, choices: [] }], removes: [], modifies: [] },
      });
    },
  };
  const input = baseInput({ message: "two cheeseburgers", cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 1);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-cheeseburger");
  assertEquals(result.cart[0].quantity, 2);
  assertEquals(result.cart[0].line_key, "line-1");
  assert(result.reply.length > 0);
  assertEquals(state.orderCartsUpdates.length, 1);
  assertEquals(state.orderCartsUpdates[0].cart_json, result.cart);
  assertEquals((state.orderCartsUpdates[0].dialogue_state as DialogueState), result.dialogueState);
  assertEquals(state.messagesInserted.length, 1);
});

// ── loadItemLexicon must page past PostgREST's silent 1000-row cap ───────
// Reproduces the live incident directly: Vito's has 1298 active item
// lexicon rows. Against the fake's PostgREST-shaped cap (see makeFakeSupabase
// above), the unpaged loader gets only the first 1000 (a truncated fake
// PROPOSE input.lexicon.length === 1000); the paged loader pages via
// .range() until a short page and gets the full 1298.

Deno.test("runTurnEngineTurn: loadItemLexicon pages past PostgREST's 1000-row cap and hands PROPOSE all 1298 lexicon rows", async () => {
  const fullLexicon = Array.from({ length: 1298 }, (_, i) => ({ term: `term-${i}`, target_id: `target-${i}` }));
  const { supabase } = makeFakeSupabase({ lexicon: fullLexicon });
  let seenLexiconLength = -1;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (input): Promise<ProposeResult> => {
      seenLexiconLength = input.lexicon.length;
      return Promise.resolve({
        ok: true,
        attempts: 1,
        proposal: { intent: "other", adds: [], removes: [], modifies: [] },
      });
    },
  };
  const input = baseInput({ message: "two cheeseburgers", cart: [] });

  await runTurnEngineTurn(input, deps);

  assertEquals(seenLexiconLength, 1298, "the loader must return every active row, not PostgREST's silently-capped first 1000");
});

// ── loadItemLexicon: a real error on page 2 must NOT be treated as a clean
// finish ────────────────────────────────────────────────────────────────
// A short/empty page (no error) is a normal, expected finish. A real
// PostgREST error on some page N is a different thing entirely: the fetch
// FAILED, and whatever rows were accumulated so far are an incomplete,
// arbitrary partial list — not a complete lexicon. b2440886's loop treats
// both the same way (`if (error || !data || data.length === 0) break;`),
// so a page-2 error silently hands back page 1's 1000 rows as if that were
// the whole lexicon — the same silent-truncation failure class one level up.

Deno.test("runTurnEngineTurn: a PostgREST error on page 2 of loadItemLexicon is NOT silently treated as a clean finish", async () => {
  const fullLexicon = Array.from({ length: 1298 }, (_, i) => ({ term: `term-${i}`, target_id: `target-${i}` }));
  const { supabase, state } = makeFakeSupabase({ lexicon: fullLexicon, lexiconPageErrorAtOffset: 1000 });
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };
  const priorCart: TurnEngineCartLine[] = [];
  const priorState: DialogueState = { ...INITIAL_DIALOGUE_STATE };
  const input = baseInput({ message: "two cheeseburgers", cart: priorCart, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "a failed lexicon load must not silently hand PROPOSE a partial list as if it were complete");
  assertEquals(result.reply, FALLBACK_REPLY);
  assertEquals(result.cart, priorCart);
  assertEquals(result.dialogueState, priorState);
  assertEquals(state.errorLogInserted.length, 1, "the page-2 error must be persisted, not swallowed");
  assertEquals(state.errorLogInserted[0].stage, "lexicon_load");
  assertEquals(state.errorLogInserted[0].shop_id, "shop-1");
  assertEquals((state.errorLogInserted[0].metadata as { offset: number }).offset, 1000, "must name the page offset where the error occurred");
});

// ── loadItemLexicon: a clean-finishing paginated fetch can still disagree
// with the table's true row count ─────────────────────────────────────────
// Pagination can "complete" with no error (ends on a short/empty page) and
// still not match reality — e.g. a stale read, a race with concurrent
// writes, or a bug in the paging bounds. b2440886 has no guard for this at
// all. An independent count-only query against the same three filters is
// the only way to catch it.

Deno.test("runTurnEngineTurn: a clean paginated finish that disagrees with an independent count query writes both numbers to error_log", async () => {
  // Exactly one full page (1000 rows) — pagination requests a second page
  // (data.length === PAGE_SIZE keeps the loop going), that second page comes
  // back empty, and the loop finishes with NO error at all. The count query
  // independently reports 1298, simulating the same true count as the live
  // incident (Vito's 1298 active lexicon rows) despite pagination itself
  // having completed cleanly.
  const exactlyOnePage = Array.from({ length: 1000 }, (_, i) => ({ term: `term-${i}`, target_id: `target-${i}` }));
  const { supabase, state } = makeFakeSupabase({ lexicon: exactlyOnePage, lexiconCountOverride: 1298 });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> =>
      Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } }),
  };
  const input = baseInput({ message: "two cheeseburgers", cart: [] });

  await runTurnEngineTurn(input, deps);

  assertEquals(state.errorLogInserted.length, 1, "a count/loaded mismatch after a clean paginated finish must be logged");
  assertEquals(state.errorLogInserted[0].stage, "lexicon_load");
  assertEquals(state.errorLogInserted[0].shop_id, "shop-1");
  const metadata = state.errorLogInserted[0].metadata as { expected_count: number; loaded_count: number };
  assertEquals(metadata.expected_count, 1298);
  assertEquals(metadata.loaded_count, 1000);
});

Deno.test("runTurnEngineTurn: an ambiguous item_span adds no cart line and routes to ASK's disambiguation question", async () => {
  const menuBothMatchBareWord: TurnEngineMenuItem[] = [
    { id: "item-a", name: "A Burger", category: "Burgers", price_cents: 500, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "A Burger", base_price_cents: 500, recap_template: "", ticket_template: "", steps: [] } },
    { id: "item-b", name: "B Burger", category: "Burgers", price_cents: 600, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "B Burger", base_price_cents: 600, recap_template: "", ticket_template: "", steps: [] } },
  ];
  // Force a genuine tie: two different lexicon terms of equal (one-word)
  // length both matching "burger".
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "burger", target_id: "item-a" }, { term: "burger", target_id: "item-b" }] });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true,
      attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "burger", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };

  const input = baseInput({ message: "burger", menu: menuBothMatchBareWord, cart: [] });
  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "an ambiguous add must never land a cart line");
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
});

// ── Terminal PROPOSE failure: fallback reply, untouched cart/state, error_log ─

Deno.test("runTurnEngineTurn: terminal PROPOSE failure returns the fallback reply, leaves cart/dialogue_state untouched, and writes an error_log row (stage propose_call) via the real proposeTurn", async () => {
  const { supabase, state } = makeFakeSupabase();
  const priorCart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [] },
  ];
  const priorState: DialogueState = { ...INITIAL_DIALOGUE_STATE };
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    // proposeTurnFn intentionally omitted — exercises the REAL proposeTurn
    // (propose.ts) so its own error_log write path runs for real, not a
    // second, reinvented logging shape in the runner.
    fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }))) as typeof fetch,
    timeoutMs: 50,
  };
  const input = baseInput({ message: "also give me fries", cart: priorCart, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.reply, FALLBACK_REPLY);
  assertEquals(result.cart, priorCart);
  assertEquals(result.dialogueState, priorState);
  assertEquals(state.orderCartsUpdates.length, 0, "nothing changed this turn — cart/dialogue_state must not be rewritten");
  assertEquals(state.messagesInserted.length, 1);
  assertEquals(state.messagesInserted[0].content, FALLBACK_REPLY);
  assertEquals(state.errorLogInserted.length, 1);
  assertEquals(state.errorLogInserted[0].stage, "propose_call");
  assertExists_rawBody(state.errorLogInserted[0]);
});

function assertExists_rawBody(row: Record<string, unknown>) {
  const metadata = row.metadata as { attempts: Array<{ raw_body: string }> };
  assert(metadata.attempts.length > 0);
  assert(metadata.attempts[0].raw_body.includes("bad gateway"));
}

// ── persistTurn must write subtotal_cents/total_cents, reusing the SAME
// itemizer/money code the reply footer and Stripe checkout already use
// (pricing.ts's computeCartSubtotalCents + connect.ts's SERVICE_FEE_CENTS) —
// never a second, parallel money calculation. Confirmed live: conversation
// 5a631ccf had a correct cart and correct reply but subtotal_cents = 0 in
// the row, because persistTurn never wrote either field.

Deno.test("runTurnEngineTurn: persists subtotal_cents/total_cents computed from the cart lines' own price_cents*quantity, plus service fee, delivery fee, and tip", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true,
      attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "cheese burger", quantity: 2, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const input = baseInput({
    message: "two cheeseburgers",
    cart: [],
    shopContext: {
      deliveryEnabled: true,
      orderType: "delivery",
      deliveryAddressKnown: true,
      driverTipCents: 200,
      pickupName: null,
      deliveryFeeCents: 300,
    },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].price_cents, 849);
  assertEquals(result.cart[0].quantity, 2);
  const expectedSubtotal = 849 * 2; // 1698 — sum of the cart lines' own price_cents * quantity
  const expectedTotal = expectedSubtotal + 99 /* SERVICE_FEE_CENTS */ + 300 /* delivery */ + 200 /* tip */;
  assertEquals(state.orderCartsUpdates.length, 1);
  assertEquals(state.orderCartsUpdates[0].subtotal_cents, expectedSubtotal);
  assertEquals(state.orderCartsUpdates[0].total_cents, expectedTotal);
});

Deno.test("runTurnEngineTurn: an empty cart persists subtotal_cents = 0 explicitly, not null, with total_cents numeric", async () => {
  const deps = baseDeps({
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "other", adds: [], removes: [], modifies: [] },
    }),
  });
  const { supabase, state } = makeFakeSupabase();
  const depsWithState: RunTurnDeps = { ...deps, supabase };
  const input = baseInput({ message: "hello", cart: [] });

  await runTurnEngineTurn(input, depsWithState);

  assertEquals(state.orderCartsUpdates.length, 1);
  assertEquals(state.orderCartsUpdates[0].subtotal_cents, 0);
  assert(state.orderCartsUpdates[0].total_cents !== null && state.orderCartsUpdates[0].total_cents !== undefined);
  assertEquals(typeof state.orderCartsUpdates[0].total_cents, "number");
});

// ── Acceptance test 1 (2026-09-15 live bug, deploy 2a852f9b, Vito's test
// store): the exact three-turn transcript that broke four different ways —
// line split (two Cheese Burger lines instead of one at quantity 2), the
// Temp slot question repeating forever, "thats it" reaching PROPOSE while a
// slot question was open and mutating the cart, and the ambiguous "fries"
// span silently dropped instead of surfacing. Asserted after EVERY turn, not
// just at the end, because each of the four defects shows up at a different
// point in the sequence. ─────────────────────────────────────────────────

const ACC1_CHEESE_BURGER_ID = "acc1-cheese-burger";
const ACC1_TEMP_GROUP_ID = "acc1-temp-group";
const ACC1_MEDIUM_CHOICE_ID = "acc1-temp-medium";
const ACC1_FRIES_A_ID = "acc1-fries-a";
const ACC1_FRIES_B_ID = "acc1-fries-b";

const ACC1_MENU: TurnEngineMenuItem[] = [
  {
    id: ACC1_CHEESE_BURGER_ID, name: "Cheese Burger", category: "Burgers", price_cents: 849,
    bot_state: "orderable",
    option_groups: [{ id: ACC1_TEMP_GROUP_ID, name: "Temp", default_choice_id: null }],
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849,
      recap_template: "", ticket_template: "",
      steps: [{
        kind: "slot", ask_mode: "ask", group_id: ACC1_TEMP_GROUP_ID, slot_key: null, prompt_template: "temp.ask",
        choices: [
          { id: "acc1-temp-well", display: "Well Done", price_delta_cents: 0 },
          { id: ACC1_MEDIUM_CHOICE_ID, display: "Medium", price_delta_cents: 0 },
          { id: "acc1-temp-rare", display: "Rare", price_delta_cents: 0 },
        ],
      }],
    },
  },
  {
    id: ACC1_FRIES_A_ID, name: "French Fries", category: "Sides", price_cents: 499, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "French Fries", base_price_cents: 499, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: ACC1_FRIES_B_ID, name: "Cajun Fries", category: "Sides", price_cents: 549, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cajun Fries", base_price_cents: 549, recap_template: "", ticket_template: "", steps: [] },
  },
];

// Both fries items tie on the bare term "fries" — the real Vito's shape
// (multiple fries-family sides) that makes "large fries" genuinely
// ambiguous, exactly like problem 4's live transcript.
const ACC1_LEXICON = [
  { term: "cheeseburger", target_id: ACC1_CHEESE_BURGER_ID },
  { term: "cheeseburgers", target_id: ACC1_CHEESE_BURGER_ID },
  { term: "fries", target_id: ACC1_FRIES_A_ID },
  { term: "fries", target_id: ACC1_FRIES_B_ID },
];

Deno.test("ACCEPTANCE 1: 'two cheeseburgers and a large fries' -> 'medium' -> 'thats it' — one line at qty 2, Temp asked once, fries surfaces, cart untouched by the closing 'thats it'", async () => {
  let proposeCalls = 0;
  const { supabase, state } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `acc1-line-${++n}`; })(),
    // Real, live-probed model output for this exact phrase against this
    // exact menu shape (OpenRouter deepseek/deepseek-v4-flash, 2026-09-15,
    // 8/8 identical runs): ONE add for the burger at the correctly-stated
    // quantity 2, ONE add for the (ambiguous) fries at quantity 1. Turn 1 is
    // the only turn PROPOSE may ever be called on in this whole transcript.
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeCalls > 1) return Promise.reject(new Error(`PROPOSE must be called exactly once across this transcript — this is call ${proposeCalls}`));
      return Promise.resolve({
        ok: true, attempts: 1,
        proposal: {
          intent: "order",
          adds: [
            { item_span: "cheeseburgers", quantity: 2, choices: [] },
            { item_span: "large fries", quantity: 1, choices: [] },
          ],
          removes: [], modifies: [],
        },
      });
    },
  };

  const shopContext = {
    deliveryEnabled: false, orderType: "pickup" as const, deliveryAddressKnown: false,
    driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null,
  };

  // ── Turn 1: "two cheeseburgers and a large fries" ───────────────────────
  const r1 = await runTurnEngineTurn(
    { conversationId: "c1", shopId: "s1", tenantId: "t1", cartId: "cart1", message: "two cheeseburgers and a large fries",
      history: [], menu: ACC1_MENU, cart: [], dialogueState: null, shopContext },
    deps,
  );
  assertEquals(r1.cart.length, 1, `turn 1 must produce ONE Cheese Burger line, not a split — got: ${JSON.stringify(r1.cart)}`);
  assertEquals(r1.cart[0].menu_item_id, ACC1_CHEESE_BURGER_ID);
  assertEquals(r1.cart[0].quantity, 2);
  assertEquals(state.orderCartsUpdates[0].subtotal_cents, 1698, "turn 1 subtotal must be exactly 2 x $8.49, never more");
  assert(r1.dialogueState.open?.kind === "slot", `turn 1 must open the Temp slot question, got: ${JSON.stringify(r1.dialogueState.open)}`);
  const tempAskCount1 = (r1.reply.match(/cooked/gi) ?? []).length;

  // ── Turn 2: "medium" ─────────────────────────────────────────────────────
  const r2 = await runTurnEngineTurn(
    { conversationId: "c1", shopId: "s1", tenantId: "t1", cartId: "cart1", message: "medium",
      history: [], menu: ACC1_MENU, cart: r1.cart, dialogueState: r1.dialogueState, shopContext },
    deps,
  );
  assertEquals(r2.cart.length, 1, `turn 2 must still be ONE Cheese Burger line — the split-one-unit-off bug creates a second here: ${JSON.stringify(r2.cart)}`);
  assertEquals(r2.cart[0].quantity, 2, "turn 2 must resolve Temp for BOTH units on the one line, never split one off");
  assertEquals(r2.cart[0].options, { Temp: ["Medium"] });
  assertEquals(state.orderCartsUpdates[1].subtotal_cents, 1698, "turn 2 subtotal must never exceed turn 1's — no phantom growth");
  const tempAskCount2 = (r2.reply.match(/cooked/gi) ?? []).length;
  assertEquals(tempAskCount1 + tempAskCount2, 1, "the Temp slot question must be asked AT MOST ONCE across the whole transcript, never repeated");
  assert(r2.dialogueState.open?.kind === "disambiguation", `turn 2 must surface the carried fries ambiguity instead of dropping it, got: ${JSON.stringify(r2.dialogueState.open)}`);
  assertEquals(
    [...(r2.dialogueState.open as { candidates: string[] }).candidates].sort(),
    [ACC1_FRIES_A_ID, ACC1_FRIES_B_ID].sort(),
    "turn 2's disambiguation question must be about the fries candidates",
  );

  // ── Turn 3: "thats it" ───────────────────────────────────────────────────
  const r3 = await runTurnEngineTurn(
    { conversationId: "c1", shopId: "s1", tenantId: "t1", cartId: "cart1", message: "thats it",
      history: [], menu: ACC1_MENU, cart: r2.cart, dialogueState: r2.dialogueState, shopContext },
    deps,
  );
  assertEquals(proposeCalls, 1, "PROPOSE must never be called again once the fries disambiguation question is open — 'thats it' is an unambiguous closure");
  assertEquals(r3.cart.length, 1, `the closing 'thats it' must never add a phantom third line: ${JSON.stringify(r3.cart)}`);
  assertEquals(r3.cart[0].quantity, 2, "'thats it' must never change quantity");
  assertEquals(r3.cart, r2.cart, "the cart must be byte-identical before and after the closing 'thats it' turn");
  assertEquals(state.orderCartsUpdates[2].subtotal_cents, 1698, "turn 3 subtotal must never exceed turn 1's — no phantom growth from the closure turn");
});

// ── Return value is always the reply string ───────────────────────────────

Deno.test("runTurnEngineTurn: always returns a non-empty reply string, even on an empty cart with nothing open", async () => {
  const deps = baseDeps({
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "other", adds: [], removes: [], modifies: [] },
    }),
  });
  const input = baseInput({ message: "hello", cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assert(typeof result.reply === "string" && result.reply.length > 0);
});

// ── 10DLC compliance disclosure on the engine path ────────────────────────
// turn-engine-runner.ts itself has no notion of isLifetimeFirstContact (it's
// computed in index.ts, above the turn-engine routing branch, and passed
// nowhere into RunTurnInput) so the disclosure can't be asserted through
// runTurnEngineTurn directly. This exercises the actual append index.ts
// performs on the engine path's outgoing reply — same seam a real regression
// (e.g. someone reverting the append at the routing branch, or dropping the
// isLifetimeFirstContact argument) would break.

Deno.test("appendComplianceDisclosureIfFirstContact: appends the disclosure on a customer's first-ever message", () => {
  const reply = appendComplianceDisclosureIfFirstContact("Here's your total: $12.99", true);
  assertEquals(reply, "Here's your total: $12.99\n\nMsg & data rates may apply. Reply HELP for help or STOP to unsubscribe.");
});

Deno.test("appendComplianceDisclosureIfFirstContact: leaves a returning customer's reply untouched", () => {
  const reply = appendComplianceDisclosureIfFirstContact("Here's your total: $12.99", false);
  assertEquals(reply, "Here's your total: $12.99");
});
