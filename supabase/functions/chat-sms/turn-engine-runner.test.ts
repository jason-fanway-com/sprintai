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
  // loadItemLexicon's category/size_label join target (menu_items, keyed by
  // id). Empty by default — tests that don't care about narrowing metadata
  // get an empty-but-successful .in() result, not a thrown error.
  // bot_state is optional here (unlike category/size_label) so every
  // existing fixture that predates the display_only-exclusion fix keeps
  // compiling unchanged — an omitted bot_state maps to null in the .in()
  // response below, and null is treated as "unknown, don't drop" by
  // loadItemLexicon, the same fallback discipline already applied to a
  // failed/missing category or size_label lookup.
  menuItems: Array<{ id: string; category: string | null; size_label: string | null; bot_state?: string | null }>;
  // Freeze-queue item 7 (returning-customer greeting): the four tables
  // maybeBuildReturningCustomerGreeting reads directly, keyed by
  // conversationId/shopId/(tenantId+phone) — see that function's own
  // header for why these live outside RunTurnInput/RunTurnShopContext.
  // null by default on every table, same "cold start, harmless" default the
  // generic maybeSingle() fallback below already gives every OTHER table —
  // so every pre-existing test in this file is unaffected.
  conversationRow: { customer_phone: string | null } | null;
  shopRow: { customer_personalization_enabled?: boolean; delivery_paused_until?: string | null; delivery_radius_mi?: number | null } | null;
  optOutRow: { id: string } | null;
  customerRow: {
    tenant_id: string;
    customer_phone: string;
    name: string | null;
    order_count: number;
    total_spent_cents: number;
    favorite_items: Array<{ name: string; count: number }>;
    last_order_id: string | null;
    last_order_at: string | null;
    last_order_type: "pickup" | "delivery" | null;
    last_delivery_address: Record<string, unknown> | null;
  } | null;
}

