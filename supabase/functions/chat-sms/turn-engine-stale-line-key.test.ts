// PO-diagnosed bug verification, 2026-09-15 (NOT part of Phase 1's gate —
// separate investigation, see docs/specs/2026-09-14-turn-engine-oversight.md
// for the Phase 1 module this targets).
//
// Claim under test: `line_key` is derived from MUTABLE content
// (identityKey(menu_item_id, options), turn-reconciler.ts) rather than a
// stable id. For a line with exactly ONE option group (Vito's Cheese
// Burger, the ONLY fixture Phase 1's 22 tests used — see
// turn-engine.test.ts), the key changes exactly once, after the line's
// last/only question, so nothing ever presents a stale key back to
// findLineByKey(). For a line with TWO OR MORE option groups, answering the
// FIRST group changes the line's identity key while the SECOND group's
// question is still pending. A `modify` proposal that names the line by the
// key that was current before the first group was answered — plausible for
// PROPOSE (a later phase) if it forms that proposal from an earlier turn's
// view of the cart — no longer matches the line's current identity.
//
// Fixture: Zio's Pizzeria's real, live "Boneless Wings" row (id
// cb53dc5b-5abe-4110-a814-3beacec644e8), which has two REQUIRED slot
// groups — "Choose Sauce" (id b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d) asked
// first, then "Quantity" (id 8774670c-7f71-4ee9-b9b4-a80552309321) — read
// directly from the DB 2026-09-15, not invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answer,
  decide,
  ask,
  type DialogueState,
  type Proposal,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskTurnEvents,
  type AskShopContext,
} from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

const WINGS_ID = "cb53dc5b-5abe-4110-a814-3beacec644e8";
const FLAVOR_GROUP_ID = "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d"; // "Choose Sauce"
const QTY_GROUP_ID = "8774670c-7f71-4ee9-b9b4-a80552309321"; // "Quantity"
const MILD_SAUCE_ID = "62a4d4ca-d0aa-4f36-a99c-ad5d7c580f70";
const BBQ_SAUCE_ID = "88b27a65-d800-4d2a-a63b-42946330c76a";
const TEN_PIECES_ID = "16f6eb99-3d95-4fd7-aef5-94180a6099bd";

const WINGS_MENU: TurnEngineMenuItem[] = [
  {
    id: WINGS_ID,
    name: "Boneless Wings",
    category: "Wings",
    price_cents: 1000,
    bot_state: "orderable",
    option_groups: [
      { id: FLAVOR_GROUP_ID, name: "Choose Sauce", default_choice_id: null },
      { id: QTY_GROUP_ID, name: "Quantity", default_choice_id: null },
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
          kind: "slot",
          ask_mode: "ask",
          group_id: FLAVOR_GROUP_ID,
          slot_key: "flavor",
          prompt_template: "flavor.ask",
          choices: [
            { id: "55ec5b81-7bd1-4479-b126-0c231decab37", display: "Sweet & Hot Sauce", price_delta_cents: 0 },
            { id: MILD_SAUCE_ID, display: "Mild Sauce", price_delta_cents: 0 },
            { id: "870dc306-c2a1-432e-b3af-aea31e109581", display: "Hot Sauce", price_delta_cents: 0 },
            { id: BBQ_SAUCE_ID, display: "BBQ Sauce", price_delta_cents: 0 },
            { id: "eece245d-7d5b-4c21-8ffe-ae689c8bdd93", display: "Plain", price_delta_cents: 0 },
          ],
        },
        {
          kind: "slot",
          ask_mode: "ask",
          group_id: QTY_GROUP_ID,
          slot_key: null,
          prompt_template: "quantity.ask",
          choices: [
            { id: TEN_PIECES_ID, display: "10 Pieces", price_delta_cents: 0 },
            { id: "dc16bc2d-72c0-42c1-b031-c792048b3fba", display: "20 Pieces", price_delta_cents: 800 },
          ],
        },
      ],
    },
  },
];

const WINGS_LEXICON: LexiconTerm[] = [{ term: "boneless wings", target_id: WINGS_ID }];

const SHOP_CONTEXT: AskShopContext = {
  deliveryEnabled: false,
  upsellEnabled: false,
  orderTypeKnown: true,
  orderTypeIsDelivery: false,
  deliveryAddressKnown: true,
  driverTipKnown: true,
  pickupNameKnown: true,
};

const NO_TURN_EVENTS: AskTurnEvents = {
  qualifyingAddMenuItemId: null,
  disambiguationCandidateIds: null,
  checkoutIntentThisTurn: false,
  confirmYes: false,
  confirmNo: false,
};

