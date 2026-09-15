// Turn Engine Phase 1 gate (docs/specs/2026-09-14-turn-engine-oversight.md).
//
// Gate item 1: the three live transcripts from §2b (conversation_ids
// 0e7b9fd7, 1eeab0c0, b4c80c78 — pulled directly from the DB, not guessed;
// see this file's fixture below for the exact real menu item / group ids
// read from Vito's live Cheese Burger row and its "Temp" option group) are
// unit-test fixtures asserting cart, reply, and next DialogueState per turn.
//
// All three conversations carry the IDENTICAL customer message sequence —
// "cheeseburger", "medium", "thats it" — differing only in the OLD, buggy
// bot's replies (which this engine replaces). One shared walkthrough, run
// once per conversation id for traceability back to the evidence.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  decide,
  ask,
  render,
  type DialogueState,
  type Proposal,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskTurnEvents,
  type AskShopContext,
} from "./turn-engine.ts";

// ── Fixture: Vito's real, live Cheese Burger row (id 442f650d-dc96-4a95-9762-
// f6b571a4dd8c) and its real "Temp" option group (id cb066502-4a62-4d6e-a65a-
// 70d8f7be7298), read directly from the DB 2026-09-14. Vito's is delivery-
// enabled (delivery_radius_mi = 5), confirmed the same way. ─────────────────

const CHEESE_BURGER_ID = "442f650d-dc96-4a95-9762-f6b571a4dd8c";
const TEMP_GROUP_ID = "cb066502-4a62-4d6e-a65a-70d8f7be7298";
const MEDIUM_CHOICE_ID = "3678d936-ff8a-4fa0-8bec-f2021a7de7d1";