interface FakeSupabaseOverrides extends Partial<Pick<FakeState, "shopSettings" | "lexicon" | "menuItems" | "conversationRow" | "shopRow" | "optOutRow" | "customerRow">> {
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
    menuItems: [],
    conversationRow: null,
    shopRow: null,
    optOutRow: null,
    customerRow: null,
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
      is() { return b; },
      order() { return b; },
      maybeSingle() {
        if (table === "shop_settings") return Promise.resolve({ data: state.shopSettings, error: null });
        if (table === "conversations") return Promise.resolve({ data: state.conversationRow, error: null });
        if (table === "shops") return Promise.resolve({ data: state.shopRow, error: null });
        if (table === "sms_opt_outs") return Promise.resolve({ data: state.optOutRow, error: null });
        if (table === "customers") return Promise.resolve({ data: state.customerRow, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      range(from: number, to: number) {
        if (table === "lexicon" && lexiconPageErrorAtOffset === from) {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
        const all = table === "lexicon" ? state.lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      // loadLexiconItemMetadata's batched `.in("id", batch)` lookup against
      // menu_items. Matches real PostgREST .in() semantics: rows whose
      // `column` value is one of `values`, error: null — EXCEPT that
      // menu_items.id is a real UUID column, so a real Postgres rejects the
      // ENTIRE `.in()` call with 22P02 ("invalid input syntax for type
      // uuid") the moment even one value in `values` isn't UUID-shaped, not
      // just the offending value. Reproduces that here so a test can prove
      // the fix filters non-UUID target_ids out before this call is made.
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (values.some((v) => typeof v !== "string" || !UUID_RE.test(v))) {
          return Promise.resolve({ data: null, error: { message: "invalid input syntax for type uuid", code: "22P02" } });
        }
        const matches = state.menuItems
          .filter((row) => values.includes((row as Record<string, unknown>)[column]))
          .map((row) => ({ ...row, bot_state: row.bot_state ?? null }));
        return Promise.resolve({ data: matches, error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert(row: Record<string, unknown>) {
        if (table === "messages") state.messagesInserted.push(row);
        if (table === "error_log") state.errorLogInserted.push(row);
        const msgId = table === "messages" ? `msg-${state.messagesInserted.length}` : null;
        // Support both:
        //   `await supabase.from(t).insert(r)` (error_log / plain-await callers)
        //   `await supabase.from(t).insert(r).select("id").single()` (messages, persistTurn)
        const insertChain = {
          select: (_cols: unknown) => ({
            single: () => Promise.resolve({ data: { id: msgId }, error: null }),
          }),
          then(resolve: (v: { error: null }) => void, reject?: (e: unknown) => void) {
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
        return insertChain;
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
  // "two cheese burgers", not "two cheeseburgers" -- 2026-09-18's item_span
  // verbatim-in-message guard (turn-engine.ts's itemSpanNamedInMessage) now
  // requires the model's span to actually occur in the customer's own
  // message; the fixture must genuinely contain the two-word phrase it
  // asserts the model returned.
  const input = baseInput({ message: "two cheese burgers", cart: [] });

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
  // UUID-shaped target_ids (not "target-N") — this test is about pagination
  // error handling, not the non-UUID trip-wire (see the dedicated test for
  // that below); a non-UUID id here would spuriously add a second, unrelated
  // error_log row and break this test's single-error assertion.
  const fullLexicon = Array.from({ length: 1298 }, (_, i) => ({ term: `term-${i}`, target_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }));
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
  // UUID-shaped target_ids — see the sibling pagination test above for why.
  const exactlyOnePage = Array.from({ length: 1000 }, (_, i) => ({ term: `term-${i}`, target_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }));
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

// ── loadLexiconItemMetadata: a non-UUID target_id sharing a batch with real
// UUID target_ids must not poison the whole batch — and must not vanish
// silently either ─────────────────────────────────────────────────────────
// Live incident (Vito's, commit 5e3398eb): lexicon.target_id is TEXT with no
// FK to menu_items.id, and live data has non-UUID target_ids (e.g.
// "derived:<uuid>:0:0") mixed in with real menu_items.id UUIDs. A real
// Postgres rejects `.in("id", batch)` for the ENTIRE batch with 22P02 the
// moment one value isn't UUID-shaped — silently dropping category/size_label
// for every other, valid id in that same batch, not just the bad one. The
// fake's `.in()` above reproduces that all-or-nothing failure; the fix
// (filtering to UUID-shaped ids before the `.in()` call) keeps the real id's
// metadata intact.
//
// PO dispatch (2026-09-19, dangling-lexicon-terms P0, required fix item 3):
// this test used to assert the filter wrote NO error_log row at all — that
// silence is exactly what let months of dead derived-row lexicon terms hide
// in production undetected (see compile-menu.ts's resolveDerivedLexiconTerms
// for the compiler-side fix). The filter itself is still correct and still
// required (a real 22P02 must never poison a batch), but dropping a
// target_id must now be a LOUD, logged trip-wire, never silent.
Deno.test("runTurnEngineTurn: a non-UUID target_id in the same lexicon page as a real UUID target_id does not poison that id's category/size_label lookup, and logs a loud trip-wire instead of vanishing silently", async () => {
  const REAL_ITEM_ID = "11111111-1111-1111-1111-111111111111";
  const mixedLexicon = [
    { term: "cheeseburger", target_id: REAL_ITEM_ID },
    { term: "beef", target_id: "derived:9369c1e7-38df-45da-985e-36d278d7a12c:0:0" },
  ];
  const { supabase, state } = makeFakeSupabase({
    lexicon: mixedLexicon,
    menuItems: [{ id: REAL_ITEM_ID, category: "Burgers", size_label: null }],
  });
  let seenLexicon: Array<{ term: string; target_id: string; category?: string | null; size_label?: string | null }> = [];
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (input): Promise<ProposeResult> => {
      seenLexicon = input.lexicon;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "cheeseburger", cart: [] });

  await runTurnEngineTurn(input, deps);

  const realRow = seenLexicon.find((r) => r.target_id === REAL_ITEM_ID);
  assert(realRow, "the real UUID target_id's lexicon row must still be handed to PROPOSE");
  assertEquals(realRow!.category, "Burgers", "the non-UUID id sharing the batch must not poison the real id's category lookup");
  assertEquals(state.errorLogInserted.length, 1, "dropping a non-UUID target_id must now be logged, never silent");
  assertEquals(state.errorLogInserted[0].stage, "lexicon_load");
  assertEquals((state.errorLogInserted[0].metadata as { dropped_non_uuid_count: number }).dropped_non_uuid_count, 1, "must name the actual dropped count");
});

// ── loadItemLexicon: a non-orderable row's lexicon term is dropped at load
// time too — belt-and-suspenders defense alongside the compiler fix ────────
// The compiler (compile-menu.ts) no longer EMITS a lexicon term for a
// display_only/blocked row going forward, but a shop compiled before that
// fix can still carry a stale term for one in its `lexicon` table until it's
// recompiled. Real Vito's incident: a live customer's "ranch" tied against a
// $0.00 "Ranch [Pizza Finish]" row (bot_state display_only) with no real
// item to resolve to. This loader-level filter means a live shop is
// protected the moment this code deploys, without waiting on a recompile.
Deno.test("runTurnEngineTurn: a lexicon term whose target menu_item is bot_state display_only is dropped before it ever reaches PROPOSE, and does not trip the count-mismatch trip-wire", async () => {
  const ORDERABLE_ID = "11111111-1111-1111-1111-111111111111";
  const DISPLAY_ONLY_ID = "22222222-2222-2222-2222-222222222222";
  const mixedLexicon = [
    { term: "grilled chicken bacon ranch", target_id: ORDERABLE_ID },
    { term: "ranch", target_id: DISPLAY_ONLY_ID },
  ];
  const { supabase, state } = makeFakeSupabase({
    lexicon: mixedLexicon,
    menuItems: [
      { id: ORDERABLE_ID, category: "Wraps", size_label: null, bot_state: "orderable" },
      { id: DISPLAY_ONLY_ID, category: "Pizza Finish", size_label: null, bot_state: "display_only" },
    ],
  });
  let seenLexicon: Array<{ term: string; target_id: string }> = [];
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (input): Promise<ProposeResult> => {
      seenLexicon = input.lexicon;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "ranch", cart: [] });

  await runTurnEngineTurn(input, deps);

  assertEquals(seenLexicon.some((r) => r.target_id === DISPLAY_ONLY_ID), false,
    "the display_only row's own lexicon term must never reach PROPOSE");
  assert(seenLexicon.some((r) => r.target_id === ORDERABLE_ID), "the orderable row's term must still reach PROPOSE");
  assertEquals(state.errorLogInserted.length, 1, "exactly one trip-wire (the dropped-non-orderable one) must be logged — no false count-mismatch");
  assertEquals((state.errorLogInserted[0].metadata as { dropped_non_orderable_count: number }).dropped_non_orderable_count, 1);
});

Deno.test("runTurnEngineTurn: a menu_items row with no bot_state on record (fake fixture default) is never dropped — only a POSITIVELY non-orderable bot_state filters a term", async () => {
  // Same discipline as a failed/missing category or size_label lookup: an
  // unknown bot_state must fall through to the pre-existing behavior, never
  // be treated as a reason to drop an otherwise-valid term.
  const REAL_ITEM_ID = "33333333-3333-3333-3333-333333333333";
  const { supabase, state } = makeFakeSupabase({
    lexicon: [{ term: "cheeseburger", target_id: REAL_ITEM_ID }],
    menuItems: [{ id: REAL_ITEM_ID, category: "Burgers", size_label: null }],
  });
  let seenLexicon: Array<{ term: string; target_id: string }> = [];
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (input): Promise<ProposeResult> => {
      seenLexicon = input.lexicon;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } });
    },
  };
  const input = baseInput({ message: "cheeseburger", cart: [] });

  await runTurnEngineTurn(input, deps);

  assert(seenLexicon.some((r) => r.target_id === REAL_ITEM_ID), "an unknown bot_state must not drop the term");
  assertEquals(state.errorLogInserted.length, 0, "no trip-wire and no mismatch when nothing was actually dropped");
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
  // Empty lexicon: this test only cares about the PROPOSE failure path, and
  // the default LEXICON fixture's non-UUID target_ids ("item-cheeseburger")
  // would otherwise also trip the new dropped-non-UUID trip-wire log,
  // adding an unrelated second error_log row this test isn't about.
  const { supabase, state } = makeFakeSupabase({ lexicon: [] });
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

// ── 2026-09-18 PO dispatch (a model timeout must not lose the order,
// conv 7aa64038/998da1a9): a TIMEOUT while no specific question is open
// falls back to decide()'s own deterministic resolve-item resolution
// instead of the "call us" apology — see turn-engine-runner.ts's own doc
// on this branch for the full reasoning and its scope boundary. ─────────

function timedOutProposeResult(): Promise<ProposeResult> {
  return Promise.resolve({
    ok: false,
    reason: "timeout",
    detail: "no response within 25000ms",
    attempts: [
      { attempt: 1, reason: "timeout", detail: "no response within 25000ms", rawBody: null, ms: 25000 },
      { attempt: 2, reason: "timeout", detail: "no response within 25000ms", rawBody: null, ms: 25000 },
    ],
  });
}

Deno.test("runTurnEngineTurn (model timeout fallback): a plain, single-item message still lands as a real cart line — never 'call us'", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const input = baseInput({ message: "cheeseburger", cart: [], dialogueState: { ...INITIAL_DIALOGUE_STATE } });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `the item must land deterministically, no model needed: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, "item-cheeseburger");
  assert(result.reply !== FALLBACK_REPLY, "must never fall back to the 'call us' apology when the item resolves cleanly");
  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
});

Deno.test("runTurnEngineTurn (model timeout fallback): a message decide() can't resolve to any item gets the normal 'didn't catch that' decline, never 'call us', cart untouched", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const input = baseInput({ message: "asdlkfjqwer", cart: [], dialogueState: { ...INITIAL_DIALOGUE_STATE } });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "nothing resolves — no guess, no cart line");
  assert(result.reply !== FALLBACK_REPLY, "a genuine miss still gets decide()'s own decline, not the harsher apology");
  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
  assert(result.reply.includes("didn't catch"), `expected decide()'s own 00-AX decline wording: ${result.reply}`);
});

Deno.test("runTurnEngineTurn (model timeout fallback): scoped to open === null for the deterministic-add carve-out — a timeout while a specific question (e.g. the customer's name) is open instead RE-ASKS that question, never 'call us' (money bug, 2026-09-19, live conv 31f54c6b, item 2)", async () => {
  const { supabase, state } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const priorCart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  // A bare single word like "cheeseburger" is itself name-shaped
  // (looksLikeCustomerName) and would resolve as a (garbage) name — a
  // separate, pre-existing quirk, not what this test is about. A real
  // sentence forces extractCustomerName() to miss, so answer()'s "name"
  // case genuinely returns UNRESOLVED and this reaches PROPOSE — unlike a
  // "slot"/"disambiguation" open, which 00-AT already short-circuits
  // before PROPOSE regardless of this dispatch's change.
  const priorState: DialogueState = { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null };
  // pickupName must genuinely be UNKNOWN here — otherwise ask()'s own
  // priority ladder sees the name question is already satisfied and skips
  // straight past it to confirm, never reaching PROPOSE at all regardless
  // of this dispatch's change, which would make this test pass for the
  // wrong reason.
  const input = baseInput({
    message: "I want a cheeseburger and fries please",
    cart: priorCart,
    dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(result.reply !== FALLBACK_REPLY, "a pending specific question must be RE-ASKED on a genuine timeout, never answered with the apology");
  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
  assert(result.reply.includes("What's the name for the order?"), `expected the same open question re-asked verbatim: ${result.reply}`);
  assertEquals(result.cart, priorCart, "a model timeout must never mutate the cart");
  assertEquals(result.dialogueState.open, priorState.open, "the exact same open question must still be open, not resolved or dropped");
  assertEquals(result.dialogueState.openRepeatCount, 1, "a re-ask is a real repeat of the same question, same escalation counter every other repeat goes through");
  assertEquals(state.orderCartsUpdates.length, 1, "the bumped openRepeatCount must be persisted so a second timeout in a row escalates normally");
});

Deno.test("runTurnEngineTurn (model timeout fallback): scoped to reason === 'timeout' — a schema_violation with open === null still falls back to 'call us', unchanged", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: false,
      reason: "schema_violation",
      detail: "response did not contain a schema-valid submit_proposal tool call",
      attempts: [{ attempt: 1, reason: "schema_violation", detail: "response did not contain a schema-valid submit_proposal tool call", rawBody: "{}", ms: 900 }],
    }),
  };
  const input = baseInput({ message: "cheeseburger", cart: [], dialogueState: { ...INITIAL_DIALOGUE_STATE } });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.reply, FALLBACK_REPLY, "schema_violation is a different failure class — not what this dispatch's fallback covers");
  assertEquals(result.cart, []);
});

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
    message: "two cheese burgers",
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
  // 2026-09-18 PO dispatch: confirm's first ask is now the full read-back,
  // not the bare "All good — confirm?" — "All good?" is its closing line.
  assert(result.reply.includes("All good?"), `the ladder must advance past the just-answered name question to confirm — reply: ${JSON.stringify(result.reply)}`);
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
  // 2026-09-18 PO dispatch: confirm's first ask is now the full read-back,
  // not the bare "All good — confirm?" — "All good?" is its closing line.
  assert(r4.reply.includes("All good?"), `turn 4 must advance to confirm, not re-ask name: ${JSON.stringify(r4.reply)}`);

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
  // 2026-09-18 PO dispatch: confirm's first ask is now the full read-back
  // ("All good?" as its closing line), not the bare "All good — confirm?".
  const confirmAskCount = (fullTranscript.match(/All good\?/g) ?? []).length;

  assertEquals(orderTypeAskCount, 1, `"Pickup or delivery today?" must be asked exactly once across the transcript, got ${orderTypeAskCount}:\n${fullTranscript}`);
  assertEquals(nameAskCount, 1, `"What's the name for the order?" must be asked exactly once across the transcript, got ${nameAskCount}:\n${fullTranscript}`);
  assertEquals(confirmAskCount, 1, `the confirm read-back must be shown exactly once across the transcript, got ${confirmAskCount}:\n${fullTranscript}`);
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
  // Round 3, item 2b: the cart now holds a real line, so ask() correctly
  // opens the tip question here (previously dead — see
  // DialogueState.driverTipResolved's own doc in turn-engine.ts) — a real
  // conversation answers it before moving on, same as address/order_type
  // above.
  await turn("no tip");
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
  // 2026-09-18 PO dispatch: confirm's first ask is now the full read-back
  // ("All good?" as its closing line), not the bare "All good — confirm?".
  const confirmAskCount = (fullTranscript.match(/All good\?/g) ?? []).length;
  assertEquals(orderTypeAskCount, 1, `order_type must be asked exactly once:\n${fullTranscript}`);
  assertEquals(tempAskCount, 1, `Temp must be asked exactly once:\n${fullTranscript}`);
  assertEquals(nameAskCount, 1, `name must be asked exactly once:\n${fullTranscript}`);
  assertEquals(confirmAskCount, 1, `the confirm read-back must be shown exactly once:\n${fullTranscript}`);
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
  // 2026-09-18 PO dispatch (named choice not on the list) supersedes the
  // 2026-09-17 "question first, then lead-in, then list" wording this test
  // used to pin: a slot answer that fails to match now names back exactly
  // what the customer said, instead of a generic "let me list the options"
  // that never acknowledges their words were heard and rejected.
  //
  // 2026-09-18 PO dispatch (choice longest match, part B) further
  // supersedes the ORIGINAL version of THIS test's own assertion: quoting
  // the whole message ("Just the regular buffalo sauce, please.") back is
  // exactly what Part B's "never the whole message" rule now forbids for a
  // message with no with/for/on clause — the fallback is the last 3
  // tokens instead, same short-fragment principle as the with/for/on
  // stripping already follows.
  //
  // 2026-09-18 PO dispatch (echo wording follow-up) supersedes THIS
  // assertion's own wording again: extractSlotChoiceWords now also strips a
  // leading filler clause ("Just the") and a trailing "please"/"thanks" —
  // the same "quote the noun phrase the customer named, never filler" rule
  // this dispatch asked for on two other real conversations applies here
  // too, and lands a cleaner "regular buffalo sauce" instead of
  // "buffalo sauce, please." for free.
  assert(
    result.reply.includes('We don\'t have "regular buffalo sauce" for Large Buffalo Chicken Pizza. The options are: Hot, BBQ, Mild, or Sweet & Spicy.'),
    `an unmatched slot answer must name back a short fragment of the customer's own words, never the whole message: ${result.reply}`,
  );
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
  assert(!result.reply.includes("Let me list the options for you"), `first ask must not carry the enumerate lead-in: ${result.reply}`);
  for (const name of ["Hot", "BBQ", "Mild", "Sweet & Spicy"]) {
    assert(!result.reply.includes(name), `first ask must not include the choice name "${name}": ${result.reply}`);
  }
});

// ── 00-AV: the nine-times name loop, end to end ────────────────────────────
//
// 00-BT above proves a BARE name ("Joe") resolves. Live customers do not send
// bare names. In a 100-conversation sim run against 1992f4ab a customer sent
// "It's Alex!" and "My name is Alex!" nine times and was asked "What's the
// name for the order?" nine times, then quit. This drives the real phrasings
// through the whole turn and asserts the question is not re-asked.
Deno.test("00-AV RED->GREEN: a name inside a sentence resolves the open 'name' question — the real phrasings from the live nine-times loop", async () => {
  for (const message of [
    "It's Alex! Can we finalize this order now?",
    "My name is Alex! Can we please just complete the order now?",
    "I already told you, the name is Alex! Let's finish this up!",
    "Alex! That's the name! Can we finalize it now?",
  ]) {
    const priorState: DialogueState = { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null };
    const cart: TurnEngineCartLine[] = [
      { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
    ];
    const deps = baseDeps({ proposeTurnFn: () => Promise.reject(new Error("must not be called — ANSWER resolves the name deterministically")) });
    const input = baseInput({
      message,
      cart,
      dialogueState: priorState,
      shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
    });

    const result = await runTurnEngineTurn(input, deps);

    assert(
      !result.reply.includes("What's the name for the order?"),
      `the name question must not be re-asked after "${message}" — reply: ${JSON.stringify(result.reply)}`,
    );
  }
});

// ── 2026-09-18 PO dispatch: "answer + new item in one message" ───────────
// A resolved answer (slot/disambiguation/order_type/name/address/tip/confirm)
// that carries a genuine second request must not silently drop it — see
// extractRemainderAfterAnswer's own header in turn-engine-runner.ts for the
// marker-based detection this exercises. All five messages below are the
// real live transcripts from today's report, verbatim.

function noSlotAskPlan(displayName: string, priceCents: number) {
  return { compiled_at: "", compiler_version: 1, display_name: displayName, base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [] };
}

function noSlotMenuItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return { id, name, category, price_cents: priceCents, bot_state: "orderable", ask_plan: noSlotAskPlan(name, priceCents) };
}

function breadSlotAskPlan(displayName: string, priceCents: number) {
  return {
    compiled_at: "", compiler_version: 1, display_name: displayName, base_price_cents: priceCents,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: "group-bread", slot_key: "bread", kind: "slot" as const, ask_mode: "ask" as const,
      prompt_template: "What bread?",
      choices: [
        { id: "choice-white", display: "White", price_delta_cents: 0 },
        { id: "choice-wheat", display: "Wheat", price_delta_cents: 0 },
        { id: "choice-rye", display: "Rye", price_delta_cents: 0 },
      ],
    }],
  };
}