Deno.test("BUG: a modify proposal keyed by the pre-first-answer line_key fails to find the line once the first of two option groups has been answered", () => {
  let state: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  let cart: TurnEngineCartLine[] = [];

  // ── Turn 1: add Boneless Wings (zero groups resolved) ──────────────────
  const addProposal: Proposal = {
    intent: "order",
    adds: [{ item_span: "boneless wings", quantity: 1, choices: [] }],
    removes: [],
    modifies: [],
  };
  const d1 = decide(addProposal, cart, WINGS_MENU, WINGS_LEXICON);
  assertEquals(d1.declines, []);
  cart = d1.cart;
  assertEquals(cart[0].options, undefined);

  state = ask(cart, state, { ...NO_TURN_EVENTS, qualifyingAddMenuItemId: d1.qualifyingAddMenuItemId }, SHOP_CONTEXT, WINGS_MENU);
  assertEquals(state.open, { kind: "slot", line_key: `${WINGS_ID}::`, group_id: FLAVOR_GROUP_ID });

  // This is the key captured at the moment "Choose Sauce" is the open
  // question — i.e. the identity of the line BEFORE either group is
  // answered. This is the key a PROPOSE call looking at that snapshot of
  // the conversation would see for this line.
  const PRE_GROUP_A_KEY = (state.open as { line_key: string }).line_key;
  assertEquals(PRE_GROUP_A_KEY, `${WINGS_ID}::`);

  // ── Turn 2: answer group A ("Choose Sauce" -> "Mild Sauce") ────────────
  const a2 = answer(state, cart, "mild sauce", WINGS_MENU);
  assertEquals(a2, { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true });
  assertEquals(cart[0].options, { "Choose Sauce": ["Mild Sauce"] });

  state = ask(cart, state, NO_TURN_EVENTS, SHOP_CONTEXT, WINGS_MENU);
  // Group B ("Quantity") is now the open question, and ASK recomputes the
  // line_key fresh off the CURRENT cart -- this is the line's real,
  // current identity, and it has changed from PRE_GROUP_A_KEY.
  const CURRENT_KEY = (state.open as { line_key: string }).line_key;
  assertEquals(state.open?.kind, "slot");
  assertEquals((state.open as { group_id: string }).group_id, QTY_GROUP_ID);
  assert(CURRENT_KEY !== PRE_GROUP_A_KEY, `expected the line_key to change once group A was answered; got the same key twice: ${CURRENT_KEY}`);

  // ── The reproduction: a `modify` proposal naming the line by the NOW-
  // STALE pre-group-A key (exactly what a PROPOSE call working from an
  // earlier snapshot of this same conversation would produce) tries to
  // change the sauce to BBQ. ─────────────────────────────────────────────
  const staleModifyProposal: Proposal = {
    intent: "order",
    adds: [],
    removes: [],
    modifies: [{ line_key: PRE_GROUP_A_KEY, choices: [{ group_id: FLAVOR_GROUP_ID, choice_id: BBQ_SAUCE_ID }] }],
  };
  const cartBeforeStaleModify = cart.map(l => ({ ...l }));
  const dStale = decide(staleModifyProposal, cart, WINGS_MENU, WINGS_LEXICON);

  console.log("── STALE-KEY MODIFY RESULT ──");
  console.log("declines:", JSON.stringify(dStale.declines));
  console.log("cart before:", JSON.stringify(cartBeforeStaleModify.map(l => l.options)));
  console.log("cart after: ", JSON.stringify(dStale.cart.map(l => l.options)));

  // THE ASSERTION: does the stale key still find the line?
  // If the bug is real: findLineByKey(cart, PRE_GROUP_A_KEY) returns -1
  // (no line in `cart` has that identity anymore), decide() pushes a
  // decline ("That item wasn't in your order"), and the sauce is NOT
  // changed to BBQ -- even though the wings line is plainly still in the
  // cart, just under a different key.
  assertEquals(dStale.declines, [{ reason: "That item wasn't in your order." }],
    "expected the stale-key modify to be declined as 'not in your order'");
  assertEquals(dStale.cart[0].options, { "Choose Sauce": ["Mild Sauce"] },
    "expected the stale-key modify to leave the line's sauce unchanged (BBQ never applied)");

  // ── Control: a modify carrying the CURRENT (non-stale) key, resolving
  // the group that's actually still pending (Quantity), must succeed --
  // proves the line IS still reachable by its real current identity, and
  // that decide()'s modify path works in general. This isolates the defect
  // to key staleness specifically, not a general decide()/modify problem. ─
  const freshModifyProposal: Proposal = {
    intent: "order",
    adds: [],
    removes: [],
    modifies: [{ line_key: CURRENT_KEY, choices: [{ group_id: QTY_GROUP_ID, choice_id: TEN_PIECES_ID }] }],
  };
  const dFresh = decide(freshModifyProposal, cart, WINGS_MENU, WINGS_LEXICON);
  assertEquals(dFresh.declines, []);
  assertEquals(dFresh.cart[0].options, { "Choose Sauce": ["Mild Sauce"], Quantity: ["10 Pieces"] },
    "control: the identical shape of modify, sent with the CURRENT key, must succeed");
});