const VITOS_MENU: TurnEngineMenuItem[] = [
  {
    id: CHEESE_BURGER_ID,
    name: "Cheese Burger",
    category: "Angus Burgers & Specialty",
    price_cents: 849,
    bot_state: "orderable",
    upsell: "French Fries +4.99; Coke +2.99",
    option_groups: [{ id: TEMP_GROUP_ID, name: "Temp", default_choice_id: null }],
    ask_plan: {
      compiled_at: "2026-09-11T20:02:51.758Z",
      compiler_version: 1,
      display_name: "Cheese Burger",
      base_price_cents: 849,
      recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot",
          ask_mode: "ask",
          group_id: TEMP_GROUP_ID,
          slot_key: null,
          prompt_template: "temp.ask",
          choices: [
            { id: "11fd4137-a1dc-4caa-9cc8-f1386bda6393", display: "Well Done", price_delta_cents: 0 },
            { id: MEDIUM_CHOICE_ID, display: "Medium", price_delta_cents: 0 },
            { id: "399bc846-9b41-4e28-9aa2-50af5be3b45e", display: "Rare", price_delta_cents: 0 },
            { id: "51fb77cf-dc9e-444d-a948-f355886c0ab6", display: "Medium Well", price_delta_cents: 0 },
            { id: "fbbcc56d-44bd-4bb7-abba-489a29c5dc01", display: "Medium Rare", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

const INITIAL_STATE: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };

// Vito's real delivery config (delivery_radius_mi = 5 -> delivery enabled).
// Nothing else is known yet at the top of a fresh conversation.
const SHOP_CONTEXT: AskShopContext = {
  deliveryEnabled: true,
  upsellEnabled: true,
  orderTypeKnown: false,
  orderTypeIsDelivery: false,
  deliveryAddressKnown: false,
  driverTipKnown: false,
  pickupNameKnown: false,
};

const NO_TURN_EVENTS: AskTurnEvents = {
  qualifyingAddMenuItemId: null,
  disambiguationCandidateIds: null,
  checkoutIntentThisTurn: false,
  confirmYes: false,
  confirmNo: false,
};

for (const conversationId of ["0e7b9fd7-396c-40ab-b5f3-c5c321401f82", "1eeab0c0-8742-4e76-9b94-cbf28edfea0d", "b4c80c78-8f39-4527-b2de-477ec51a3b8d"]) {
  Deno.test(`turn-engine gate transcript ${conversationId}: cheeseburger -> medium -> thats it`, () => {
    let state: DialogueState = INITIAL_STATE;
    let cart: TurnEngineCartLine[] = [];

    // ── Turn 1: "cheeseburger" ──────────────────────────────────────────
    // No open question yet — deterministically unresolvable (not a bare
    // yes/no/checkout phrase), so ANSWER must defer to PROPOSE. This is the
    // ONE place a model call belongs; the mocked proposal below stands in
    // for what propose.ts (Phase 2, not yet built) would return.
    const a1 = answer(state, cart, "cheeseburger", VITOS_MENU);
    assertEquals(a1, { resolved: false });

    const proposal1: Proposal = {
      intent: "order",
      adds: [{ menu_item_id: CHEESE_BURGER_ID, quantity: 1, choices: [] }],
      removes: [],
      modifies: [],
    };
    const d1 = decide(proposal1, cart, VITOS_MENU);
    assertEquals(d1.declines, []);
    assertEquals(d1.qualifyingAddMenuItemId, CHEESE_BURGER_ID);
    assertEquals(d1.cart.length, 1);
    assertEquals(d1.cart[0].menu_item_id, CHEESE_BURGER_ID);
    assertEquals(d1.cart[0].quantity, 1);
    assertEquals(d1.cart[0].price_cents, 849);
    assertEquals(d1.cart[0].options, undefined); // Temp not yet answered
    assertEquals(d1.cart[0].pending_options, ["Temp"]);

    const cartBefore1 = cart;
    cart = d1.cart;
    const events1: AskTurnEvents = { ...NO_TURN_EVENTS, qualifyingAddMenuItemId: d1.qualifyingAddMenuItemId };
    state = ask(cart, state, events1, SHOP_CONTEXT, VITOS_MENU);
    assertEquals(state.open, { kind: "slot", line_key: `${CHEESE_BURGER_ID}::`, group_id: TEMP_GROUP_ID });
    assertEquals(state.phase, "ordering");

    const reply1 = render(cartBefore1, cart, state, d1.declines, VITOS_MENU);
    // THE gate assertion: a cart line AND the Temp question in the SAME
    // turn — never "pickup or delivery" against an empty cart, never a
    // claim of an add that didn't happen.
    assert(reply1.includes("Cheese Burger added."), `turn 1 must confirm the real add: ${reply1}`);
    assert(reply1.includes("How would you like the Cheese Burger cooked?"), `turn 1 must ask Temp in the same turn: ${reply1}`);
    assert(!/pickup or delivery/i.test(reply1), `turn 1 must never ask order type before Temp: ${reply1}`);
    assert(reply1.includes("Subtotal: $8.49"), `turn 1's footer must reflect the real $8.49 line: ${reply1}`);

    // ── Turn 2: "medium" ────────────────────────────────────────────────
    // state.open is the Temp slot — deterministically resolvable via the
    // existing ask-plan-engine.ts matcher, no model call.
    const cartBefore2 = cart.map(l => ({ ...l }));
    const a2 = answer(state, cart, "medium", VITOS_MENU); // mutates `cart` in place
    assertEquals(a2, { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true });
    assertEquals(cart[0].options, { Temp: ["Medium"] });
    assertEquals(cart[0].ask_plan_selections, { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID });
    assertEquals(cart[0].pending_options, undefined);

    const events2: AskTurnEvents = { ...NO_TURN_EVENTS }; // resolving a slot is not a fresh "qualifying add"
    state = ask(cart, state, events2, SHOP_CONTEXT, VITOS_MENU);
    // Temp is answered; order_type is Vito's next unmet prerequisite.
    assertEquals(state.open, { kind: "order_type" });
    assertEquals(state.phase, "order_type");

    const reply2 = render(cartBefore2, cart, state, [], VITOS_MENU);
    assert(reply2.includes("Medium"), `turn 2 must confirm the real Temp resolution: ${reply2}`);
    assert(reply2.includes("Pickup or delivery today?"), `turn 2 must now ask order type: ${reply2}`);
    assert(reply2.includes("Subtotal: $8.49"), `turn 2's footer must still show the real cart: ${reply2}`);

    // ── Turn 3: "thats it" ──────────────────────────────────────────────
    // state.open is order_type, and "thats it" names neither pickup nor
    // delivery — per the spec's own literal step-2 text this is NOT the
    // "no open question" checkout-intent/closure case (see this file's
    // header note 2 in turn-engine.ts), so ANSWER defers to PROPOSE again.
    const a3 = answer(state, cart, "thats it", VITOS_MENU);
    assertEquals(a3, { resolved: false });

    // Mocked PROPOSE output: the model correctly reads "thats it" as
    // checkout intent, carrying no adds/removes/modifies.
    const proposal3: Proposal = { intent: "checkout", adds: [], removes: [], modifies: [] };
    const cartBefore3 = cart.map(l => ({ ...l }));
    const d3 = decide(proposal3, cart, VITOS_MENU);
    assertEquals(d3.declines, []);
    assertEquals(d3.cart, cart); // nothing to add/remove/modify -> cart unchanged in content

    const events3: AskTurnEvents = { ...NO_TURN_EVENTS, checkoutIntentThisTurn: true };
    state = ask(d3.cart, state, events3, SHOP_CONTEXT, VITOS_MENU);
    // order_type is STILL unresolved (nothing this turn set it) — Vito's
    // hard prerequisite ladder means checkout intent alone cannot skip
    // past it. This is the correct, honest outcome: re-ask order_type,
    // never lose the cart, never claim a phantom re-add.
    assertEquals(state.open, { kind: "order_type" });

    const reply3 = render(cartBefore3, d3.cart, state, d3.declines, VITOS_MENU, {});
    assert(reply3.includes("Pickup or delivery today?"), `turn 3 must re-ask the still-unanswered order type: ${reply3}`);
    assert(reply3.includes("Subtotal: $8.49"), `turn 3 must NEVER show an empty cart — this is the exact bug being closed: ${reply3}`);
    assert(!/what would you like to order/i.test(reply3), `turn 3 must never claim the order is empty: ${reply3}`);
  });
}

// ── Gate item 2: zero `source_phrase`/`sourcePhrase`, exactly one reply-
// building function ─────────────────────────────────────────────────────
Deno.test("gate: turn-engine.ts contains no source-phrase text-grounding concept", () => {
  const src = Deno.readTextFileSync(new URL("./turn-engine.ts", import.meta.url));
  assert(!/source_phrase/i.test(src), "turn-engine.ts must never reference source_phrase — the model's own words are no longer trusted to authorize a mutation");
  assert(!/sourcePhrase/.test(src), "turn-engine.ts must never reference sourcePhrase — same reason, camelCase form");
});

Deno.test("gate: exactly one function in turn-engine.ts returns a reply string", () => {
  const src = Deno.readTextFileSync(new URL("./turn-engine.ts", import.meta.url));
  const matches = src.match(/\)\s*:\s*string\s*\{/g) ?? [];
  assertEquals(matches.length, 1, `expected exactly one \`): string {\` function signature (render); found ${matches.length}`);
  assert(/export function render\(/.test(src), "the one reply-building function must be the exported render()");
});

// Strips `//` line comments and `/* */` block comments so gate assertions
// scan actual code, not prose — a comment merely mentioning "Deno.env" (e.g.
// to explain this module avoids it) must never itself trip an I/O gate.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

// ── Gate item 3: no I/O imports ──────────────────────────────────────────
Deno.test("gate: turn-engine.ts imports nothing that performs I/O", () => {
  const src = stripComments(Deno.readTextFileSync(new URL("./turn-engine.ts", import.meta.url)));
  assert(!/createClient/.test(src), "must never import/call createClient (Supabase)");
  assert(!/\bfetch\s*\(/.test(src), "must never call fetch");
  assert(!/Deno\.env\./.test(src), "must never read Deno.env");
  assert(!/Deno\.serve/.test(src), "must never boot a server");
});

// ── DECIDE: proposal validation / collapse rules ─────────────────────────
Deno.test("decide: two adds with identical identity collapse to ONE line at MAX quantity, never a sum", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { menu_item_id: CHEESE_BURGER_ID, quantity: 1, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] },
      { menu_item_id: CHEESE_BURGER_ID, quantity: 3, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] },
    ],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, [], VITOS_MENU);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].quantity, 3);
});

