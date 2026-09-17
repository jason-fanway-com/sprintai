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
  extractAddressSpan,
  type RunTurnInput,
  type RunTurnDeps,
  type RunTurnShopContext,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";
import { appendComplianceDisclosureIfFirstContact, appendEngineCheckoutLinkIfReady, type EngineCheckoutDeps } from "./index.ts";

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
  // 00-AK: the cart is empty, so ASK opens "ordering" (what would you like
  // to order?) rather than `null` (which renders "Anything else?" — wrong
  // over an empty cart). Before that fix this asserted `open === null`.
  assertEquals((state.orderCartsUpdates[0].dialogue_state as DialogueState).open, { kind: "ordering", askCount: 1 });
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

// ── 00-BT: ASK must see what THIS turn's ANSWER resolved, not just the
// turn-start shopContext snapshot (Vito's live bug, conversation
// 7be9e651-1274-47f7-990e-f0d8218ac03e, 2026-09-16). ANSWER's sideEffects
// (order_type, driver_tip_cents, pickup_name) are persisted by persistTurn
// but were never merged into the shopContext ASK runs against — so ASK
// re-fired the exact question that was just answered this same turn. Fixed
// by overlaying sideEffects onto input.shopContext before buildAskShopContext,
// same pattern RENDER already used for deliveryFeeCents/driverTipCents a few
// lines below.
//
// NOTE ON SCOPE — the reported transcript also showed a delivery-ADDRESS
// re-ask ("We'll deliver to 5620 Cetronia Rd... / What's the delivery
// address?" repeating). That symptom cannot reproduce through this runner:
// answer()'s "address" case only resolves given an external geocode result
// (AnswerExternalInputs.geocodedAddress), which runTurnEngineTurn never
// supplies — no call site threads it in, and CartSideEffects (above) has no
// address field to merge in the first place (this file's own header note 2
// already documents address collection as inert here). RENDER also never
// emits confirmation prose like "We'll deliver to X" — it only ever emits
// the fixed string "What's the delivery address?" — and that exact
// confirmation string does not appear anywhere in this codebase. That half
// of the report traces to a different code path (the legacy index.ts/LLM
// pipeline, which is frozen for this dispatch), not to the shopContext-merge
// defect fixed here. Flagged for the PO rather than improvised around.

