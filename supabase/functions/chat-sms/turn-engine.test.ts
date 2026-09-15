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
import type { LexiconTerm } from "./resolve-item.ts";
import { runTurnEngineTurn, type RunTurnDeps, type RunTurnInput } from "./turn-engine-runner.ts";

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

// Code-owned item resolution (docs/specs/2026-09-15-code-owned-resolution.md
// §4): every decide() call below now resolves an add's item_span through a
// lexicon rather than trusting a model-chosen menu_item_id — this is the
// same shape the real `lexicon` table (target_type = 'item') carries.
const VITOS_LEXICON: LexiconTerm[] = [
  { term: "cheeseburger", target_id: CHEESE_BURGER_ID },
  { term: "cheese burger", target_id: CHEESE_BURGER_ID },
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
  disambiguationSettledThisTurn: false,
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
      adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }],
      removes: [],
      modifies: [],
    };
    const d1 = decide(proposal1, cart, VITOS_MENU, VITOS_LEXICON);
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
    // delivery — but per the FIX for the live money bug this dispatch
    // closes (10/20 canary failures, deploy 8da2227c; see turn-engine.ts's
    // header note 2 and closureOrAffirmationFallback), an explicit
    // checkout/closure phrase is now recognized in ANSWER regardless of
    // which non-slot question is open, BEFORE any model call — it must
    // never again fall through to PROPOSE, and it must never mutate the
    // cart either.
    const cartBefore3 = cart.map(l => ({ ...l }));
    const a3 = answer(state, cart, "thats it", VITOS_MENU);
    assertEquals(a3, { resolved: true, outcome: { kind: "checkout_intent" }, cartChanged: false });
    assertEquals(cart, cartBefore3, "a closure/checkout phrase must never mutate the cart");

    const events3: AskTurnEvents = { ...NO_TURN_EVENTS, checkoutIntentThisTurn: true };
    state = ask(cart, state, events3, SHOP_CONTEXT, VITOS_MENU);
    // order_type is STILL unresolved (nothing this turn set it) — Vito's
    // hard prerequisite ladder means checkout intent alone cannot skip
    // past it. This is the correct, honest outcome: re-ask order_type,
    // never lose the cart, never claim a phantom re-add.
    assertEquals(state.open, { kind: "order_type" });

    const reply3 = render(cartBefore3, cart, state, [], VITOS_MENU, {});
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
      { item_span: "cheeseburger", quantity: 1, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] },
      { item_span: "cheeseburger", quantity: 3, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] },
    ],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, [], VITOS_MENU, VITOS_LEXICON);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].quantity, 3);
});

Deno.test("decide: a resolved item_span whose lexicon target isn't on the menu is declined, never silently added — the existing menu-validation path still runs after resolution", () => {
  // A lexicon/menu mismatch (a stale or misconfigured lexicon row) must be
  // caught by the SAME "That item isn't on the menu." path decide() has
  // always had — resolve-item.ts only decides WHICH id to look up, it never
  // replaces the existing legality checks.
  const staleLexicon: LexiconTerm[] = [...VITOS_LEXICON, { term: "flying spaghetti monster", target_id: "not-a-real-id" }];
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "flying spaghetti monster", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU, staleLexicon);
  assertEquals(result.cart.length, 0);
  assertEquals(result.declines.length, 1);
});

Deno.test("decide: an item_span matching nothing in the lexicon is unresolved — no line added, a decline explains it, never silently guessed", () => {
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "xyzzy plugh nothing like that here", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU, VITOS_LEXICON);
  assertEquals(result.cart.length, 0);
  assertEquals(result.disambiguationCandidateIds, null);
  assertEquals(result.declines.length, 1);
});

Deno.test("decide: an item_span tying between two different items is ambiguous — no line added, both candidates carried for ASK, never guessed", () => {
  const menuWithTwoBurgers: TurnEngineMenuItem[] = [
    VITOS_MENU[0],
    {
      id: "turkey-burger-1", name: "Turkey Burger", price_cents: 799, bot_state: "orderable",
      ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Turkey Burger", base_price_cents: 799, recap_template: "", ticket_template: "", steps: [] },
    },
  ];
  // Both items legitimately carry the bare term "burger" — the real-menu
  // shape the spec's own evidence table describes ("burger" (7 items) ->
  // ambiguous -> ask). No tiebreak may resolve this; both candidates survive.
  const ambiguousLexicon: LexiconTerm[] = [
    { term: "burger", target_id: CHEESE_BURGER_ID },
    { term: "burger", target_id: "turkey-burger-1" },
  ];
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "i'll have a burger", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], menuWithTwoBurgers, ambiguousLexicon);
  assertEquals(result.cart.length, 0);
  assertEquals(result.declines, []);
  assertEquals([...(result.disambiguationCandidateIds ?? [])].sort(), [CHEESE_BURGER_ID, "turkey-burger-1"].sort());
});