Deno.test("decide: unknown menu_item_id is declined, never silently added", () => {
  const proposal: Proposal = { intent: "order", adds: [{ menu_item_id: "not-a-real-id", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU);
  assertEquals(result.cart.length, 0);
  assertEquals(result.declines.length, 1);
});

Deno.test("decide: an illegal choice_id for the named group is dropped, not asserted — the add still applies with what's left", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ menu_item_id: CHEESE_BURGER_ID, quantity: 1, choices: [{ group_id: TEMP_GROUP_ID, choice_id: "not-a-real-choice-id" }] }],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, [], VITOS_MENU);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].options, undefined); // bogus choice never resolved -> Temp still pending
  assertEquals(result.cart[0].pending_options, ["Temp"]);
  assert(result.declines.length === 1, "a dropped illegal choice must be surfaced, not silently swallowed");
});

Deno.test("decide: quantity is used verbatim from the proposal — nothing here parses a number out of prose", () => {
  const proposal: Proposal = { intent: "order", adds: [{ menu_item_id: CHEESE_BURGER_ID, quantity: 16, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU);
  // The exact $336/x16 defect class this design makes structurally
  // impossible (§3d row 1): a real explicit quantity of 16 is honored
  // exactly as given, because nothing downstream re-derives it from text.
  assertEquals(result.cart[0].quantity, 16);
});

Deno.test("decide: removes a line by line_key", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
  const lineKey = `${CHEESE_BURGER_ID}::Temp=Medium`;
  const proposal: Proposal = { intent: "order", adds: [], removes: [{ line_key: lineKey }], modifies: [] };
  const result = decide(proposal, cart, VITOS_MENU);
  assertEquals(result.cart.length, 0);
});

// ── ANSWER: the other open-question kinds ────────────────────────────────
Deno.test("answer: order_type resolves 'delivery' deterministically, no model call", () => {
  const state: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const result = answer(state, [], "delivery please", VITOS_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "order_type_resolved", orderType: "delivery" }, cartChanged: false });
});