Deno.test("00-BT RED->GREEN: order_type open, 'Delivery' resolves it — ASK must not re-ask 'Pickup or delivery today?' in the same turn's reply", async () => {
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called — ANSWER resolves order_type deterministically")) });
  const input = baseInput({
    message: "Delivery",
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  const askCount = (result.reply.match(/Pickup or delivery today\?/g) ?? []).length;
  assertEquals(askCount, 0, `order_type must not be re-asked once ANSWER resolved it this turn — reply: ${JSON.stringify(result.reply)}`);
  // The ladder correctly advances to the NEXT open question (address, since
  // this turn resolved to delivery) — this is not suppressed, only the
  // just-answered order_type question is.
  assert(result.reply.includes("What's the delivery address?"), `the address question must still open this same turn: ${JSON.stringify(result.reply)}`);
});

Deno.test("00-BT RED->GREEN: order_type open, 'Pickup' resolves it — ASK must not re-ask 'Pickup or delivery today?' in the same turn's reply", async () => {
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called — ANSWER resolves order_type deterministically")) });
  const input = baseInput({
    message: "Pickup",
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  const askCount = (result.reply.match(/Pickup or delivery today\?/g) ?? []).length;
  assertEquals(askCount, 0, `order_type must not be re-asked once ANSWER resolved it this turn — reply: ${JSON.stringify(result.reply)}`);
});

Deno.test("00-BT RED->GREEN: a bare customer name resolves the open 'name' question — ASK must not re-ask it in the same turn's reply", async () => {
  const priorState: DialogueState = { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called — ANSWER resolves name deterministically")) });
  const input = baseInput({
    message: "Joe",
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("What's the name for the order?"), `the name question must not be re-asked once ANSWER resolved it this turn — reply: ${JSON.stringify(result.reply)}`);
  assert(!result.reply.includes("Putting this in for"), `the name question's suggested-name variant must not fire either — reply: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("All good — confirm?"), `the ladder must advance past the just-answered name question to confirm — reply: ${JSON.stringify(result.reply)}`);
});

Deno.test("00-BT: a driver tip amount resolves the open 'tip' question — ASK must not re-ask it in the same turn's reply (same mechanism, same fix)", async () => {
  const priorState: DialogueState = { phase: "tip", open: { kind: "tip" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called — ANSWER resolves tip deterministically")) });
  const input = baseInput({
    message: "$5",
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: true, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: 300 },
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("Want to add a tip for the driver?"), `the tip question must not be re-asked once ANSWER resolved it this turn — reply: ${JSON.stringify(result.reply)}`);
});

// ── 00-BT ACCEPTANCE 3: a full order driven end-to-end at the runner level,
// each question counted across the whole transcript. Delivery-specific
// (order type -> address -> item -> name -> confirm) cannot be driven
// end-to-end through this runner today — see the scope note above (address
// never resolves via ANSWER here, independent of this fix). This drives the
// PICKUP path instead: order type -> item (same turn, matches the real
// prompt's "both things must happen in one turn" rule) -> checkout intent ->
// name -> confirm, threading each turn's persisted sideEffects into the next
// turn's shopContext exactly as index.ts's real reload-from-DB would.

Deno.test("00-BT ACCEPTANCE 3: full pickup order end-to-end — order type, name, and confirm are each asked EXACTLY ONCE", async () => {
  const { supabase, state } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `acc3-line-${++n}`; })(),
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeCalls > 1) return Promise.reject(new Error(`PROPOSE must be called exactly once across this transcript — this is call ${proposeCalls}`));
      return Promise.resolve({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "cheese burger", quantity: 1, choices: [] }], removes: [], modifies: [] },
      });
    },
  };

  let shopContext = { deliveryEnabled: true, orderType: null as "pickup" | "delivery" | null, deliveryAddressKnown: false, driverTipCents: null as number | null, pickupName: null as string | null, deliveryFeeCents: null as number | null };
  const replies: string[] = [];

  function advanceShopContext(update: Record<string, unknown>) {
    shopContext = {
      ...shopContext,
      orderType: (update.order_type as "pickup" | "delivery" | undefined) ?? shopContext.orderType,
      driverTipCents: (update.driver_tip_cents as number | undefined) ?? shopContext.driverTipCents,
      pickupName: (update.pickup_name as string | undefined) ?? shopContext.pickupName,
    };
  }

  // ── Turn 1: "cheese burger" — item added, order_type asked same turn ────
  const r1 = await runTurnEngineTurn(
    { conversationId: "acc3", shopId: "s1", tenantId: "t1", cartId: "cart-acc3", message: "cheese burger",
      history: [], menu: MENU, cart: [], dialogueState: null, shopContext },
    deps,
  );
  replies.push(r1.reply);
  assertEquals(r1.cart.length, 1, "turn 1 must add the Cheese Burger line");
  advanceShopContext(state.orderCartsUpdates[0]);

  // ── Turn 2: "Pickup" — resolves order_type ───────────────────────────────
  const r2 = await runTurnEngineTurn(
    { conversationId: "acc3", shopId: "s1", tenantId: "t1", cartId: "cart-acc3", message: "Pickup",
      history: [], menu: MENU, cart: r1.cart, dialogueState: r1.dialogueState, shopContext },
    deps,
  );
  replies.push(r2.reply);
  advanceShopContext(state.orderCartsUpdates[1]);
  assertEquals(shopContext.orderType, "pickup", "order_type must be persisted from turn 2's ANSWER");

  // ── Turn 3: "thats it" — explicit checkout intent, moves the ladder toward name ─
  const r3 = await runTurnEngineTurn(
    { conversationId: "acc3", shopId: "s1", tenantId: "t1", cartId: "cart-acc3", message: "thats it",
      history: [], menu: MENU, cart: r2.cart, dialogueState: r2.dialogueState, shopContext },
    deps,
  );
  replies.push(r3.reply);
  advanceShopContext(state.orderCartsUpdates[2]);
  assert(r3.reply.includes("What's the name for the order?"), `turn 3 must open the name question: ${JSON.stringify(r3.reply)}`);

  // ── Turn 4: "Joe" — resolves name ────────────────────────────────────────
  const r4 = await runTurnEngineTurn(
    { conversationId: "acc3", shopId: "s1", tenantId: "t1", cartId: "cart-acc3", message: "Joe",
      history: [], menu: MENU, cart: r3.cart, dialogueState: r3.dialogueState, shopContext },
    deps,
  );
  replies.push(r4.reply);
  advanceShopContext(state.orderCartsUpdates[3]);
  assertEquals(shopContext.pickupName, "Joe", "pickup_name must be persisted from turn 4's ANSWER");
  assert(r4.reply.includes("All good — confirm?"), `turn 4 must advance to confirm, not re-ask name: ${JSON.stringify(r4.reply)}`);

  // ── Turn 5: "yes" — confirms, moves to link_sent ─────────────────────────
  const r5 = await runTurnEngineTurn(
    { conversationId: "acc3", shopId: "s1", tenantId: "t1", cartId: "cart-acc3", message: "yes",
      history: [], menu: MENU, cart: r4.cart, dialogueState: r4.dialogueState, shopContext },
    deps,
  );
  replies.push(r5.reply);
  assertEquals(r5.dialogueState.phase, "link_sent");

  const fullTranscript = replies.join("\n---\n");
  const orderTypeAskCount = (fullTranscript.match(/Pickup or delivery today\?/g) ?? []).length;
  const nameAskCount = (fullTranscript.match(/What's the name for the order\?/g) ?? []).length;
  const confirmAskCount = (fullTranscript.match(/All good — confirm\?/g) ?? []).length;

  assertEquals(orderTypeAskCount, 1, `"Pickup or delivery today?" must be asked exactly once across the transcript, got ${orderTypeAskCount}:\n${fullTranscript}`);
  assertEquals(nameAskCount, 1, `"What's the name for the order?" must be asked exactly once across the transcript, got ${nameAskCount}:\n${fullTranscript}`);
  assertEquals(confirmAskCount, 1, `"All good — confirm?" must be asked exactly once across the transcript, got ${confirmAskCount}:\n${fullTranscript}`);
});

// ── Delivery path, as far as this runner can currently go without the
// address geocode wiring flagged in this file's header note 2 (out of this
// fix's scope): order_type -> address must not double-fire either.

Deno.test("00-BT: delivery order_type resolves and hands off to address in the same turn, neither question doubles", async () => {
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called")) });
  const input = baseInput({
    message: "delivery please",
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  const orderTypeAskCount = (result.reply.match(/Pickup or delivery today\?/g) ?? []).length;
  const addressAskCount = (result.reply.match(/What's the delivery address\?/g) ?? []).length;
  assertEquals(orderTypeAskCount, 0, `order_type must not re-ask once resolved: ${JSON.stringify(result.reply)}`);
  assertEquals(addressAskCount, 1, `address must open exactly once: ${JSON.stringify(result.reply)}`);
});

// ── Dispatch 00-AH (2026-09-16, PO report — a delivery order can never
// complete on the engine): ANSWER's "address" case (turn-engine.ts) only
// ever resolves given an external geocode result (AnswerExternalInputs.
// geocodedAddress), and this runner never supplied one — so the address
// question re-asked forever, and free text answered while it was open (a
// name, in the live report) fell through to PROPOSE with no guard, letting
// the model mutate the cart. Fixed by wiring a real, injectable geocode call
// (geocodeAddressFn) into the runner before ANSWER, and by making turn-
// engine.ts's own "address" case check closure/checkout-intent BEFORE
// consulting the geocode result (so "thats it"/decline phrases keep their
// existing closure semantics regardless of what a geocode attempt on that
// same text would have returned).

function makeFakeStripeForCheckout() {
  const createCalls: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  const stripe: any = {
    checkout: {
      sessions: {
        create(params: Record<string, unknown>) {
          createCalls.push(params);
          const id = `sess_${createCalls.length}`;
          return Promise.resolve({ id, url: `https://checkout.stripe.com/${id}` });
        },
      },
    },
  };
  return { stripe, createCalls };
}

function makeFakeCheckoutSupabase(initialCartRow: Record<string, unknown> = {}) {
  const cartRow: Record<string, unknown> = { ...initialCartRow };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      single() {
        if (table === "order_carts") return Promise.resolve({ data: { ...cartRow }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") Object.assign(cartRow, row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert() { return Promise.resolve({ error: null }); },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (table: string) => builder(table) } as any;
}

function advanceDeliveryShopContext(shopContext: RunTurnShopContext, update: Record<string, unknown>): RunTurnShopContext {
  return {
    ...shopContext,
    orderType: (update.order_type as "pickup" | "delivery" | undefined) ?? shopContext.orderType,
    deliveryAddressKnown: update.delivery_address != null ? true : shopContext.deliveryAddressKnown,
    driverTipCents: (update.driver_tip_cents as number | undefined) ?? shopContext.driverTipCents,
    pickupName: (update.pickup_name as string | undefined) ?? shopContext.pickupName,
  };
}

Deno.test("ACCEPTANCE 00-AH-1 RED->GREEN: delivery order end to end — order type, address, item, temp, close, name, confirm — address asked AT MOST once, cart never mutated by the name turn, ends at a real payment link", async () => {
  const ADDRESS_TEXT = "5620 cetronia rd Allentown Pa 18106";
  const GEOCODED_FORMATTED = "5620 Cetronia Rd, Allentown, PA 18106";

  const { supabase, state } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `ah1-line-${++n}`; })(),
    // Injectable, deterministic stand-in for the real Google Geocode call
    // (defaultGeocodeAddress) — only the exact typed address qualifies,
    // matching the live shop's real geocoder rejecting anything else.
    geocodeAddressFn: (address) =>
      Promise.resolve(address === ADDRESS_TEXT ? { formatted: GEOCODED_FORMATTED, withinZone: true } : null),
    proposeTurnFn: (proposeInput): Promise<ProposeResult> => {
      if (proposeInput.message.toLowerCase().includes("cheeseburger")) {
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] },
        });
      }
      // "Time to order" — not an order, not checkout, not a slot answer.
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };

  let shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: 0, pickupName: null, deliveryFeeCents: 300,
  };
  const replies: string[] = [];
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  async function turn(message: string) {
    const r = await runTurnEngineTurn(
      { conversationId: "ah1", shopId: "s-ah1", tenantId: "t1", cartId: "cart-ah1", message,
        history: [], menu: ACC1_MENU, cart, dialogueState, shopContext },
      deps,
    );
    replies.push(r.reply);
    cart = r.cart;
    dialogueState = r.dialogueState;
    shopContext = advanceDeliveryShopContext(shopContext, state.orderCartsUpdates[state.orderCartsUpdates.length - 1]);
    return r;
  }

  await turn("Time to order");
  await turn("Delivery");
  await turn(ADDRESS_TEXT);
  // 00-AK: address resolves into a still-EMPTY cart (nothing ordered yet) —
  // ASK's empty-cart branch opens "ordering" (asking what to order), never
  // `null` (which would render "Anything else?" over nothing). Before that
  // fix this assertion read `open === null`; that was the bug, not a
  // property worth preserving.
  assertEquals(dialogueState!.open, { kind: "ordering", askCount: 1 }, "address must resolve THIS turn — dialogue_state.open must move off the address slot onto the ordering question, since the cart is still empty");
  await turn("a cheeseburger");
  await turn("medium");
  await turn("thats it");
  await turn("Jason Flick");
  await turn("yes");

  const fullTranscript = replies.join("\n---\n");
  const addressAskCount = (fullTranscript.match(/What's the delivery address\?/g) ?? []).length;
  assertEquals(addressAskCount, 1, `the address question must be asked AT MOST once across the whole transcript, got ${addressAskCount}:\n${fullTranscript}`);

  assertEquals(cart.length, 1, `the cart must hold exactly ONE Cheese Burger line after the name turn: ${JSON.stringify(cart)}`);
  assertEquals(cart[0].menu_item_id, ACC1_CHEESE_BURGER_ID);
  assertEquals(cart[0].quantity, 1, `quantity must still be 1 — never bumped by the "Jason Flick" name turn: ${JSON.stringify(cart)}`);

  assertEquals(dialogueState!.phase, "link_sent", `the transcript must reach link_sent: ${JSON.stringify(dialogueState)}`);

  const { stripe, createCalls } = makeFakeStripeForCheckout();
  const checkoutSupabase = makeFakeCheckoutSupabase({ order_type: "delivery", delivery_fee_cents: 300, driver_tip_cents: 0, notes: null, stripe_checkout_session_id: null });
  const checkoutDeps: EngineCheckoutDeps = { supabase: checkoutSupabase, resolveStripeKey: () => "sk_test_fake", createStripeClient: () => stripe };
  const finalReply = await appendEngineCheckoutLinkIfReady(
    { cartId: "cart-ah1", shopName: "Vito's", testMode: true, priorPhase: "confirm", nextPhase: "link_sent", cartLines: cart, reply: replies[replies.length - 1], isSms: false },
    checkoutDeps,
  );
  assert(finalReply.includes("Pay here: https://pay.getsprintai.com/o/"), `the delivery transcript must end at a real payment link, got: ${finalReply}`);
  assertEquals(createCalls.length, 1, "exactly one Stripe session must be created");
});

Deno.test("ACCEPTANCE 00-AH-2: pickup order end to end — order type, item, temp, close, name, confirm — each question asked exactly once, ends at a real payment link", async () => {
  const { supabase, state } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `ah2-line-${++n}`; })(),
    proposeTurnFn: (proposeInput): Promise<ProposeResult> => {
      if (proposeInput.message.toLowerCase().includes("cheeseburger")) {
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] },
        });
      }
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };

  let shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: 0, pickupName: null, deliveryFeeCents: null,
  };
  const replies: string[] = [];
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  async function turn(message: string) {
    const r = await runTurnEngineTurn(
      { conversationId: "ah2", shopId: "s-ah2", tenantId: "t1", cartId: "cart-ah2", message,
        history: [], menu: ACC1_MENU, cart, dialogueState, shopContext },
      deps,
    );
    replies.push(r.reply);
    cart = r.cart;
    dialogueState = r.dialogueState;
    shopContext = advanceDeliveryShopContext(shopContext, state.orderCartsUpdates[state.orderCartsUpdates.length - 1]);
    return r;
  }

  await turn("Time to order");
  await turn("pickup");
  await turn("a cheeseburger");
  await turn("medium");
  await turn("thats it");
  await turn("Jason Flick");
  await turn("yes");

  const fullTranscript = replies.join("\n---\n");
  const orderTypeAskCount = (fullTranscript.match(/Pickup or delivery today\?/g) ?? []).length;
  const tempAskCount = (fullTranscript.match(/cooked/gi) ?? []).length;
  const nameAskCount = (fullTranscript.match(/What's the name for the order\?/g) ?? []).length;
  const confirmAskCount = (fullTranscript.match(/All good — confirm\?/g) ?? []).length;
  assertEquals(orderTypeAskCount, 1, `order_type must be asked exactly once:\n${fullTranscript}`);
  assertEquals(tempAskCount, 1, `Temp must be asked exactly once:\n${fullTranscript}`);
  assertEquals(nameAskCount, 1, `name must be asked exactly once:\n${fullTranscript}`);
  assertEquals(confirmAskCount, 1, `confirm must be asked exactly once:\n${fullTranscript}`);
  assertEquals(dialogueState!.phase, "link_sent", `the pickup transcript must reach link_sent: ${JSON.stringify(dialogueState)}`);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);

  const { stripe, createCalls } = makeFakeStripeForCheckout();
  const checkoutSupabase = makeFakeCheckoutSupabase({ order_type: "pickup", delivery_fee_cents: 0, driver_tip_cents: 0, notes: null, stripe_checkout_session_id: null });
  const checkoutDeps: EngineCheckoutDeps = { supabase: checkoutSupabase, resolveStripeKey: () => "sk_test_fake", createStripeClient: () => stripe };
  const finalReply = await appendEngineCheckoutLinkIfReady(
    { cartId: "cart-ah2", shopName: "Vito's", testMode: true, priorPhase: "confirm", nextPhase: "link_sent", cartLines: cart, reply: replies[replies.length - 1], isSms: false },
    checkoutDeps,
  );
  assert(finalReply.includes("Pay here: https://pay.getsprintai.com/o/"), `the pickup transcript must end at a real payment link, got: ${finalReply}`);
  assertEquals(createCalls.length, 1, "exactly one Stripe session must be created");
});

