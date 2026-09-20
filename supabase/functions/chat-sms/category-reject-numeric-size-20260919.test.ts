// PO dispatch (2026-09-19), MONEY BUG N3, deterministic repro (probe-narrow2,
// "the slice" quantity 1, "No stromboli, I only want the 14\" The Slice pizza
// for pickup!"): "The Slice" is sold ONLY as a stromboli at this shop (no
// pizza version exists) in two sizes, 14" and 16" — a real, common customer
// mistake ("pizza" for a stromboli) that must always get a clarifying
// confirmation, never a silent add, AND must respect the customer's own
// stated size.
//
// Root cause, traced against the real functions (turn-engine.ts's
// findDisambiguationCategoryRejectionCandidate / decide()'s fresh-tie
// narrowing, both built on pending-disambiguation.ts's extractSizeAndKind /
// narrowCandidatesByFacetAnswer / extractGlobalSizeWord): every one of those
// derives a candidate's own "size" and a customer's stated size ONLY via
// NARROWING_SIZE_WORD_RE, which matches named sizes (Small/Medium/Large/...)
// and NEVER a bare inch measurement like `14"`. For an item family sized
// PURELY by inches ("The Slice - 14\"", "The Slice - 16\""), every one of
// those helpers returns size=null for every candidate — so the moment two
// same-item, different-inch-size candidates tie, nothing can narrow them by
// the customer's own stated size, and findDisambiguationCategoryRejection
// Candidate's own size-narrow-or-fall-back-to-candidates[0] logic silently
// defaults to whatever order the candidates happen to arrive in — provably
// NOT the customer's stated size (verified directly: swapping the candidate
// array order alone flips which size gets added, with the exact same
// customer message).
//
// Fix (pending-disambiguation.ts): extractSizeAndKind, narrowCandidatesBy
// FacetAnswer, and extractGlobalSizeWord all gained a numeric-inch fallback
// (14"/16"/14 inch/etc, only tried when no named size word is present), so a
// numeric-only size family narrows exactly the same way a named-size one
// already did — both at the disambiguation-answer stage (this file's first
// test) and at the fresh single-message tie stage (second test), where it
// now correctly asks for confirmation with the RIGHT size instead of
// defaulting silently.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch uses — never decide()/answer() called directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const SLICE_14 = "11111111-1111-1111-1111-111111111111";
const SLICE_16 = "22222222-2222-2222-2222-222222222222";
const PEPPERONI_14 = "33333333-3333-3333-3333-333333333333";
const PEPPERONI_16 = "44444444-4444-4444-4444-444444444444";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

// The Slice is sold ONLY as a stromboli, in two inch-only sizes — no named
// size word (Small/Medium/Large) anywhere in either candidate's name. Real
// Pizza-category items are also on the menu (as they are at any real shop)
// so "pizza" is a genuine, distinct menu category the category-rejection
// check can recognize as outside the Stromboli candidates' own category —
// without a real Pizza category present, messageNamesCategoryOutsideStemSet
// has nothing to detect at all, masking this fix entirely.
const MENU: TurnEngineMenuItem[] = [
  realItem(SLICE_14, "The Slice - 14\"", "Stromboli", 1895),
  realItem(SLICE_16, "The Slice - 16\"", "Stromboli", 2295),
  realItem(PEPPERONI_14, "Pepperoni Pizza - 14\"", "Pizza", 1945),
  realItem(PEPPERONI_16, "Pepperoni Pizza - 16\"", "Pizza", 2100),
];

// size_label deliberately null on the Slice rows — mirrors the real-world
// lexicon gap this fix is scoped to (an item family whose sizes are only
// ever distinguishable via the bare inch numeral in the name itself, never a
// separately-populated lexicon size_label column).
const LEXICON = [
  { term: "the slice", target_id: SLICE_14, category: "Stromboli", size_label: null },
  { term: "the slice", target_id: SLICE_16, category: "Stromboli", size_label: null },
  { term: "slice", target_id: SLICE_14, category: "Stromboli", size_label: null },
  { term: "slice", target_id: SLICE_16, category: "Stromboli", size_label: null },
  { term: "pepperoni pizza", target_id: PEPPERONI_14, category: "Pizza", size_label: "14\"" },
  { term: "pepperoni pizza", target_id: PEPPERONI_16, category: "Pizza", size_label: "16\"" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-n3-probe-narrow2",
    shopId: "shop-1",
    tenantId: "shop-1",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
  };
}

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
  const supabase = { from: (table: string) => builder(table) } as any;
  return supabase;
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

