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
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CONFIRM_READBACK_SPLIT_MARKER } from "./confirm-readback-20260918.ts";
import {
  answer,
  decide,
  ask,
  render,
  extractSlotChoiceWords,
  type DialogueState,
  type Proposal,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskTurnEvents,
  type AskShopContext,
  type RenderContext,
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

// ============================================================
// 2026-09-18 PO dispatch (fries-duplicate money bug). Real transcript, conv
// fbc7cab1: cart already holds The Slice Cheesesteak (Bread: White). The
// customer says "I want to add a side of fries, too!" — "fries" correctly
// ties ambiguous across 10 real items (unaffected here, not this fixture's
// concern), but the SAME turn's proposal also carried a second add whose
// item_span resolved, uniquely, to The Slice Cheesesteak — an item never
// named anywhere in the message. Live result: a duplicate $13.99 line with
// its own unresolved Bread slot, and the bread question restarted.
// ============================================================
const SLICE_CHEESESTEAK_ID = "item-slice-cheesesteak";
const FRIES_MENU: TurnEngineMenuItem[] = [
  {
    id: SLICE_CHEESESTEAK_ID, name: "The Slice Cheesesteak", category: "Hot Sandwiches", price_cents: 1399, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "The Slice Cheesesteak", base_price_cents: 1399, recap_template: "", ticket_template: "", steps: [] },
  },
];
const FRIES_LEXICON: LexiconTerm[] = [{ term: "the slice cheesesteak", target_id: SLICE_CHEESESTEAK_ID }];

// ── (a) token-based guard — 2026-09-18 two-regressions dispatch ────────────
// Original guard was an exact substring test; reordered tokens ("medium
// Hawaiian Pizza" for "a Hawaiian Pizza in medium size") always failed,
// even though every word the model used was genuinely in the message (conv
// 55c05b4c). Guard is now token-based: every span token must appear in the
// message token set, order-free.
const HAWAIIAN_PIZZA_ID = "item-hawaiian-pizza";
const HAWAIIAN_MENU: TurnEngineMenuItem[] = [
  {
    id: HAWAIIAN_PIZZA_ID, name: "Hawaiian Pizza", category: "Pizza", price_cents: 1299,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Hawaiian Pizza", base_price_cents: 1299, recap_template: "", ticket_template: "", steps: [] },
  },
];
const HAWAIIAN_LEXICON: LexiconTerm[] = [{ term: "hawaiian pizza", target_id: HAWAIIAN_PIZZA_ID }];

Deno.test("decide (a — token-based guard): reordered span tokens still resolve — 'medium Hawaiian Pizza' for 'a Hawaiian Pizza in medium size' (conv 55c05b4c)", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "medium Hawaiian Pizza", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  // "medium" is not in the lexicon (not an exact term), but it IS in the
  // message — guard passes because every span token is in the message.
  // resolveItem will match on "hawaiian pizza" subset of the span tokens.
  const result = decide(proposal, [], HAWAIIAN_MENU, HAWAIIAN_LEXICON, undefined, "a Hawaiian Pizza in medium size");
  assertEquals(result.cart.length, 1, "item must resolve — guard must not block reordered tokens");
  assertEquals(result.cart[0].menu_item_id, HAWAIIAN_PIZZA_ID);
});

Deno.test("decide (a — token-based guard): The Slice Cheesesteak still fails for a fries message — no shared tokens", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: SLICE_CHEESESTEAK_ID, name: "The Slice Cheesesteak", quantity: 1, price_cents: 1399, modifiers: [], options: { Bread: ["White"] }, line_key: "line-1" },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, cart, FRIES_MENU, FRIES_LEXICON, undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 1, "no second Slice Cheesesteak line — span tokens not in fries message");
  assertEquals(result.cart[0].quantity, 1);
  // (b): item IS in cart → guard-drop is silent, 0 declines
  assertEquals(result.declines.length, 0, "silent when guard-dropped item is already in cart");
});

// ── (b) guard-drop messaging — 2026-09-18 two-regressions dispatch ──────────
// A guard-dropped add must never say "didn't catch <span>". If the resolved
// item is already in cart → silent. Otherwise → "Did you want a X as well?"
Deno.test("decide (b — guard-drop not in cart): asks 'Did you want a X as well?' — never 'didn't catch'", () => {
  // Cart is EMPTY — cheesesteak is not in it. Guard fires (span not in
  // message). Since the item is NOT in cart, the bot must ask, not say
  // "didn't catch".
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], FRIES_MENU, FRIES_LEXICON, undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 0, "item must not be added without confirmation");
  assertEquals(result.declines.length, 1, "one decline — the bot asks");
  assert(/did you want/i.test(result.declines[0].reason), `must ask 'Did you want…': ${result.declines[0].reason}`);
  assert(!/didn'?t catch/i.test(result.declines[0].reason), `must never say 'didn't catch' for a guard drop: ${result.declines[0].reason}`);
});

// ── Commit 2, item 3 (2026-09-19, real conv #41): a guard-dropped add whose
// span FAILED TO RESOLVE must never be phrased as an actionable "as well?"
// question — "Did you want a grandma's medium 14" as well?" was asked for
// exactly this shape, the customer said "yes", and the checkout link went
// out without it, because a bare "yes" can never actually add anything
// (propose.ts's item_span must be verbatim in the CUSTOMER'S current
// message — "yes" names nothing). See turn-engine.ts's own header on this
// branch for the full mechanism.
Deno.test("decide (Commit 2, item 3): a guard-dropped add that never resolves (unresolved) gets the plain 'didn't catch' wording, never 'as well?'", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "grandma's medium 14 inch pizza", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  // Empty lexicon: the span can never resolve to anything, real or not.
  const result = decide(proposal, [], FRIES_MENU, [], undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 0);
  assertEquals(result.declines.length, 1);
  assert(!/as well/i.test(result.declines[0].reason), `must never phrase an unresolved span as "as well?": ${result.declines[0].reason}`);
  assert(/didn'?t catch/i.test(result.declines[0].reason), `must say it couldn't be found/understood: ${result.declines[0].reason}`);
  assert(result.declines[0].reason.includes("grandma's medium 14 inch pizza"), "the reply must name the actual span");
  assertEquals(result.unresolvedSpans, ["grandma's medium 14 inch pizza"], "carried forward so the next turn's prompt still knows about it");
});

Deno.test("decide (Commit 2, item 3): a guard-dropped add that resolves AMBIGUOUSLY also gets the plain wording, never 'as well?'", () => {
  const AMBIG_A = "item-ambig-a";
  const AMBIG_B = "item-ambig-b";
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "chicken parm", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const lexicon: LexiconTerm[] = [
    { term: "chicken parm", target_id: AMBIG_A },
    { term: "chicken parm", target_id: AMBIG_B },
  ];
  const result = decide(proposal, [], FRIES_MENU, lexicon, undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 0);
  assertEquals(result.declines.length, 1);
  assert(!/as well/i.test(result.declines[0].reason), `must never phrase an ambiguous span as "as well?": ${result.declines[0].reason}`);
  assertEquals(result.unresolvedSpans, ["chicken parm"]);
});

Deno.test("decide (Commit 2, item 3): a guard-dropped add that DOES resolve to a real item says to restate it, not just a bare 'as well?' implying yes suffices", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], FRIES_MENU, FRIES_LEXICON, undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 0, "not added without the customer actually restating it");
  assertEquals(result.declines.length, 1);
  assert(/did you want/i.test(result.declines[0].reason));
  assert(/say it again/i.test(result.declines[0].reason), `must say what's needed for it to actually be added, not just "as well?": ${result.declines[0].reason}`);
  assertEquals(result.unresolvedSpans, ["The Slice Cheesesteak"]);
});

Deno.test("decide: an add whose item_span never occurs in the customer's message is dropped when item IS in cart — silent (no decline)", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: SLICE_CHEESESTEAK_ID, name: "The Slice Cheesesteak", quantity: 1, price_cents: 1399, modifiers: [], options: { Bread: ["White"] }, line_key: "line-1" },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, cart, FRIES_MENU, FRIES_LEXICON, undefined, "I want to add a side of fries, too!");
  assertEquals(result.cart.length, 1, "no second Slice Cheesesteak line — the span was never said this turn");
  assertEquals(result.cart[0].quantity, 1);
  assertEquals(result.declines.length, 0, "silent when guard-dropped item is already in cart — not a customer concern");
});

Deno.test("decide: an add whose item_span DOES occur in the message still resolves normally — the guard only blocks a span that was never said", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], FRIES_MENU, FRIES_LEXICON, undefined, "I'd like The Slice Cheesesteak, please.");
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, SLICE_CHEESESTEAK_ID);
});

Deno.test("decide: omitting customerMessage entirely (pre-fix call sites) never applies the verbatim guard — identical to this function's behavior before it existed", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "The Slice Cheesesteak", quantity: 1, choices: [] }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], FRIES_MENU, FRIES_LEXICON);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, SLICE_CHEESESTEAK_ID);
});

// ============================================================
// 2026-09-18 PO dispatch (self-correction money bug). Real transcript, conv
// c879937d: "Actually, can I add a side salad to that? Just the house
// salad. Thanks!" resolved BOTH Side Salad ($3.99) and House ($8.99) —
// two real, distinct, correctly-resolved items, both genuinely present in
// the message, so the verbatim guard above does not (and must not) catch
// this. The gap is recognizing "Just X" as retracting "a side salad", not
// adding to it.
// ============================================================
const SIDE_SALAD_ID = "item-side-salad";
const HOUSE_SALAD_ID = "item-house-salad";
const SALAD_MENU: TurnEngineMenuItem[] = [
  {
    id: SIDE_SALAD_ID, name: "Side Salad", category: "Appetizers", price_cents: 399, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Side Salad", base_price_cents: 399, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: HOUSE_SALAD_ID, name: "House", category: "Salads", price_cents: 899, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "House", base_price_cents: 899, recap_template: "", ticket_template: "", steps: [] },
  },
];
const SALAD_LEXICON: LexiconTerm[] = [
  { term: "side salad", target_id: SIDE_SALAD_ID },
  { term: "house salad", target_id: HOUSE_SALAD_ID },
];

Deno.test("decide: 'add a side salad... Just the house salad' -- both spans are real and genuinely said, but the correction marker means only the later one lands", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "a side salad", quantity: 1, choices: [] },
      { item_span: "the house salad", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], SALAD_MENU, SALAD_LEXICON, undefined, "Actually, can I add a side salad to that? Just the house salad. Thanks!");
  assertEquals(result.cart.length, 1, `only the corrected item must land — cart: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, HOUSE_SALAD_ID);
});

Deno.test("decide: two genuinely distinct adds with NO correction marker between them both land — this is not a general 'second add wins' rule", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "a side salad", quantity: 1, choices: [] },
      { item_span: "the house salad", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], SALAD_MENU, SALAD_LEXICON, undefined, "Can I get a side salad and the house salad, please?");
  assertEquals(result.cart.length, 2, `both real items must land absent a correction marker — cart: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.menu_item_id === SIDE_SALAD_ID));
  assert(result.cart.some(l => l.menu_item_id === HOUSE_SALAD_ID));
});