function addOnlyProposeFn(
  captured: { calls: number; messages: string[] },
  build: (message: string) => ProposeResult,
): (input: { message: string }) => Promise<ProposeResult> {
  return (input) => {
    captured.calls++;
    captured.messages.push(input.message);
    return Promise.resolve(build(input.message));
  };
}

Deno.test("00-remainder conv 47 (UPDATED 2026-09-20, slot-resolved blocks item search THIS TURN): 'wheat bread' answers the open slot; 'also, boneless wings' is no longer added this same turn", async () => {
  // 2026-09-20 PO dispatch (slot-resolved blocks item search THIS TURN, real
  // conv 6365b84d #16 money bug): this test used to prove the remainder
  // mechanism could safely add a genuinely separate bonus item after a
  // resolved slot answer. That mechanism is exactly what let a DIFFERENT
  // phrasing ("Yes, please add ranch for both pizzas!") open a phantom
  // disambiguation the same turn -- see turn-engine-runner.ts's own
  // REMAINDER_ELIGIBLE_OUTCOME_KINDS doc for why "slot_resolved" no longer
  // ever reaches the remainder call, unconditionally. The bonus-item case
  // this test covered is a deliberate, known casualty: "also, boneless
  // wings" no longer lands this same turn -- the customer can just say it
  // next turn. Updated (not weakened) to prove the new, intentional
  // invariant: proposeTurnFn must never be called at all once the bread slot
  // resolves.
  const menu: TurnEngineMenuItem[] = [
    { id: "item-garlic-cheesesteak", name: "Garlic Cheesesteak", category: "Hot Sandwiches", price_cents: 999, bot_state: "orderable", ask_plan: breadSlotAskPlan("Garlic Cheesesteak", 999) },
    noSlotMenuItem("item-boneless-wings", "Boneless Wings", "Wings", 1299),
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-garlic-cheesesteak", name: "Garlic Cheesesteak", quantity: 1, price_cents: 999, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-bread" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "boneless wings", target_id: "item-boneless-wings" }] });
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: () => {
      throw new Error("FORBIDDEN: proposeTurnFn must never be called this turn — a resolved slot answer blocks ALL fresh item search/PROPOSE processing, full stop");
    },
  };
  const input = baseInput({
    message: "Oh, wheat bread for the Garlic Cheesesteak, please! Also, can I get an order of 10 boneless wings?",
    cart, menu, dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, "no fresh item search of any kind may run this turn — the boneless wings must not land");
  assertEquals(result.cart[0].ask_plan_selections?.["group-bread"], "choice-wheat", "the bread slot must still be resolved by the primary answer");
  const wings = result.cart.find(l => l.menu_item_id === "item-boneless-wings");
  assertEquals(wings, undefined, "the wings must not reach the cart this turn — customer can ask again next turn");
});

Deno.test("00-remainder conv 7: 'I'll do pickup' answers order_type; 'also, a Coke' is added", async () => {
  const menu: TurnEngineMenuItem[] = [noSlotMenuItem("item-coke", "Coke", "Drinks", 249)];
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "coke", target_id: "item-coke" }] });
  const captured = { calls: 0, messages: [] as string[] };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: addOnlyProposeFn(captured, () => ({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "Coke", quantity: 1, choices: [] }], removes: [], modifies: [] },
    })),
  };
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const input = baseInput({
    message: "I'll do pickup. Also, can I get a Coke with that?",
    cart: [], menu, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(captured.calls, 1);
  assertEquals(captured.messages[0], "Also, can I get a Coke with that?");
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-coke");
});

Deno.test("00-remainder conv 14: 'I'll do pickup, please!' answers order_type; 'also, can I add a calzone' reaches DECIDE", async () => {
  const menu: TurnEngineMenuItem[] = [noSlotMenuItem("item-calzone", "Calzone", "Stromboli", 1495)];
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "calzone", target_id: "item-calzone" }] });
  const captured = { calls: 0, messages: [] as string[] };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: addOnlyProposeFn(captured, () => ({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "a calzone", quantity: 1, choices: [] }], removes: [], modifies: [] },
    })),
  };
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const input = baseInput({
    message: "I'll do pickup, please! Also, can I add a calzone? Just a 14-inch one.",
    cart: [], menu, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(captured.calls, 1);
  assertEquals(captured.messages[0], "Also, can I add a calzone? Just a 14-inch one.");
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-calzone");
});

Deno.test("00-remainder conv 52 (UPDATED 2026-09-20, slot-resolved blocks item search THIS TURN): 'white bread' answers the open slot; 'and also ... pasta w/ clam sauce' no longer reaches DECIDE this same turn", async () => {
  // 2026-09-20 PO dispatch (slot-resolved blocks item search THIS TURN) —
  // same deliberate, known casualty as conv 47 above. See that test's own
  // updated header and turn-engine-runner.ts's REMAINDER_ELIGIBLE_OUTCOME_
  // KINDS doc for why "slot_resolved" no longer ever reaches the remainder
  // call, unconditionally.
  const menu: TurnEngineMenuItem[] = [
    { id: "item-cheesesteak", name: "Cheesesteak", category: "Hot Sandwiches", price_cents: 999, bot_state: "orderable", ask_plan: breadSlotAskPlan("Cheesesteak", 999) },
    noSlotMenuItem("item-pasta-clam-sauce", "Pasta With Clam Sauce", "Entrees", 1895),
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheesesteak", name: "Cheesesteak", quantity: 1, price_cents: 999, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-bread" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "pasta w/ clam sauce", target_id: "item-pasta-clam-sauce" }] });
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: () => {
      throw new Error("FORBIDDEN: proposeTurnFn must never be called this turn — a resolved slot answer blocks ALL fresh item search/PROPOSE processing, full stop");
    },
  };
  const input = baseInput({ message: "white bread ... and also can i add a pasta w/ clam sauce", cart, menu, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart[0].ask_plan_selections?.["group-bread"], "choice-white");
  assertEquals(result.cart.length, 1, "no fresh item search of any kind may run this turn — the pasta must not land");
});

Deno.test("00-remainder conv 84: disambiguation resolves to Side Salad; 'and add chicken fingers' reaches DECIDE", async () => {
  // Onion Rings (not another Salad) as the other candidate — the point of
  // this test is the remainder mechanism, not pending-disambiguation.ts's
  // own tier ordering, so the candidate pair is chosen to resolve
  // unambiguously via the exact-label tier alone.
  const menu: TurnEngineMenuItem[] = [
    noSlotMenuItem("item-side-salad", "Side Salad", "Appetizers", 399),
    noSlotMenuItem("item-onion-rings", "Onion Rings", "Sides", 499),
    noSlotMenuItem("item-chicken-fingers", "Chicken Fingers", "Appetizers", 799),
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "disambiguation", candidates: ["item-side-salad", "item-onion-rings"] }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "chicken fingers", target_id: "item-chicken-fingers" }] });
  const captured = { calls: 0, messages: [] as string[] };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: addOnlyProposeFn(captured, () => ({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "chicken fingers", quantity: 1, choices: [] }], removes: [], modifies: [] },
    })),
  };
  const input = baseInput({ message: "Can I just stick with the side salad and add chicken fingers?", cart: [], menu, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(captured.calls, 1);
  assertEquals(captured.messages[0], "add chicken fingers?");
  assert(result.cart.some(l => l.menu_item_id === "item-side-salad"), "the disambiguation must resolve to Side Salad");
  assert(result.cart.some(l => l.menu_item_id === "item-chicken-fingers"), "chicken fingers must reach the cart, not vanish silently");
});