Deno.test("ACCEPTANCE 00-AH-3 RED->GREEN: a name answer while ADDRESS is open must never create or grow a cart line", async () => {
  const priorCart: TurnEngineCartLine[] = [
    {
      menu_item_id: ACC1_CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [],
      line_key: "ah3-line-1", ask_plan_selections: { [ACC1_TEMP_GROUP_ID]: ACC1_MEDIUM_CHOICE_ID }, options: { Temp: ["Medium"] },
    },
  ];
  const priorState: DialogueState = { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null };

  const { supabase } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    // "Jason Flick" is not a real address — a real geocode attempt never
    // qualifies it (ZERO_RESULTS / no ROOFTOP-precision match).
    geocodeAddressFn: () => Promise.resolve(null),
    // Reproduces the live-reported symptom exactly (dispatch 00-AH report,
    // second replay): pre-fix, ANSWER never resolves "address" deterministically
    // (no external input was ever supplied), so this falls through to PROPOSE,
    // and the model — given an open "address" question and free text that
    // isn't one — still proposed an add for the item already in the cart,
    // bumping it ("Cheese Burger - now 2"). This fake is only reachable
    // pre-fix; post-fix, ANSWER resolves address_declined and PROPOSE is
    // never called at all.
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] },
      });
    },
  };

  const input = baseInput({
    message: "Jason Flick",
    menu: ACC1_MENU,
    cart: priorCart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: 0, pickupName: null, deliveryFeeCents: 300 },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "PROPOSE must never be called — a real geocode attempt resolves (or declines) the address deterministically");
  assertEquals(result.cart.length, 1, `a name answer must never add a second cart line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].quantity, 1, `a name answer must never bump quantity: ${JSON.stringify(result.cart)}`);
  assertEquals(result.dialogueState.open?.kind, "address", "the address question must still be open — 'Jason Flick' never resolved it");
});

// ── Dispatch 00-AP (2026-09-16, simulated-customer adversarial harness
// finding): 00-AH's geocode wiring only ever fed defaultGeocodeAddress the
// customer's ENTIRE trimmed message, and only attempted it while "address"
// was the open question. A real customer routinely states the address
// embedded in a sentence, and/or in the same breath as answering whatever
// else is open (a Temp slot, live transcript below) — neither condition
// reliably held, so the address question re-asked forever even though the
// customer repeated the address correctly turn after turn. Fixed by
// extractAddressSpan (finds the candidate substring deterministically) plus
// an opportunistic geocode attempt independent of what's currently open.

const AP_ADDRESS_TEXT = "5620 Cetronia Rd Allentown PA 18106";
const AP_GEOCODED_FORMATTED = "5620 Cetronia Rd, Allentown, PA 18106";

function makeApGeocodeFn(seen: string[]): NonNullable<RunTurnDeps["geocodeAddressFn"]> {
  return (address) => {
    seen.push(address);
    return Promise.resolve(address === AP_ADDRESS_TEXT ? { formatted: AP_GEOCODED_FORMATTED, withinZone: true } : null);
  };
}

Deno.test("00-AP ACCEPTANCE 1 RED->GREEN: the live 5-turn transcript — address embedded in the Temp-slot answer resolves on the turn it first appears, and is never asked again despite being repeated 3 more times", async () => {
  const geocodeCalls: string[] = [];
  const { supabase, state } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `ap1-line-${++n}`; })(),
    geocodeAddressFn: makeApGeocodeFn(geocodeCalls),
    proposeTurnFn: (proposeInput): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeInput.message.toLowerCase().includes("cheeseburger")) {
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] },
        });
      }
      // Turns 4/5 ("Dude I literally just told you...", "Are you even
      // reading...") carry no item and no explicit closure — ANSWER cannot
      // resolve them deterministically against the "anything else?" state
      // (open === null), so they fall to PROPOSE. Not orders, not checkout.
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };

  let shopContext: RunTurnShopContext = {
    deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
    driverTipCents: 0, pickupName: "Jason", deliveryFeeCents: 300,
  };
  const replies: string[] = [];
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  async function turn(message: string) {
    const r = await runTurnEngineTurn(
      { conversationId: "ap1", shopId: "s-ap1", tenantId: "t1", cartId: "cart-ap1", message,
        history: [], menu: ACC1_MENU, cart, dialogueState, shopContext },
      deps,
    );
    replies.push(r.reply);
    cart = r.cart;
    dialogueState = r.dialogueState;
    shopContext = advanceDeliveryShopContext(shopContext, state.orderCartsUpdates[state.orderCartsUpdates.length - 1]);
    return r;
  }

  // Turn 1: "Yo can I get a cheeseburger delivered?" — item added, Temp asked.
  await turn("Yo can I get a cheeseburger delivered?");
  assertEquals(cart.length, 1, `turn 1 must add the Cheese Burger line: ${JSON.stringify(cart)}`);
  assert(dialogueState!.open?.kind === "slot", `turn 1 must open the Temp slot question, got: ${JSON.stringify(dialogueState!.open)}`);
  assertEquals(shopContext.deliveryAddressKnown, false, "address must not be known before it has ever been stated");

  // Turn 2: "Medium. And yeah that's fine, delivery to 5620 Cetronia Rd
  // Allentown PA 18106." — answers the OPEN Temp slot AND, in the same
  // breath, states the address for the first time. THIS is the turn the
  // address must resolve on.
  await turn("Medium. And yeah that's fine, delivery to 5620 Cetronia Rd Allentown PA 18106.");
  assertEquals(cart[0].options, { Temp: ["Medium"] }, "turn 2 must still resolve the open Temp slot");
  assertEquals(
    shopContext.deliveryAddressKnown, true,
    "RED (pre-fix): the address is embedded in the Temp answer, not its own turn — geocodeAddressFn was never even called, so deliveryAddressKnown stays false forever. GREEN (post-fix): extractAddressSpan pulls the address out of the sentence and it resolves this same turn.",
  );
  assertEquals(geocodeCalls[geocodeCalls.length - 1], AP_ADDRESS_TEXT, "the geocode call must receive the extracted address span, not the whole sentence");
  const openKindAfterTurn2: string | undefined = dialogueState!.open?.kind;
  assert(openKindAfterTurn2 !== "address", "address must never become the open question — it was already resolved before ASK ran this turn");

  // Turns 3-5: the customer repeats the exact same address three more times
  // (answering order_type, then twice more with no open slot at all) — the
  // address question must never fire again.
  await turn("Delivery. I already said that. 5620 Cetronia Rd Allentown PA 18106.");
  await turn("Dude I literally just told you. 5620 Cetronia Rd Allentown PA 18106. Can you just put the order through already?");
  await turn("Are you even reading what I'm sending? 5620 Cetronia Rd Allentown PA 18106.");

  const fullTranscript = replies.join("\n---\n");
  const addressAskCount = (fullTranscript.match(/What's the delivery address\?/g) ?? []).length;
  assertEquals(addressAskCount, 0, `the address question must NEVER be asked in this transcript — it resolved before ASK ever ran — got ${addressAskCount}:\n${fullTranscript}`);
  assertEquals(shopContext.orderType, "delivery", "turn 3's 'Delivery' must still resolve order_type normally");
});

// ── Acceptance criteria 2: phrasing matrix — the bug that got through
// before existed because only a bare-address-only shape was ever exercised.
// Every one of these must extract to the identical canonical address and
// resolve, with no open question at all (the hardest case: nothing already
// points at "this message might be the address").

const AP_PHRASING_MATRIX: Array<{ label: string; message: string }> = [
  { label: "bare address alone", message: AP_ADDRESS_TEXT },
  { label: "'deliver to X'", message: `deliver to ${AP_ADDRESS_TEXT}` },
  { label: "'it's X'", message: `it's ${AP_ADDRESS_TEXT}` },
  { label: "'X please'", message: `${AP_ADDRESS_TEXT} please` },
  { label: "'yeah X thanks'", message: `yeah ${AP_ADDRESS_TEXT} thanks` },
  { label: "address followed by another sentence", message: `${AP_ADDRESS_TEXT}. Can you rush it?` },
  { label: "address preceded by an unrelated clause", message: `Sorry for the wait, ${AP_ADDRESS_TEXT}` },
];