// ============================================================
// 2026-09-18 PO dispatch (add-on treated as a separate item, real money
// bug, every run that day): "house salad w/ black diamond steak" applied
// the $8.00 Black Diamond Steak add-on to House correctly AND ALSO added a
// separate $12.49 "Steak" Quesadilla line. Same shape with "2 turkey
// hoagies w/ black diamond steak" -> a bogus "2x Steak" $24.98 line.
// Customers paid both. Fixtures below mirror the real menu shape: House
// (Salads) and Turkey Hoagie (Sandwiches) both carry a "Protein Add-on"
// modifier group with a "Black Diamond Steak" choice; Quesadillas' own
// "Steak" item is a completely separate, real dish the same word also
// names — exactly the lexicon collision the PO's own diagnosis describes.
// ============================================================
const ADDON_HOUSE_SALAD_ID = "item-addon-house-salad";
const ADDON_TURKEY_HOAGIE_ID = "item-addon-turkey-hoagie";
const ADDON_STEAK_QUESADILLA_ID = "item-addon-steak-quesadilla";
const ADDON_CHICKEN_ID = "item-addon-chicken";
const ADDON_PROTEIN_GROUP_ID = "group-addon-protein";
const ADDON_HOAGIE_PROTEIN_GROUP_ID = "group-addon-hoagie-protein";
const ADDON_CHEESESTEAK_SANDWICH_ID = "item-addon-chicken-cheesesteak-sandwich";

function proteinAddOnStep(groupId: string) {
  return {
    group_id: groupId, slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
    prompt_template: "protein_addon.on_request",
    choices: [
      { id: "choice-black-diamond-steak", display: "Black Diamond Steak", price_delta_cents: 800 },
      { id: "choice-grilled-chicken", display: "Chicken", price_delta_cents: 300 },
    ],
  };
}

const ADDON_MENU: TurnEngineMenuItem[] = [
  {
    id: ADDON_HOUSE_SALAD_ID, name: "House", category: "Salads", price_cents: 899, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "House", base_price_cents: 899,
      recap_template: "", ticket_template: "", steps: [proteinAddOnStep(ADDON_PROTEIN_GROUP_ID)],
    },
  },
  {
    id: ADDON_TURKEY_HOAGIE_ID, name: "Turkey Hoagie", category: "Sandwiches", price_cents: 1099, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Turkey Hoagie", base_price_cents: 1099,
      recap_template: "", ticket_template: "", steps: [proteinAddOnStep(ADDON_HOAGIE_PROTEIN_GROUP_ID)],
    },
  },
  {
    id: ADDON_STEAK_QUESADILLA_ID, name: "Steak", category: "Quesadillas", price_cents: 1249, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Steak", base_price_cents: 1249, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: ADDON_CHICKEN_ID, name: "Chicken", category: "Entrees", price_cents: 999, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Chicken", base_price_cents: 999, recap_template: "", ticket_template: "", steps: [] },
  },
  // 2026-09-19 P0 (phantom money, real live bug): a choice/add-on name
  // ("Chicken") that is literally one WORD inside a DIFFERENT item's full
  // name ("Chicken Cheesesteak Sandwich") — the exact shape that made the
  // whole $11.99 sandwich silently vanish, no decline, no trace. See
  // ADDON_CHEESESTEAK_SANDWICH_ID's tests below.
  {
    id: ADDON_CHEESESTEAK_SANDWICH_ID, name: "Chicken Cheesesteak Sandwich", category: "Sandwiches", price_cents: 1199, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Chicken Cheesesteak Sandwich", base_price_cents: 1199, recap_template: "", ticket_template: "", steps: [] },
  },
];
const ADDON_LEXICON: LexiconTerm[] = [
  { term: "house salad", target_id: ADDON_HOUSE_SALAD_ID },
  { term: "house", target_id: ADDON_HOUSE_SALAD_ID },
  { term: "turkey hoagie", target_id: ADDON_TURKEY_HOAGIE_ID },
  { term: "turkey hoagies", target_id: ADDON_TURKEY_HOAGIE_ID },
  { term: "steak", target_id: ADDON_STEAK_QUESADILLA_ID },
  { term: "steak quesadilla", target_id: ADDON_STEAK_QUESADILLA_ID },
  { term: "chicken", target_id: ADDON_CHICKEN_ID },
  { term: "chicken cheesesteak sandwich", target_id: ADDON_CHEESESTEAK_SANDWICH_ID },
];

Deno.test("decide (add-on as item, real transcript 1): 'house salad w/ black diamond steak' -> ONE House line with the add-on applied, no separate Steak line", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "house salad", quantity: 1, choices: [] },
      { item_span: "black diamond steak", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ADDON_MENU, ADDON_LEXICON, undefined, "house salad w/ black diamond steak");
  assertEquals(result.cart.length, 1, `must be exactly one line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, ADDON_HOUSE_SALAD_ID);
  assertEquals(result.cart[0].ask_plan_selections, { [ADDON_PROTEIN_GROUP_ID]: "choice-black-diamond-steak" }, "the add-on must be applied to the House line");
  assert(!result.cart.some(l => l.menu_item_id === ADDON_STEAK_QUESADILLA_ID), "no separate Steak Quesadilla line");
});

Deno.test("decide (add-on as item, real transcript 2): '2 turkey hoagies w/ black diamond steak' -> ONE Turkey Hoagie line (qty 2) with the add-on, no separate Steak line", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "turkey hoagies", quantity: 2, choices: [] },
      { item_span: "black diamond steak", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ADDON_MENU, ADDON_LEXICON, undefined, "2 turkey hoagies w/ black diamond steak");
  assertEquals(result.cart.length, 1, `must be exactly one line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, ADDON_TURKEY_HOAGIE_ID);
  assertEquals(result.cart[0].quantity, 2);
  assertEquals(result.cart[0].ask_plan_selections, { [ADDON_HOAGIE_PROTEIN_GROUP_ID]: "choice-black-diamond-steak" }, "the add-on must be applied to the Turkey Hoagie line");
  assert(!result.cart.some(l => l.menu_item_id === ADDON_STEAK_QUESADILLA_ID), "no separate Steak Quesadilla line");
});

// ============================================================
// 2026-09-18 PO dispatch (add-on rule edge, real conv 9fc0fad9): "I want an
// Italian wrap with chicken, please. Wheat tortilla." split into "Italian"
// (ambiguous — Vito's really has both Italian Wraps and Italian Homemade
// Paninis) and "chicken" (its own $12.49 Chicken Entree). Chicken is a real
// modifier choice on BOTH Italian candidates, per the real ask_plan pulled
// from the DB — dropAddsThatAreReallyModifiersOfAnotherAdd only checks
// resolved siblings, so it never got a chance to catch this one.
// ============================================================
const ITALIAN_WRAP_ID = "item-italian-wrap";
const ITALIAN_PANINI_ID = "item-italian-panini";
const CHICKEN_ENTREE_ID = "item-chicken-entree";
const ITALIAN_PROTEIN_GROUP_ID = "group-italian-protein";

function italianProteinStep(groupId: string) {
  return {
    group_id: groupId, slot_key: null, kind: "modifier" as const, ask_mode: "on_request" as const,
    prompt_template: "protein_addon.on_request",
    choices: [
      { id: "choice-black-diamond-steak", display: "Black Diamond Steak", price_delta_cents: 800 },
      { id: "choice-shrimp", display: "Shrimp", price_delta_cents: 500 },
      { id: "choice-blackened-salmon", display: "Blackened Salmon", price_delta_cents: 600 },
      { id: "choice-chicken", display: "Chicken", price_delta_cents: 300 },
    ],
  };
}

const ITALIAN_MENU: TurnEngineMenuItem[] = [
  {
    id: ITALIAN_WRAP_ID, name: "Italian Wrap", category: "Wraps", price_cents: 899, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Italian Wrap", base_price_cents: 899,
      recap_template: "", ticket_template: "", steps: [italianProteinStep(ITALIAN_PROTEIN_GROUP_ID)],
    },
  },
  {
    id: ITALIAN_PANINI_ID, name: "Italian Homemade Panini", category: "Paninis", price_cents: 999, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Italian Homemade Panini", base_price_cents: 999,
      recap_template: "", ticket_template: "", steps: [italianProteinStep(ITALIAN_PROTEIN_GROUP_ID)],
    },
  },
  {
    id: CHICKEN_ENTREE_ID, name: "Chicken", category: "Entrees", price_cents: 1249, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Chicken", base_price_cents: 1249, recap_template: "", ticket_template: "", steps: [] },
  },
];
const ITALIAN_LEXICON: LexiconTerm[] = [
  { term: "italian wrap", target_id: ITALIAN_WRAP_ID },
  { term: "italian", target_id: ITALIAN_WRAP_ID },
  { term: "italian", target_id: ITALIAN_PANINI_ID },
  { term: "italian homemade panini", target_id: ITALIAN_PANINI_ID },
  { term: "italian panini", target_id: ITALIAN_PANINI_ID },
  { term: "chicken", target_id: CHICKEN_ENTREE_ID },
];

Deno.test("decide (add-on rule edge, real conv 9fc0fad9): 'Italian' + 'chicken' — Italian is ambiguous, chicken is a modifier choice of every candidate — held, not added as its own item", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "Italian", quantity: 1, choices: [] },
      { item_span: "chicken", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ITALIAN_MENU, ITALIAN_LEXICON, undefined, "I want an Italian wrap with chicken, please. Wheat tortilla.");
  assertEquals(result.cart.length, 0, `nothing resolves to the cart yet — Italian is still ambiguous: ${JSON.stringify(result.cart)}`);
  assert(!result.cart.some(l => l.menu_item_id === CHICKEN_ENTREE_ID), "no separate Chicken entree line");
  assertEquals(
    [...result.disambiguationCandidateIds ?? []].sort(),
    [ITALIAN_PANINI_ID, ITALIAN_WRAP_ID].sort(),
    "Italian must still surface as the disambiguation",
  );
  assertEquals(result.heldModifierText, "chicken", "the chicken span must be held, not dropped or added as its own item");
});

Deno.test("answer (add-on rule edge, real conv 9fc0fad9): picking 'Wrap' after the held modifier applies Chicken to the Italian Wrap line, no separate Chicken item", () => {
  const state: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [ITALIAN_WRAP_ID, ITALIAN_PANINI_ID], heldModifierText: "chicken" },
    upsell_offered: false,
    asked_message_id: null,
  };
  const cart: TurnEngineCartLine[] = [];
  const result = answer(state, cart, "Wrap", ITALIAN_MENU);
  assert(result.resolved, "the Wrap/Panini disambiguation must resolve");
  assert(result.cartChanged);
  assertEquals(cart.length, 1, `must be exactly one line: ${JSON.stringify(cart)}`);
  assertEquals(cart[0].menu_item_id, ITALIAN_WRAP_ID);
  assertEquals(cart[0].ask_plan_selections, { [ITALIAN_PROTEIN_GROUP_ID]: "choice-chicken" }, "Chicken must be applied as the Italian Wrap's own add-on");
  assert(!cart.some(l => l.menu_item_id === CHICKEN_ENTREE_ID), "no separate Chicken entree line");
});