Deno.test("00-remainder: 'Wheat bread, please.' is only the answer plus filler — no remainder, no model call at all", async () => {
  const menu: TurnEngineMenuItem[] = [
    { id: "item-garlic-cheesesteak", name: "Garlic Cheesesteak", category: "Hot Sandwiches", price_cents: 999, bot_state: "orderable", ask_plan: breadSlotAskPlan("Garlic Cheesesteak", 999) },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-garlic-cheesesteak", name: "Garlic Cheesesteak", quantity: 1, price_cents: 999, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: "group-bread" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("must not be called — no remainder in a bare slot answer")); },
  };
  const input = baseInput({ message: "Wheat bread, please.", cart, menu, dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0);
  assertEquals(result.cart[0].ask_plan_selections?.["group-bread"], "choice-wheat");
});

Deno.test("00-remainder acceptance: 'yes, and add a coke' while confirm is open — Coke added, confirm re-asked, never link_sent", async () => {
  const menu: TurnEngineMenuItem[] = [noSlotMenuItem("item-coke", "Coke", "Drinks", 249)];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-cheeseburger", name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
  const { supabase } = makeFakeSupabase({ lexicon: [...LEXICON, { term: "coke", target_id: "item-coke" }] });
  const captured = { calls: 0, messages: [] as string[] };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    newLineKey: (() => { let n = 0; return () => `line-${++n}`; })(),
    proposeTurnFn: addOnlyProposeFn(captured, () => ({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "a coke", quantity: 1, choices: [] }], removes: [], modifies: [] },
    })),
  };
  const fullMenu = [...menu, { id: "item-cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849, bot_state: "orderable", ask_plan: noSlotAskPlan("Cheese Burger", 849) }];
  const input = baseInput({
    message: "yes, and add a coke", cart, menu: fullMenu, dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(captured.calls, 1);
  assertEquals(captured.messages[0], "add a coke");
  assert(result.cart.some(l => l.menu_item_id === "item-coke"), "the Coke must be added");
  assertEquals(result.dialogueState.phase, "confirm", "a new item after 'yes' must re-ask confirm, never finalize");
  assertEquals(result.dialogueState.open, { kind: "confirm" }, "must land back on the confirm question, never link_sent, since the order just changed");
});

// ── conv 5 (14:35 run): "Alfredo - Chicken — now 2" — investigated, NOT this
// mechanism. Real transcript (conversation 2d3183e3-d7c8-4d62-9173-
// 5aec4045a8b4): the quantity bump happened on a turn where the OPEN
// question was a `disambiguation` (which of 8 Gyro items), answered with
// "I'll go with the Gyro hot sandwich for $10.99. So that's an Alfredo with
// spaghetti, a Gyro sandwich, and a medium Hawaiian pizza. What's the total
// now?" — pending-disambiguation.ts's own EXACT-LABEL tier matches a
// candidate's exact display name ANYWHERE in the message, not just inside
// the answer clause (unlike its category/ordinal tiers, scoped by design —
// see 00-PO-0918-list-answer-scope.reply's own flagged residual bug). This
// mechanism does not exist in this file at all today — it is entirely
// inside pending-disambiguation.ts's resolvePendingDisambiguation, called
// once per turn from turn-engine.ts's ANSWER case "disambiguation", which
// this dispatch's new code never touches (it only runs AFTER a resolved
// answer, using a DIFFERENT marker set aimed at finding a NEW request, not
// at resolving an open one). Confirmed by inspection: this dispatch adds no
// code path that calls applyCompiledAddItem for an item whose name merely
// appears in a remainder string outside of a real, model-returned
// `item_span` — the Alfredo bump traces to the disambiguation resolver
// re-matching "Alfredo - Chicken" against its own candidate list on a LATER
// turn (the follow-up disambiguation asked after the Gyro pick, which listed
// "the Alfredo - Chicken entree" as one of its 10 options), not to a
// remainder-extraction turn. That residual bug is real, already flagged as
// a follow-up in an earlier reply today, and stays out of this dispatch's
// scope — fixing it means touching pending-disambiguation.ts, not this file.

// ── P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md, live
// conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b): "4 large pizzas" tied 62 real
// Vito's candidates and the disambiguation question enumerated every one of
// them into a 3,378-character reply — Telnyx/Twilio silently refused to
// carry it, so the customer's phone got nothing. This synthetic 7-pizza
// menu reproduces the same shape (a bare category term ties more candidates
// than a text should ever enumerate) without needing the real Vito's menu.
// The four cases below are the spec's own required acceptance shape.

const PIZZA_KINDS = ["Pepperoni", "Cheese", "Sausage", "Buffalo Chicken", "Meat Lovers", "Veggie", "Hawaiian"];
const PIZZA_MENU: TurnEngineMenuItem[] = PIZZA_KINDS.map((kind, i) =>
  noSlotMenuItem(`item-pizza-${i}`, `Large ${kind} Pizza`, "Pizza", 1800 + i * 100)
);
// Deliberately no `category`/`size_label` on the lexicon rows themselves
// (only on the menu items) — matches the existing "ambiguous item_span"
// test above (line 492) and keeps this fixture scoped to what this dispatch
// actually changed (render()'s disambiguation case), not resolve-item.ts's
// separate, already-tested category/size narrowing.
const PIZZA_LEXICON = PIZZA_MENU.flatMap(m => [{ term: "pizza", target_id: m.id }, { term: "pizzas", target_id: m.id }]);

function pizzaProposeFn(itemSpan: string, quantity: number) {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true,
    attempts: 1,
    proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity, choices: [] }], removes: [], modifies: [] },
  });
}

Deno.test('runTurnEngineTurn P0 (narrowing questions): "4 large pizzas" asks the exact fixed narrowing question, never an enumerated list', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: PIZZA_LEXICON });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: pizzaProposeFn("large pizzas", 4) };
  const input = baseInput({ message: "4 large pizzas", menu: PIZZA_MENU, cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "still ambiguous — no line added yet");
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  // PO amendment (2026-09-19): fixed copy — quantity AND size were already
  // stated, so the reply acknowledges both and asks only for kind. Never a
  // candidate list, never model-generated free text.
  assertEquals(result.reply, "Sounds good, what kind?");
  assert(!result.reply.includes("Which one would you like"), `must never enumerate all 7 candidates: ${JSON.stringify(result.reply)}`);
  assert(result.reply.length <= 480, `narrowing question must stay SMS-safe, got ${result.reply.length} chars: ${JSON.stringify(result.reply)}`);
});

Deno.test('runTurnEngineTurn P0 (narrowing questions): answering "pepperoni" to the kind question resolves straight to Large Pepperoni Pizza x4, not another question', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: PIZZA_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: PIZZA_MENU.map(m => m.id), quantity: 4 },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({ message: "pepperoni", menu: PIZZA_MENU, cart: [], dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pizza-0", "must resolve to the Large Pepperoni Pizza");
  assertEquals(result.cart[0].quantity, 4, "the quantity originally stated ('4 large pizzas') must carry through, not silently reset to 1");
  assertEquals(result.dialogueState.open, null, "fully resolved — no follow-up question");
});

Deno.test('runTurnEngineTurn P0 (narrowing questions): a bare "pizza" (nothing else stated) asks "Sure — what kind?"', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: PIZZA_LEXICON });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: pizzaProposeFn("pizza", 1) };
  const input = baseInput({ message: "pizza", menu: PIZZA_MENU, cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  // PO amendment (2026-09-19): fixed copy — nothing else was stated, so the
  // acknowledgement is the plain "Sure", not "Sounds good" (which implies
  // quantity+size were already given).
  assertEquals(result.reply, "Sure — what kind?");
});

Deno.test('runTurnEngineTurn P0 (narrowing questions): "what are the options" while the kind question is open lists the kind NAMES only, no prices', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: PIZZA_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — an explicit options request resolves deterministically")),
  };
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: PIZZA_MENU.map(m => m.id), quantity: 4, spanText: "large pizzas" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({ message: "what are the options", menu: PIZZA_MENU, cart: [], dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);
  assertEquals(result.dialogueState.open?.kind, "disambiguation", "still open — the customer asked a question, not an answer");
  assertEquals(result.cart.length, 0);
  for (const kind of PIZZA_KINDS) {
    assert(result.reply.includes(kind), `options list must name every kind, missing "${kind}": ${JSON.stringify(result.reply)}`);
  }
  // PO amendment (2026-09-19): "lists the kinds only (names, no prices, no
  // descriptions)" — never the priced numbered list this dispatch's own
  // enumeration fallback used to produce.
  assert(!result.reply.includes("$"), `options list must never show prices: ${JSON.stringify(result.reply)}`);
});

// ── PO amendment (2026-09-19, addendum to p0-narrowing-and-sms-0919 Commit 1):
// "2 pizzas, one large" states a size for only ONE of the two units — the
// kind question still comes first ("Got it — what kind?", not "Sounds good",
// since size is only PARTIALLY known), and answering it resolves the sized
// half outright while reopening a smaller question for the other unit's
// size ("And the size on the other one?"). Needs a menu where kind AND size
// both vary so the split is genuine (the PIZZA_MENU fixture above has only
// one size per kind, which can't exercise this).
const MIXED_PIZZA_KINDS = ["Pepperoni", "Cheese"];
const MIXED_PIZZA_SIZES = ["Small", "Medium", "Large"];
const MIXED_PIZZA_MENU: TurnEngineMenuItem[] = MIXED_PIZZA_KINDS.flatMap((kind, ki) =>
  MIXED_PIZZA_SIZES.map((size, si) =>
    noSlotMenuItem(`item-mixed-${ki}-${si}`, `${kind} Pizza - ${size} 14''`, "Pizza", 1200 + ki * 100 + si * 300)
  )
);
const MIXED_PIZZA_LEXICON = MIXED_PIZZA_MENU.flatMap(m => [{ term: "pizza", target_id: m.id }, { term: "pizzas", target_id: m.id }]);

Deno.test('runTurnEngineTurn P0 (narrowing questions, partial size): "2 pizzas, one large" asks "Got it — what kind?" (not "Sounds good" — size is only partially known)', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: MIXED_PIZZA_LEXICON });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: pizzaProposeFn("2 pizzas, one large", 2) };
  const input = baseInput({ message: "2 pizzas, one large", menu: MIXED_PIZZA_MENU, cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "still ambiguous — no line added yet");
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  assertEquals(result.reply, "Got it — what kind?");
});

Deno.test('runTurnEngineTurn P0 (narrowing questions, partial size): answering "pepperoni" adds the Large one outright and asks for the other one\'s size', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: MIXED_PIZZA_LEXICON });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: pizzaProposeFn("2 pizzas, one large", 2) };
  const turn1 = await runTurnEngineTurn(baseInput({ message: "2 pizzas, one large", menu: MIXED_PIZZA_MENU, cart: [] }), deps);
  assertEquals(turn1.reply, "Got it — what kind?");

  const rejectDeps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const turn2 = await runTurnEngineTurn(
    baseInput({ message: "pepperoni", menu: MIXED_PIZZA_MENU, cart: turn1.cart, dialogueState: turn1.dialogueState }),
    rejectDeps,
  );

  assertEquals(turn2.cart.length, 1, "the Large Pepperoni resolves and is added outright");
  assertEquals(turn2.cart[0].menu_item_id, "item-mixed-0-2", "must be the Large Pepperoni Pizza (kind index 0, size index 2)");
  assertEquals(turn2.cart[0].quantity, 1, "only the ONE unit that was stated as large");
  assertEquals(turn2.dialogueState.open?.kind, "disambiguation", "the other, still-unsized unit reopens a question");
  if (turn2.dialogueState.open?.kind === "disambiguation") {
    assertEquals(turn2.dialogueState.open.quantity, 1, "only 1 unit remains unsized (2 total - 1 already sized)");
    assertEquals(turn2.dialogueState.open.otherOneFollowUp, true);
  }
  // PO's exact required copy: "And the size on the other one?"
  assert(turn2.reply.includes("And the size on the other one?"), `verbatim reply: ${JSON.stringify(turn2.reply)}`);

  const turn3 = await runTurnEngineTurn(
    baseInput({ message: "medium", menu: MIXED_PIZZA_MENU, cart: turn2.cart, dialogueState: turn2.dialogueState }),
    rejectDeps,
  );
  assertEquals(turn3.cart.length, 2, "both units are now in the cart, as two separate lines");
  const mediumPepperoniLine = turn3.cart.find(l => l.menu_item_id === "item-mixed-0-1");
  assert(mediumPepperoniLine, `expected the Medium Pepperoni line in the cart: ${JSON.stringify(turn3.cart)}`);
  assertEquals(mediumPepperoniLine?.quantity, 1);
  assertEquals(turn3.dialogueState.open, null, "fully resolved — no further question");
});

