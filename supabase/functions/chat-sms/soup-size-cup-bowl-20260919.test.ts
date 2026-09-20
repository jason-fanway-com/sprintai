// R2 (2026-09-19 PO dispatch, live conv 836bf473 #29): soup Cup/Bowl sizes
// were never recognized by M1's size-binding mechanism, causing three
// compounding symptoms across one conversation:
//   1. "can I get a Lobster Bisque - Cup please?" opened a "which one —
//      Bowl or Cup?" disambiguation even though the customer's own words
//      state the size right next to the item's name — M1 (already handles
//      "Sausage Pizza - Small" this same way for pizzas) never applied
//      because "Cup"/"Bowl" weren't in NARROWING_SIZE_WORD_RE
//      (pending-disambiguation.ts).
//   2. "I asked for the Cup, so 2 please" resolved to 1x Cup, silently
//      discarding the stated quantity of 2.
//   3. "Just the Lobster Bisque - Cup for pickup" (a closure + restatement
//      of the already-resolved pick) was feared to reopen the disambiguation
//      list instead of closing.
//
// ROOT CAUSE (confirmed, corrects the PO's own framing on #2): widening
// NARROWING_SIZE_WORD_RE to include "Cup"/"Bowl" makes M1's existing
// fresh-tie-closing mechanism (narrowAmbiguousCandidatesBySpanSize,
// turn-engine.ts — the same one that already closes "Sausage Pizza - Small"
// outright) apply to soups too: "Lobster Bisque - Cup" now resolves
// DIRECTLY on the first mention, so no disambiguation ever opens, and
// symptoms #2 and #3 (which both presuppose an open disambiguation) never
// occur in this exact sequence — confirmed below, PROPOSE never even sees a
// tie. The PO's own framing for #2 ("it did not apply here because 'Cup'
// matched by size, not by row name") does not match the code:
// extractDisambiguationAnswerQuantity does not branch on how the pick
// resolved at all. The REAL, separate gap (still live for any disambiguation
// that genuinely stays open — see the second test below, where no size is
// stated on the first mention) is that extractDisambiguationAnswerQuantity
// only ever scans the first 6 words for a stated quantity, and even inside
// that window a number followed by nothing but filler ("2 please") is read
// as a bare INDEX pick, not a quantity — correct for a truly bare answer,
// wrong once the item was already named earlier in the very same sentence
// ("I asked for the Cup, so 2 please" trails "so 2" at the very END).
// Fixed with a narrow, separately-scoped "so N" trailing-quantity tier.
//
// METHODOLOGY: every test below drives the real turn-engine-runner.ts
// runTurnEngineTurn across MULTIPLE chained turns (cart/dialogueState from
// each result feeds the next), the same call path index.ts's
// turn_engine_enabled branch uses. Menu/lexicon shapes are a representative
// reconstruction (no live DB access for this task); PROPOSE mocks per turn
// are chosen to match what a competently-prompted model would realistically
// output given the FULL context available to it at that point (e.g. once
// M1 auto-resolves turn 1, the dialogue is asking "pickup or delivery?", not
// re-opening a soup question — so turn 2's "so 2 please" is a quantity
// correction on an existing line, not a disambiguation answer; this is
// documented explicitly at each mock).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
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

// size_label deliberately null on both, same shape the M1 test fixture uses
// for Sausage Pizza (topping-cross-contamination-and-size-binding-20260919.
// test.ts) — real Vito's data has this gap for at least one real sized
// family, so the fix must work via NAME-derived narrowing
// (extractSizeAndKind/candidateSizeValue), not the lexicon size_label path.
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

function proposeAdd(itemSpan: string, quantity: number): () => Promise<ProposeResult> {
  return (): Promise<ProposeResult> =>
    Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity, choices: [] }], removes: [], modifies: [] } });
}