Deno.test("decide (add-on as item, acceptance 3): 'a steak quesadilla and a house salad' -> TWO real lines, no add-on — nothing in the message has a group Steak's own span could be read as a choice of", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "a steak quesadilla", quantity: 1, choices: [] },
      { item_span: "a house salad", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ADDON_MENU, ADDON_LEXICON, undefined, "a steak quesadilla and a house salad");
  assertEquals(result.cart.length, 2, `both real, distinct items must land: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.menu_item_id === ADDON_STEAK_QUESADILLA_ID), "Steak Quesadilla must still be its own line");
  const houseLine = result.cart.find(l => l.menu_item_id === ADDON_HOUSE_SALAD_ID);
  assert(houseLine, "House must still be its own line");
  assert(
    !houseLine!.ask_plan_selections || !(ADDON_PROTEIN_GROUP_ID in houseLine!.ask_plan_selections),
    `no add-on — 'steak quesadilla' was never a modifier claim on House: ${JSON.stringify(houseLine!.ask_plan_selections)}`,
  );
});

Deno.test("decide (add-on as item, acceptance 4): 'house salad with chicken' -> House + Chicken add-on applied, no separate Chicken item line", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "house salad", quantity: 1, choices: [] },
      { item_span: "chicken", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ADDON_MENU, ADDON_LEXICON, undefined, "house salad with chicken");
  assertEquals(result.cart.length, 1, `must be exactly one line: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, ADDON_HOUSE_SALAD_ID);
  assertEquals(result.cart[0].ask_plan_selections, { [ADDON_PROTEIN_GROUP_ID]: "choice-grilled-chicken" }, "the Chicken add-on must be applied to the House line");
  assert(!result.cart.some(l => l.menu_item_id === ADDON_CHICKEN_ID), "no separate Chicken item line");
});

// ============================================================
// 2026-09-19 P0 (phantom money, real live bug, deterministic 3/3 offline
// and live): "a chicken cheesesteak sandwich and a house salad" -> the
// resolved $11.99 sandwich silently vanished -- no decline, no trace, not
// applied as anyone's add-on either. Root cause: House's own "Chicken"
// add-on choice is a bare WORD inside the sandwich's full resolved span,
// and dropAddsThatAreReallyModifiersOfAnotherAdd used to drop on ANY
// substring/stem-subset match (matchChoiceInText) instead of requiring the
// whole span to BE the choice's name. Fixed via matchChoiceAsWholeSpan
// (stem-set equality) -- see turn-engine.ts's header comment on that
// function call for the "longest match wins" reasoning.
// ============================================================
Deno.test("decide (P0 phantom money): 'a chicken cheesesteak sandwich and a house salad' -> TWO real lines, sandwich never dropped as a modifier of House's 'Chicken' choice", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "chicken cheesesteak sandwich", quantity: 1, choices: [] },
      { item_span: "house salad", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], ADDON_MENU, ADDON_LEXICON, undefined, "a chicken cheesesteak sandwich and a house salad");
  assertEquals(result.cart.length, 2, `both real, distinct items must land: ${JSON.stringify(result.cart)}`);
  assert(result.cart.some(l => l.menu_item_id === ADDON_CHEESESTEAK_SANDWICH_ID), "Chicken Cheesesteak Sandwich must still be its own line");
  const houseLine = result.cart.find(l => l.menu_item_id === ADDON_HOUSE_SALAD_ID);
  assert(houseLine, "House must still be its own line");
  assert(
    !houseLine!.ask_plan_selections || !(ADDON_PROTEIN_GROUP_ID in houseLine!.ask_plan_selections),
    `no add-on -- 'chicken cheesesteak sandwich' is a real item, not a modifier claim on House: ${JSON.stringify(houseLine!.ask_plan_selections)}`,
  );
  assertEquals(result.unresolvedSpans, [], "the sandwich must not be recorded as dropped/unresolved either");
});

Deno.test("decide (P0 phantom money, ambiguous sibling shape): 'a chicken cheesesteak sandwich and a garden salad' -> sandwich survives, garden salad's own (unrelated) ambiguity is untouched", () => {
  const AMBIGUOUS_SALAD_A = "item-ambiguous-salad-a";
  const AMBIGUOUS_SALAD_B = "item-ambiguous-salad-b";
  const menu: TurnEngineMenuItem[] = [
    ...ADDON_MENU,
    { id: AMBIGUOUS_SALAD_A, name: "Garden - Small", category: "Salads", price_cents: 699, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Garden - Small", base_price_cents: 699, recap_template: "", ticket_template: "", steps: [] } },
    { id: AMBIGUOUS_SALAD_B, name: "Garden - Large", category: "Salads", price_cents: 999, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Garden - Large", base_price_cents: 999, recap_template: "", ticket_template: "", steps: [] } },
  ];
  const lexicon: LexiconTerm[] = [
    ...ADDON_LEXICON,
    { term: "garden salad", target_id: AMBIGUOUS_SALAD_A },
    { term: "garden salad", target_id: AMBIGUOUS_SALAD_B },
  ];
  const proposal: Proposal = {
    intent: "order",
    adds: [
      { item_span: "chicken cheesesteak sandwich", quantity: 1, choices: [] },
      { item_span: "garden salad", quantity: 1, choices: [] },
    ],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], menu, lexicon, undefined, "a chicken cheesesteak sandwich and a garden salad");
  assert(result.cart.some(l => l.menu_item_id === ADDON_CHEESESTEAK_SANDWICH_ID), `sandwich must survive, not be held as a modifier of the ambiguous salad: ${JSON.stringify(result.cart)}`);
  assertEquals(
    [...result.disambiguationCandidateIds ?? []].sort(),
    [AMBIGUOUS_SALAD_A, AMBIGUOUS_SALAD_B].sort(),
    "garden salad's own, unrelated ambiguity must still surface",
  );
  assertEquals(result.heldModifierText, null, "the sandwich's span must never be held as a modifier text");
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
const WINGS_BBQ_CHOICE_ID = "88b27a65-d800-4d2a-a63b-42946330c76a";
// Synthetic, non-colliding second group (00-BK, 2026-09-15): the real
// "Quantity" group (10|20 Pieces) is now in the numeric-stem collision set —
// a structured {group_id, choice_id} assertion for it is deliberately never
// trusted by decide()'s add path anymore (that is the fix this test would
// otherwise contradict). Swapped for a synthetic "Choose Bread" group (2
// choices, distinct non-numeric words) so this test still exercises its
// real contract — a structured proposal resolving BOTH of an item's groups
// in one shot, not choice-identity trust. Fixture ids and names only; the
// assertion shape is unchanged.
const WINGS_BREAD_GROUP_ID = "grp-bread-00bk";
const WINGS_WHITE_BREAD_ID = "choice-white-bread-00bk";

const WINGS_MENU: TurnEngineMenuItem[] = [
  {
    id: WINGS_ID,
    name: "Boneless Wings",
    category: "Wings",
    price_cents: 1000,
    bot_state: "orderable",
    option_groups: [
      { id: WINGS_FLAVOR_GROUP_ID, name: "Choose Sauce", default_choice_id: null },
      { id: WINGS_BREAD_GROUP_ID, name: "Choose Bread", default_choice_id: null },
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
          kind: "slot", ask_mode: "ask", group_id: WINGS_BREAD_GROUP_ID, slot_key: null, prompt_template: "bread.ask",
          choices: [
            { id: WINGS_WHITE_BREAD_ID, display: "White Bread", price_delta_cents: 0 },
            { id: "choice-wheat-bread-00bk", display: "Wheat Bread", price_delta_cents: 0 },
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
        { group_id: WINGS_BREAD_GROUP_ID, choice_id: WINGS_WHITE_BREAD_ID },
      ],
    }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], WINGS_MENU, WINGS_LEXICON);
  assertEquals(result.declines, []);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].menu_item_id, WINGS_ID);
  assertEquals(result.cart[0].options, { "Choose Sauce": ["BBQ Sauce"], "Choose Bread": ["White Bread"] });
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
        const msgId = table === "messages" ? `msg-${state.messagesInserted.length}` : null;
        // Support both `await ...insert(r)` (plain-await callers) and
        // `await ...insert(r).select("id").single()` (persistTurn/saveMessage).
        return {
          select: (_cols: unknown) => ({
            single: () => Promise.resolve({ data: { id: msgId }, error: null }),
          }),
          then(resolve: (v: { error: null }) => void, reject?: (e: unknown) => void) {
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
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

// ── Acceptance test 2 (2026-09-15, deploy 2a852f9b live bug): the FULL
// closure matrix — every `state.open.kind` crossed with every closure/
// affirmation phrase, not just order_type. The original 00-AA fix
// (0ffd5373) only wired closureOrAffirmationFallback into the five
// non-slot kinds, reasoning that slot/disambiguation/upsell already had
// their own closure-shaped resolution — true for disambiguation and
// upsell, false for slot (a slot question has no decline concept at all).
// "thats it" while a Temp slot was open reached PROPOSE exactly like the
// original bug and let the model add a THIRD Cheese Burger line. The
// dispatch's own wording — "regardless of which question is open" — is a
// closed list with NO exceptions, so this covers all six kinds x all five
// phrases (30 combinations): PROPOSE must never be called and the cart must
// never change, for every single one.

const CLOSURE_MATRIX_PHRASES = ["thats it", "that's all", "im done", "no thanks", "yes"];

const CLOSURE_MATRIX_FRIES_ID = "closure-matrix-fries";
const CLOSURE_MATRIX_MENU: TurnEngineMenuItem[] = [
  ...VITOS_MENU,
  {
    id: CLOSURE_MATRIX_FRIES_ID, name: "French Fries", price_cents: 499, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "French Fries", base_price_cents: 499, recap_template: "", ticket_template: "", steps: [] },
  },
];

function closureMatrixResolvedBurgerCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID } },
  ];
}

function closureMatrixPendingSlotCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: undefined, ask_plan_selections: {}, line_key: "closure-matrix-slot-line" },
  ];
}

interface ClosureMatrixFixture { kind: string; openState: DialogueState; cart: TurnEngineCartLine[] }

