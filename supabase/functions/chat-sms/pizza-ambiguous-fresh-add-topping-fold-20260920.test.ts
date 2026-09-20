// PO dispatch 2026-09-20 (real live conv e5796b9f, 50-run #37). REAL
// captured transcript (pulled from `messages`/`order_carts`/`error_log`,
// conversation_id e5796b9f-959c-468c-b6c1-391d0808586d, 2026-09-20 — the
// PO's own two prose descriptions of this conv id did not match each other,
// so this is ground truth, not a paraphrase):
//
//   CUSTOMER: Hi, I want to place an order for 2 Chicken Bacon Ranch
//             pizzas with steak and green peppers. Can you help me with
//             that?
//   ASSISTANT: Which one would you like — 1) the Chicken Bacon Ranch
//             flatbread — $10.50  2) the Grilled Chicken Bacon & Ranch
//             wrap — $9.99  3) the Chicken Bacon Ranch - Medium (14")
//             pizza — $19.99  4) the Chicken Bacon Ranch - Large (16")
//             pizza — $22.99  5) the Chicken Bacon Ranch - Small (10")
//             pizza — $12.95? Reply 1, 2, 3, 4 or 5.
//   CUSTOMER: I meant the Chicken Bacon Ranch pizza, I want 2 of the
//             Large (16") please!
//   ASSISTANT: Large Chicken Bacon Ranch Pizza added. ... Subtotal: $45.98
//
// $45.98 = 2 x $22.99 -- quantity was always right. The toppings the
// customer named IN THE SAME BREATH as the item ("with steak and green
// peppers") never landed: the line added has zero modifiers. The
// conversation goes on to a long, ultimately partial recovery (the
// customer restates the toppings many more times; a later turn splits the
// line into two quantity-1 lines, only one of which ever gets the
// toppings) — a real, messy symptom of the same root gap repeating, not a
// second bug: the toppings never had anywhere to land at ADD time, so
// every later attempt to state them again fights the cart instead of
// completing it.
//
// ROOT CAUSE (confirmed against error_log's real propose_success row for
// this conversation's first turn): PROPOSE returned
//   { adds: [{ item_span: "Chicken Bacon Ranch", quantity: 2, choices: [] }] }
// -- ONE add, item_span stripped to the bare item name, no separate add for
// the toppings at all. "Chicken Bacon Ranch" matches five real menu items
// (flatbread/wrap/three pizza sizes), so it opens a disambiguation with no
// resolved `menuItem` yet.
//
// turn-engine.ts already has a mechanism for carrying a modifier forward
// across an open disambiguation (DialogueState's "disambiguation" variant,
// `heldModifierText`) — but the ONLY function that populates it,
// holdAddsThatAreModifiersOfAnAmbiguousSibling, only ever recovers a
// modifier from a SEPARATE sibling add's own item_span (the "Italian wrap
// with chicken" shape, where "chicken" comes back as its own add). Here
// there is no sibling add — "with steak and green peppers" only ever
// existed inside the raw customerMessage, glued into the same clause as the
// still-ambiguous item — so heldModifierText stayed null and the toppings
// were silently dropped the moment the disambiguation opened. This is the
// hoagie fold's own gap, on the pizza path specifically: the fold that
// recovers add-on words named in the same clause as an item
// (scopedModifierText / decomposeSpanIntoChoicesOfMenuItem / the 00-BF
// modifier floor) only ever runs against a RESOLVED menuItem — an ambiguous
// add that hasn't resolved yet has no menuItem for it to run against at
// all.
//
// FIX (turn-engine.ts, decide()): when exactly one ambiguous span opens
// this turn and there is no other resolved add competing for the leftover
// words (soleAddThisTurn's own "no competing item" reasoning, applied to
// the not-yet-resolved case), the customer's raw message — minus the
// matched item span — is held as heldModifierText, same as the sibling-add
// case. Recovered later against the WINNING candidate's own real choices in
// answer()'s "disambiguation" case, which also switched from the singular
// recoverAssertedChoiceFromText (whose own plural-tie guard silently drops
// BOTH toppings whenever two plain, non-placement choices are named
// together with no "added" cue — exactly "steak and green peppers") to the
// plural recoverAssertedChoicesFromText with noCompetingItems=true, the
// same call the resolved-item 00-BF floor already makes for the identical
// shape ("Italian hoagie with shrimp and blackened salmon").

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runTurnEngineTurn, type RunTurnInput } from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const CBR_LARGE = "edac128c-c963-495a-8e4a-ec09a9787267";
const CBR_MED = "dca6fae3-2d94-4a18-b0a9-760474cec7c1";
const CBR_SMALL = "f320da06-15d2-4503-97b2-001c17b444bf";
const CBR_FLATBREAD = "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d";
const GREEN_PEPPERS_CHOICE = "bb77f9ed-cd42-44b2-a9e4-50f2113c981a"; // "Green Peppers (Whole pizza)", +$4.50
const STEAK_CHOICE = "c764febd-257d-437b-a2ea-c59ab9b09650"; // "Steak (Whole pizza)", +$5.00
const TOPPINGS_GROUP = "b49da574-3da2-4b1a-9d58-4d1a30c23ef8";