for (const { label, message } of AP_PHRASING_MATRIX) {
  Deno.test(`00-AP ACCEPTANCE 2: phrasing matrix — ${label} — resolves to the same address`, async () => {
    const geocodeCalls: string[] = [];
    const { supabase, state } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
    const deps: RunTurnDeps = {
      supabase,
      apiKey: "test-key",
      geocodeAddressFn: makeApGeocodeFn(geocodeCalls),
      proposeTurnFn: (): Promise<ProposeResult> =>
        Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } }),
    };
    const input = baseInput({
      message,
      menu: ACC1_MENU,
      cart: [],
      dialogueState: null,
      shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: 0, pickupName: "Jason", deliveryFeeCents: 300 },
    });

    await runTurnEngineTurn(input, deps);

    assertEquals(geocodeCalls, [AP_ADDRESS_TEXT], `"${label}" must extract exactly the canonical address span, got: ${JSON.stringify(geocodeCalls)}`);
    assertEquals(
      state.orderCartsUpdates[0].delivery_address, { formatted: AP_GEOCODED_FORMATTED },
      `"${label}" must resolve and persist the delivery address`,
    );
  });
}

// ── Acceptance criteria 3: a non-address message while the address
// question is open must not resolve it and must not crash — "no match"
// stays reachable (address_declined), the same guarantee 00-AH established.
// Guards against over-eager extraction hallucinating an address out of
// unrelated text.