// ── PO addendum (2026-09-19, SECOND addendum to p0-narrowing-and-sms-0919
// Commit 1): the real propose_success row logged live for "4 large pizzas"
// is item_span="large pizzas", qty=4, choices=[] — and the 62-candidate
// question that reached Jason's phone still included Small and Medium
// pizzas, proving the stated size never narrowed the candidate set before
// the facet question was built. The PIZZA_MENU fixture above (line 2031)
// cannot catch this regression: every one of its 7 items is already
// "Large", so a size filter that silently no-ops would still pass those
// tests. MIXED_PIZZA_MENU is the only fixture in this file with genuine
// small/medium/large variation across more than one kind — reused here
// (not a new menu) against the *global* "4 large pizzas" shape, the one
// the live bug actually hit (MIXED_PIZZA_MENU's other tests above only
// exercise the partial-size "2 pizzas, one large" shape).
Deno.test('runTurnEngineTurn P0 (narrowing questions, global size, real span): "4 large pizzas" against a menu with genuine size variation narrows to Large-only before asking kind', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: MIXED_PIZZA_LEXICON });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: pizzaProposeFn("large pizzas", 4) };
  const input = baseInput({ message: "4 large pizzas", menu: MIXED_PIZZA_MENU, cart: [] });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "still ambiguous — no line added yet");
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  // Size AND quantity were both already stated -> the fixed "both known" copy.
  assertEquals(result.reply, "Sounds good, what kind?");
  assert(!/small|medium/i.test(result.reply), `size was already stated as large — must never surface Small/Medium: ${JSON.stringify(result.reply)}`);

  const rejectDeps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const turn2 = await runTurnEngineTurn(
    baseInput({ message: "pepperoni", menu: MIXED_PIZZA_MENU, cart: result.cart, dialogueState: result.dialogueState }),
    rejectDeps,
  );

  assertEquals(turn2.cart.length, 1, "the size was already resolved — one line, not a fresh size question");
  assertEquals(turn2.cart[0].menu_item_id, "item-mixed-0-2", "must resolve to the Large Pepperoni Pizza, never Small/Medium");
  assertEquals(turn2.cart[0].quantity, 4, "the originally-stated quantity (4) must carry through whole, not split");
  assertEquals(turn2.dialogueState.open, null, "fully resolved — size must never be re-asked, it was already stated");
});

// ── PO addendum (2026-09-19, THIRD addendum to p0-narrowing-and-sms-0919
// Commit 1): the previous fixture's root-cause note (line 2214 above) already
// explains why a 1-size-per-kind menu can hide a broken size filter. The
// SAME shape gap exists on the ANSWER side: MIXED_PIZZA_MENU has only 2
// kinds, so a bare kind word ("cheese") narrowing a same-kind, multi-size
// group down to exactly 3 candidates — then asking "What size?" scoped to
// just those 3 — was never exercised end to end through runTurnEngineTurn.
// This is the exact shape live Vito's has (7 kinds, each in Small/Medium/
// Large -> 21 candidates for a bare "pizza"; the real menu has 62 because it
// carries more kinds still), confirmed against the real menu/lexicon via
// scripts/tmp-probe-narrow2-20260919.ts.
const VITO_SHAPED_KINDS = ["Cheese", "Pepperoni", "Margherita", "Buffalo Chicken", "Hawaiian", "Veggie", "Meat Lover"];
const VITO_SHAPED_SIZES = ["Small", "Medium", "Large"];
const VITO_SHAPED_MENU: TurnEngineMenuItem[] = VITO_SHAPED_KINDS.flatMap((kind, ki) =>
  VITO_SHAPED_SIZES.map((size, si) =>
    noSlotMenuItem(`item-vito-${ki}-${si}`, `${kind} - ${size} (16")`, "Pizza", 1000 + ki * 50 + si * 300)
  )
);
const VITO_SHAPED_LEXICON = VITO_SHAPED_MENU.flatMap(m => [{ term: "pizza", target_id: m.id }, { term: "pizzas", target_id: m.id }]);

Deno.test('runTurnEngineTurn P0 (narrowing questions, kind narrows a same-kind multi-size group): "cheese" against 21 real-shaped candidates (no size stated) narrows to the 3 Cheese sizes and asks "What size?"', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: VITO_SHAPED_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: VITO_SHAPED_MENU.map(m => m.id), quantity: 1, spanText: "pizza" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({ message: "cheese", menu: VITO_SHAPED_MENU, cart: [], dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "still narrowed, not resolved — 3 Cheese sizes remain, size was never stated");
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  if (result.dialogueState.open?.kind === "disambiguation") {
    assertEquals(
      result.dialogueState.open.candidates.sort(),
      ["item-vito-0-0", "item-vito-0-1", "item-vito-0-2"].sort(),
      "narrowed set must be exactly the 3 Cheese sizes, never the other 6 kinds",
    );
  }
  assertEquals(result.reply, "What size?");

  const turn2 = await runTurnEngineTurn(
    baseInput({ message: "large", menu: VITO_SHAPED_MENU, cart: result.cart, dialogueState: result.dialogueState }),
    deps,
  );
  assertEquals(turn2.cart.length, 1);
  assertEquals(turn2.cart[0].menu_item_id, "item-vito-0-2", "must resolve to the Large Cheese, never Small/Medium or another kind");
  assertEquals(turn2.dialogueState.open, null, "fully resolved");
});

Deno.test('runTurnEngineTurn P0 (data-fact guard): "pepperoni" while a pizza disambiguation is open never dead-ends — it narrows to the 3 Pepperoni PIZZA sizes (the menu\'s Pepperoni Stromboli, a different category, was never a candidate to begin with)', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: VITO_SHAPED_LEXICON });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: VITO_SHAPED_MENU.map(m => m.id), quantity: 1, spanText: "pizza" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({ message: "pepperoni", menu: VITO_SHAPED_MENU, cart: [], dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0);
  assertEquals(result.dialogueState.open?.kind, "disambiguation");
  if (result.dialogueState.open?.kind === "disambiguation") {
    assertEquals(
      result.dialogueState.open.candidates.sort(),
      ["item-vito-1-0", "item-vito-1-1", "item-vito-1-2"].sort(),
      "narrowed set must be exactly the 3 Pepperoni PIZZA sizes",
    );
  }
  assertEquals(result.reply, "What size?");
});

// ── PO fix (2026-09-19, round-2 "plain" addendum, live conv on v511/c8b69c26):
// a list answer's own lexicon lookup for a clause like "plain" can land on an
// ambiguous same-kind, multi-size hit (all 3 Cheese sizes) even when the size
// was ALREADY stated earlier in the same conversation ("4 large pizzas").
// Before this fix, the held size was never applied to that ambiguous hit, so
// the clause fell through to "I'm not sure what you meant by plain" even
// though the lexicon found exactly the right family — see
// resolveMultiKindClauses's own "else if (heldSize && ..." branch in
// turn-engine.ts. VITO_SHAPED_LEXICON's items don't carry a "plain" alias by
// name (the item is literally named "Cheese"), so this needs its own lexicon
// row, same as the real compiled menu's alias rows.
const VITO_SHAPED_LEXICON_WITH_PLAIN_ALIAS = [
  ...VITO_SHAPED_LEXICON,
  ...VITO_SHAPED_SIZES.map((_, si) => ({ term: "plain", target_id: `item-vito-0-${si}` })),
];