// Real ask_plan toppings step for this exact real menu item (menu_items.id
// edac128c-c963-495a-8e4a-ec09a9787267, pulled live 2026-09-20) — trimmed to
// the two choices this transcript names, same group_id/choice ids as
// production so the real customer message resolves against the real data.
const PIZZA_STEPS = [{
  kind: "modifier",
  choices: [
    { id: GREEN_PEPPERS_CHOICE, display: "Green Peppers (Whole pizza)", price_delta_cents: 450 },
    { id: STEAK_CHOICE, display: "Steak (Whole pizza)", price_delta_cents: 500 },
  ],
  ask_mode: "on_request",
  group_id: TOPPINGS_GROUP,
  slot_key: null,
  prompt_template: "toppings.on_request",
}];

function realItem(id: string, name: string, category: string, priceCents: number, sizeLabel: string | null, steps: unknown[] = []): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    size_label: sizeLabel,
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: steps as never,
    },
  } as unknown as TurnEngineMenuItem;
}

const MENU: TurnEngineMenuItem[] = [
  realItem(CBR_LARGE, "Chicken Bacon Ranch - Large (16\")", "Pizza", 2299, "Large (16\")", PIZZA_STEPS),
  realItem(CBR_MED, "Chicken Bacon Ranch - Medium (14\")", "Pizza", 1999, "Medium (14\")", PIZZA_STEPS),
  realItem(CBR_SMALL, "Chicken Bacon Ranch - Small (10\")", "Pizza", 1295, "Small (10\")", PIZZA_STEPS),
  realItem(CBR_FLATBREAD, "Chicken Bacon Ranch", "Flatbread", 1050, null),
];

// Real lexicon rows for this family (target_type = 'item', active = true),
// pulled live from Vito's menu 54a42842-32be-43b5-9e0c-00fae0ce48fc.
const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "chicken bacon ranch", target_id: CBR_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "chicken bacon ranch", target_id: CBR_MED, category: "Pizza", size_label: "Medium (14\")" },
  { term: "chicken bacon ranch", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chicken bacon ranch", target_id: CBR_FLATBREAD, category: "Flatbread", size_label: null },
  { term: "large chicken bacon ranch", target_id: CBR_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_LARGE, category: "Pizza", size_label: "Large (16\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_MED, category: "Pizza", size_label: "Medium (14\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
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
    conversationId: "conv-e5796b9f",
    shopId: "shop-vitos",
    tenantId: "shop-vitos",
    cartId: "cart-e5796b9f",
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

function proposeFixed(result: ProposeResult): () => Promise<ProposeResult> {
  return () => Promise.resolve(result);
}

Deno.test("conv e5796b9f: '2 Chicken Bacon Ranch pizzas with steak and green peppers' folds both toppings onto the pizza once the size disambiguation resolves, ONE line at qty 2", async () => {
  const supabase = makeFakeSupabase();
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = null;

  // Turn 1: the EXACT real PROPOSE payload captured in error_log
  // (propose_success, 2026-09-20T09:34:55Z) — item_span stripped to the
  // bare item name, toppings never became their own add.
  const t1 = await runTurnEngineTurn(
    baseInput({
      message: "Hi, I want to place an order for 2 Chicken Bacon Ranch pizzas with steak and green peppers. Can you help me with that?",
      cart, dialogueState,
    }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeFixed({
        ok: true, attempts: 1,
        proposal: { intent: "order", adds: [{ item_span: "Chicken Bacon Ranch", quantity: 2, choices: [] }], removes: [], modifies: [] },
      }),
    },
  );
  assertEquals(t1.cart.length, 0, "nothing lands yet -- five real menu items share this name");
  assertEquals(t1.dialogueState.open?.kind, "disambiguation", `must open a which-one question: ${JSON.stringify(t1.dialogueState.open)}`);
  assertEquals(
    (t1.dialogueState.open as { quantity?: number }).quantity, 2,
    `must carry the original "2" forward: ${JSON.stringify(t1.dialogueState.open)}`,
  );
  assertEquals(
    (t1.dialogueState.open as { heldModifierText?: string }).heldModifierText?.includes("steak"),
    true,
    `must hold the toppings text for the winning candidate: ${JSON.stringify(t1.dialogueState.open)}`,
  );
  cart = t1.cart; dialogueState = t1.dialogueState;

  // Turn 2: the real customer's actual second message, resolved
  // deterministically inside answer() -- never reaches PROPOSE.
  const t2 = await runTurnEngineTurn(
    baseInput({ message: "I meant the Chicken Bacon Ranch pizza, I want 2 of the Large (16\") please!", cart, dialogueState }),
    {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => { throw new Error("must resolve deterministically, never reach PROPOSE"); },
    },
  );

  assertEquals(t2.cart.length, 1, `must be ONE line, not split into a plain line + a topped line: ${JSON.stringify(t2.cart)}`);
  const line = t2.cart[0];
  assertEquals(line.menu_item_id, CBR_LARGE);
  assertEquals(line.quantity, 2, "both pizzas, not one");
  const toppingIds = (line.ask_plan_selections?.[TOPPINGS_GROUP] as string[] | undefined) ?? [];
  assertEquals([...toppingIds].sort(), [GREEN_PEPPERS_CHOICE, STEAK_CHOICE].sort(), `both named toppings must apply, neither silently dropped: ${JSON.stringify(line)}`);
  assertEquals(line.price_cents, 2299 + 450 + 500, "per-unit price must reflect both toppings");
  assertEquals(
    line.price_cents * line.quantity,
    (2299 + 450 + 500) * 2,
    `total must be 2x the fully-topped price, real money at stake: ${JSON.stringify(line)}`,
  );
});