Deno.test("decide: an illegal choice_id for the named group is dropped, not asserted — the add still applies with what's left", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "cheeseburger", quantity: 1, choices: [{ group_id: TEMP_GROUP_ID, choice_id: "not-a-real-choice-id" }] }],
    removes: [],
    modifies: [],
  };
  const result = decide(proposal, [], VITOS_MENU, VITOS_LEXICON);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].options, undefined); // bogus choice never resolved -> Temp still pending
  assertEquals(result.cart[0].pending_options, ["Temp"]);
  assert(result.declines.length === 1, "a dropped illegal choice must be surfaced, not silently swallowed");
});

Deno.test("decide: quantity is used verbatim from the proposal — nothing here parses a number out of prose", () => {
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 16, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU, VITOS_LEXICON);
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
  const result = decide(proposal, cart, VITOS_MENU, VITOS_LEXICON);
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

// ── Ambiguous-path ASK: confident copy + carried second span (2026-09-15,
// docs/specs/2026-09-15-code-owned-resolution.md's "ambiguous means ASK"
// ruling). Live repro: "lemme do a burger well done plus an order of
// fries" produced "Sorry, I didn't catch that — 1) the Chicken Fingers (5)
// with french fries appetizer — $10.95 2) the Bacon Cheese Fries appetizer
// — $8.49 3) the Fren..." — the apology-shaped RE-ASK copy (meant for a
// FAILED resolution attempt) leaking onto the very first, confident
// clarifying question, AND the wrong span (fries, second in the message)
// asked about instead of the first (burger), with the burger dropped
// entirely. Two fixes, two test groups below. ──────────────────────────────

function ambiguousMenuItem(id: string, name: string, priceCents: number, category: string): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [] },
  };
}

const AMBIGUOUS_BURGER_A_ID = "amb-burger-a";
const AMBIGUOUS_BURGER_B_ID = "amb-burger-b";
const AMBIGUOUS_FRIES_A_ID = "amb-fries-a";
const AMBIGUOUS_FRIES_B_ID = "amb-fries-b";

const AMBIGUOUS_MENU: TurnEngineMenuItem[] = [
  ambiguousMenuItem(AMBIGUOUS_BURGER_A_ID, "Bacon Burger", 999, "Burgers"),
  ambiguousMenuItem(AMBIGUOUS_BURGER_B_ID, "Turkey Burger", 799, "Burgers"),
  ambiguousMenuItem(AMBIGUOUS_FRIES_A_ID, "Cheese Fries", 549, "Appetizers"),
  ambiguousMenuItem(AMBIGUOUS_FRIES_B_ID, "Chili Fries", 599, "Appetizers"),
];

const AMBIGUOUS_LEXICON: LexiconTerm[] = [
  { term: "burger", target_id: AMBIGUOUS_BURGER_A_ID },
  { term: "burger", target_id: AMBIGUOUS_BURGER_B_ID },
  { term: "fries", target_id: AMBIGUOUS_FRIES_A_ID },
  { term: "fries", target_id: AMBIGUOUS_FRIES_B_ID },
];

