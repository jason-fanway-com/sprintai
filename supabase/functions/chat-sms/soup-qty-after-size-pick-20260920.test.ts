// R2, REOPENED (2026-09-20 PO reopen, live conv 836bf473 #29, still broken
// on main after tonight's earlier attempt): "can I get a Lobster Bisque -
// Cup please?" resolves DIRECTLY to the Cup line (no disambiguation ever
// opens -- M1's size-binding widening, fe917be2, already fixed that part).
// Vito's then asks the next real question, order type ("pickup or
// delivery?") -- so by the time "I asked for the Cup, so 2 please. What's
// going on?" arrives, `state.open.kind` is "order_type", NOT
// "disambiguation". Actual (broken, confirmed against current main):
// resolves to 1x Cup -- the trailing "2" is silently discarded.
//
// ROOT CAUSE (confirmed, not assumed): pending-disambiguation.ts's
// TRAILING_SO_QUANTITY_RE / extractDisambiguationAnswerQuantity ("so N"
// trailing-quantity tier, fixed earlier tonight) is wired into ONLY the
// "disambiguation" case of answer()'s switch (turn-engine.ts) -- see that
// file's own call site (extractDisambiguationAnswerQuantity(trimmed) inside
// case "disambiguation"). It never runs, and was never meant to run, once
// the pick has already resolved and no disambiguation is open -- there is
// no pending-disambiguation state left for it to answer. The earlier
// attempt tonight's own test (soup-size-cup-bowl-20260919.test.ts,
// "R2 acceptance") never actually exercises this gap: its turn-2 PROPOSE
// mock hands back an ALREADY-CORRECT `modifies` op (quantity: 2) directly,
// which just proves decide() can apply a correct modify -- it assumes away
// the exact thing that's broken (whether anything ever produces that
// correct modify in the first place). The real message reaches UNRESOLVED
// in the "order_type" case (readOrderTypeReply and
// closureOrAffirmationFallback both miss it) and falls through to a REAL
// PROPOSE call whose actual output for this shape is exactly the open
// question this dispatch cannot verify without live model access --
// the fix therefore has to be the same kind of deterministic, pre-PROPOSE
// mechanism this file already uses everywhere else for money-critical
// corrections, not a hope that the model gets it right.
//
// FIX: a new "so N" trailing-quantity correction shape --
// QUANTITY_CORRECTION_SO_TRAILING_RE (turn-engine.ts) -- recognizes
// "asked for/wanted/want/ordered <item>, so <N>[, please]" (the mirror of
// the existing item-first "<N> <item>, not <M>" family: here the quantity
// TRAILS the item phrase instead of leading it), feeding the same
// findCartLineByNamePhrase name-match used by the "confirm" case's own
// mechanism 1. That check used to run ONLY in the "confirm" case (built for
// read-back corrections at the very end of the order); this dispatch
// extracts it into applyStandaloneQuantityCorrection() and also calls it
// from "order_type" and "ordering" -- the two open kinds with no
// item-specific resolution machinery of their own, where a stray quantity
// correction has nothing else to catch it before PROPOSE.
//
// METHODOLOGY: drives the real turn-engine-runner.ts runTurnEngineTurn
// across chained turns, same call path index.ts's turn_engine_enabled
// branch uses. Turn 2's proposeTurnFn THROWS if ever called -- this is the
// only honest way to prove the fix is a genuine deterministic intercept
// rather than a mock that already assumes the answer, matching this file's
// sibling (soup-size-cup-bowl-20260919.test.ts)'s own second test's
// convention for the still-open-disambiguation case.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const BISQUE_CUP = "f0000000-0000-0000-0000-000000000001";
const BISQUE_BOWL = "f0000000-0000-0000-0000-000000000002";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

// Same real-Vito's-shaped fixture as soup-size-cup-bowl-20260919.test.ts
// (size_label deliberately null on both -- the real gap for at least one
// real sized family -- so resolution must go via NAME-derived narrowing).
const MENU: TurnEngineMenuItem[] = [
  realItem(BISQUE_CUP, "Lobster Bisque - Cup", "Soup", 495),
  realItem(BISQUE_BOWL, "Lobster Bisque - Bowl", "Soup", 695),
];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "lobster bisque", target_id: BISQUE_CUP, category: "Soup", size_label: null },
  { term: "lobster bisque", target_id: BISQUE_BOWL, category: "Soup", size_label: null },
];

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
    conversationId: "conv-836bf473",
    shopId: "shop-vitos",
    tenantId: "shop-vitos",
    cartId: "cart-836bf473",
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

function proposeAdd(itemSpan: string, quantity: number): () => Promise<ProposeResult> {
  return (): Promise<ProposeResult> =>
    Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity, choices: [] }], removes: [], modifies: [] } });
}

Deno.test("R2 reopened (real conv 836bf473 #29): 'so 2 please' quantity correction lands while order_type -- not disambiguation -- is the open question, and must NEVER reach PROPOSE", async () => {
  const supabase = makeFakeSupabase();
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  // Turn 1: direct resolution to the Cup, no disambiguation.
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "can I get a Lobster Bisque - Cup please?", cart, dialogueState }),
    { supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(), proposeTurnFn: proposeAdd("Lobster Bisque - Cup", 1) },
  );
  assertEquals(t1.cart.length, 1);
  assertEquals(t1.cart[0].menu_item_id, BISQUE_CUP);
  assertEquals(t1.cart[0].quantity, 1);
  assert(t1.dialogueState.open?.kind !== "disambiguation", `must resolve directly: ${JSON.stringify(t1.dialogueState.open)}`);
  // Confirms the premise this whole test depends on: order_type (NOT
  // disambiguation) is what's actually open when turn 2 arrives. If this
  // assertion ever fails because the ladder changes, the test's own
  // reasoning needs re-checking, not just this line patched away.
  assertEquals(t1.dialogueState.open?.kind, "order_type", `test premise requires order_type open, got: ${JSON.stringify(t1.dialogueState.open)}`);
  cart = t1.cart; dialogueState = t1.dialogueState;

  // Turn 2: THE bug. proposeTurnFn throws if ever invoked -- this message
  // must resolve deterministically, entirely inside answer(), or the test
  // fails loudly rather than silently trusting a mock that already knows
  // the right answer.
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "I asked for the Cup, so 2 please. What's going on?", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => {
        throw new Error("must resolve deterministically as a standalone quantity correction, never reach PROPOSE");
      },
    },
  );
  assertEquals(t2.cart.length, 1, `must still be exactly one line: ${JSON.stringify(t2.cart)}`);
  assertEquals(t2.cart[0].menu_item_id, BISQUE_CUP);
  assertEquals(t2.cart[0].quantity, 2, `the trailing 'so 2 please' must update quantity to 2: ${JSON.stringify(t2.cart)}`);
  assertEquals(
    t2.cart[0].price_cents * t2.cart[0].quantity,
    495 * 2,
    "total for the Cup line must reflect 2x, not 1x",
  );
});