const MESSAGE = "No stromboli, I only want the 14\" The Slice pizza for pickup!";

Deno.test("N3 runner-level (probe-narrow2, disambiguation-answer stage): stated size 14\" wins regardless of candidate array order, never silently defaults to 16\"", async () => {
  for (const candidateOrder of [[SLICE_14, SLICE_16], [SLICE_16, SLICE_14]]) {
    const supabase = makeFakeSupabase();
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [], removes: [], modifies: [] },
      }),
    };
    const result = await runTurnEngineTurn(
      baseInput({
        message: MESSAGE,
        dialogueState: {
          phase: "ordering",
          open: { kind: "disambiguation", candidates: candidateOrder, quantity: 1, spanText: "the slice" },
          upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
        },
      }),
      deps,
    );
    assertEquals(result.cart.length, 1, `candidate order ${JSON.stringify(candidateOrder)}: exactly one line: ${JSON.stringify(result.cart)}`);
    assertEquals(
      result.cart[0].menu_item_id, SLICE_14,
      `candidate order ${JSON.stringify(candidateOrder)}: the customer said 14", the 16" must never be picked instead: ${JSON.stringify(result.cart)}`,
    );
    assert(/14"/.test(result.reply), `reply must reference the correct 14" size: ${JSON.stringify(result.reply)}`);
    assert(/stromboli/i.test(result.reply), `reply must surface the category correction, never a bare silent add: ${JSON.stringify(result.reply)}`);
  }
});

Deno.test("N3 runner-level (probe-narrow2, fresh single-message tie): a fresh ambiguous add narrows to the stated 14\" size and asks for confirmation instead of silently adding either size", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "the 14\" The Slice pizza", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const result = await runTurnEngineTurn(baseInput({ message: MESSAGE }), deps);
  assertEquals(result.cart.length, 0, `must never silently add before confirmation: ${JSON.stringify(result.cart)}`);
  assertEquals(result.dialogueState.open?.kind, "category_confirm", `must hold for a category-mismatch confirmation: ${JSON.stringify(result.dialogueState)}`);
  if (result.dialogueState.open?.kind === "category_confirm") {
    assertEquals(result.dialogueState.open.menu_item_id, SLICE_14, "the held item must be the stated 14\" size, never 16\"");
  }
  assert(/14"/.test(result.reply), `reply must reference the correct 14" size: ${JSON.stringify(result.reply)}`);
  assert(/stromboli/i.test(result.reply), `reply must explain it's a stromboli, not a pizza: ${JSON.stringify(result.reply)}`);
});

Deno.test("N3 regression (unaffected): named-size families (Small/Medium/Large) still narrow exactly as before", async () => {
  const SMALL = "33333333-3333-3333-3333-333333333333";
  const LARGE = "44444444-4444-4444-4444-444444444444";
  const namedMenu: TurnEngineMenuItem[] = [
    realItem(SMALL, "Meat Lover Pizza - Small", "Pizza", 1200),
    realItem(LARGE, "Meat Lover Pizza - Large", "Pizza", 1800),
  ];
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } }),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "I'll take the large one",
      menu: namedMenu,
      dialogueState: {
        phase: "ordering",
        open: { kind: "disambiguation", candidates: [SMALL, LARGE], quantity: 1, spanText: "meat lover pizza" },
        upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
      },
    }),
    deps,
  );
  assert(result.cart.some(l => l.menu_item_id === LARGE), `Large must still resolve correctly by name: ${JSON.stringify(result.cart)}`);
});