Deno.test("render: a single ambiguous span asks a confident question — no apology, no \"didn't catch\" wording, names every candidate", () => {
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "burger", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const d = decide(proposal, [], AMBIGUOUS_MENU, AMBIGUOUS_LEXICON);
  assertEquals(d.cart.length, 0);
  assert(d.disambiguationCandidateIds, "burger must resolve ambiguous, not resolved/unresolved");

  const events: AskTurnEvents = {
    ...NO_TURN_EVENTS,
    disambiguationCandidateIds: d.disambiguationCandidateIds,
    carriedDisambiguationCandidateIds: d.carriedDisambiguationCandidateIds,
  };
  const state = ask([], INITIAL_STATE, events, SHOP_CONTEXT, AMBIGUOUS_MENU);
  const reply = render([], [], state, d.declines, AMBIGUOUS_MENU);

  assert(!/sorry/i.test(reply), `an ambiguous-item ASK must never apologize — the engine understood the customer: ${reply}`);
  assert(!/didn'?t catch/i.test(reply), `must never use the re-ask's "didn't catch" wording on the FIRST ask: ${reply}`);
  assert(/\?/.test(reply), `must read as an actual question: ${reply}`);
  assert(reply.includes("Bacon Burger"), `must name every candidate: ${reply}`);
  assert(reply.includes("Turkey Burger"), `must name every candidate: ${reply}`);
});

Deno.test("decide: a genuinely unresolvable item_span keeps the existing apology wording — ambiguous and unresolved must not collapse into shared copy", () => {
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "flying spaghetti monster sandwich", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const d = decide(proposal, [], AMBIGUOUS_MENU, AMBIGUOUS_LEXICON);
  assertEquals(d.disambiguationCandidateIds, null);
  assertEquals(d.declines.length, 1);
  assert(/sorry, i didn'?t catch/i.test(d.declines[0].reason), `a genuinely unresolved span must keep its apology text exactly as-is: ${d.declines[0].reason}`);
});

Deno.test("RED->GREEN: two ambiguous spans in one message — ASK asks about the FIRST (message order); the second survives in dialogue_state and gets asked next turn, never dropped", () => {
  // "lemme do a burger well done plus an order of fries" -- burger named
  // FIRST, fries second. Both tie ambiguous in the lexicon.
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "burger", quantity: 1, choices: [] },
      { item_span: "fries", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const d = decide(proposal, [], AMBIGUOUS_MENU, AMBIGUOUS_LEXICON);
  assertEquals(d.cart.length, 0);
  assertEquals(
    [...(d.disambiguationCandidateIds ?? [])].sort(),
    [AMBIGUOUS_BURGER_A_ID, AMBIGUOUS_BURGER_B_ID].sort(),
    "the FIRST ambiguous span named in the message (burger) must be the one decide() surfaces for THIS turn's ASK",
  );
  assertEquals(d.carriedDisambiguationCandidateIds.length, 1, "the second ambiguous span (fries) must be carried forward, not dropped");
  assertEquals(
    [...d.carriedDisambiguationCandidateIds[0]].sort(),
    [AMBIGUOUS_FRIES_A_ID, AMBIGUOUS_FRIES_B_ID].sort(),
  );

  // ── Turn 1: ASK must be about the burger, not the fries. ─────────────────
  const events1: AskTurnEvents = {
    ...NO_TURN_EVENTS,
    disambiguationCandidateIds: d.disambiguationCandidateIds,
    carriedDisambiguationCandidateIds: d.carriedDisambiguationCandidateIds,
  };
  let state = ask([], INITIAL_STATE, events1, SHOP_CONTEXT, AMBIGUOUS_MENU);
  assert(state.open?.kind === "disambiguation", `turn 1 must open a disambiguation question, got: ${JSON.stringify(state.open)}`);
  assertEquals(
    [...(state.open as { candidates: string[] }).candidates].sort(),
    [AMBIGUOUS_BURGER_A_ID, AMBIGUOUS_BURGER_B_ID].sort(),
  );

  const reply1 = render([], [], state, d.declines, AMBIGUOUS_MENU);
  assert(reply1.includes("Bacon Burger") && reply1.includes("Turkey Burger"), `turn 1 must ask about the burger candidates: ${reply1}`);
  assert(!reply1.includes("Cheese Fries") && !reply1.includes("Chili Fries"), `turn 1 must NOT ask about fries yet — one question per turn: ${reply1}`);

  // ── Turn 2: the customer answers the burger question. The fries question
  // must now surface — not silently dropped. ───────────────────────────────
  const cart: TurnEngineCartLine[] = [];
  const answerResult = answer(state, cart, "the first one", AMBIGUOUS_MENU);
  assertEquals(answerResult.resolved, true);
  assert(answerResult.resolved && answerResult.outcome.kind === "disambiguation_resolved");
  assertEquals(cart.length, 1, "the resolved burger must be added to the cart");
  assert([AMBIGUOUS_BURGER_A_ID, AMBIGUOUS_BURGER_B_ID].includes(cart[0].menu_item_id), "the added line must be one of the two burger candidates");

  const events2: AskTurnEvents = { ...NO_TURN_EVENTS, disambiguationSettledThisTurn: true };
  state = ask(cart, state, events2, SHOP_CONTEXT, AMBIGUOUS_MENU);
  assert(
    state.open?.kind === "disambiguation",
    `turn 2 must now ask about the carried fries span instead of dropping it — got: ${JSON.stringify(state.open)}`,
  );
  assertEquals(
    [...(state.open as { candidates: string[] }).candidates].sort(),
    [AMBIGUOUS_FRIES_A_ID, AMBIGUOUS_FRIES_B_ID].sort(),
  );

  const reply2 = render([], cart, state, [], AMBIGUOUS_MENU);
  assert(reply2.includes("Cheese Fries") && reply2.includes("Chili Fries"), `turn 2 must ask about the fries candidates: ${reply2}`);
});

// ── stale line_key fix (2026-09-15, docs/specs/2026-09-14-turn-engine-
// oversight.md Phase 1.5) ────────────────────────────────────────────────
//
// Real, live Zio's row (id 62f14b74-1b24-41f7-8b09-eed293d95910, "Pasta with
// Garlic & Oil"), read from ~/po-scratch/item2g.json 2026-09-15 — the exact
// fixture the PO's verification test (turn-engine-stale-line-key.test.ts)
// and stale-line-key-findings-20260915.md confirmed the bug against. Two
// required slot groups: GROUP_A auto-resolves silently (its one and only
// choice), GROUP_B is a real customer-facing question ("choose the pasta").

const PASTA_ITEM_ID = "62f14b74-1b24-41f7-8b09-eed293d95910";
const PASTA_GROUP_A = "a2d9f051-68c2-4068-a51e-3ab9939edf89"; // auto_single, one choice
const PASTA_GROUP_B = "da31c0b7-8976-4994-8e34-4eaba2688b16"; // ask, 6 choices
const PASTA_PENNE_CHOICE_ID = "7fafecb7-8458-454e-a3d9-45c63e8192c6";

const PASTA_MENU: TurnEngineMenuItem[] = [
  {
    id: PASTA_ITEM_ID,
    name: "Pasta with Garlic & Oil",
    category: "Pasta",
    price_cents: 1499,
    bot_state: "orderable",
    option_groups: [
      { id: PASTA_GROUP_A, name: "Prep", default_choice_id: null },
      { id: PASTA_GROUP_B, name: "Type", default_choice_id: null },
    ],
    ask_plan: {
      compiled_at: "2026-09-10T20:42:39.658Z",
      compiler_version: 1,
      display_name: "Pasta With Garlic & Oil",
      base_price_cents: 1499,
      recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "auto_single", group_id: PASTA_GROUP_A, slot_key: null, prompt_template: "type.auto_single",
          choices: [{ id: "db69c17d-8274-42fa-a438-773287635d59", display: "Pasta", price_delta_cents: 0 }],
        },
        {
          kind: "slot", ask_mode: "ask", group_id: PASTA_GROUP_B, slot_key: null, prompt_template: "choose_pasta.ask",
          choices: [
            { id: "17961b5a-ba64-4d47-804f-66db9674cff8", display: "Fettuccine", price_delta_cents: 0 },
            { id: "4fd2d286-66fe-4534-a6de-9490392f0f25", display: "Rigatoni", price_delta_cents: 0 },
            { id: PASTA_PENNE_CHOICE_ID, display: "Penne", price_delta_cents: 0 },
            { id: "bad9c7cc-7094-412d-8eaf-9aa889be890e", display: "Spaghetti", price_delta_cents: 0 },
            { id: "f14496ef-10fd-41a1-ae85-20edcc914d13", display: "Angel Hair", price_delta_cents: 0 },
            { id: "f54e4265-f330-40dc-bddb-e5e0a6b73022", display: "Linguine", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

const PASTA_LEXICON: LexiconTerm[] = [
  { term: "pasta with garlic and oil", target_id: PASTA_ITEM_ID },
  { term: "pasta", target_id: PASTA_ITEM_ID },
];

Deno.test("decide: a modify carrying the line_key ASK stored BEFORE a second option group was answered still applies — the stale-identityKey bug this fix closes", () => {
  let counter = 0;
  const newLineKey = () => `k${++counter}`;

  // Turn 1: add the item. GROUP_A (auto_single) resolves silently; GROUP_B
  // is left open. This is the one and only genuinely-new-line add in this
  // test, so it's the only call that mints a stable key.
  const proposalAdd: Proposal = { intent: "order", adds: [{ item_span: "pasta with garlic and oil", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const d1 = decide(proposalAdd, [], PASTA_MENU, PASTA_LEXICON, newLineKey);
  assertEquals(d1.declines, []);
  assertEquals(d1.cart.length, 1);
  assertEquals(d1.cart[0].line_key, "k1");
  assertEquals(d1.cart[0].options, { Prep: ["Pasta"] }); // GROUP_A auto-resolved; GROUP_B still open
  const cart = d1.cart;

  // ASK opens GROUP_B, storing the line's STABLE key — never a derived one.
  const shopContext: AskShopContext = {
    deliveryEnabled: false, upsellEnabled: false, orderTypeKnown: true, orderTypeIsDelivery: false,
    deliveryAddressKnown: true, driverTipKnown: true, pickupNameKnown: true,
  };
  const events: AskTurnEvents = { ...NO_TURN_EVENTS, qualifyingAddMenuItemId: d1.qualifyingAddMenuItemId };
  const state = ask(cart, INITIAL_STATE, events, shopContext, PASTA_MENU);
  assertEquals(state.open, { kind: "slot", line_key: "k1", group_id: PASTA_GROUP_B });
  const askStoredKey = (state.open as { line_key: string }).line_key;

  // ANSWER resolves GROUP_B — the line's DERIVED identity (menu_item_id +
  // options) changes, but its stable line_key does not: applyCompiledModifyItem
  // (called by answer()) never reads or writes this field.
  const answerResult = answer(state, cart, "Penne", PASTA_MENU);
  assertEquals(answerResult, { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true });
  assertEquals(cart[0].options, { Prep: ["Pasta"], Type: ["Penne"] });
  assertEquals(cart[0].line_key, "k1", "line_key must survive the option mutation unchanged");

  // A modify proposal carrying the ASK-stored key — captured BEFORE GROUP_B
  // was answered, so it is stale by the OLD derived-identityKey rule — must
  // still find and mutate this line. Before this fix: declines with "That
  // item wasn't in your order." and the cart is left unchanged.
  const proposalModify: Proposal = { intent: "order", adds: [], removes: [], modifies: [{ line_key: askStoredKey, quantity: 3 }] };
  const d2 = decide(proposalModify, cart, PASTA_MENU, PASTA_LEXICON, newLineKey);
  assertEquals(d2.declines, [], "a modify keyed by the ASK-stored line_key must not decline — the item IS in the cart");
  assertEquals(d2.cart[0].quantity, 3, "the modify must actually apply, not silently no-op");
  assertEquals(counter, 1, "the modify must never mint a new key — only the original add did");
});

Deno.test("decide: a modify still targets a KEYLESS line via the derived-identity fallback — a pre-migration DB row must not break", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
  // No `line_key` field at all — simulates a cart line loaded from a DB row
  // that predates this fix. The only valid key for it is still the derived
  // identityKey string.
  const derivedKey = `${CHEESE_BURGER_ID}::Temp=Medium`;
  const proposal: Proposal = { intent: "order", adds: [], removes: [], modifies: [{ line_key: derivedKey, quantity: 5 }] };
  const result = decide(proposal, cart, VITOS_MENU, VITOS_LEXICON);
  assertEquals(result.declines, []);
  assertEquals(result.cart[0].quantity, 5);
});

Deno.test("decide: mints a stable line_key only for a genuinely NEW line, never for a quantity-bump merge into an existing identical line", () => {
  let counter = 0;
  const newLineKey = () => `k${++counter}`;

  const proposal1: Proposal = {
    intent: "order",
    adds: [{ item_span: "cheeseburger", quantity: 1, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] }],
    removes: [], modifies: [],
  };
  const d1 = decide(proposal1, [], VITOS_MENU, VITOS_LEXICON, newLineKey);
  assertEquals(d1.cart.length, 1);
  assertEquals(d1.cart[0].line_key, "k1");

  // Same fully-resolved identity, ordered again — merges into the SAME
  // line, growing quantity. Must NOT mint a second key.
  const proposal2: Proposal = {
    intent: "order",
    adds: [{ item_span: "cheeseburger", quantity: 2, choices: [{ group_id: TEMP_GROUP_ID, choice_id: MEDIUM_CHOICE_ID }] }],
    removes: [], modifies: [],
  };
  const d2 = decide(proposal2, d1.cart, VITOS_MENU, VITOS_LEXICON, newLineKey);
  assertEquals(d2.cart.length, 1);
  assertEquals(d2.cart[0].quantity, 3);
  assertEquals(d2.cart[0].line_key, "k1", "a quantity-bump merge into an existing line must never mint a new key");
  assertEquals(counter, 1, "newLineKey must be called exactly once — only for the genuinely new line");
});

Deno.test("decide: omitting newLineKey entirely (pre-fix call sites) never sets line_key — identical to this function's behavior before stable keys existed", () => {
  const proposal: Proposal = { intent: "order", adds: [{ item_span: "cheeseburger", quantity: 1, choices: [] }], removes: [], modifies: [] };
  const result = decide(proposal, [], VITOS_MENU, VITOS_LEXICON); // no 5th arg
  assertEquals(result.cart[0].line_key, undefined);
});

// ── DECIDE: an item resolved through the lexicon into an item with TWO real
// option groups (Zio's live "Boneless Wings" — Choose Sauce + Quantity, id
// cb53dc5b-5abe-4110-a814-3beacec644e8, see
// turn-engine-stale-line-key.test.ts for the same real fixture) — Cheese
// Burger has exactly one option group and already hid a defect once before
// under different code, so this module's own DECIDE-level coverage of
// resolve-item.ts must not lean on it as the only multi-group fixture. ────

const WINGS_ID = "cb53dc5b-5abe-4110-a814-3beacec644e8";
const WINGS_FLAVOR_GROUP_ID = "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d";
const WINGS_QTY_GROUP_ID = "8774670c-7f71-4ee9-b9b4-a80552309321";
const WINGS_BBQ_CHOICE_ID = "88b27a65-d800-4d2a-a63b-42946330c76a";
const WINGS_TEN_PIECES_ID = "16f6eb99-3d95-4fd7-aef5-94180a6099bd";

const WINGS_MENU: TurnEngineMenuItem[] = [
  {
    id: WINGS_ID,
    name: "Boneless Wings",
    category: "Wings",
    price_cents: 1000,
    bot_state: "orderable",
    option_groups: [
      { id: WINGS_FLAVOR_GROUP_ID, name: "Choose Sauce", default_choice_id: null },
      { id: WINGS_QTY_GROUP_ID, name: "Quantity", default_choice_id: null },
    ],
    ask_plan: {
      compiled_at: "2026-09-10T20:42:39.658Z",
      compiler_version: 1,
      display_name: "Boneless Wings",
      base_price_cents: 1000,
      recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: WINGS_FLAVOR_GROUP_ID, slot_key: "flavor", prompt_template: "flavor.ask",
          choices: [
            { id: "62a4d4ca-d0aa-4f36-a99c-ad5d7c580f70", display: "Mild Sauce", price_delta_cents: 0 },
            { id: WINGS_BBQ_CHOICE_ID, display: "BBQ Sauce", price_delta_cents: 0 },
          ],
        },
        {
          kind: "slot", ask_mode: "ask", group_id: WINGS_QTY_GROUP_ID, slot_key: null, prompt_template: "quantity.ask",
          choices: [
            { id: WINGS_TEN_PIECES_ID, display: "10 Pieces", price_delta_cents: 0 },
            { id: "dc16bc2d-72c0-42c1-b031-c792048b3fba", display: "20 Pieces", price_delta_cents: 800 },
          ],
        },
      ],
    },
  },
];

const WINGS_LEXICON: LexiconTerm[] = [{ term: "boneless wings", target_id: WINGS_ID }];

Deno.test("decide: an item_span resolved through the lexicon into an item with TWO real option groups applies both groups' choices, not just the first", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{
      item_span: "boneless wings",
      quantity: 1,
      choices: [
        { group_id: WINGS_FLAVOR_GROUP_ID, choice_id: WINGS_BBQ_CHOICE_ID },
        { group_id: WINGS_QTY_GROUP_ID, choice_id: WINGS_TEN_PIECES_ID },
      ],
    }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], WINGS_MENU, WINGS_LEXICON);
  assertEquals(result.declines, []);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, WINGS_ID);
  assertEquals(result.cart[0].options, { "Choose Sauce": ["BBQ Sauce"], Quantity: ["10 Pieces"] });
  assertEquals(result.cart[0].pending_options, undefined);
});

// ── Live money bug (10/20 canary failures, deploy 8da2227c): "thats it"
// while order_type is open silently added a SECOND Cheese Burger ────────
//
// Root cause: ANSWER's "with no open question" checkout-intent/closure
// branch (header note 2 above) only ever fired when state.open === null.
// Here order_type was open, "thats it" doesn't name pickup or delivery, so
// the turn fell through to PROPOSE — and the model, asked to interpret free
// text against an open cart with no other instruction, read "thats it" as
// "yes, one more of the same" and bumped quantity to 2 (cart total $8.49 ->
// $16.98). Same defect family as the LEGACY engine's "thats it" bug
// (conversations 0e7b9fd7, 1eeab0c0) this whole engine was built to make
// structurally impossible. Fixed in ANSWER via closureOrAffirmationFallback
// — every non-slot open kind (order_type/tip/address/name/confirm) now
// checks it before ever returning UNRESOLVED, so a closure/affirmation
// phrase can never reach PROPOSE regardless of which one is open.
//
// This minimal fake only needs to answer loadUpsellEnabled's shop_settings
// read and persistTurn's order_carts/messages writes — the whole point of
// this fixture is that PROPOSE (and therefore loadItemLexicon) must NEVER
// run, so neither needs real behavior.
function makeMinimalFakeSupabase() {
  const state = {
    orderCartsUpdates: [] as Array<Record<string, unknown>>,
    messagesInserted: [] as Array<Record<string, unknown>>,
  };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert(row: Record<string, unknown>) {
        if (table === "messages") state.messagesInserted.push(row);
        return Promise.resolve({ error: null });
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void, reject?: (e: unknown) => void) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

const ORDER_TYPE_OPEN_STATE: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };

function cheeseBurgerMediumCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
}

async function runClosureFixture(message: string) {
  const { supabase } = makeMinimalFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => {
      proposeCalls++;
      return Promise.reject(new Error("PROPOSE must never be called for a bare closure/affirmation while a non-slot question is open"));
    },
  };
  const input: RunTurnInput = {
    conversationId: "conv-1",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message,
    history: [],
    menu: VITOS_MENU,
    cart: cheeseBurgerMediumCart(),
    dialogueState: ORDER_TYPE_OPEN_STATE,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };
  const result = await runTurnEngineTurn(input, deps);
  return { result, proposeCalls };
}

Deno.test('runTurnEngineTurn: "thats it" while order_type is open must NOT add a second Cheese Burger — the exact $8.49 -> $16.98 money bug (deploy 8da2227c, 10/20 canary failures)', async () => {
  const { result, proposeCalls } = await runClosureFixture("thats it");

  assertEquals(proposeCalls, 0, "PROPOSE must never be called for a bare closure while order_type is open");
  assertEquals(result.cart.length, 1, "no second line — the cart must not grow");
  assertEquals(result.cart[0].quantity, 1, "quantity must stay 1 — this is the exact defect: it silently became 2");
  assertEquals(result.dialogueState.open, { kind: "order_type" }, "the SAME open question must be re-asked, never cleared or force-resolved");
  assert(result.reply.includes("Pickup or delivery today?"), `must re-ask order type: ${result.reply}`);
  assert(result.reply.includes("Subtotal: $8.49"), `subtotal must not double: ${result.reply}`);
});

// One clean phrasing passing is exactly how this bug class survived three
// prior fixes — every phrase below must independently produce the same
// safe outcome: cart unchanged, PROPOSE never called, order_type re-asked.
for (const phrase of ["that's all", "im done", "no thanks", "yes"]) {
  Deno.test(`runTurnEngineTurn: closure/affirmation matrix — "${phrase}" while order_type is open produces the same safe outcome as "thats it"`, async () => {
    const { result, proposeCalls } = await runClosureFixture(phrase);

    assertEquals(proposeCalls, 0, `PROPOSE must never be called for "${phrase}" while order_type is open`);
    assertEquals(result.cart.length, 1, `no second line for "${phrase}"`);
    assertEquals(result.cart[0].quantity, 1, `quantity must stay 1 for "${phrase}"`);
    assertEquals(result.dialogueState.open, { kind: "order_type" }, `order_type must stay open for "${phrase}"`);
    assert(result.reply.includes("Pickup or delivery today?"), `must re-ask order type for "${phrase}": ${result.reply}`);
  });
}