Deno.test("answer: tip resolves a bare dollar figure", () => {
  const state: DialogueState = { phase: "tip", open: { kind: "tip" }, upsell_offered: false, asked_message_id: null };
  const result = answer(state, [], "$5", VITOS_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "tip_resolved", tipCents: 500 }, cartChanged: false });
});

Deno.test("answer: tip decline resolves to zero", () => {
  const state: DialogueState = { phase: "tip", open: { kind: "tip" }, upsell_offered: false, asked_message_id: null };
  const result = answer(state, [], "no thanks", VITOS_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "tip_resolved", tipCents: 0 }, cartChanged: false });
});

Deno.test("answer: name resolves a name-shaped bare reply", () => {
  const state: DialogueState = { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null };
  const result = answer(state, [], "Jason", VITOS_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "name_resolved", name: "Jason" }, cartChanged: false });
});

Deno.test("answer: confirm resolves a bare yes to confirm_yes", () => {
  const state: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
  const result = answer(state, [], "yes", VITOS_MENU);
  assertEquals(result, { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false });
});

Deno.test("answer: upsell acceptance adds the offered item with no model call", () => {
  const menuWithFries: TurnEngineMenuItem[] = [
    ...VITOS_MENU,
    {
      id: "fries-1", name: "French Fries", price_cents: 499, bot_state: "orderable",
      ask_plan: { compiled_at: "", compiler_version: 1, display_name: "French Fries", base_price_cents: 499, recap_template: "", ticket_template: "", steps: [] },
    },
  ];
  const state: DialogueState = { phase: "ordering", open: { kind: "upsell", menu_item_id: "fries-1" }, upsell_offered: true, asked_message_id: null };
  const result = answer(state, [], "yes please", menuWithFries);
  assertEquals(result.resolved, true);
  assert(result.resolved && result.outcome.kind === "upsell_accepted");
});