const CLOSURE_MATRIX_FIXTURES: ClosureMatrixFixture[] = [
  {
    kind: "slot",
    openState: { phase: "ordering", open: { kind: "slot", line_key: "closure-matrix-slot-line", group_id: TEMP_GROUP_ID }, upsell_offered: false, asked_message_id: null },
    cart: closureMatrixPendingSlotCart(),
  },
  {
    kind: "disambiguation",
    openState: { phase: "ordering", open: { kind: "disambiguation", candidates: [CHEESE_BURGER_ID, CLOSURE_MATRIX_FRIES_ID] }, upsell_offered: false, asked_message_id: null },
    cart: [],
  },
  {
    kind: "upsell",
    openState: { phase: "ordering", open: { kind: "upsell", menu_item_id: CLOSURE_MATRIX_FRIES_ID }, upsell_offered: true, asked_message_id: null },
    cart: closureMatrixResolvedBurgerCart(),
  },
  {
    kind: "order_type",
    openState: { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null },
    cart: closureMatrixResolvedBurgerCart(),
  },
  {
    kind: "name",
    openState: { phase: "name", open: { kind: "name" }, upsell_offered: false, asked_message_id: null },
    cart: closureMatrixResolvedBurgerCart(),
  },
  {
    kind: "confirm",
    openState: { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null },
    cart: closureMatrixResolvedBurgerCart(),
  },
];

for (const fixture of CLOSURE_MATRIX_FIXTURES) {
  for (const phrase of CLOSURE_MATRIX_PHRASES) {
    Deno.test(`closure matrix: "${phrase}" while ${fixture.kind} is open never reaches PROPOSE and never mutates the cart`, async () => {
      const { supabase } = makeMinimalFakeSupabase();
      let proposeCalls = 0;
      const deps: RunTurnDeps = {
        supabase,
        apiKey: "test-key",
        proposeTurnFn: () => {
          proposeCalls++;
          return Promise.reject(new Error(`PROPOSE must never be called for "${phrase}" while ${fixture.kind} is open`));
        },
      };
      const cartBefore = JSON.parse(JSON.stringify(fixture.cart));
      const input: RunTurnInput = {
        conversationId: "conv-1",
        shopId: "shop-1",
        tenantId: "tenant-1",
        cartId: "cart-1",
        message: phrase,
        history: [],
        menu: CLOSURE_MATRIX_MENU,
        cart: JSON.parse(JSON.stringify(fixture.cart)),
        dialogueState: fixture.openState,
        shopContext: { deliveryEnabled: true, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
      };

      const result = await runTurnEngineTurn(input, deps);

      assertEquals(proposeCalls, 0, `PROPOSE must never be called for "${phrase}" while ${fixture.kind} is open`);
      // "yes" while `upsell` is open is the one cell in this matrix that is
      // NOT a closure — impliesUpsellAcceptance's own real, correct
      // resolution (same standing as "no thanks" genuinely resolving a
      // `tip` question to $0, or a real Temp answer resolving a `slot`) —
      // so the cart is SUPPOSED to grow by the offered item here. Every
      // other cell, including "no thanks" for this same `upsell` kind (a
      // genuine decline, not a closure fallback catch either, but still
      // cart-inert), must leave the cart completely untouched.
      if (fixture.kind === "upsell" && phrase === "yes") {
        assertEquals(result.cart.length, cartBefore.length + 1, `"yes" must accept the upsell and add the offered item, not silently no-op`);
      } else {
        assertEquals(result.cart, cartBefore, `the cart must never change for "${phrase}" while ${fixture.kind} is open`);
      }
    });
  }
}

// ── Dispatch 00-AK (live bug, conv 70c7c02a, 2026-09-16) — "Anything else?"
// asked over an EMPTY cart is a dead end ────────────────────────────────────
//
// Defect 1: once every pre-order slot resolves (order_type, address, tip)
// with NOTHING ever added to the cart, ASK's "not committed to close"
// branch (turn-engine.ts ask(), priority 7) returned `open: null`
// regardless of cart contents — RENDER's own fallback for that shape is
// unconditionally "Anything else?" (`state.phase !== "link_sent"`), a
// question that presupposes a first item already exists.
//
// Defect 2: because the cart never changes and the open state never changes
// either, ANY reply — including a genuine protest like "I didn't order
// anything yet" — falls through ANSWER unresolved, PROPOSE adds nothing,
// and ASK re-derives the identical `open: null` again next turn: the exact
// same "Anything else?" forever. The PO's own replay script never caught
// this because it always answered "a cheeseburger" on the turn after the
// address regardless of what the bot asked, walking straight past the dead
// end; a real customer stops and argues instead, which is why this only
// surfaced live.
//
// `(dialogueState.open as any)?.kind` is used below (rather than a typed
// literal comparison) so these assertions compile identically before AND
// after DialogueState's `open` union gains its new "ordering" member —
// the RED run must fail on the ASSERTION, never on a TypeScript compile
// error that would obscure which check actually failed.

function neverProposeFn(label: string) {
  return () => Promise.reject(new Error(`PROPOSE must never be called for a deterministic ${label} resolution`));
}

Deno.test("00-AK defect 1 (delivery): address resolves into an EMPTY cart -> ASK asks the ordering question, never the closure question", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    geocodeAddressFn: () => Promise.resolve({ formatted: "5620 Cetronia Rd, Allentown, PA 18106", withinZone: true }),
    proposeTurnFn: neverProposeFn("address"),
  };
  const priorState: DialogueState = { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null };
  const input: RunTurnInput = {
    conversationId: "conv-70c7c02a",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message: "5620 cetronia rd allentown pa 18106",
    history: [],
    menu: VITOS_MENU,
    cart: [],
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: 0, pickupName: null, deliveryFeeCents: 0 },
  };

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "cart must still be empty — nothing was ever ordered");
  assert(!result.reply.includes("Anything else?"), `must not ask the closure question over an empty cart: ${JSON.stringify(result.reply)}`);
  assert(/what would you like to order/i.test(result.reply), `must ask the ordering question instead: ${JSON.stringify(result.reply)}`);
  const openKind = (result.dialogueState.open as { kind?: string } | null)?.kind;
  assertEquals(openKind, "ordering", `dialogue_state.open must be the ordering question, not stuck on a closure/confirm slot (got ${JSON.stringify(result.dialogueState.open)})`);
  assertEquals(result.dialogueState.phase, "ordering", "phase must not have walked toward checkout with an empty cart");
});

Deno.test("00-AK defect 1 (pickup): order type resolves to pickup into an EMPTY cart -> ASK asks the ordering question, never the closure question", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: neverProposeFn("order_type"),
  };
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const input: RunTurnInput = {
    conversationId: "conv-pickup-empty",
    shopId: "shop-1",
    tenantId: "tenant-1",
    cartId: "cart-1",
    message: "pickup",
    history: [],
    menu: VITOS_MENU,
    cart: [],
    dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(result.cart.length, 0, "cart must still be empty — nothing was ever ordered");
  assert(!result.reply.includes("Anything else?"), `must not ask the closure question over an empty cart: ${JSON.stringify(result.reply)}`);
  assert(/what would you like to order/i.test(result.reply), `must ask the ordering question instead: ${JSON.stringify(result.reply)}`);
  const openKind = (result.dialogueState.open as { kind?: string } | null)?.kind;
  assertEquals(openKind, "ordering", `dialogue_state.open must be the ordering question, not stuck on a closure/confirm slot (got ${JSON.stringify(result.dialogueState.open)})`);
  assertEquals(result.dialogueState.phase, "ordering", "phase must not have walked toward checkout with an empty cart");
});

Deno.test("00-AK defect 2: three consecutive non-order replies to an empty cart never produce the identical question three times in a row", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () =>
      Promise.resolve({ ok: true, proposal: { intent: "other", adds: [], removes: [], modifies: [] }, attempts: 1 }),
  };
  const shopContext = { deliveryEnabled: true, orderType: "delivery" as const, deliveryAddressKnown: true, driverTipCents: 0, pickupName: null, deliveryFeeCents: 0 };

  // Start already parked at the dead end this fixes (empty cart, every
  // pre-order slot resolved) — exactly where conv 70c7c02a got stuck after
  // its address turn.
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };

  const replies: string[] = [];
  for (const message of ["I didn't order anything yet", "I didn't order anything", "I said I haven't ordered"]) {
    const turn = await runTurnEngineTurn({
      conversationId: "conv-70c7c02a",
      shopId: "shop-1",
      tenantId: "tenant-1",
      cartId: "cart-1",
      message,
      history: [],
      menu: VITOS_MENU,
      cart,
      dialogueState,
      shopContext,
    }, deps);
    cart = turn.cart;
    dialogueState = turn.dialogueState;
    replies.push(turn.reply);
    assertEquals(cart.length, 0, `cart must stay empty for "${message}"`);
  }

  assert(
    !(replies[0] === replies[1] && replies[1] === replies[2]),
    `the same question must not repeat identically three times in a row on an empty cart: ${JSON.stringify(replies)}`,
  );
});

// ============================================================
// 2026-09-18 PO dispatch, Jason direct: read-back before checkout. The
// confirm step must show every cart line (quantity, name, resolved
// options, its own price), order type (+ address if delivery) and name,
// before the customer can finalize — never confirm-in-the-dark.
// ============================================================

function confirmState(openRepeatCount = 0): DialogueState {
  return { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount };
}

Deno.test("render: confirm read-back — canary, one item (Cheese Burger, Temp: Medium) — one line, unchanged money footer ($8.49 + $0.99 = $9.48)", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" },
  ];
  const context: RenderContext = { orderType: "pickup", pickupName: "Jason" };
  const reply = render(cart, cart, confirmState(), [], VITOS_MENU, context);

  assertStringIncludes(reply, "Here's what I've got - I'm a bot and I sometimes get things wrong, so give it a look:");
  assertStringIncludes(reply, "Cheese Burger (Temp: Medium) $8.49");
  assertStringIncludes(reply, "Pickup, name Jason.");
  assertStringIncludes(reply, "All good?");
  assertStringIncludes(reply, "Subtotal: $8.49");
  assertStringIncludes(reply, "Service fee: $0.99");
  assertStringIncludes(reply, "Total: $9.48");
  assertEquals(reply.split("\n").filter(l => l.includes("Cheese Burger")).length, 1, "exactly one item line");
});

Deno.test("render: confirm read-back — 3 items, one with options, each on its own line with its own price", () => {
  const margherita: TurnEngineMenuItem = {
    id: "item-margherita", name: "Small Margherita Pizza", category: "Pizza", price_cents: 1295, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Small Margherita Pizza", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] },
  };
  const coke: TurnEngineMenuItem = {
    id: "item-coke", name: "Coke", category: "Drinks", price_cents: 299, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Coke", base_price_cents: 299, recap_template: "", ticket_template: "", steps: [] },
  };
  const menu = [...VITOS_MENU, margherita, coke];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "item-margherita", name: "Small Margherita Pizza", quantity: 1, price_cents: 1295, modifiers: [], line_key: "line-1" },
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 2, price_cents: 849, modifiers: [], options: { Temp: ["Medium Well"] }, ask_plan_selections: { [TEMP_GROUP_ID]: "choice-medium-well" }, line_key: "line-2" },
    { menu_item_id: "item-coke", name: "Coke", quantity: 1, price_cents: 299, modifiers: [], line_key: "line-3" },
  ];
  const context: RenderContext = { orderType: "pickup", pickupName: "Alex" };
  const reply = render(cart, cart, confirmState(), [], menu, context);

  // Quantity 1 shows no "1x" prefix — reusing renderItemizedLine's own,
  // already-established convention (see itemizer.test.ts's "plain item
  // with no options" case) exactly, not reformatting it.
  assertStringIncludes(reply, "Small Margherita Pizza $12.95");
  assertStringIncludes(reply, "2x Cheese Burger (Temp: Medium Well) $16.98");
  assertStringIncludes(reply, "Coke $2.99");
  assertStringIncludes(reply, "Pickup, name Alex.");
  const subtotalCents = 1295 + 849 * 2 + 299;
  assertStringIncludes(reply, `Subtotal: $${(subtotalCents / 100).toFixed(2)}`);
});

