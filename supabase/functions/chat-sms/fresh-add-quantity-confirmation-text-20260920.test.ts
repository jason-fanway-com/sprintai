// PO dispatch 2026-09-20 (real live conv 93559ccf): "I need a small Green
// Peppers Pizza, a Fish and Chips, and two Chicken Noodle cups" -> the pizza
// and fish landed, the soup opened a Bowl/Cup which-one question instead
// (genuine ambiguity -- "cups" isn't itself a resolvable size word here).
// The customer then restated "I want two Chicken Noodle cups... So that's 2
// of the Chicken Noodle - Cup, $4.99 each" and the bot replied "Cup Chicken
// Noodle Soup added." with no "2x" anywhere.
//
// ROOT CAUSE (confirmed against real DB data, not assumed): the CART was
// never wrong. error_log's own propose_success row for conv 93559ccf's
// first turn shows PROPOSE already reported quantity: 2 for item_span
// "Chicken Noodle cups", and turn-engine.ts's existing effectiveAddQuantity
// (spanLeadingCount fallback) / disambiguationQuantity (decide()'s
// ambiguousSpansFiltered[0].quantity, carried onto DialogueState.open.
// quantity) already persist that 2 across the disambiguation and land it on
// the cart line correctly -- reproduced below with a BARE one-word answer
// ("Cup") that restates nothing, proving the carry-through alone is enough
// and no restatement was ever required for the CART to be right.
//
// The bug was entirely in what the customer was TOLD:
// action-confirmation.ts's renderActionConfirmation, "added" case (no
// options on the line, so it never went through the itemized branch) built
// its sentence from event.itemName alone, ignoring event.qty completely --
// "Cup Chicken Noodle Soup added." whether 1 or 10 landed. See that file's
// own fix for the one-line change (a "Nx " prefix, the same convention
// qty_set and index.ts's own qtyPrefixC2b already use).
//
// This file proves the FULL real transcript, turn engine start to render(),
// produces the correct cart AND the correct customer-facing sentence in one
// turn, with no restatement — the PO's own stated fixture.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runTurnEngineTurn, type RunTurnInput } from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const SOUP_CUP = "721d8cd0-5d93-49cf-9a00-94dfd4ad6bc9";
const SOUP_BOWL = "3139ab05-94f3-41da-858b-efcc044ee859";
const GP_SMALL = "4acbfa1a-f5ce-4504-9646-b58bbea0d70c";
const FISH_CHIPS = "a5a8103e-d335-47b6-869f-713b9e3e7fb7";

// Real Vito's menu rows (id, name, price_cents, size_label) — pulled live
// from menu_items for this exact conversation's cart, 2026-09-20.
function realItem(id: string, name: string, category: string, priceCents: number, sizeLabel: string | null): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    size_label: sizeLabel,
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  } as unknown as TurnEngineMenuItem;
}

const MENU: TurnEngineMenuItem[] = [
  realItem(SOUP_CUP, "Chicken Noodle - Cup", "Soup", 499, "Cup"),
  realItem(SOUP_BOWL, "Chicken Noodle - Bowl", "Soup", 799, "Bowl"),
  realItem(GP_SMALL, "Green Peppers Pizza - Small (10\")", "Pizza", 1745, "Small (10\")"),
  realItem(FISH_CHIPS, "Fish and Chips", "Sides", 1350, null),
];

