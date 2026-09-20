// R3 (2026-09-19 PO dispatch, live conv a156dc34 #47): a Coke added to the
// cart on an EARLIER turn, as a real order line (never as an upsell
// accept), was still offered right back to the customer on a LATER turn —
// "Want to add a Coke for $2.99?" — once Fries qualified for its own
// configured upsell. Root cause: turn-engine.ts's `ask()` upsell branch
// (priority 6) resolved the added item's `upsell` field to a target menu
// item and offered it unconditionally, with no check against what's
// already sitting in the cart.
//
// FIX: upsell-offer-20260914.ts's firstParseableUpsellName (which only ever
// returns the FIRST "Name +Price" entry) is now allParseableUpsellNames —
// every parseable candidate, in the field's own listed order. ask()'s
// upsell branch tries each in turn and skips any whose resolved
// menu_item_id already has a REAL line in the cart (isRealCartLine — a
// removed/zero-quantity line must not count as "already ordered" and block
// a legitimate offer). Nothing left to offer means no upsell fires this
// turn at all — never a wrong offer, never a crash trying to render one.
//
// REQUIRED METHODOLOGY: every test below drives the real
// turn-engine-runner.ts runTurnEngineTurn (the same call path index.ts's
// turn_engine_enabled branch uses), never decide()/ask() called directly.
// Menu/lexicon shapes are a representative reconstruction (no live DB
// access for this task) of a shop with a drink upsell configured on Fries;
// the customer's own message text mirrors the PO's dispatch shape ("Coke
// added turn 1 as a real line, Fries added later, no drink flagged").

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const COKE = "10000000-0000-0000-0000-000000000001";
const FRIES_SINGLE_UPSELL = "10000000-0000-0000-0000-000000000002";
const FRIES_MULTI_UPSELL = "10000000-0000-0000-0000-000000000003";
const BROWNIE = "10000000-0000-0000-0000-000000000004";

function realItem(
  id: string, name: string, category: string, priceCents: number, upsell?: string,
): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable", upsell,
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

// Fries A: single-candidate upsell field (Coke only) — the exact shape the
// live repro carries. Fries B: multi-candidate field (Coke then Brownie) —
// isolates the "alternate still fires" half of the acceptance criteria on
// its own item, so it can never collide with Fries A's own dialogue state
// in the same test.
const MENU: TurnEngineMenuItem[] = [
  realItem(COKE, "Coke", "Drinks", 299),
  realItem(FRIES_SINGLE_UPSELL, "Fries", "Sides", 399, "Coke +2.99"),
  realItem(FRIES_MULTI_UPSELL, "Loaded Fries", "Sides", 399, "Coke +2.99; Brownie +3.50"),
  realItem(BROWNIE, "Brownie", "Desserts", 350),
];

const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "coke", target_id: COKE, category: "Drinks", size_label: null },
  { term: "fries", target_id: FRIES_SINGLE_UPSELL, category: "Sides", size_label: null },
  { term: "loaded fries", target_id: FRIES_MULTI_UPSELL, category: "Sides", size_label: null },
  { term: "brownie", target_id: BROWNIE, category: "Desserts", size_label: null },
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
      // Pre-resolved to "pickup" so the order_type question (a higher
      // ask() priority than upsell) never masks whether the upsell branch
      // itself fired correctly — this file is testing priority 6 in
      // isolation, not the ladder above it.
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function freshOrderingState(): DialogueState {
  return { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };
}

function proposeAdd(itemSpan: string, quantity: number): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> =>
    Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity, choices: [] }], removes: [], modifies: [] } });
}

Deno.test("R3 (real conv a156dc34): a Coke already in the cart as a real order line is never re-offered as an upsell after Fries is added — genuinely nothing left to upsell", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: COKE, name: "Coke", quantity: 1, price_cents: 299, modifiers: [], line_key: `${COKE}::` },
  ];
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Fries", 1),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "can I also get some fries", cart: cartBefore, dialogueState: freshOrderingState() }),
    deps,
  );

  assertEquals(result.cart.length, 2, `Coke line must survive unchanged, Fries added: ${JSON.stringify(result.cart)}`);
  assert(
    !/want to add/i.test(result.reply),
    `must never offer an upsell at all when the only configured candidate (Coke) is already in the cart: ${JSON.stringify(result.reply)}`,
  );
  assert(
    result.dialogueState.open?.kind !== "upsell",
    `no upsell question should be left open: ${JSON.stringify(result.dialogueState.open)}`,
  );
});

Deno.test("R3 regression baseline: Coke NOT already in the cart — Fries still offers the Coke upsell exactly as before this fix", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Fries", 1),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get some fries", cart: [], dialogueState: freshOrderingState() }),
    deps,
  );

  assert(/want to add coke for \$2\.99/i.test(result.reply), `Coke upsell must still fire when Coke isn't already in the cart: ${JSON.stringify(result.reply)}`);
  assertEquals(result.dialogueState.open, { kind: "upsell", menu_item_id: COKE });
});

Deno.test("R3 alternate-candidate acceptance: Coke already in the cart, but Fries' upsell field also lists a Brownie — the Brownie upsell still fires instead of silently suppressing everything", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: COKE, name: "Coke", quantity: 1, price_cents: 299, modifiers: [], line_key: `${COKE}::` },
  ];
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Fries", 1),
  };
  const result = await runTurnEngineTurn(
    baseInput({
      message: "can I also get some loaded fries",
      cart: cartBefore,
      dialogueState: freshOrderingState(),
      menu: MENU.filter(m => m.id !== FRIES_SINGLE_UPSELL), // only the multi-candidate Loaded Fries variant is orderable here
    }),
    { ...deps, proposeTurnFn: proposeAdd("Loaded Fries", 1) },
  );

  assert(
    /want to add brownie for \$3\.50/i.test(result.reply),
    `the Brownie upsell (the next real candidate after Coke) must fire instead: ${JSON.stringify(result.reply)}`,
  );
  assertEquals(result.dialogueState.open, { kind: "upsell", menu_item_id: BROWNIE });
  assert(!/want to add coke/i.test(result.reply), "Coke, already in the cart, must never be the one offered");
});
