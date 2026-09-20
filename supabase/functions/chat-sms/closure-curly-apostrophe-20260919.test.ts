// PO dispatch (2026-09-19), REAL LIVE BUG, v558 #40, conv 8aa34668:
// "No, that's it for me. Just the Calzone and Crazy Fries for pickup." — a
// closure (declining more items) immediately followed by a RESTATEMENT of
// what's already in the cart (Calzone and Crazy Fries were already there,
// not new adds) — got "Anything else?" three turns running instead of
// moving the conversation forward.
//
// ROOT CAUSE (corrects the dispatch's own working theory): NOT a gap in the
// closure-detection regexes themselves, and NOT the PROPOSE-routing/
// re-open-after-closure theory floated going in. BARE_CLOSURE_RE and
// CLOSURE_ANYWHERE_RE (turn-engine.ts) both match this message's TEXT
// correctly, and CLOSURE_BLOCKED_BY_RE does not fire on it — verified
// directly against the plain-ASCII-apostrophe form of the live message,
// which impliesClosure() already read as closure=true before any change
// here. The actual live message never reached that path: iOS autocorrects
// a customer's typed straight `'` into a curly U+2019 (’) before the SMS is
// sent, and every `that'?s`/`don'?t`-style pattern in this file only ever
// anticipated the straight apostrophe or none at all. With the curly form
// (byte-for-byte what a real iPhone sends), impliesClosure() returned
// false, ANSWER fell through to PROPOSE/decide() every turn, and the
// deterministic "closure over a non-empty cart advances the conversation"
// path (case "ordering" in answer(), turn-engine.ts) never engaged — which
// is why "Anything else?" repeated instead of moving toward the name/
// confirm ladder.
//
// FIX: turn-engine.ts's impliesClosure() now normalizes curly apostrophes
// (‘ U+2018, ’ U+2019) to a straight `'` before running BARE_CLOSURE_RE/
// CLOSURE_BLOCKED_BY_RE/CLOSURE_ANYWHERE_RE. Scoped to impliesClosure only
// — see normalizeApostrophes' own header in turn-engine.ts for why this
// dispatch does not also touch answer()'s shared `trimmed` (the same gap
// likely affects TIP_DECLINE_ANYWHERE_RE, CONFIRM_AFFIRMATIVE_RE/
// CONFIRM_NEGATION_RE, UPSELL_DECLINE_IDIOM_RE — flagged, not fixed, here).
//
// REQUIRED METHODOLOGY: the acceptance test below drives the real
// turn-engine-runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly. proposeTurnFn rejects on any call: proving ANSWER resolves this
// deterministically, exactly as the live bug needed and did not get.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { impliesClosure } from "./turn-engine.ts";
import { runTurnEngineTurn, type RunTurnInput, type RunTurnDeps } from "./turn-engine-runner.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Unit level: impliesClosure itself, both apostrophe forms ──────────────

Deno.test("impliesClosure: curly-apostrophe 'that's it' (real iOS autocorrect form) over a non-empty cart reads as closure", () => {
  assert(impliesClosure("No, that’s it for me. Just the Calzone and Crazy Fries for pickup.", true));
});

Deno.test("impliesClosure: straight-apostrophe form (unaffected by the fix) still reads as closure", () => {
  assert(impliesClosure("No, that's it for me. Just the Calzone and Crazy Fries for pickup.", true));
});

Deno.test("impliesClosure: bare curly-apostrophe \"that’s all\" (BARE_CLOSURE_RE tier) reads as closure even over an empty cart", () => {
  assert(impliesClosure("that’s all", false));
});

Deno.test("impliesClosure: curly-apostrophe closure still correctly BLOCKED when a real addition rides along ('also')", () => {
  assertEquals(impliesClosure("No, that’s it, also add a coke", true), false);
});

// ── Runner level: the real live shape, real call path ──────────────────────

const CALZONE_ID = "b0000000-0000-0000-0000-000000000001";
const FRIES_ID = "b0000000-0000-0000-0000-000000000002";

const MENU: TurnEngineMenuItem[] = [
  {
    id: CALZONE_ID, name: "Calzone", category: "Calzones", price_cents: 1095, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Calzone", base_price_cents: 1095, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: FRIES_ID, name: "Crazy Fries", category: "Sides", price_cents: 595, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Crazy Fries", base_price_cents: 595, recap_template: "", ticket_template: "", steps: [] },
  },
];

function makeFakeSupabase() {
  const state: { orderCartsUpdates: Array<Record<string, unknown>> } = { orderCartsUpdates: [] };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) { return Promise.resolve({ data: ([] as unknown[]).slice(from, to + 1), error: null }); },
      in() { return Promise.resolve({ data: [], error: null }); },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
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
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

// Real conv 8aa34668 shape: cart already has a Calzone and Crazy Fries
// (synthetic prices — the real Vito's-shape items/prices were not pulled
// live for this dispatch; item names/categories match the real menu).
// "Anything else?" is already open (askCount 2 — the bot has already asked
// it, live, more than once) when the closure+restatement message arrives.
function realLiveCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CALZONE_ID, name: "Calzone", quantity: 1, price_cents: 1095, modifiers: [], line_key: "line-1" },
    { menu_item_id: FRIES_ID, name: "Crazy Fries", quantity: 1, price_cents: 595, modifiers: [], line_key: "line-2" },
  ];
}

Deno.test("ACCEPTANCE (conv 8aa34668): curly-apostrophe closure+restatement over a real cart moves past 'Anything else?', never re-asks it, PROPOSE never called", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — closure must resolve deterministically via ANSWER, exactly like every other closure test in this suite")),
  };
  const cart = realLiveCart();
  const priorState: DialogueState = { phase: "ordering", open: { kind: "ordering", askCount: 2 }, upsell_offered: false, asked_message_id: null };
  const input: RunTurnInput = {
    conversationId: "conv-8aa34668-repro", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    // Byte-for-byte the live message's closure clause, with the real
    // curly apostrophe an iPhone actually sends (U+2019), not a
    // hand-typed straight one.
    message: "No, that’s it for me. Just the Calzone and Crazy Fries for pickup.",
    history: [], menu: MENU, cart, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!/anything else/i.test(result.reply), `bot must never re-ask 'Anything else?' after a closure+restatement turn, got: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart, cart, "the closing message must never mutate the cart — it only restates what's already there, no new adds");
  assert(result.dialogueState.open?.kind !== "ordering", `the open question must move past 'ordering' once closure is recognized, got: ${JSON.stringify(result.dialogueState.open)}`);
});

Deno.test("ACCEPTANCE variant: the same curly-apostrophe closure+restatement over open===null (no prior 'Anything else?' turn yet) also resolves via ANSWER, never PROPOSE", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  const cart = realLiveCart();
  const input: RunTurnInput = {
    conversationId: "conv-8aa34668-repro-2", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "No, that’s it for me. Just the Calzone and Crazy Fries for pickup.",
    history: [], menu: MENU, cart, dialogueState: null,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!/anything else/i.test(result.reply), `got: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart, cart);
});