Deno.test("00-AP ACCEPTANCE 3: a non-address message while address is open resolves to address_declined, never crashes, never reaches PROPOSE", async () => {
  const priorState: DialogueState = { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: ACC1_CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "ap3-line-1", ask_plan_selections: { [ACC1_TEMP_GROUP_ID]: ACC1_MEDIUM_CHOICE_ID }, options: { Temp: ["Medium"] } },
  ];
  const geocodeCalls: string[] = [];
  const { supabase } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    geocodeAddressFn: makeApGeocodeFn(geocodeCalls),
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({
    message: "I'm not sure, let me check with my roommate",
    menu: ACC1_MENU,
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: 0, pickupName: null, deliveryFeeCents: 300 },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "a non-address message while address is open must resolve deterministically (declined), never reach PROPOSE");
  assertEquals(geocodeCalls.length, 1, "address being open must still attempt a real geocode call even with no extracted span, same as 00-AH's original guarantee");
  assertEquals(result.cart, cart, "the cart must be untouched");
  assertEquals(result.dialogueState.open?.kind, "address", "address must still be open — nothing resolved it");
});

Deno.test("extractAddressSpan: returns null for ordinary conversational text with no address shape", () => {
  assertEquals(extractAddressSpan("thanks so much, see you soon"), null);
  assertEquals(extractAddressSpan("I'm not sure, let me check with my roommate"), null);
  assertEquals(extractAddressSpan("table for 2 please"), null, "a bare digit with no street suffix must never match");
});