Deno.test("render: confirm read-back — delivery shows the address, pickup does not", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" },
  ];
  const deliveryReply = render(cart, cart, confirmState(), [], VITOS_MENU, { orderType: "delivery", pickupName: "Alex", deliveryAddress: "123 Main St" });
  assertStringIncludes(deliveryReply, "Delivery to 123 Main St, name Alex.");

  const pickupReply = render(cart, cart, confirmState(), [], VITOS_MENU, { orderType: "pickup", pickupName: "Alex", deliveryAddress: "123 Main St" });
  assertStringIncludes(pickupReply, "Pickup, name Alex.");
  assertEquals(pickupReply.includes("123 Main St"), false, "an address must never appear on a pickup order, even if one happens to be on file");
});

Deno.test("render: confirm read-back — over 480 chars splits into two messages via the marker, never truncating an item", () => {
  const cart: TurnEngineCartLine[] = Array.from({ length: 20 }, (_, i) => ({
    menu_item_id: `item-${i}`, name: `Extra Large Specialty Pizza Number ${i}`, quantity: 1, price_cents: 1999, modifiers: [], line_key: `line-${i}`,
  }));
  const context: RenderContext = { orderType: "pickup", pickupName: "Jason" };
  const reply = render(cart, cart, confirmState(), [], VITOS_MENU, context);

  const splitCount = reply.split(CONFIRM_READBACK_SPLIT_MARKER).length - 1;
  assertEquals(splitCount, 1, `must split into exactly two messages when over budget — reply: ${JSON.stringify(reply)}`);
  for (const line of cart) {
    assertStringIncludes(reply, line.name, `item "${line.name}" must appear in full, never truncated`);
  }
  const [page1] = reply.split(CONFIRM_READBACK_SPLIT_MARKER);
  assert(page1.length <= 480, `page 1 must respect the SMS budget — got ${page1.length} chars`);
});

Deno.test("render: confirm read-back — dropping options is tried before splitting", () => {
  // Enough items with options to exceed 480 chars WITH the parentheses, but
  // fit once they're dropped — must land on the "drop options" branch, not
  // the split marker.
  const cart: TurnEngineCartLine[] = Array.from({ length: 8 }, (_, i) => ({
    menu_item_id: `item-${i}`, name: `Item ${i}`, quantity: 1, price_cents: 999, modifiers: [`Some Long Option Name Number ${i}`], line_key: `line-${i}`,
  }));
  const context: RenderContext = { orderType: "pickup", pickupName: "Jason" };
  const reply = render(cart, cart, confirmState(), [], VITOS_MENU, context);

  assertEquals(reply.includes(CONFIRM_READBACK_SPLIT_MARKER), false, "must not need to split once options are dropped");
  assertEquals(reply.includes("Some Long Option Name"), false, "options must be dropped before splitting is ever considered");
  for (const line of cart) assertStringIncludes(reply, line.name);
});

Deno.test("render: confirm read-back is shown ONCE per cycle — a repeat re-ask is the short prompt, not the full read-back again", () => {
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" },
  ];
  const context: RenderContext = { orderType: "pickup", pickupName: "Jason" };

  const first = render(cart, cart, confirmState(0), [], VITOS_MENU, context);
  assertStringIncludes(first, "Here's what I've got");

  const repeat = render(cart, cart, confirmState(1), [], VITOS_MENU, context);
  assertEquals(repeat.includes("Here's what I've got"), false, "the full read-back must not repeat on the same cycle");
  assertStringIncludes(repeat, "All good — confirm?");
});

// ── ask(): restatement while confirm is open (2026-09-18 PO dispatch) ────

const CONFIRM_SHOP_CONTEXT: AskShopContext = {
  deliveryEnabled: false, upsellEnabled: false, orderTypeKnown: true, orderTypeIsDelivery: false,
  deliveryAddressKnown: true, driverTipKnown: true, pickupNameKnown: true,
};

function confirmTurnEvents(overrides: Partial<AskTurnEvents> = {}): AskTurnEvents {
  return {
    qualifyingAddMenuItemId: null, disambiguationCandidateIds: null, carriedDisambiguationCandidateIds: [],
    disambiguationSettledThisTurn: false, checkoutIntentThisTurn: false, confirmYes: false, confirmNo: false,
    ...overrides,
  };
}