Deno.test('runTurnEngineTurn P0 (round-2 "plain" addendum): a list answer\'s "plain" clause resolves via the lexicon AND the already-held size, never "not sure what you meant"', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: VITO_SHAPED_LEXICON_WITH_PLAIN_ALIAS });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: VITO_SHAPED_MENU.map(m => m.id), quantity: 4, spanText: "4 large pizzas" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({
    message: "one plain, one meat lover, one hawaiian, one pepperoni",
    menu: VITO_SHAPED_MENU,
    cart: [],
    dialogueState: priorState,
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!/not sure what you meant/i.test(result.reply), `"plain" must resolve via the held size, not fall back to a clarify question: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.length, 4, "all four named kinds must resolve, each to its held Large size");
  const ids = result.cart.map(l => l.menu_item_id).sort();
  assertEquals(
    ids,
    ["item-vito-0-2", "item-vito-1-2", "item-vito-4-2", "item-vito-6-2"].sort(),
    "must be the Large Cheese ('plain'), Large Pepperoni, Large Hawaiian, and Large Meat Lover — never Small/Medium",
  );
  for (const line of result.cart) assertEquals(line.quantity, 1);
  assertEquals(result.dialogueState.open, null, "fully resolved — size was already stated, never re-asked");
});

// ── PO fix (2026-09-19, round-2 item 1 ROOT CAUSE, live repro run TWICE with
// Jason's exact two turns): the test above pre-seeds priorState.open.spanText
// as the already-correct "4 large pizzas" — it never exercises how that
// spanText gets set in the first place. Live, PROPOSE's own item_span for
// the turn that OPENS the disambiguation is model output and varies call to
// call for the IDENTICAL customer message: one run's item_span kept "large
// pizzas", another run's dropped it to bare "pizzas". decide() used to read
// the held size ONLY from that item_span (extractGlobalSizeWord run against
// it), so the dropped-word run stored no size at all — every clause in the
// following list answer then narrowed to a same-kind, multi-size group with
// nothing to disambiguate them further, and (depending on exactly how thin
// the remaining candidate set was) could fall all the way through to
// unresolved instead of asking "What size?" once. The fix reads the held
// size from the CUSTOMER'S OWN raw message for the opening turn — which
// always has "large" whether or not the model's item_span kept it — so this
// must resolve correctly regardless of which shape PROPOSE happens to
// return. Runs the FULL two turns (open, then answer) through
// runTurnEngineTurn — never pre-seeds state — so a decide()-level regression
// in how spanText gets built is not masked by fixture setup.
Deno.test('runTurnEngineTurn P0 (round-2 item 1 root cause): the held size for a disambiguation survives even when PROPOSE\'s own item_span for the opening turn drops "large"', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: VITO_SHAPED_LEXICON_WITH_PLAIN_ALIAS });

  // Turn 1: "I want 4 large pizzas. 1 pepperoni, 1 plain, 1 hawaiian, 1 meat
  // lovers" — PROPOSE's own item_span for the (still-ambiguous) 4-pizza add
  // is "pizzas", dropping the word "large" the customer actually typed. This
  // is the exact live variance the PO's root-cause investigation found —
  // the SAME customer message, a different model call, a different span.
  const openDeps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true,
      attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "pizzas", quantity: 4, choices: [] }],
        removes: [], modifies: [],
      },
    }),
  };
  const openInput = baseInput({
    message: "I want 4 large pizzas. 1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers",
    menu: VITO_SHAPED_MENU,
    cart: [],
    dialogueState: null,
  });
  const openResult = await runTurnEngineTurn(openInput, openDeps);

  assertEquals(openResult.cart.length, 0, "still ambiguous — nothing resolves on the opening turn");
  assertEquals(openResult.dialogueState.open?.kind, "disambiguation");
  if (openResult.dialogueState.open?.kind === "disambiguation") {
    assertEquals(
      openResult.dialogueState.open.spanText,
      "large pizzas",
      "the held size must come from the customer's own raw message, not the model's item_span which dropped \"large\"",
    );
  }

  // Turn 2: the list answer. PROPOSE must never be called — a disambiguation
  // answer resolves deterministically.
  const answerDeps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
  const answerInput = baseInput({
    message: "one plain, one meat lover, one hawaiian, one pepperoni",
    menu: VITO_SHAPED_MENU,
    cart: [],
    dialogueState: openResult.dialogueState,
  });
  const answerResult = await runTurnEngineTurn(answerInput, answerDeps);

  assert(!/not sure what you meant/i.test(answerResult.reply), `all four clauses must resolve via the recovered held size, never "not sure what you meant": ${JSON.stringify(answerResult.reply)}`);
  assertEquals(answerResult.cart.length, 4, "all four named kinds must land, each at its held Large size");
  const ids = answerResult.cart.map(l => l.menu_item_id).sort();
  assertEquals(
    ids,
    ["item-vito-0-2", "item-vito-1-2", "item-vito-4-2", "item-vito-6-2"].sort(),
    "must be the Large Cheese ('plain'), Large Pepperoni, Large Hawaiian, and Large Meat Lover — never Small/Medium and never an empty cart",
  );
  for (const line of answerResult.cart) assertEquals(line.quantity, 1);
  assertEquals(answerResult.dialogueState.open, null, "fully resolved — size was recovered from the raw message, never re-asked");
});

// ── Freeze-queue item 7 (2026-09-19): returning-customer greeting ──────────
// PO report: "Last week the bot recognised Jason by number, greeted him by
// name, and offered 'the same as last time?' with the full order, delivery
// and address. It no longer does" on the turn-engine path. Fixture below is
// shaped exactly like the real `customers` row queried live for Vito's
// (tenant_id/shop_id e0000000-0000-0000-0000-000000000001, customer_phone
// "web:cq-1789437090-7304") — not invented field names or values — and
// REGULAR_MENU's "Cheese - Large (16\")" / "Large Cheese Pizza" pairing is
// the real menu_items.name/display_name for menu_item_id
// 8857b40a-e53b-44fa-8bf0-6fdafb7efa45 on Vito's live menu.

const REGULAR_MENU: TurnEngineMenuItem[] = [
  {
    id: "item-cheese-large-16",
    name: 'Cheese - Large (16")',
    category: "Pizza",
    price_cents: 1650,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1,
      display_name: "Large Cheese Pizza",
      base_price_cents: 1650,
      recap_template: "", ticket_template: "",
      steps: [],
    },
  },
];

const REAL_VITOS_CUSTOMER_ROW = {
  tenant_id: "e0000000-0000-0000-0000-000000000001",
  customer_phone: "web:cq-1789437090-7304",
  name: "Jason",
  order_count: 9,
  total_spent_cents: 0,
  favorite_items: [{ name: 'Cheese - Large (16")', count: 6 }],
  last_order_id: "4837ee2a-64bb-4b16-b81f-4b66ced1fa3f",
  last_order_at: "2026-09-15T01:51:31.720894+00:00",
  last_order_type: "delivery" as const,
  last_delivery_address: {
    zip: "18106", city: "Allentown", state: "PA", street: "5620 Cetronia Rd",
    formatted: "5620 Cetronia Rd, Allentown, PA 18106",
  },
};

// Real Vito's shops row values for the fields maybeBuildReturningCustomerGreeting reads.
const REAL_VITOS_SHOP_ROW = {
  customer_personalization_enabled: true,
  delivery_paused_until: null,
  delivery_radius_mi: 5.0,
};

function returningCustomerBaseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return baseInput({
    menu: REGULAR_MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: null,
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: 0,
    },
    ...overrides,
  });
}

Deno.test("ACCEPTANCE 1+2 (freeze-queue item 7): a known returning customer's first message is greeted by name AND offered the remembered regular + delivery address together, never a generic welcome", async () => {
  const { supabase } = makeFakeSupabase({
    conversationRow: { customer_phone: REAL_VITOS_CUSTOMER_ROW.customer_phone },
    shopRow: REAL_VITOS_SHOP_ROW,
    customerRow: REAL_VITOS_CUSTOMER_ROW,
  });
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — turn 1 is fully swallowed by the offer, never reaches ANSWER/PROPOSE")),
  };
  const input = returningCustomerBaseInput({ message: "hi" });

  const result = await runTurnEngineTurn(input, deps);

  assert(result.reply.startsWith("Hey Jason, welcome back!"), `must greet by the real stored name, not a generic welcome: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("Large Cheese Pizza"), `must describe the actual remembered regular item: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("5620 Cetronia Rd, Allentown, PA 18106"), `must describe the actual remembered delivery address: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.length, 0, "nothing is added to the cart on the offer turn itself — only on an explicit yes");
  assertEquals(
    result.dialogueState.returningCustomerOffer,
    {
      regularItem: { menu_item_id: "item-cheese-large-16", name: "Large Cheese Pizza" },
      deliveryOffer: { type: "delivery", address: REAL_VITOS_CUSTOMER_ROW.last_delivery_address },
    },
    "the exact offer just made must be remembered so a 'yes' next turn knows what to place",
  );
  assertEquals(result.dialogueState.open, null);
});

Deno.test("ACCEPTANCE 3 (freeze-queue item 7): saying yes to the offer places the remembered order — item, order type, and delivery address all land correctly", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = { supabase, apiKey: "test-key" };
  const priorState: DialogueState = {
    ...INITIAL_DIALOGUE_STATE,
    returningCustomerOffer: {
      regularItem: { menu_item_id: "item-cheese-large-16", name: "Large Cheese Pizza" },
      deliveryOffer: { type: "delivery", address: REAL_VITOS_CUSTOMER_ROW.last_delivery_address },
    },
  };
  const input = returningCustomerBaseInput({ message: "yes please", dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, `the remembered item must land in the cart: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, "item-cheese-large-16");
  assertEquals(result.cart[0].quantity, 1);
  assertEquals(result.dialogueState.returningCustomerOffer, null, "the offer must be cleared once acted on — never re-applied on a later turn");

  const lastUpdate = state.orderCartsUpdates.at(-1) as { order_type?: string; delivery_address?: { formatted: string } };
  assertEquals(lastUpdate.order_type, "delivery", "order type must be set from the accepted offer, not left for the customer to state again");
  assertEquals(lastUpdate.delivery_address?.formatted, "5620 Cetronia Rd, Allentown, PA 18106", "the remembered address must be persisted, not re-asked");
});

Deno.test("ACCEPTANCE 4 (freeze-queue item 7): saying no (or anything else) to the offer proceeds to a completely normal, unaffected conversation — nothing forced onto the cart", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const priorState: DialogueState = {
    ...INITIAL_DIALOGUE_STATE,
    returningCustomerOffer: {
      regularItem: { menu_item_id: "item-cheese-large-16", name: "Large Cheese Pizza" },
      deliveryOffer: { type: "delivery", address: REAL_VITOS_CUSTOMER_ROW.last_delivery_address },
    },
  };
  const input = returningCustomerBaseInput({ message: "no thanks", dialogueState: priorState });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "declining must never place the remembered regular");
  assertEquals(result.dialogueState.returningCustomerOffer, null, "the offer must be cleared on a decline, so it is never re-offered or silently re-accepted later");
  assert(!result.reply.includes("welcome back"), "a decline reply is an ordinary turn reply, not another greeting");
  const lastUpdate = state.orderCartsUpdates.at(-1) as { order_type?: string } | undefined;
  assertEquals(lastUpdate?.order_type, undefined, "order type must not be silently set from a declined offer");
});

Deno.test("ACCEPTANCE 5 (freeze-queue item 7): a brand-new customer with no profile row is completely unaffected — first-turn behavior is unchanged", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  // conversationRow/shopRow/customerRow are all null by default — the exact
  // shape of a phone that has never contacted this shop before.
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const input = baseInput({ message: "cheeseburger", cart: [], dialogueState: null });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, "the item must still land exactly as it does today for a first-ever contact");
  assertEquals(result.cart[0].menu_item_id, "item-cheeseburger");
  assert(!result.reply.includes("welcome back"), `a brand-new customer must never be greeted as returning: ${JSON.stringify(result.reply)}`);
  assertEquals(result.dialogueState.returningCustomerOffer, undefined, "no offer state for a customer with no profile row");
});

// ── MONEY BUG (2026-09-19, live conv 31f54c6b, item 2 of tonight's 50-run):
// cart correct at $39.98, confirm read-back shown correctly, customer typed
// "Looks good to me!" ready to pay — PROPOSE (the model call) timed out
// twice (25s x2) and the bot answered "Sorry, I ran into a problem. Please
// call us directly to place your order," sending a customer who wanted to
// pay to the phone instead. Root cause (PO): the 2026-09-18 timeout
// carve-out above only ever covered `priorState.open === null` — it had no
// answer for a timeout while a yes/no-shaped question (confirm,
// category_confirm) was open. Two fixes, tested independently below:
//   1. "Looks good to me" (and the rest of that bare-affirmation family) at
//      confirm now resolves in ANSWER itself (turn-engine.ts's widened
//      CONFIRM_AFFIRMATIVE_RE) — PROPOSE is never reached at all for this
//      shape of reply, so there is no timeout to fall back from.
//   2. A genuine timeout while ANY question is still open (confirm,
//      category_confirm, name, ...) now re-asks that exact question
//      (turn-engine-runner.ts's new `reason === "timeout" && priorState.open
///     !== null` branch) instead of the apology. ──────────────────────────

const CONFIRM_BUG_PIZZA_MENU: TurnEngineMenuItem[] = [
  {
    id: "item-cbr-pizza-medium", name: "Medium Chicken Bacon Ranch Pizza", category: "Pizza", price_cents: 1999,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Medium Chicken Bacon Ranch Pizza", base_price_cents: 1999, recap_template: "", ticket_template: "", steps: [] },
  },
];

function pizzaConfirmCart(): TurnEngineCartLine[] {
  // 2x Medium Chicken Bacon Ranch pizza @ $19.99 = $39.98 — the exact #3
  // repro cart.
  return [{ menu_item_id: "item-cbr-pizza-medium", name: "Medium Chicken Bacon Ranch Pizza", quantity: 2, price_cents: 1999, modifiers: [], line_key: "line-1" }];
}

function pizzaConfirmState(): DialogueState {
  return { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
}

function pizzaConfirmShopContext(): RunTurnShopContext {
  return { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null };
}

// ACCEPTANCE 1: the exact #3 repro resolves to checkout WITHOUT ever calling
// the model.
Deno.test("MONEY BUG fix 1: 'Looks good to me!' over the exact #3 repro cart ($39.98, confirm open) resolves straight to checkout — PROPOSE is never called", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("must not be called — 'Looks good to me!' at confirm must resolve code-side, with zero chance of a model timeout")),
  };
  const input = baseInput({
    message: "Looks good to me!",
    menu: CONFIRM_BUG_PIZZA_MENU,
    cart: pizzaConfirmCart(),
    dialogueState: pizzaConfirmState(),
    shopContext: pizzaConfirmShopContext(),
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.toLowerCase().includes("problem"), `must never fall back to the apology: ${result.reply}`);
  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
  assertEquals(result.dialogueState.phase, "link_sent", "a clean affirmative at confirm must proceed straight to checkout");
  assertEquals(result.dialogueState.open, null, "confirm is resolved, nothing left open");
  assertEquals(result.cart, pizzaConfirmCart(), "confirming never mutates the cart");
  assertEquals(state.messagesInserted.length, 1);
});

// ACCEPTANCE 2: a GENUINE timeout (the model call itself fails) while
// confirm is open re-asks confirm, never the apology. Deliberately a
// message fix 1 does NOT resolve ("banana" — no yes/no shape at all) so
// this exercises the timeout branch specifically, not fix 1's shortcut.
Deno.test("MONEY BUG fix 2: a genuine model timeout while confirm is open RE-ASKS confirm, never 'call us'", async () => {
  // lexicon: [] — the default LEXICON fixture's non-UUID target_ids would
  // otherwise also trip the unrelated dropped-non-UUID trip-wire log (see
  // the "terminal PROPOSE failure" test's own comment above), adding a
  // second error_log row this test isn't about.
  const { supabase, state } = makeFakeSupabase({ lexicon: [] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const priorState = pizzaConfirmState();
  const input = baseInput({
    message: "banana",
    menu: CONFIRM_BUG_PIZZA_MENU,
    cart: pizzaConfirmCart(),
    dialogueState: priorState,
    shopContext: pizzaConfirmShopContext(),
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
  assertEquals(result.dialogueState.open, priorState.open, "confirm must still be open — nothing was resolved, so nothing should have changed");
  assertEquals(result.dialogueState.phase, "confirm");
  assertEquals(result.dialogueState.openRepeatCount, 1, "a timeout re-ask is a real repeat of the same question");
  assertEquals(result.cart, pizzaConfirmCart(), "a model timeout must never mutate the cart");
  assert(result.reply.includes("confirm") || result.reply.includes("All good"), `expected the confirm question re-asked: ${result.reply}`);
  // error_log is written by the REAL proposeTurn (propose.ts) on a genuine
  // failure — the "terminal PROPOSE failure" test above already covers that
  // write via the real implementation; this test's stubbed proposeTurnFn
  // (timedOutProposeResult) never touches supabase at all, so there's
  // nothing to assert on that front here.
  assertEquals(state.orderCartsUpdates.length, 1, "the bumped openRepeatCount must be persisted so a second timeout in a row escalates normally");
});

// ACCEPTANCE 3 (regression): a genuine timeout with NO open question is
// unchanged by this dispatch — still governed entirely by the pre-existing
// 2026-09-18 carve-out (decide()'s own deterministic resolution, or that
// same carve-out's own decline — never this dispatch's new re-ask branch,
// since there is nothing open to re-ask). Non-timeout failures with an open
// question are also unchanged: they must still fall to the literal apology,
// proving the new branch is scoped to reason === "timeout" only.
Deno.test("MONEY BUG regression: a genuine timeout with NO open question is untouched by this dispatch — never routes through the new re-ask branch", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const input = baseInput({ message: "cheeseburger", cart: [], dialogueState: { ...INITIAL_DIALOGUE_STATE } });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 1, "unchanged 2026-09-18 behavior: the item still lands deterministically, no model needed");
  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
});

Deno.test("MONEY BUG regression: a NON-timeout failure (schema_violation) while confirm is open still gets the literal apology, unchanged — proves the new re-ask branch is scoped to reason === 'timeout' only", async () => {
  const { supabase, state } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: false,
      reason: "schema_violation",
      detail: "response did not contain a schema-valid submit_proposal tool call",
      attempts: [{ attempt: 1, reason: "schema_violation", detail: "response did not contain a schema-valid submit_proposal tool call", rawBody: "{}", ms: 900 }],
    }),
  };
  const priorState = pizzaConfirmState();
  const input = baseInput({
    message: "banana",
    menu: CONFIRM_BUG_PIZZA_MENU,
    cart: pizzaConfirmCart(),
    dialogueState: priorState,
    shopContext: pizzaConfirmShopContext(),
  });

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.reply, FALLBACK_REPLY, "a non-timeout failure class is out of scope for both the 2026-09-18 carve-out and this dispatch's re-ask branch");
  assertEquals(result.cart, pizzaConfirmCart());
  assertEquals(result.dialogueState, priorState, "nothing changed this turn");
  assertEquals(state.orderCartsUpdates.length, 0, "nothing changed this turn — cart/dialogue_state must not be rewritten");
});

