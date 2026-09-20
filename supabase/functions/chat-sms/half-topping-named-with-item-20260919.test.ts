// R4 (2026-09-19 PO dispatch, live conv 3ea2d604 #14): "a medium Chicken
// Bacon Ranch pizza with half anchovies on it" was reported landing
// completely plain — no Anchovies topping, no half-placement notation, and
// no acknowledgment that the add-on was ever dropped.
//
// INVESTIGATION (methodology: reproduce against the real runTurnEngineTurn
// call path before writing anything, per tonight's standing rule that a fix
// verified only against decide()/answer() fixtures passed offline and was
// still completely broken live):
//
// The PO's own framing called this a W2-class gap ("add-ons named with the
// item are dropped in silence... your W2 merge did not cover
// half-toppings"). W2 (fix/addons-named-with-item-not-dropped-20260919,
// EXPLICIT_MULTI_ADDON_RE in turn-engine.ts) is a real, separate mechanism —
// but it only ever governs PLAIN (non-placement) choices named together
// ("Black Diamond Steak and Chicken added"), the tie-guard on
// recoverPlainHits. Half-placement toppings never go through that guard at
// all: groupChoicesByPlacement/recoverPlacementHits (turn-engine.ts, built
// earlier the same night for the "pepperoni warts" dispatch — item 6 part C
// and the b65c5bea half-pepperoni fix, both already on this branch's base
// commit) is a SEPARATE, ORDER-INDEPENDENT, TOKEN-SUBSET mechanism: it does
// not require "half"/the topping name to sit adjacent to a trigger word
// like "with"/"and" at all — it groups a topping's Whole/Half choice pair by
// their shared core name and picks Half whenever the literal word "half"
// appears ANYWHERE in the scoped text, Whole otherwise. Every phrasing this
// dispatch names — "half anchovies", "anchovies on half", "half of it with
// anchovies" — already recovers the Half choice correctly through this
// existing mechanism; verified directly (recoverAssertedChoicesFromText,
// all five phrasings) and end-to-end via runTurnEngineTurn (below) with
// THREE independently plausible shapes of what the model's real PROPOSE
// call could produce for this message: (1) the topping folded inside the
// add's own item_span, (2) the topping mentioned only in customerMessage
// with item_span excluding it (the ordinary "model asserted nothing"
// shape), and (3) the model splitting the topping into its OWN separate
// `adds[]` entry (caught by decide()'s isModifierOfAnyCandidate/
// heldModifierText holding mechanism). All three land correctly.
//
// CORRECTED FRAMING: this exact defect does not reproduce against this
// branch's base commit (6ca800a9) with a representative Vito's-shape
// fixture — no code change was made for R4. The half-placement recovery
// mechanism the PO's own dispatch pointed to already generalizes to cover
// it; it was built independently of (and before) W2's own plain-choice
// fix, so "W2 didn't cover half-toppings" is true only in the narrow sense
// that W2 itself was never the mechanism responsible for half-toppings in
// the first place. This test locks the current, correct behavior in as a
// regression guard using the literal customer phrasing from the dispatch,
// against a fixture built the same way this branch's other repro fixtures
// are (representative reconstruction — no live DB access for this task).
// FLAG: if the real Vito's-compiled choice-display convention for
// half/whole placement differs from the "Name (Whole pizza)"/"Name (Half
// pizza)" shape this fixture (and every other half-topping test on this
// branch) uses, PLACEMENT_SUFFIX_RE would not recognize the pair at all and
// this specific mechanism would not apply — that data-shape question is out
// of reach without a live query, exactly as tonight's earlier "wart c" work
// flagged for its own menu-data assumptions.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const CBR_MEDIUM = "e0000000-0000-0000-0000-000000000001";
const TOPPING_GROUP = "grp-toppings";

const CBR: TurnEngineMenuItem = {
  id: CBR_MEDIUM, name: "Chicken Bacon Ranch - Medium (14\")", category: "Pizza", price_cents: 1699, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Chicken Bacon Ranch - Medium (14\")", base_price_cents: 1699,
    recap_template: "", ticket_template: "",
    steps: [{
      group_id: TOPPING_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "toppings.ask",
      choices: [
        { id: "t-anchovies-whole", display: "Anchovies (Whole pizza)", price_delta_cents: 200 },
        { id: "t-anchovies-half", display: "Anchovies (Half pizza)", price_delta_cents: 100 },
      ],
    }],
  },
  option_groups: [{ id: TOPPING_GROUP, name: "Toppings" }],
};

const MENU: TurnEngineMenuItem[] = [CBR];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "chicken bacon ranch", target_id: CBR_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "chicken bacon ranch pizza", target_id: CBR_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "medium chicken bacon ranch", target_id: CBR_MEDIUM, category: "Pizza", size_label: "Medium" },
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
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

const MESSAGE = "Can I get a medium Chicken Bacon Ranch pizza with half anchovies on it";

Deno.test("R4 runner-level (real conv 3ea2d604): 'medium Chicken Bacon Ranch pizza with half anchovies on it' lands the Half Anchovies topping, never a plain pizza — shape 1, topping folded into the add's own item_span", async () => {
  const supabase = makeFakeSupabase();
  const result = await runTurnEngineTurn(
    baseInput({ message: MESSAGE }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> =>
        Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [
          { item_span: "medium Chicken Bacon Ranch pizza with half anchovies on it", quantity: 1, choices: [] },
        ], removes: [], modifies: [] } }),
    },
  );
  assertEquals(result.cart.length, 1, `exactly one pizza line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.[TOPPING_GROUP], "t-anchovies-half",
    `must carry the Half Anchovies choice, never plain: ${JSON.stringify(result.cart)}`);
  assert(!/couldn'?t add|isn'?t a real option/i.test(result.reply), `no silent-drop decline expected: ${result.reply}`);
});

Deno.test("R4 runner-level, shape 2: topping named only in customerMessage, item_span excludes it (the ordinary 'model asserted nothing' shape)", async () => {
  const supabase = makeFakeSupabase();
  const result = await runTurnEngineTurn(
    baseInput({ message: MESSAGE }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> =>
        Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [
          { item_span: "medium Chicken Bacon Ranch pizza", quantity: 1, choices: [] },
        ], removes: [], modifies: [] } }),
    },
  );
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].ask_plan_selections?.[TOPPING_GROUP], "t-anchovies-half",
    `must still recover Half Anchovies from the scoped customer message: ${JSON.stringify(result.cart)}`);
});

Deno.test("R4 runner-level, shape 3: the model splits the topping into its own separate adds[] entry — still lands as a modifier, never a phantom second line or a silent drop", async () => {
  const supabase = makeFakeSupabase();
  const result = await runTurnEngineTurn(
    baseInput({ message: MESSAGE }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> =>
        Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [
          { item_span: "medium Chicken Bacon Ranch pizza", quantity: 1, choices: [] },
          { item_span: "half anchovies", quantity: 1, choices: [] },
        ], removes: [], modifies: [] } }),
    },
  );
  assertEquals(result.cart.length, 1, `must never become a second phantom line for "anchovies": ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].ask_plan_selections?.[TOPPING_GROUP], "t-anchovies-half",
    `the split-off topping add must still merge back as a modifier: ${JSON.stringify(result.cart)}`);
});