Deno.test("ask: a restatement matching the cart, while confirm is open, proceeds as a yes (link_sent)", () => {
  const priorState: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
  const next = ask(
    [{ menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" }],
    priorState, confirmTurnEvents(), CONFIRM_SHOP_CONTEXT, VITOS_MENU,
    "So that's the Cheese Burger for pickup, right?",
  );
  assertEquals(next.open, null);
  assertEquals(next.phase, "link_sent");
});

Deno.test("ask: a restatement naming a NEW item (an addition marker) does not auto-confirm — falls through to the normal path instead", () => {
  const priorState: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
  const next = ask(
    [{ menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" }],
    priorState, confirmTurnEvents(), CONFIRM_SHOP_CONTEXT, VITOS_MENU,
    "So that's the Cheese Burger, and also a Coke.",
  );
  assertEquals(next.phase, "confirm");
  assertEquals(next.open, { kind: "confirm" }, "must not silently finalize when the message also names something new");
});

Deno.test("ask: a restatement-shaped message does NOT confirm if something was actually added or is pending disambiguation this same turn", () => {
  const priorState: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [{ menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" }];

  const withQualifyingAdd = ask(cart, priorState, confirmTurnEvents({ qualifyingAddMenuItemId: CHEESE_BURGER_ID }), CONFIRM_SHOP_CONTEXT, VITOS_MENU, "So that's the Cheese Burger.");
  assertEquals(withQualifyingAdd.phase, "confirm", "a genuine add landing this turn must not be masked by the restatement shortcut");

  // A fresh ambiguous span outranks confirm entirely via ask()'s own
  // existing priority order (disambiguation is priority 2, confirm is
  // priority 8) — this never even reaches the new restatement check, which
  // is itself the safety property: the guard doesn't need to fire because
  // priority order already prevents the bad outcome.
  const withAmbiguous = ask(cart, priorState, confirmTurnEvents({ disambiguationCandidateIds: ["a", "b"] }), CONFIRM_SHOP_CONTEXT, VITOS_MENU, "So that's the Cheese Burger.");
  assertEquals(withAmbiguous.open, { kind: "disambiguation", candidates: ["a", "b"] }, "a fresh ambiguous span this turn must win priority over confirm, never be masked");
});

Deno.test("ask: isRestatementOfExistingOrder is never consulted outside confirm — a restatement-shaped message while some OTHER question is open behaves exactly as before", () => {
  const priorState: DialogueState = { phase: "ordering", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null };
  const cart: TurnEngineCartLine[] = [{ menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" }];
  // deliveryEnabled: true — order_type must genuinely be this turn's
  // priority question (ask()'s priority 3 is itself gated on
  // deliveryEnabled; a pickup-only shop never asks it at all).
  const shopContext: AskShopContext = { ...CONFIRM_SHOP_CONTEXT, deliveryEnabled: true, orderTypeKnown: false };
  const next = ask(cart, priorState, confirmTurnEvents(), shopContext, VITOS_MENU, "So that's the Cheese Burger for pickup, right?");
  assertEquals(next.open, { kind: "order_type" }, "a restatement while order_type is open must not be treated as a checkout confirmation");
});

// ============================================================
// 2026-09-18 PO dispatch (address loop, run 181417: address asked 14x
// across 3 conversations). While address is open: "can I just pick it up?",
// "forget it, just cancel", and a repeated/different address all got the
// identical "I couldn't find that" line, forever. Four rules, tested below.
// ============================================================

const ADDRESS_OPEN_STATE: DialogueState = { phase: "address", open: { kind: "address" }, upsell_offered: false, asked_message_id: null };
const ADDRESS_CART: TurnEngineCartLine[] = [
  { menu_item_id: CHEESE_BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [], options: { Temp: ["Medium"] }, ask_plan_selections: { [TEMP_GROUP_ID]: MEDIUM_CHOICE_ID }, line_key: "line-1" },
];
const ADDRESS_SHOP_CONTEXT: AskShopContext = {
  deliveryEnabled: true, upsellEnabled: true, orderTypeKnown: true, orderTypeIsDelivery: true,
  deliveryAddressKnown: false, driverTipKnown: false, pickupNameKnown: false,
};

// ── Rule 1: an order-type answer while address is open resolves pickup and
// closes the address question, without ever attempting a geocode. ─────────

for (const phrase of ["can I just pick it up?", "pickup instead", "make it pickup"]) {
  Deno.test(`answer (address loop, rule 1): "${phrase}" while address is open resolves order_type=pickup, not an address`, () => {
    const result = answer(ADDRESS_OPEN_STATE, [...ADDRESS_CART], phrase, VITOS_MENU);
    assertEquals(result, { resolved: true, outcome: { kind: "order_type_resolved", orderType: "pickup" }, cartChanged: false });
  });
}

Deno.test("ask (address loop, rule 1): after pickup resolves the address question, ask() never re-opens address — orderTypeIsDelivery flips false", () => {
  // sideEffects.order_type = "pickup" this turn — mirrors what
  // turn-engine-runner.ts's switch does with order_type_resolved's outcome,
  // fed into THIS turn's ask() shopContext exactly as the runner does.
  const shopContext: AskShopContext = { ...ADDRESS_SHOP_CONTEXT, orderTypeIsDelivery: false };
  const next = ask(ADDRESS_CART, ADDRESS_OPEN_STATE, NO_TURN_EVENTS, shopContext, VITOS_MENU);
  assert(next.open?.kind !== "address", `address must not reopen once order type switched to pickup: ${JSON.stringify(next.open)}`);
});

// ── Rule 2: cancel/forget-it/never-mind while address is open abandons the
// whole order — clears the cart, never treated as a failed address. ───────

for (const phrase of ["forget it, just cancel", "never mind", "actually, cancel my order"]) {
  Deno.test(`answer (address loop, rule 2): "${phrase}" while address is open clears the cart and never attempts a geocode`, () => {
    const cart = [...ADDRESS_CART];
    const result = answer(ADDRESS_OPEN_STATE, cart, phrase, VITOS_MENU, { geocodedAddress: null });
    assertEquals(result, { resolved: true, outcome: { kind: "cart_cancelled" }, cartChanged: true });
    assertEquals(cart.length, 0, "the cart must be cleared in place");
  });
}

Deno.test("runTurnEngineTurn (address loop, rule 2): 'forget it, just cancel' while address is open never says \"couldn't find\", ends with an empty cart, and asks the ordering question next — never re-asks address or order_type", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    geocodeAddressFn: () => Promise.resolve(null),
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — cancel resolves deterministically")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-address-cancel", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "forget it, just cancel",
    history: [], menu: VITOS_MENU, cart: ADDRESS_CART, dialogueState: ADDRESS_OPEN_STATE,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!/couldn'?t find/i.test(result.reply), `must never render the failed-address line for a cancel: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.length, 0, "the whole order must be cleared");
  const openKind = (result.dialogueState.open as { kind?: string } | null)?.kind;
  assertEquals(openKind, "ordering", `must ask the ordering question next, not re-open address or order_type: ${JSON.stringify(result.dialogueState.open)}`);
});

// ── Rule 3: after the SECOND consecutive failed lookup, stop re-asking —
// offer pickup or a different address once, then fall back to the plain
// order-type question on any further repeat. A later address that DOES
// geocode still resolves normally. ─────────────────────────────────────────

Deno.test("ask (address loop, rule 3): a FIRST failed lookup (openRepeatCount 0) still re-asks address plainly — the give-up fallback has not fired yet", () => {
  const priorState: DialogueState = { ...ADDRESS_OPEN_STATE, openRepeatCount: 0 };
  const next = ask(ADDRESS_CART, priorState, NO_TURN_EVENTS, ADDRESS_SHOP_CONTEXT, VITOS_MENU);
  assertEquals(next.open, { kind: "address" });
});

Deno.test("ask (address loop, rule 3): a SECOND consecutive failed lookup (openRepeatCount 1) switches to order_type with the address-unverifiable reason, never re-asks address a third time", () => {
  const priorState: DialogueState = { ...ADDRESS_OPEN_STATE, openRepeatCount: 1 };
  const next = ask(ADDRESS_CART, priorState, NO_TURN_EVENTS, ADDRESS_SHOP_CONTEXT, VITOS_MENU);
  assertEquals(next.open, { kind: "order_type", reason: "address_unverifiable" });
});

Deno.test("render (address loop, rule 3): the give-up line shows ONCE (openRepeatCount 0 on the order_type-with-reason state), then the plain order_type question on any repeat", () => {
  const cartAfter: TurnEngineCartLine[] = [];
  const firstAsk: DialogueState = { phase: "order_type", open: { kind: "order_type", reason: "address_unverifiable" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };
  const reply1 = render(cartAfter, cartAfter, firstAsk, [], VITOS_MENU, {});
  assert(reply1.includes("I can't verify that address."), `first ask must show the give-up line: ${JSON.stringify(reply1)}`);
  assert(!/couldn'?t find/i.test(reply1), `must never combine with the old "couldn't find" wording: ${JSON.stringify(reply1)}`);

  const repeatAsk: DialogueState = { ...firstAsk, openRepeatCount: 1 };
  const reply2 = render(cartAfter, cartAfter, repeatAsk, [], VITOS_MENU, {});
  assertEquals(reply2.trim(), "Pickup or delivery today?", "a repeat of the SAME question must be the plain, short prompt, not the give-up line again");
});

Deno.test("runTurnEngineTurn (address loop, rule 3): two consecutive un-geocodable addresses stop re-asking address on the second — reply gives the pickup-or-different-address line, dialogue opens order_type", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    geocodeAddressFn: () => Promise.resolve(null),
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — address resolves deterministically")),
  };
  // openRepeatCount: 1 — this cart/state models the conversation ALREADY
  // having failed once (turn 1's failure already re-opened address with
  // openRepeatCount incremented to 1); this turn is the SECOND failure.
  const priorState: DialogueState = { ...ADDRESS_OPEN_STATE, openRepeatCount: 1 };
  const input: RunTurnInput = {
    conversationId: "conv-address-2nd-fail", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "456 Oak Street", history: [], menu: VITOS_MENU, cart: ADDRESS_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(result.reply.includes("I can't verify that address."), `second failure must give up and offer pickup/a different address: ${JSON.stringify(result.reply)}`);
  const openState = result.dialogueState.open as { kind?: string; reason?: string } | null;
  assertEquals(openState?.kind, "order_type");
  assertEquals(openState?.reason, "address_unverifiable");
});

Deno.test("runTurnEngineTurn (address loop, rule 3): a THIRD address attempt that DOES geocode still resolves normally, even though order_type is now the nominal open question", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    geocodeAddressFn: () => Promise.resolve({ formatted: "456 Oak St, Bethlehem, PA 18015", withinZone: true }),
    // Bare address text doesn't answer the NOMINALLY open order_type
    // question (no pickup/delivery word in it), so ANSWER's own "order_type"
    // case can't resolve it and — since order_type isn't in the slot/
    // disambiguation PROPOSE-blocking set — this DOES fall through to
    // PROPOSE, same as any other order_type-open turn with an unrelated
    // message. The address itself is still recovered independently by the
    // 00-AP opportunistic geocode path, which runs before ANSWER and does
    // not depend on what's nominally open.
    proposeTurnFn: () => Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } }),
  };
  // Dialogue already gave up once (rule 3's own transition) — order_type
  // with the address-unverifiable reason is now open, per the previous test.
  const priorState: DialogueState = { phase: "order_type", open: { kind: "order_type", reason: "address_unverifiable" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };
  const input: RunTurnInput = {
    conversationId: "conv-address-3rd-succeeds", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "456 Oak St, Bethlehem, PA 18015", history: [], menu: VITOS_MENU, cart: ADDRESS_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: false, driverTipCents: 0, pickupName: "Jason", deliveryFeeCents: 300 },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("I can't verify that address."), `a geocode that succeeds must not repeat the give-up line: ${JSON.stringify(result.reply)}`);
  const openKind = (result.dialogueState.open as { kind?: string } | null)?.kind;
  assert(openKind !== "address" && !(openKind === "order_type"), `address must be treated as resolved, not re-asked as either address or order_type: got ${JSON.stringify(result.dialogueState.open)}`);
});

// ── Rule 4: an address that fails to geocode is never silently accepted as
// the delivery address — it must always surface as address_declined, never
// address_resolved, regardless of how plausible the customer's text looks. ─

Deno.test("answer (address loop, rule 4): a failed geocode is NEVER address_resolved — always address_declined, no matter how address-shaped the text is", () => {
  const result = answer(ADDRESS_OPEN_STATE, [...ADDRESS_CART], "123 Main St", VITOS_MENU, { geocodedAddress: null });
  assertEquals(result, { resolved: true, outcome: { kind: "address_declined" }, cartChanged: false });
});

// ============================================================
// 2026-09-18 PO dispatch (named choice not on the list, real conv 0):
// "creamy italian dressing" x5 on the House salad's dressing slot — the
// customer named a choice that doesn't exist, the bot re-asked the bare
// question, and the customer kept repeating the exact same unavailable
// words. Fixed shape: name back what they said + list the real options,
// every time, until they name something real.
// ============================================================

const HOUSE_SALAD_DRESSING_ID = "item-house-salad";
const DRESSING_GROUP_ID = "group-dressing";
const HOUSE_SALAD_MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_SALAD_DRESSING_ID, name: "House", category: "Salads", price_cents: 899, bot_state: "orderable",
    option_groups: [{ id: DRESSING_GROUP_ID, name: "Dressing", default_choice_id: null }],
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "House", base_price_cents: 899,
      recap_template: "", ticket_template: "",
      steps: [{
        group_id: DRESSING_GROUP_ID, slot_key: "dressing", kind: "slot", ask_mode: "ask",
        prompt_template: "dressing.ask",
        choices: [
          { id: "choice-ranch", display: "Ranch", price_delta_cents: 0 },
          { id: "choice-balsamic", display: "Balsamic Vinaigrette", price_delta_cents: 0 },
          { id: "choice-caesar", display: "Caesar", price_delta_cents: 0 },
        ],
      }],
    },
  },
];
const HOUSE_SALAD_CART: TurnEngineCartLine[] = [
  { menu_item_id: HOUSE_SALAD_DRESSING_ID, name: "House", quantity: 1, price_cents: 899, modifiers: [], line_key: "line-1" },
];
const DRESSING_OPEN_STATE: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: DRESSING_GROUP_ID }, upsell_offered: false, asked_message_id: null };

Deno.test("runTurnEngineTurn (named choice not on the list): 'creamy italian' names back the customer's exact words and lists the real choices, never re-reads as a generic re-ask", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — 00-AT: an unresolvable slot answer resolves deterministically")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "creamy italian", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: DRESSING_OPEN_STATE,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(
    result.reply.includes('We don\'t have "creamy italian" for House. The options are: Ranch, Balsamic Vinaigrette, or Caesar.'),
    `must name back the customer's own words and list the real choices: ${JSON.stringify(result.reply)}`,
  );
  assertEquals((result.dialogueState.open as { kind?: string } | null)?.kind, "slot", "the dressing slot is still open — nothing was resolved");
});

Deno.test("runTurnEngineTurn (named choice not on the list): a SECOND unmatched answer ('cream dressin') gets the SAME line shape, updated to their new words — never degrades to the plain bare question", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  // openRepeatCount: 1 — this models the FIRST unmatched answer ("creamy
  // italian") having already re-opened the slot once.
  const priorState: DialogueState = { ...DRESSING_OPEN_STATE, openRepeatCount: 1 };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "cream dressin", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(
    result.reply.includes('We don\'t have "cream dressin" for House. The options are: Ranch, Balsamic Vinaigrette, or Caesar.'),
    `a second unmatched answer must get the same line, updated to the new words: ${JSON.stringify(result.reply)}`,
  );
  assert(!result.reply.includes("Let me list the options for you"), `must never fall back to the generic lead-in wording: ${JSON.stringify(result.reply)}`);
});

Deno.test("runTurnEngineTurn (named choice not on the list): 'jalapeno ranch' resolves cleanly — the correction message never blocks a real, matching choice", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — a matching choice resolves deterministically")),
  };
  const priorState: DialogueState = { ...DRESSING_OPEN_STATE, openRepeatCount: 2 };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "jalapeno ranch", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("We don't have"), `a real matching choice must not be treated as unmatched: ${JSON.stringify(result.reply)}`);
  assertEquals(result.dialogueState.open, null, "the dressing slot must resolve — nothing left open, cart is non-empty so ASK falls to \"Anything else?\"");
  assert(result.reply.includes("Anything else?"), `must ask what's next now that the slot resolved: ${JSON.stringify(result.reply)}`);
});