Deno.test("R2 acceptance (real conv 836bf473 #29): full 3-message sequence ends at 2x Lobster Bisque - Cup, pickup, no open disambiguation", async () => {
  const supabase = makeFakeSupabase();
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  // Turn 1: "Lobster Bisque - Cup" stated with the item's own name — M1
  // (widened to recognize "Cup" as a size word) must close this tie
  // directly, exactly like "Sausage Pizza - Small" already does for pizzas.
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "can I get a Lobster Bisque - Cup please?", cart, dialogueState }),
    { supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(), proposeTurnFn: proposeAdd("Lobster Bisque - Cup", 1) },
  );
  assertEquals(t1.cart.length, 1);
  assertEquals(t1.cart[0].menu_item_id, BISQUE_CUP, `must resolve directly to Cup, no disambiguation: ${JSON.stringify(t1.dialogueState.open)}`);
  assertEquals(t1.cart[0].quantity, 1);
  assert(t1.dialogueState.open?.kind !== "disambiguation", `M1 must close the tie outright: ${JSON.stringify(t1.dialogueState.open)}`);
  cart = t1.cart; dialogueState = t1.dialogueState;

  // Turn 2: with no disambiguation open (order_type is the open question),
  // "I asked for the Cup, so 2 please" is an ordinary quantity correction on
  // the existing Lobster Bisque - Cup line — the real PROPOSE call, given
  // the full cart in context, would read this as a `modifies` op, not a
  // fresh `add`.
  const lineKey: string = cart[0].line_key ?? "line-1";
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "I asked for the Cup, so 2 please", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> =>
        Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [{ line_key: lineKey, quantity: 2 }] } }),
    },
  );
  assertEquals(t2.cart.length, 1, `must still be exactly one line: ${JSON.stringify(t2.cart)}`);
  assertEquals(t2.cart[0].quantity, 2, `quantity must update to 2: ${JSON.stringify(t2.cart)}`);
  cart = t2.cart; dialogueState = t2.dialogueState;

  // Turn 3: a closure ("for pickup") combined with a restatement of the
  // already-resolved pick. Must never reopen a disambiguation or duplicate
  // the line; must set order type to pickup.
  let proposeCalledOnTurn3 = false;
  const t3 = await runTurnEngineTurn(
    baseInput({ message: "Just the Lobster Bisque - Cup for pickup", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: () => { proposeCalledOnTurn3 = true; return proposeAdd("Lobster Bisque - Cup", 1)(); },
    },
  );
  assertEquals(t3.cart.length, 1, `must never duplicate or reopen a second Cup line: ${JSON.stringify(t3.cart)}`);
  assertEquals(t3.cart[0].quantity, 2, `quantity must stay at 2: ${JSON.stringify(t3.cart)}`);
  assert(t3.dialogueState.open?.kind !== "disambiguation", `must never reopen a disambiguation: ${JSON.stringify(t3.dialogueState.open)}`);
  assert(!proposeCalledOnTurn3, "order_type resolution for 'for pickup' is deterministic and must never need a PROPOSE call");
});

Deno.test("R2, quantity-extraction gap in isolation (genuinely still-open disambiguation): no size stated on the first mention, so Cup/Bowl legitimately ties and asks — the trailing 'so 2 please' answer must still be read as quantity 2, not silently dropped to 1", async () => {
  const supabase = makeFakeSupabase();
  const t1 = await runTurnEngineTurn(
    baseInput({ message: "can I get a Lobster Bisque please?", cart: [], dialogueState: null }),
    { supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(), proposeTurnFn: proposeAdd("Lobster Bisque", 1) },
  );
  assertEquals(t1.dialogueState.open?.kind, "disambiguation", "no size stated at all — a genuine tie must still ask");

  const t2 = await runTurnEngineTurn(
    baseInput({ message: "I asked for the Cup, so 2 please", cart: t1.cart, dialogueState: t1.dialogueState }),
    { supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(), proposeTurnFn: () => { throw new Error("must resolve deterministically via the open disambiguation, never call PROPOSE"); } },
  );
  assertEquals(t2.cart.length, 1);
  assertEquals(t2.cart[0].menu_item_id, BISQUE_CUP, `must resolve to Cup via the name-match tier: ${JSON.stringify(t2.cart)}`);
  assertEquals(t2.cart[0].quantity, 2, `the trailing 'so 2 please' must be read as quantity 2, not silently dropped to 1: ${JSON.stringify(t2.cart)}`);
});