Deno.test("extractAddressSpan: a trailing word that merely starts with a suffix abbreviation ('please' vs 'Pl') must not be swallowed into the span", () => {
  assertEquals(extractAddressSpan("5620 Cetronia Rd Allentown PA 18106 please"), "5620 Cetronia Rd Allentown PA 18106");
});

Deno.test("00-AP: a garbled-but-numeric message while a Temp slot (not address) is open must not attempt a geocode call at all — no wasted lookup, no accidental resolution", async () => {
  const geocodeCalls: string[] = [];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "ap3b-line-1", group_id: ACC1_TEMP_GROUP_ID }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: ACC1_CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "ap3b-line-1" },
  ];
  const { supabase } = makeFakeSupabase({ lexicon: ACC1_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    geocodeAddressFn: makeApGeocodeFn(geocodeCalls),
    proposeTurnFn: () => Promise.reject(new Error("must not be called — 'medium' resolves the open slot deterministically")),
  };
  const input = baseInput({
    message: "medium, table for 2 please",
    menu: ACC1_MENU,
    cart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: 0, pickupName: null, deliveryFeeCents: 300 },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(geocodeCalls.length, 0, "no digit+street-suffix shape is present — extractAddressSpan must return null and no geocode call is made");
  assertEquals(result.cart[0].options, { Temp: ["Medium"] }, "the Temp slot must still resolve normally");
});