// Real lexicon rows for these items (target_type = 'item', active = true),
// pulled live from the `lexicon` table for Vito's menu 54a42842-32be-43b5-
// 9e0c-00fae0ce48fc, 2026-09-20.
const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "chicken noodle", target_id: SOUP_CUP, category: "Soup", size_label: "Cup" },
  { term: "chicken noodle", target_id: SOUP_BOWL, category: "Soup", size_label: "Bowl" },
  { term: "cup chicken noodle", target_id: SOUP_CUP, category: "Soup", size_label: "Cup" },
  { term: "bowl chicken noodle", target_id: SOUP_BOWL, category: "Soup", size_label: "Bowl" },
  { term: "green peppers", target_id: GP_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small green peppers pizza", target_id: GP_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "fish and chips", target_id: FISH_CHIPS, category: "Sides", size_label: null },
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
          .map(m => ({ id: m.id, category: m.category, size_label: (m as unknown as { size_label: string | null }).size_label, bot_state: m.bot_state }));
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
    conversationId: "conv-93559ccf",
    shopId: "shop-vitos",
    tenantId: "shop-vitos",
    cartId: "cart-93559ccf",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: false,
      orderType: "pickup",
      deliveryAddressKnown: true,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

function proposeFixed(result: ProposeResult): () => Promise<ProposeResult> {
  return () => Promise.resolve(result);
}

Deno.test("conv 93559ccf: 'two Chicken Noodle cups' lands at qty 2 with a bare disambiguation answer, and the reply states the count", async () => {
  const supabase = makeFakeSupabase();
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  // Turn 1: the EXACT real PROPOSE payload captured in error_log for this
  // conversation's first message (propose_success, 2026-09-20T09:33:08Z).
  const t1 = await runTurnEngineTurn(
    baseInput({
      message: "Hey, I want to place an order for pickup. I need a small Green Peppers Pizza, a Fish and Chips, and two Chicken Noodle cups.\n\nCan you get that for me?",
      cart, dialogueState,
    }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeFixed({
        ok: true, attempts: 1,
        proposal: {
          intent: "order",
          adds: [
            { item_span: "small Green Peppers Pizza", quantity: 1, choices: [] },
            { item_span: "Fish and Chips", quantity: 1, choices: [] },
            { item_span: "Chicken Noodle cups", quantity: 2, choices: [] },
          ],
          removes: [], modifies: [],
        },
      }),
    },
  );
  assertEquals(t1.cart.length, 2, `pizza + fish should land immediately, soup still ambiguous: ${JSON.stringify(t1.cart)}`);
  assertEquals(t1.dialogueState.open?.kind, "disambiguation", `soup must open a which-one question: ${JSON.stringify(t1.dialogueState.open)}`);
  assertEquals(
    (t1.dialogueState.open as { quantity?: number }).quantity,
    2,
    `the disambiguation must carry the original "two" forward: ${JSON.stringify(t1.dialogueState.open)}`,
  );
  cart = t1.cart; dialogueState = t1.dialogueState;

  // Turn 2: a BARE one-word answer -- "Cup" -- no quantity restated at all.
  // Fixture requires this alone to land 2x, and the reply to say so; never
  // reaches PROPOSE.
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "Cup", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => { throw new Error("must resolve deterministically, never reach PROPOSE"); },
    },
  );

  const soupLine = t2.cart.find(l => l.menu_item_id === SOUP_CUP);
  assertEquals(soupLine?.quantity, 2, `expected 2x Cup Chicken Noodle Soup, got: ${JSON.stringify(t2.cart)}`);
  assertEquals(soupLine?.price_cents, 499);
  assertEquals(
    t2.cart.reduce((sum, l) => sum + l.price_cents * l.quantity, 0),
    1745 + 1350 + 499 * 2,
    `subtotal must reflect 2x soup: ${JSON.stringify(t2.cart)}`,
  );
  assert(/\b2x Chicken Noodle - Cup added\b/.test(t2.reply), `reply must state the count, not just add silently: ${JSON.stringify(t2.reply)}`);
});

Deno.test("conv 93559ccf shape, restated: '2 of the Chicken Noodle - Cup' also lands at qty 2 (R2's own answer-quantity extraction, unaffected)", async () => {
  const supabase = makeFakeSupabase();
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  const t1 = await runTurnEngineTurn(
    baseInput({ message: "two Chicken Noodle cups please", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeFixed({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "Chicken Noodle cups", quantity: 2, choices: [] }], removes: [], modifies: [] },
      }),
    },
  );
  cart = t1.cart; dialogueState = t1.dialogueState;

  // The real customer's actual restatement.
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "I want two Chicken Noodle cups, like I said. So that's 2 of the Chicken Noodle - Cup, $4.99 each. Can you update that?", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => { throw new Error("must resolve deterministically, never reach PROPOSE"); },
    },
  );
  const soupLine = t2.cart.find(l => l.menu_item_id === SOUP_CUP);
  assertEquals(soupLine?.quantity, 2, `expected 2x, got: ${JSON.stringify(t2.cart)}`);
  assert(/\b2x Chicken Noodle - Cup added\b/.test(t2.reply), `reply must state the count: ${JSON.stringify(t2.reply)}`);
});