// ── ASK: priority ladder ──────────────────────────────────────────────────
Deno.test("ask: upsell offer fires once, after a qualifying add, before it repeats", () => {
  const menuWithFries: TurnEngineMenuItem[] = [
    { ...VITOS_MENU[0] },
    {
      id: "fries-1", name: "French Fries", price_cents: 499, bot_state: "orderable",
      ask_plan: { compiled_at: "", compiler_version: 1, display_name: "French Fries", base_price_cents: 499, recap_template: "", ticket_template: "", steps: [] },
    },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
  const shopContext: AskShopContext = { ...SHOP_CONTEXT, orderTypeKnown: true, orderTypeIsDelivery: false };
  const events: AskTurnEvents = { ...NO_TURN_EVENTS, qualifyingAddMenuItemId: CHEESE_BURGER_ID };
  const state = ask(cart, INITIAL_STATE, events, shopContext, menuWithFries);
  assertEquals(state.open, { kind: "upsell", menu_item_id: "fries-1" });
  assertEquals(state.upsell_offered, true);

  // Second call with upsell_offered already true must never repeat the offer.
  const state2 = ask(cart, state, events, shopContext, menuWithFries);
  assertEquals(state2.open, null);
});

Deno.test("ask: order_type is skipped once known, address/tip are skipped for pickup orders", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
  const shopContext: AskShopContext = { ...SHOP_CONTEXT, orderTypeKnown: true, orderTypeIsDelivery: false, upsellEnabled: false };
  const state = ask(cart, INITIAL_STATE, NO_TURN_EVENTS, shopContext, VITOS_MENU);
  assertEquals(state.open, null); // straight to "anything else?" — pickup, no address/tip owed
});

Deno.test("ask: once checkout intent is established and name/order-type/address/tip are known, moves to confirm", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
  const shopContext: AskShopContext = { ...SHOP_CONTEXT, orderTypeKnown: true, orderTypeIsDelivery: false, upsellEnabled: false, pickupNameKnown: true };
  const events: AskTurnEvents = { ...NO_TURN_EVENTS, checkoutIntentThisTurn: true };
  const state = ask(cart, INITIAL_STATE, events, shopContext, VITOS_MENU);
  assertEquals(state.open, { kind: "confirm" });
  assertEquals(state.phase, "confirm");
});

Deno.test("ask: confirm_yes moves to link_sent with nothing left open", () => {
  const priorState: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: true, asked_message_id: "m1" };
  const shopContext: AskShopContext = { ...SHOP_CONTEXT, orderTypeKnown: true, pickupNameKnown: true };
  const events: AskTurnEvents = { ...NO_TURN_EVENTS, confirmYes: true };
  const state = ask([], priorState, events, shopContext, VITOS_MENU);
  assertEquals(state.phase, "link_sent");
  assertEquals(state.open, null);
});

// ── RENDER: unconditional reply ──────────────────────────────────────────
Deno.test("render: never produces an empty reply, even with nothing open and an empty cart", () => {
  const state: DialogueState = { phase: "link_sent", open: null, upsell_offered: false, asked_message_id: null };
  const reply = render([], [], state, [], VITOS_MENU);
  assert(reply.length > 0, "RENDER must never return an empty string");
});
