// PO dispatch (2026-09-19), GAP (b): "just a"/"regular"/"plain" don't
// resolve to the family's default row (real conv 040f91dd, #47).
//
// "can I get a Coke with that?" -> "Sure — what kind?" (multiple Coke
// sizes tied). The customer replies "Just a regular Coke" -- FOUR TIMES --
// and gets the identical question every time. Root cause, confirmed via
// resolveItem: "regular coke" resolves AMBIGUOUSLY across Coke AND three
// unrelated Cheese pizzas -- "regular" itself is a real, bare, single-word
// lexicon term (a Regular-labeled Cheese Pizza row on at least one real
// shop) that ties against "coke" and pulls in an entirely unrelated family.
// Separately, NARROWING_SIZE_WORD_RE (pending-disambiguation.ts) already
// treats "Regular" as a legitimate SIZE token — so even scoped to just the
// open Coke candidates, "regular" was read as the WANTED size, found zero
// hits (no Coke candidate is actually sized "Regular"), and returned a flat
// null with no escalation cap on this particular branch (render()'s plain
// facet-question path had none, unlike the fullList/noProgress branches).
//
// FIX (pending-disambiguation.ts): "regular"/"just" are stripped before
// either facet tier (kind or size) ever sees the message — never a real
// item-search word, never a real facet word. When that stripping is what
// leaves the message with nothing left to narrow by, this resolves to the
// family's own default row instead of asking again: a candidate among the
// CURRENTLY OPEN ones whose own kind/size is literally "Regular" if one
// exists, else the cheapest of the open candidates (see
// resolveDefaultCandidate's own header in pending-disambiguation.ts — this
// codebase has no item-level "is_default" concept to defer to instead,
// flagged there rather than invented).
//
// "plain" is deliberately NOT included in the filler-word list: this
// codebase already treats "plain" as an intentional lexicon ALIAS for
// Cheese Pizza (turn-engine.test.ts's own "round 2 addendum" coverage) —
// stripping it broke that real, tested behavior. See resolve-item.ts's own
// NON_SEARCH_FILLER_WORDS header and pending-disambiguation.ts's own
// NON_SEARCH_FILLER_WORD_RE header for the full reasoning.
//
// METHODOLOGY: drives the real production call path, turn-engine-runner.ts's
// runTurnEngineTurn — never decide()/answer() called directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineMenuItem } from "./turn-engine.ts";

const SMALL_COKE = "d1111111-1111-1111-1111-111111111111";
const MEDIUM_COKE = "d2222222-2222-2222-2222-222222222222";
const LARGE_COKE = "d3333333-3333-3333-3333-333333333333";

const SMALL_SODA = "e1111111-1111-1111-1111-111111111111";
const REGULAR_SODA = "e2222222-2222-2222-2222-222222222222";
const LARGE_SODA = "e3333333-3333-3333-3333-333333333333";

function drinkItem(id: string, name: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category: "Drinks", price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const COKE_MENU: TurnEngineMenuItem[] = [
  drinkItem(SMALL_COKE, "Coke - Small", 199),
  drinkItem(MEDIUM_COKE, "Coke - Medium", 249),
  drinkItem(LARGE_COKE, "Coke - Large", 299),
];

const SODA_MENU: TurnEngineMenuItem[] = [
  drinkItem(SMALL_SODA, "Soda - Small", 199),
  drinkItem(REGULAR_SODA, "Soda - Regular", 249),
  drinkItem(LARGE_SODA, "Soda - Large", 299),
];

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder() {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
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
  return { from: () => builder() } as any;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-040f91dd",
    shopId: "shop-repro-3",
    tenantId: "shop-repro-3",
    cartId: "cart-repro-3",
    message: "",
    history: [],
    menu: COKE_MENU,
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

Deno.test("GAP (b) runner-level (real conv 040f91dd #47): 'Just a regular Coke' resolves the Coke size narrowing on the FIRST reply, never a repeated identical question", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [SMALL_COKE, MEDIUM_COKE, LARGE_COKE], quantity: 1, facetNarrowed: true },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("GAP (b)"),
  };

  const result = await runTurnEngineTurn(
    baseInput({
      message: "Just a regular Coke",
      cart: [],
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  assert(
    result.dialogueState.open?.kind !== "disambiguation",
    `the Coke size question must resolve on the first reply, not stay open: ${JSON.stringify(result.dialogueState.open)}`,
  );
  assertEquals(result.cart.length, 1, `exactly one Coke line must be added: ${JSON.stringify(result.cart)}`);
  // No candidate here is literally sized "Regular" — resolveDefaultCandidate
  // falls back to the cheapest of the currently open candidates (Small).
  assertEquals(result.cart[0].menu_item_id, SMALL_COKE, `with no "Regular" Coke on offer, the cheapest/plainest candidate must be chosen: ${JSON.stringify(result.cart)}`);
});

Deno.test("GAP (b) runner-level: 'just a regular soda' resolves to the family's OWN Regular-labeled row when one is actually on offer (never merely the cheapest by coincidence)", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [SMALL_SODA, REGULAR_SODA, LARGE_SODA], quantity: 1, facetNarrowed: true },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("GAP (b), soda"),
  };

  const result = await runTurnEngineTurn(
    baseInput({
      message: "just a regular soda",
      menu: SODA_MENU,
      cart: [],
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  assertEquals(result.cart.length, 1, `exactly one Soda line must be added: ${JSON.stringify(result.cart)}`);
  assertEquals(
    result.cart[0].menu_item_id,
    REGULAR_SODA,
    `the family's own Regular-labeled row must win over the merely-cheapest Small: ${JSON.stringify(result.cart)}`,
  );
});

Deno.test("GAP (b) no-regression: a plain size word ('large coke', no filler) still resolves normally via the ordinary size facet, untouched by the filler-word stripping", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [SMALL_COKE, MEDIUM_COKE, LARGE_COKE], quantity: 1, facetNarrowed: true },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("GAP (b), no-regression"),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "large coke please", cart: [], dialogueState: dialogueStateBefore }),
    deps,
  );

  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, LARGE_COKE, `a real, unambiguous size word must still resolve exactly as before: ${JSON.stringify(result.cart)}`);
});