// ============================================================
// 2026-09-18 PO dispatch (echo regression in the named-choice-not-on-the-
// list fix, real conv 4854b0e3, run v489): "Spaghetti, please! Now can you
// confirm my whole order?" echoed the ENTIRE message back as if it were an
// unmatched choice, thirteen turns straight, then the turn cap. Real root
// cause found by pulling the live cart: TWO "Chicken Alfredo Entree" lines
// existed (a customer recap re-triggered a duplicate add) — one already
// resolved to Spaghetti, one still blank. applyCompiledModifyItem finds its
// target line by menu_item_id alone (this file's own header note 4), so it
// silently matched the ALREADY-RESOLVED line and reported no change, even
// though matchChoiceInText plainly resolves "Spaghetti" out of every one of
// these messages. Fixture below reproduces the real duplicate-line shape.
// ============================================================
const ALFREDO_ID = "96547aec-338b-4677-9e0f-0de3920c2c7b";
const PASTA_GROUP_ID = "42c3cc32-dd8b-4053-94b7-958ecf08ce8b";
const SPAGHETTI_CHOICE_ID = "85494329-ba8b-46e3-8c8b-4a191682dbcc";
const ALFREDO_ASK_PLAN = {
  compiled_at: "", compiler_version: 1, display_name: "Chicken Alfredo Entree", base_price_cents: 1995,
  recap_template: "", ticket_template: "",
  steps: [{
    group_id: PASTA_GROUP_ID, slot_key: null, kind: "slot" as const, ask_mode: "ask" as const,
    prompt_template: "pasta.ask",
    choices: [
      { id: "36e676f4-d6c2-4b46-8d77-8a26900b8ac9", display: "Linguine", price_delta_cents: 0 },
      { id: "77435dfa-3fde-430d-b1a6-94418ce0290c", display: "Angel Hair", price_delta_cents: 0 },
      { id: SPAGHETTI_CHOICE_ID, display: "Spaghetti", price_delta_cents: 0 },
      { id: "beb4e1bb-44ee-41ea-b07b-b2dc13a4ab00", display: "Penne", price_delta_cents: 0 },
    ],
  }],
};
const ALFREDO_MENU: TurnEngineMenuItem[] = [
  { id: ALFREDO_ID, name: "Alfredo - Chicken", category: "Entrees", price_cents: 1995, bot_state: "orderable", ask_plan: ALFREDO_ASK_PLAN },
];
// The exact real duplicate-line shape from conv 4854b0e3's own cart_json:
// line 1 already resolved to Spaghetti, line 2 (the one ask() actually has
// open, per the real dialogue_state) still blank.
function alfredoDuplicateCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: ALFREDO_ID, name: "Chicken Alfredo Entree", quantity: 1, price_cents: 1995, modifiers: [], options: { Pasta: ["Spaghetti"] }, ask_plan_selections: { [PASTA_GROUP_ID]: SPAGHETTI_CHOICE_ID } },
    { menu_item_id: ALFREDO_ID, name: "Chicken Alfredo Entree", quantity: 1, price_cents: 1995, modifiers: [] },
  ];
}
const ALFREDO_OPEN_STATE: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: `${ALFREDO_ID}::`, group_id: PASTA_GROUP_ID }, upsell_offered: false, asked_message_id: null };

for (const msg of [
  "Spaghetti, please! Now can you confirm my whole order?",
  "I already chose spaghetti for the Chicken Alfredo. Could you please just confirm the entire order now?",
  "Okay, I'll go with Spaghetti for the Chicken Alfredo. Can you just confirm my order now?",
  "I want Spaghetti for the Chicken Alfredo. My order is: 1x Chicken Alfredo with Spaghetti, 1x Gyro, and 1x Medium Hawaiian Pizza.",
]) {
  Deno.test(`answer (echo regression, real transcript): "${msg}" resolves Spaghetti on the SECOND (still-blank) line, not blocked by the first, already-resolved duplicate`, () => {
    const result = answer(ALFREDO_OPEN_STATE, alfredoDuplicateCart(), msg, ALFREDO_MENU);
    assertEquals(result, { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true });
  });
}

Deno.test("answer (echo regression): resolving the second line leaves the first, already-resolved line untouched", () => {
  const cart = alfredoDuplicateCart();
  answer(ALFREDO_OPEN_STATE, cart, "Spaghetti, please! Now can you confirm my whole order?", ALFREDO_MENU);
  assertEquals(cart[0].ask_plan_selections, { [PASTA_GROUP_ID]: SPAGHETTI_CHOICE_ID }, "first line's own resolved choice must be untouched");
  assertEquals(cart[1].ask_plan_selections, { [PASTA_GROUP_ID]: SPAGHETTI_CHOICE_ID }, "second (previously blank) line must now be resolved too");
});

Deno.test("extractSlotChoiceWords: strips a trailing 'for <the item>' clause — 'creamy italian dressing for the house salad' -> 'creamy italian dressing'", () => {
  assertEquals(extractSlotChoiceWords("creamy italian dressing for the house salad"), "creamy italian dressing");
});

Deno.test("extractSlotChoiceWords: a short message with no preposition clause is returned whole", () => {
  assertEquals(extractSlotChoiceWords("cream dressin"), "cream dressin");
});

Deno.test("extractSlotChoiceWords: 'on' introduces the choice, not the item — real conv 192e1bdf, 'Can I get that on a regular hoagie roll?' -> 'a regular hoagie roll'", () => {
  assertEquals(extractSlotChoiceWords("Can I get that on a regular hoagie roll?"), "a regular hoagie roll");
});

Deno.test("extractSlotChoiceWords: strips leading filler and trailing thanks — real conv ba0a6717, 'Got it! I already said ranch, thanks!' -> 'ranch'", () => {
  assertEquals(extractSlotChoiceWords("Got it! I already said ranch, thanks!"), "ranch");
});

Deno.test("runTurnEngineTurn (echo regression, acceptance): a GENUINE miss on the House salad ('creamy italian dressing for the house salad') echoes only the choice words, not the whole message", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "creamy italian dressing for the house salad", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: DRESSING_OPEN_STATE,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };
  const result = await runTurnEngineTurn(input, deps);
  assert(
    result.reply.includes('We don\'t have "creamy italian dressing" for House. The options are: Ranch, Balsamic Vinaigrette, or Caesar.'),
    `must echo only the choice-shaped fragment, not the whole message: ${JSON.stringify(result.reply)}`,
  );
});

Deno.test("runTurnEngineTurn (echo regression, anti-repeat): the SAME quoted words never echo twice in a row — the second identical miss falls back to the plain enumerate wording", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  // Models turn 2 of the same miss: turn 1 already echoed "creamy italian
  // dressing" and persisted it as lastSlotEchoText.
  const priorState: DialogueState = { ...DRESSING_OPEN_STATE, openRepeatCount: 1, lastSlotEchoText: "creamy italian dressing" };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "creamy italian dressing for the house salad", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };
  const result = await runTurnEngineTurn(input, deps);
  assert(!result.reply.includes("We don't have"), `must not echo the same words twice in a row: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("Let me list the options for you"), `must fall back to the plain enumerate wording: ${JSON.stringify(result.reply)}`);
});

Deno.test("runTurnEngineTurn (echo regression, anti-repeat): DIFFERENT quoted words on the second miss still echo fresh — this is not a general 'never echo twice' rule", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  const priorState: DialogueState = { ...DRESSING_OPEN_STATE, openRepeatCount: 1, lastSlotEchoText: "creamy italian dressing" };
  const input: RunTurnInput = {
    conversationId: "conv-0", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "cream dressin", history: [], menu: HOUSE_SALAD_MENU, cart: HOUSE_SALAD_CART, dialogueState: priorState,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null },
  };
  const result = await runTurnEngineTurn(input, deps);
  assert(result.reply.includes('We don\'t have "cream dressin" for House.'), `different words must still echo: ${JSON.stringify(result.reply)}`);
});

// ============================================================
// 2026-09-18 PO dispatch (read-back corrections, mechanism 1: quantity).
// Real conv e46f1c41, live: read-back showed "One Size Thin Sicilian Pizza"
// (customer ordered 2). Three consecutively differently-worded corrections
// all hit "Anything else?" with the cart untouched — impliesConfirmDecline
// consumed "wrong"/"instead"/"actually" as a bare decline before the
// correction's actual content (the real quantity) was ever read. Only a
// FOURTH attempt, phrased as a plain restatement with no decline word,
// happened to reach the existing PROPOSE path and succeed.
// ============================================================
const SICILIAN_PIZZA_ID = "item-sicilian-pizza";
const GARLIC_KNOTS_ID = "item-garlic-knots";
const QTY_FIX_MENU: TurnEngineMenuItem[] = [
  { id: SICILIAN_PIZZA_ID, name: "One Size Thin Sicilian Pizza", category: "Pizza", price_cents: 1750, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "One Size Thin Sicilian Pizza", base_price_cents: 1750, recap_template: "", ticket_template: "", steps: [] } },
  { id: GARLIC_KNOTS_ID, name: "Garlic Knots (6)", category: "Appetizers", price_cents: 599, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Garlic Knots (6)", base_price_cents: 599, recap_template: "", ticket_template: "", steps: [] } },
];
function qtyFixCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: SICILIAN_PIZZA_ID, name: "One Size Thin Sicilian Pizza", quantity: 1, price_cents: 1750, modifiers: [] },
    { menu_item_id: GARLIC_KNOTS_ID, name: "Garlic Knots (6)", quantity: 1, price_cents: 599, modifiers: [] },
  ];
}
const QTY_FIX_CONFIRM_STATE: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };

for (const msg of [
  "I think you got the pizzas wrong. I meant 2 Thin Sicilian Pizzas, not one.",
  "Okay, then let's make it 2 Thin Sicilian Pizzas and the Garlic Knots! That's all.",
  "No, it's actually 2 x Thin Sicilian Pizzas instead of one. So it should be $35.00 for the pizzas. Can you update that?",
]) {
  Deno.test(`answer (read-back corrections, mechanism 1): "${msg}" sets quantity to 2 on the FIRST attempt, never a plain decline`, () => {
    const result = answer(QTY_FIX_CONFIRM_STATE, qtyFixCart(), msg, QTY_FIX_MENU);
    assertEquals(result, { resolved: true, outcome: { kind: "quantity_corrected" }, cartChanged: true });
  });
}

Deno.test("answer (read-back corrections, mechanism 1): the correction mutates the matched line's quantity in place, leaves the other line untouched", () => {
  const cart = qtyFixCart();
  answer(QTY_FIX_CONFIRM_STATE, cart, "I think you got the pizzas wrong. I meant 2 Thin Sicilian Pizzas, not one.", QTY_FIX_MENU);
  assertEquals(cart[0].quantity, 2, "the pizza line must be corrected to 2");
  assertEquals(cart[1].quantity, 1, "the Garlic Knots line must be untouched");
});

Deno.test("runTurnEngineTurn (read-back corrections, mechanism 1): the reply is the read-back again, NEVER 'Anything else?'", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — the correction resolves deterministically")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-e46f1c41", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "I think you got the pizzas wrong. I meant 2 Thin Sicilian Pizzas, not one.",
    history: [], menu: QTY_FIX_MENU, cart: qtyFixCart(), dialogueState: QTY_FIX_CONFIRM_STATE,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Alex", deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("Anything else?"), `must never fall through to the empty-correction dead end: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("All good?"), `must re-show the read-back, not the short re-confirm: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes("2x One Size Thin Sicilian Pizza") || result.reply.includes("2 One Size Thin Sicilian Pizza"), `read-back must reflect the corrected quantity: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart[0].quantity, 2);
  assertEquals((result.dialogueState.open as { kind?: string } | null)?.kind, "confirm");
  assertEquals(result.dialogueState.openRepeatCount, 0, "a fresh cycle — the next re-ask should be the short prompt, not this one");
});