// ACCEPTANCE 4: a genuine timeout with category_confirm open (the OTHER
// yes/no-shaped open kind, freeze-queue item 4) re-asks THAT question too —
// this dispatch is not scoped to "confirm" specifically.
Deno.test("MONEY BUG fix 2 (category_confirm): a genuine model timeout while category_confirm is open re-asks that exact question too", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: timedOutProposeResult };
  const categoryConfirmMenu: TurnEngineMenuItem[] = [
    {
      id: "item-16-stromboli", name: "16\" Stromboli", category: "Stromboli", price_cents: 1499,
      bot_state: "orderable",
      ask_plan: { compiled_at: "", compiler_version: 1, display_name: "16\" Stromboli", base_price_cents: 1499, recap_template: "", ticket_template: "", steps: [] },
    },
  ];
  const priorState: DialogueState = {
    phase: "ordering",
    open: { kind: "category_confirm", menu_item_id: "item-16-stromboli", quantity: 1, message: "We only have 16\" Stromboli as a stromboli. Want that, or skip it?" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const input = baseInput({
    message: "banana",
    menu: categoryConfirmMenu,
    cart: [],
    dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.toLowerCase().includes("call us"), `reply must not tell the customer to call: ${result.reply}`);
  assertEquals(result.dialogueState.open?.kind, "category_confirm", "category_confirm must still be open — never dropped, never silently swapped for the apology");
  assertEquals(result.dialogueState.openRepeatCount, 1);
  assert(result.reply.includes("We only have 16\" Stromboli"), `expected the exact category_confirm question re-asked: ${result.reply}`);
  assertEquals(result.cart, [], "a model timeout must never add the item on its own");
});

// ACCEPTANCE 5: a message that is NOT cleanly yes/no while confirm is open
// must still go to the model as normal — fix 1 must not intercept genuinely
// ambiguous replies, only unambiguous yes/no ones.
Deno.test("MONEY BUG fix 1 guard rail: a genuine question at confirm ('What toppings does the everything pizza have?') is NOT intercepted — it still reaches PROPOSE", async () => {
  const { supabase } = makeFakeSupabase();
  let proposeCalled = false;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalled = true;
      return Promise.resolve({
        ok: true,
        proposal: { intent: "question", answer_text: "We don't carry an everything pizza — want to pick a different one?", adds: [], removes: [], modifies: [] },
        attempts: 1,
      });
    },
  };
  const input = baseInput({
    message: "What toppings does the everything pizza have?",
    menu: CONFIRM_BUG_PIZZA_MENU,
    cart: pizzaConfirmCart(),
    dialogueState: pizzaConfirmState(),
    shopContext: pizzaConfirmShopContext(),
  });

  const result = await runTurnEngineTurn(input, deps);

  assert(proposeCalled, "an ambiguous, non-yes/no message at confirm must still reach the model — fix 1 must only intercept clean yes/no replies");
  assertEquals(result.cart, pizzaConfirmCart());
});

// ── TOP PRIORITY LIVE MONEY BUG (2026-09-19, live conv 4c52298c, turn #5) ──
// End-to-end proof, through runTurnEngineTurn, of the real transcript: a
// which-one list was open for "pepperoni pizza" (quantity 1 — nothing was
// stated in the ORIGINAL ambiguous request) with candidates in real
// transcript list order where option 2 happened to be Small. The customer
// answered "I'll take 2 Large Pepperoni pizzas, please." The leading "2" was
// read as selecting OPTION NUMBER 2 (Small) instead of a QUANTITY of 2 —
// cart ended up 2x Small Pepperoni Pizza ($17.45 each = $34.90) instead of
// 2x Large ($21.00 each = $42.00), no clarifying question ever asked, and
// the wrong item/wrong money reached checkout silently. See
// pending-disambiguation.test.ts's own PEPPERONI_PIZZA_CANDIDATES block for
// the pure-function-level proof this exercises end to end; propose is wired
// to reject so a stray model call would fail these tests loudly instead of
// silently masking a regression back to the LLM path.
const PEPPERONI_MONEY_BUG_MENU: TurnEngineMenuItem[] = [
  noSlotMenuItem("item-pep-medium", "Pepperoni Pizza - Medium (14\")", "Pizza", 1900),
  noSlotMenuItem("item-pep-small",  "Pepperoni Pizza - Small (10\")",  "Pizza", 1745),
  noSlotMenuItem("item-pep-large",  "Pepperoni Pizza - Large (16\")",  "Pizza", 2100),
];

function pepperoniMoneyBugPriorState(): DialogueState {
  return {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: PEPPERONI_MONEY_BUG_MENU.map(m => m.id), quantity: 1, spanText: "pepperoni pizza" },
    upsell_offered: false,
    asked_message_id: null,
  };
}

function pepperoniMoneyBugDeps(supabase: unknown): RunTurnDeps {
  return {
    supabase: supabase as RunTurnDeps["supabase"],
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a disambiguation answer resolves deterministically")),
  };
}