// ── 00-AU: the turn engine can never list a slot's real choices ─────────
//
// Root cause: turn-engine.ts's render() call site (turn-engine.ts:924, at
// the time this was written) called renderStepQuestion with only two
// arguments, so `enumerate` defaulted to false — always. The turn engine
// therefore never enumerated a slot's real choices, not on a genuine
// repeat, not when the customer explicitly asked what the options were.
// Live consequence (100-run sim against a61be121): a customer answering a
// sauce question with "Just the regular buffalo sauce, please." was asked
// the identical unanswerable question 11 times until they quit — the real
// choices (Hot, BBQ, Mild, Sweet & Spicy) were never shown.
//
// The fix threads a flag from turn-engine-runner.ts's own 00-AT dispatch
// (an open slot/disambiguation question whose ANSWER this turn resolved
// nothing) into render(), which then enumerates the real choices behind a
// fixed, code-authored lead-in — never a model rephrasing, never a
// hardcoded choice list.

const BUFFALO_SAUCE_CHOICES = [
  { id: "choice-hot", display: "Hot", price_delta_cents: 0 },
  { id: "choice-bbq", display: "BBQ", price_delta_cents: 0 },
  { id: "choice-mild", display: "Mild", price_delta_cents: 0 },
  { id: "choice-sweet-spicy", display: "Sweet & Spicy", price_delta_cents: 0 },
];