// ============================================================
// 2026-09-18 PO dispatch (read-back corrections, mechanism 2: replacement).
// Real conv 453c5cc7, live: read-back showed "16\" House Stromboli". "Just
// to clarify, I wanted a 16\" House pizza, not a stromboli. Can you fix
// that?" removed "Small Gyro Pizza" — a line never named. Pulled the real
// propose_success log for that turn (not guessed): the model's own
// proposal removed all THREE cart lines and only re-added ONE ("16\"
// House pizza") — decide()'s remove loop trusts line_key with no
// verification the customer actually named that line, unlike the add
// path's guard. Whichever line_key still matched (the Gyro's) got deleted
// for real.
// ============================================================
const REPLACE_GYRO_ID = "item-replace-gyro";
const REPLACE_FISH_ID = "item-replace-fish";
const REPLACE_HOUSE_STROMBOLI_ID = "item-replace-house-stromboli";
const REPLACE_MENU: TurnEngineMenuItem[] = [
  { id: REPLACE_GYRO_ID, name: "Small Gyro Pizza", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Small Gyro Pizza", base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [] } },
  { id: REPLACE_FISH_ID, name: "Fish And Chips", category: "Entrees", price_cents: 1350, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Fish And Chips", base_price_cents: 1350, recap_template: "", ticket_template: "", steps: [] } },
  { id: REPLACE_HOUSE_STROMBOLI_ID, name: "House - 16\"", category: "Stromboli", price_cents: 2295, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "16\" House Stromboli", base_price_cents: 2295, recap_template: "", ticket_template: "", steps: [] } },
];
function replaceCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: REPLACE_GYRO_ID, name: "Small Gyro Pizza", quantity: 1, price_cents: 1295, modifiers: [] },
    { menu_item_id: REPLACE_FISH_ID, name: "Fish And Chips", quantity: 1, price_cents: 1350, modifiers: [] },
    { menu_item_id: REPLACE_HOUSE_STROMBOLI_ID, name: "16\" House Stromboli", quantity: 1, price_cents: 2295, modifiers: [] },
  ];
}
const REPLACE_CONFIRM_STATE: DialogueState = { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };

for (const msg of [
  "Just to clarify, I wanted a 16\" House pizza, not a stromboli. Can you fix that? So, I need the small Gyro pizza, Fish and Chips, and the 16\" House pizza for pickup.",
  "I already told you I want the small Gyro pizza, Fish and Chips, and the 16\" House pizza, not a stromboli! Can you fix that?",
  "I still want the 16\" House pizza, not the stromboli! Just to confirm: small Gyro pizza with tomatoes and spinach, Fish and Chips, and a 16\" House pizza for pickup. Can you confirm that?",
  "I need the 16\" House pizza, not a stromboli! Let me just confirm: small Gyro pizza with tomatoes and spinach, Fish and Chips, and a 16\" House pizza for pickup. Can you confirm that?",
]) {
  Deno.test(`answer (read-back corrections, mechanism 2): "${msg.slice(0, 60)}..." declines by name — no House pizza exists — and touches NOTHING`, () => {
    const cart = replaceCart();
    const result = answer(REPLACE_CONFIRM_STATE, cart, msg, REPLACE_MENU);
    assertEquals(result, {
      resolved: true,
      outcome: { kind: "replacement_unavailable", message: 'We only have House as a stromboli in 16". Keep it, or take it off?' },
      cartChanged: false,
    });
    assertEquals(cart.map(l => l.menu_item_id), [REPLACE_GYRO_ID, REPLACE_FISH_ID, REPLACE_HOUSE_STROMBOLI_ID], "the Gyro (and everything else) must be untouched — nothing the customer didn't name is ever removed");
  });
}

Deno.test("answer (read-back corrections, mechanism 2): a real, distinct target item DOES replace the wrong line, preserving quantity", () => {
  const cheeseId = "item-cheese-pizza-2";
  const pepperoniId = "item-pepperoni-pizza-2";
  const menu: TurnEngineMenuItem[] = [
    { id: cheeseId, name: "Cheese Pizza", category: "Pizza", price_cents: 1299, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Pizza", base_price_cents: 1299, recap_template: "", ticket_template: "", steps: [] } },
    { id: pepperoniId, name: "Pepperoni Pizza", category: "Pizza", price_cents: 1499, bot_state: "orderable", ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Pepperoni Pizza", base_price_cents: 1499, recap_template: "", ticket_template: "", steps: [] } },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: cheeseId, name: "Cheese Pizza", quantity: 2, price_cents: 1299, modifiers: [] },
  ];
  const result = answer(REPLACE_CONFIRM_STATE, cart, "I wanted a Pepperoni Pizza, not a Cheese Pizza.", menu);
  assertEquals(result, { resolved: true, outcome: { kind: "line_replaced" }, cartChanged: true });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, pepperoniId);
  assertEquals(cart[0].quantity, 2, "quantity must carry over from the replaced line");
});

Deno.test("runTurnEngineTurn (read-back corrections, mechanism 2): the real transcript never removes the Gyro — reply names what's actually on the menu, cart is untouched, never reaches PROPOSE", async () => {
  const { supabase } = makeMinimalFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — the correction resolves deterministically")),
  };
  const input: RunTurnInput = {
    conversationId: "conv-453c5cc7", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "Just to clarify, I wanted a 16\" House pizza, not a stromboli. Can you fix that? So, I need the small Gyro pizza, Fish and Chips, and the 16\" House pizza for pickup.",
    history: [], menu: REPLACE_MENU, cart: replaceCart(), dialogueState: REPLACE_CONFIRM_STATE,
    shopContext: { deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: "Alex", deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!result.reply.includes("removed"), `must never claim anything was removed: ${JSON.stringify(result.reply)}`);
  assert(result.reply.includes('We only have House as a stromboli in 16". Keep it, or take it off?'), `must name what's actually available: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.map(l => l.menu_item_id), [REPLACE_GYRO_ID, REPLACE_FISH_ID, REPLACE_HOUSE_STROMBOLI_ID]);
});

// ============================================================
// 2026-09-19 PO dispatch (Commit 3): when a disambiguation answer explicitly
// rejects the offered category ("not stromboli", "I meant pizza not X"),
// respond with "We only have X as a Y. Keep it, or take it off?" and add the
// item — never silently drop it as a closure. The Slice live repro:
// customer says "The Slice pizza, the large one" -> bot offers Slice Stromboli
// candidates -> customer replies "I meant pizza, not stromboli" -> must NOT
// drop, must add and say "We only have ...".
// ============================================================
const SLICE_STROMBOLI_SMALL_ID = "slice-stromboli-small";
const SLICE_STROMBOLI_LARGE_ID = "slice-stromboli-large";
const CHEESE_PIZZA_DISAMG_ID = "cheese-pizza-disambig-test";

const SLICE_DISAMBIGUATION_MENU: TurnEngineMenuItem[] = [
  {
    id: SLICE_STROMBOLI_SMALL_ID, name: "The Slice - Small", category: "Stromboli", price_cents: 999,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Small The Slice Stromboli", base_price_cents: 999, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: SLICE_STROMBOLI_LARGE_ID, name: "The Slice - Large", category: "Stromboli", price_cents: 1299,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Large The Slice Stromboli", base_price_cents: 1299, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: CHEESE_PIZZA_DISAMG_ID, name: "Cheese Pizza", category: "Pizza", price_cents: 1650,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Pizza", base_price_cents: 1650, recap_template: "", ticket_template: "", steps: [] },
  },
];

const SLICE_DISAMBIG_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "disambiguation", candidates: [SLICE_STROMBOLI_SMALL_ID, SLICE_STROMBOLI_LARGE_ID], quantity: 1 },
  upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
};

Deno.test("answer (Commit 3, category rejection): 'not stromboli, I want pizza' is NOT a closure — adds item and returns disambiguation_category_rejected", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SLICE_DISAMBIG_STATE, cart, "I meant pizza, not stromboli", SLICE_DISAMBIGUATION_MENU);
  assertEquals(result.resolved, true);
  assert(result.resolved && result.outcome.kind === "disambiguation_category_rejected",
    `expected disambiguation_category_rejected, got: ${JSON.stringify(result)}`);
  assert(result.resolved && (result.outcome as { kind: string; message: string }).message.includes("We only have"),
    `message must include "We only have": ${JSON.stringify(result)}`);
  assert(result.resolved && (result.outcome as { kind: string; message: string }).message.includes("Keep it, or take it off?"),
    `message must include "Keep it, or take it off?": ${JSON.stringify(result)}`);
  assertEquals(result.cartChanged, true, "the item must be added to the cart");
  assertEquals(cart.length, 1, "cart must have one line after category rejection");
  assert(
    cart[0].menu_item_id === SLICE_STROMBOLI_SMALL_ID || cart[0].menu_item_id === SLICE_STROMBOLI_LARGE_ID,
    `added item must be a slice stromboli, got: ${cart[0].menu_item_id}`,
  );
});

Deno.test("answer (Commit 3, category rejection): size token narrows to Large when customer says 'large, not stromboli, I want pizza'", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SLICE_DISAMBIG_STATE, cart, "large, I meant pizza not stromboli", SLICE_DISAMBIGUATION_MENU);
  assertEquals(result.resolved, true);
  assert(result.resolved && result.outcome.kind === "disambiguation_category_rejected",
    `expected disambiguation_category_rejected, got: ${JSON.stringify(result)}`);
  assertEquals(result.cartChanged, true);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].menu_item_id, SLICE_STROMBOLI_LARGE_ID, "size token 'large' must narrow to the Large stromboli");
});

Deno.test("answer (Commit 3, genuine decline): 'forget the stromboli' with NO other category named is still a closure, not category rejection", () => {
  const cart: TurnEngineCartLine[] = [];
  const result = answer(SLICE_DISAMBIG_STATE, cart, "forget the stromboli", SLICE_DISAMBIGUATION_MENU);
  assertEquals(result.resolved, true);
  assert(result.resolved && result.outcome.kind === "closure",
    `genuine decline must still return closure, got: ${JSON.stringify(result)}`);
  assertEquals(result.cartChanged, false);
  assertEquals(cart.length, 0, "genuine decline must not add anything to the cart");
});