Deno.test('runTurnEngineTurn LIVE MONEY BUG (real repro, conv 4c52298c): "I\'ll take 2 Large Pepperoni pizzas, please." resolves to 2x LARGE ($21.00 each = $42.00), never Small', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "I'll take 2 Large Pepperoni pizzas, please.",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1, `expected exactly one cart line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, "item-pep-large", "must resolve to LARGE — the customer's own stated size — never Small via index misread");
  assertEquals(result.cart[0].quantity, 2, "the customer's stated quantity (2) must carry through, not the disambiguation's original quantity (1)");
  assertEquals(result.cart[0].price_cents, 2100);
  assertEquals(result.cart[0].price_cents * result.cart[0].quantity, 4200, "2x $21.00 Large = $42.00");
  assertEquals(result.dialogueState.open, null, "fully resolved — no further question");
});

Deno.test('runTurnEngineTurn: "2 large please" resolves to 2x LARGE ($21.00 each = $42.00)', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "2 large please",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pep-large");
  assertEquals(result.cart[0].quantity, 2);
  assertEquals(result.cart[0].price_cents, 2100);
  assertEquals(result.cart[0].price_cents * result.cart[0].quantity, 4200);
  assertEquals(result.dialogueState.open, null);
});

Deno.test('runTurnEngineTurn: "option 2" is a bare position pick — resolves to 1x SMALL ($17.45), this fixture\'s option 2, unchanged from today\'s index-based behavior', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "option 2",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pep-small");
  assertEquals(result.cart[0].quantity, 1);
  assertEquals(result.cart[0].price_cents, 1745);
  assertEquals(result.dialogueState.open, null);
});

Deno.test('runTurnEngineTurn: bare "2" is the same position pick as "option 2" (1x SMALL, $17.45) — unchanged from today\'s index-based behavior', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "2",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pep-small");
  assertEquals(result.cart[0].quantity, 1);
  assertEquals(result.cart[0].price_cents, 1745);
  assertEquals(result.dialogueState.open, null);
});

Deno.test('runTurnEngineTurn: "the second one" (ordinal path) resolves to the same position (1x SMALL, $17.45)', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "the second one",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pep-small");
  assertEquals(result.cart[0].quantity, 1);
  assertEquals(result.cart[0].price_cents, 1745);
  assertEquals(result.dialogueState.open, null);
});

Deno.test('runTurnEngineTurn: "2 of the large" (partitive-of shape) resolves to 2x LARGE ($21.00 each = $42.00)', async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [] });
  const input = baseInput({
    message: "2 of the large",
    menu: PEPPERONI_MONEY_BUG_MENU,
    cart: [],
    dialogueState: pepperoniMoneyBugPriorState(),
  });

  const result = await runTurnEngineTurn(input, pepperoniMoneyBugDeps(supabase));

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, "item-pep-large");
  assertEquals(result.cart[0].quantity, 2);
  assertEquals(result.cart[0].price_cents, 2100);
  assertEquals(result.cart[0].price_cents * result.cart[0].quantity, 4200);
  assertEquals(result.dialogueState.open, null);
});

// ============================================================
// PO dispatch (2026-09-19), MONEY BUG (W1), real live conv 0db63161 (#28),
// deploy v549, order never paid:
//
//   bot: "What's the name for the order?"
//   customer: "It's under my name. Just put it in my name."
//   bot: "10 Pieces Wings (Bone-In) added. What wing flavor would you like...?"
//
// answer()'s "name" case already correctly refuses to read a name out of
// this message (NOT_NAME_TOKENS has both "my" and "name" -- see
// name-step-empty-takeover-and-wing-slot-removal-20260919.test.ts's own
// "rule 1" acceptance for that half, proven directly against answer()) and
// returns UNRESOLVED, so the turn reaches PROPOSE. Nothing in PROPOSE's own
// contract stops the MODEL from reading that same confusing reply as an
// order anyway -- exactly like the order-shaped-message defect fixed
// earlier tonight (Round 2, item 4/1b, just above), except here the model's
// own adds/removes/modifies are the leak, not a code-side re-run. Fixed by
// discarding a PROPOSE result's adds/removes/modifies outright whenever the
// open question is name/address/order_type/confirm -- each has a narrow,
// specific expected answer shape, so a reply to any of them is never a
// license to add/remove/modify a cart line, no matter what the model
// itself proposes. The model is still consulted (answer_value extraction
// for name/address needs the call to happen); only its cart mutation is
// discarded.
// ============================================================

const WINGS_MONEY_BUG_ID = "wings-10pc-bone-in";
const WINGS_MONEY_BUG_MENU: TurnEngineMenuItem[] = [
  ...MENU,
  {
    id: WINGS_MONEY_BUG_ID, name: "10 Pieces Wings (Bone-In)", category: "Wings", price_cents: 1699,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "10 Pieces Wings (Bone-In)", base_price_cents: 1699,
      recap_template: "", ticket_template: "",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: "wings-flavor-group", slot_key: "flavor", prompt_template: "flavor.ask",
          choices: [
            { id: "wings-mild", display: "Mild", price_delta_cents: 0 },
            { id: "wings-hot", display: "Hot", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];
const LIVE_NAME_STEP_REPLY = "It's under my name. Just put it in my name.";
const NAME_OPEN_STATE: DialogueState = { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null };

Deno.test("runTurnEngineTurn (rule 1+2, PRIMARY ACCEPTANCE, real conv 0db63161 #28, MONEY BUG): with the name question open, even a model that hallucinates 'Wings' out of the name reply never lands it on the cart", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "wings", target_id: WINGS_MONEY_BUG_ID }] });
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    // The exact live outcome: the model reads the name-step reply as an
    // order for the wings. Nothing in PROPOSE's contract forbids this --
    // code must be the backstop, not a hope that the model behaves.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "Wings", quantity: 10, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const input = baseInput({
    message: LIVE_NAME_STEP_REPLY,
    menu: WINGS_MONEY_BUG_MENU,
    cart: [],
    dialogueState: NAME_OPEN_STATE,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  });

  const result = await runTurnEngineTurn(input, deps);

  // BEFORE this fix (verified directly against the pre-fix code path --
  // the adds/removes/modifies sanitization step added to
  // turn-engine-runner.ts did not exist, so decide() received the model's
  // adds unchanged): this same call adds Wings and opens the flavor slot
  // next -- the exact live defect, "10 Pieces Wings (Bone-In) added. What
  // wing flavor would you like...?". AFTER: nothing lands on the cart.
  assertEquals(result.cart.length, 0, `Wings must never be added from a name-question reply, even when the model itself proposes it: ${JSON.stringify(result.cart)}`);
  assert(!result.reply.toLowerCase().includes("wing"), `reply must not mention Wings at all: ${result.reply}`);
});

// Rule 2, the code-side takeover specifically: an order-shaped message ("4
// burgers please" -- leading quantity + real category word) with the model
// returning EMPTY adds normally re-runs through the same order-add pipeline
// (Round 2, item 4/1b, above) -- but only when open === null or a kind
// without a narrow expected-answer shape. Verifies the gate for all four
// blocked kinds, plus a regression check that the pre-existing behavior
// (open === null) still fires, unaffected.
const ORDER_SHAPED_MONEY_BUG_MESSAGE = "4 cheese burgers please";
function emptyAddsProposeFn(): Promise<ProposeResult> {
  return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
}
const RULE2_BLOCKED_OPEN_STATES: Array<{ label: string; state: DialogueState }> = [
  { label: "name", state: { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null } },
  { label: "address", state: { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null } },
  { label: "order_type", state: { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null } },
  { label: "confirm", state: { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null } },
];

for (const { label, state } of RULE2_BLOCKED_OPEN_STATES) {
  Deno.test(`runTurnEngineTurn (rule 2): the order-shaped empty-adds takeover never fires while open.kind === "${label}"`, async () => {
    const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheese burger", target_id: "item-cheeseburger" }] });
    const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: emptyAddsProposeFn };
    const input = baseInput({
      message: ORDER_SHAPED_MONEY_BUG_MESSAGE,
      cart: [],
      dialogueState: state,
      shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: label === "name" ? null : "Jason", deliveryFeeCents: null },
    });
    const result = await runTurnEngineTurn(input, deps);
    assertEquals(result.cart.length, 0, `"${ORDER_SHAPED_MONEY_BUG_MESSAGE}" while open.kind === "${label}" must never resolve as a fresh order: ${JSON.stringify(result.cart)}`);
  });
}

Deno.test("runTurnEngineTurn (rule 2 regression): the order-shaped empty-adds takeover still fires normally when open === null (unaffected case, Round 2 item 4/1b)", async () => {
  const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheese burger", target_id: "item-cheeseburger" }] });
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: emptyAddsProposeFn };
  const input = baseInput({
    message: ORDER_SHAPED_MONEY_BUG_MESSAGE,
    cart: [],
    dialogueState: { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null },
  });
  const result = await runTurnEngineTurn(input, deps);
  assertEquals(result.cart.length, 1, "a genuinely fresh order-shaped message with no open question must still resolve, unaffected by this gate");
  assertEquals(result.cart[0].menu_item_id, "item-cheeseburger");
});

// PO dispatch (2026-09-20, live regression, "cheeseburger" cart-empty miss,
// present on v584 AND v585/7e7ab0c1 -- not a window-25 regression): a
// PLAIN item message -- no leading quantity, no category word, just the
// item name -- is not order-shaped by orderShapedMessageQuantity's own
// narrow definition (it requires a leading quantity directly followed by a
// real category word, see the rule-2 tests just above), so a fully empty
// proposal ({intent:"order", adds:[]}) for a message like "cheeseburger"
// fell through both existing takeovers entirely and landed on ASK's plain
// "What would you like to order?" with nothing on the cart -- most visibly
// live on turn 2, right after a "Pickup or delivery today?" opener
// (deepseek-v4-flash returns empty adds for this exact shape 5-15% of the
// time). Deliberately covers BOTH shapes from the PO's acceptance spec: a
// genuinely fresh conversation (open === null) and the turn-2 shape (open
// still order_type from the immediately-preceding pickup/delivery
// question) -- the bug was specifically that the SECOND shape did not
// resolve even though the first one already did.
const PLAIN_ITEM_FIRES_OPEN_STATES: Array<{ label: string; state: DialogueState | null }> = [
  { label: "null (fresh conversation, no preceding question)", state: null },
  { label: "order_type (immediately after 'Pickup or delivery today?')", state: { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null } },
];

for (const { label, state } of PLAIN_ITEM_FIRES_OPEN_STATES) {
  Deno.test(`runTurnEngineTurn (plain-item empty-proposal takeover): a fully empty proposal ({intent:'order', adds:[]}) for the plain message "cheeseburger" still lands Cheese Burger $8.49, with open.kind === ${label}`, async () => {
    const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
    const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: emptyAddsProposeFn };
    const input = baseInput({
      message: "cheeseburger",
      cart: [],
      dialogueState: state,
    });

    const result = await runTurnEngineTurn(input, deps);

    assertEquals(result.cart.length, 1, `"cheeseburger" with a fully empty proposal must still resolve, not land empty (open.kind === ${label}): ${JSON.stringify(result.cart)}`);
    assertEquals(result.cart[0].menu_item_id, "item-cheeseburger");
    assertEquals(result.cart[0].price_cents, 849);
    assert(!result.reply.toLowerCase().includes("what would you like to order"), `must not fall through to the generic ordering prompt with the item unresolved: ${result.reply}`);
    assert(!result.reply.toLowerCase().includes("pickup or delivery"), `must not re-ask the pickup/delivery question this same turn while silently dropping the item: ${result.reply}`);
  });
}

// Narrower guard check: name/address must stay blocked for this branch too
// (a name or address reply is never legitimately a food order, and the
// existing blanket adds-wipe for those two kinds would erase this branch's
// synthesized add anyway) -- locks in openKindBlocksPlainItemTakeover's
// scope now that it deliberately diverges from openKindBlocksOrderShapedTakeover
// (which still blocks all four kinds, unchanged).
const PLAIN_ITEM_STILL_BLOCKED_OPEN_STATES: Array<{ label: string; state: DialogueState }> = [
  { label: "name", state: { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null } },
  { label: "address", state: { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null } },
];

for (const { label, state } of PLAIN_ITEM_STILL_BLOCKED_OPEN_STATES) {
  Deno.test(`runTurnEngineTurn (plain-item empty-proposal takeover): still never fires while open.kind === "${label}"`, async () => {
    const { supabase } = makeFakeSupabase({ lexicon: [{ term: "cheeseburger", target_id: "item-cheeseburger" }] });
    const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: emptyAddsProposeFn };
    const input = baseInput({
      message: "cheeseburger",
      cart: [],
      dialogueState: state,
      shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: label === "name" ? null : "Jason", deliveryFeeCents: null },
    });
    const result = await runTurnEngineTurn(input, deps);
    assertEquals(result.cart.length, 0, `"cheeseburger" while open.kind === "${label}" must never resolve as a fresh order: ${JSON.stringify(result.cart)}`);
  });
}