const askPlanWithSauceSlot = {
  compiled_at: "", compiler_version: 1, display_name: "Large Buffalo Chicken Pizza", base_price_cents: 1899,
  recap_template: "", ticket_template: "",
  steps: [{
    group_id: "group-sauce", slot_key: "sauce", kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "sauce.ask",
    choices: BUFFALO_SAUCE_CHOICES,
  }],
};

const menuWithSauceSlot: TurnEngineMenuItem[] = [
  {
    id: "item-buffalo-pizza", name: "Large Buffalo Chicken Pizza", category: "Pizza", price_cents: 1899,
    bot_state: "orderable", ask_plan: askPlanWithSauceSlot, option_groups: [{ id: "group-sauce", name: "Sauce" }],
  },
];

function buffaloSauceCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: "item-buffalo-pizza", name: "Large Buffalo Chicken Pizza", quantity: 1, price_cents: 1899, modifiers: [], line_key: "line-1" },
  ];
}

Deno.test("00-AU RED->GREEN: sauce slot open, 'Just the regular buffalo sauce, please.' resolves nothing — the SECOND question must list all four real choices behind the lead-in, never re-ask the identical short question, and never reach PROPOSE", async () => {
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-sauce" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("must not be called")); } };
  const input = baseInput({
    message: "Just the regular buffalo sauce, please.",
    menu: menuWithSauceSlot,
    cart: buffaloSauceCart(),
    dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "00-AT: an unresolvable answer to an open slot must never reach PROPOSE");
  assert(result.reply.includes("Let me list the options for you."), `reply must announce it's about to list the options: ${result.reply}`);
  for (const name of ["Hot", "BBQ", "Mild", "Sweet & Spicy"]) {
    assert(result.reply.includes(name), `reply must include the real choice "${name}": ${result.reply}`);
  }
  assertEquals((result.dialogueState.open as { kind: string } | null)?.kind, "slot", "the sauce slot is still open — nothing was resolved by the customer's message");
});

Deno.test("00-AU: the FIRST ask for a slot is still short by default — no choice names, no lead-in", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = { supabase, apiKey: "test-key" };
  // priorState.open is null (nothing was open before this turn) — the cart
  // already carries the pizza line with the sauce slot unresolved, so ASK's
  // priority-1 opens it fresh THIS turn, for the first time.
  const input = baseInput({ message: "thats it", menu: menuWithSauceSlot, cart: buffaloSauceCart(), dialogueState: null });

  const result = await runTurnEngineTurn(input, deps);

  assert(
    result.reply.startsWith("What sauce would you like for the Large Buffalo Chicken Pizza?"),
    `first ask must be the short question, unmodified (a money footer may follow it): ${result.reply}`,
  );
  assert(!result.reply.includes("Let me list the options for you."), `first ask must not carry the enumerate lead-in: ${result.reply}`);
  for (const name of ["Hot", "BBQ", "Mild", "Sweet & Spicy"]) {
    assert(!result.reply.includes(name), `first ask must not include the choice name "${name}": ${result.reply}`);
  }
});
