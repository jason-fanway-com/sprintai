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

function makeFakeSupabase(overrides: Partial<Pick<FakeState, "shopSettings" | "lexicon">> = {}) {
  const state: FakeState = {
    orderCartsUpdates: [],
    messagesInserted: [],
    errorLogInserted: [],
    shopSettings: null,
    lexicon: LEXICON,
    ...overrides,
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
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() {
        if (table === "shop_settings") return Promise.resolve({ data: state.shopSettings, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      range(from: number, to: number) {
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
      // silent default-cap behavior when no explicit Range header is sent.
      then(resolve: (v: { data: unknown; error: null }) => void, reject?: (e: unknown) => void) {
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
