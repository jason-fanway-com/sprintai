// PO dispatch 2026-09-19, live money bug (conv s2-v557): "a small Margherita
// pizza with gyro meat and bacon" billed a Small Margherita Pizza (Bacon
// +$4.50, $17.45) AND, separately, a Small Gyro Pizza (Gyro Meat +$5.00,
// Bacon +$4.50, $22.45) — one message, one intended pizza, two lines on the
// receipt. "Gyro Meat" is a real Toppings choice on Vito's own Margherita
// (item id 7ef2d0da-f452-4af8-964c-ecddefc6ea75 in production); it is never
// a request for the separate "Gyro - Small (10")" menu item (id
// 8b7a1ec8-1288-4199-82d0-a0dbf58fc22d), even though that real item also
// exists and even though the model sometimes resolves the topping word to
// it.
//
// The PO's own live-probe of the real PROPOSE model never reproduced this
// exact two-add shape twice in a row (model non-determinism — see the
// PO dispatch that assigned this fix for the other two shapes it DID
// reproduce), so this fixture's exact proposal shape below is an INFERENCE
// from the PO's own captured receipt text, not a literal model transcript:
// it assumes PROPOSE produced two adds, the second naming the topping word
// alone ("gyro meat") and resolving it to the real Gyro Pizza menu item,
// with both toppings already filled in as that item's own choices (mirroring
// "both toppings landed on both lines" from the incident report).
//
// Root cause: dropAddsThatAreReallyModifiersOfAnotherAdd (turn-engine.ts)
// already drops a second add whose span IS another add's own modifier
// choice, but its match requires the span's token set to equal a choice's
// FULL compiled display — pizza toppings compile as "X (Whole pizza)"/"X
// (Half pizza)" pairs, and a bare "gyro meat" mention never contains that
// suffix, so the old check missed it. mergeAddsThatAreNamedPlacementChoice-
// OfAnotherAdd closes that gap AND explicitly attaches the matched choice to
// the surviving add (rather than relying on the 00-BF modifier floor, which
// only fires when the survivor's own choices are empty — not true here,
// since the model already filled in Bacon on the Margherita line).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";

const MARGHERITA_ID = "margherita-small";
const GYRO_PIZZA_ID = "gyro-pizza-small";
const MARGHERITA_TOPPINGS_GROUP = "grp-margherita-toppings";
const GYRO_TOPPINGS_GROUP = "grp-gyro-toppings";

// Base price chosen so base + Bacon ($4.50) = $17.45, matching the real
// incident's own (correct, single-line) Margherita subtotal exactly.
const MARGHERITA_BASE_CENTS = 1295;

const MENU: TurnEngineMenuItem[] = [
  {
    id: MARGHERITA_ID, name: "Margherita - Small (10\")", category: "Pizza", price_cents: MARGHERITA_BASE_CENTS,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Margherita Pizza",
      base_price_cents: MARGHERITA_BASE_CENTS, recap_template: "", ticket_template: "",
      steps: [{
        group_id: MARGHERITA_TOPPINGS_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "toppings.ask",
        choices: [
          { id: "m-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
          { id: "m-bacon-half", display: "Bacon (Half pizza)", price_delta_cents: 350 },
          { id: "m-gyro-meat-whole", display: "Gyro Meat (Whole pizza)", price_delta_cents: 500 },
          { id: "m-gyro-meat-half", display: "Gyro Meat (Half pizza)", price_delta_cents: 400 },
        ],
      }],
    },
    option_groups: [{ id: MARGHERITA_TOPPINGS_GROUP, name: "Toppings" }],
  },
  {
    id: GYRO_PIZZA_ID, name: "Gyro - Small (10\")", category: "Pizza", price_cents: 1345,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Gyro Pizza",
      base_price_cents: 1345, recap_template: "", ticket_template: "",
      steps: [{
        group_id: GYRO_TOPPINGS_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "toppings.ask",
        choices: [
          { id: "g-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
          { id: "g-gyro-meat-whole", display: "Gyro Meat (Whole pizza)", price_delta_cents: 500 },
        ],
      }],
    },
    option_groups: [{ id: GYRO_TOPPINGS_GROUP, name: "Toppings" }],
  },
];

const LEXICON = [
  { term: "margherita", target_id: MARGHERITA_ID },
  { term: "margherita pizza", target_id: MARGHERITA_ID },
  { term: "small margherita pizza", target_id: MARGHERITA_ID },
  { term: "gyro meat", target_id: GYRO_PIZZA_ID },
  { term: "gyro pizza", target_id: GYRO_PIZZA_ID },
];

const MESSAGE = "a small Margherita pizza with gyro meat and bacon";

function cartLines(out: { cart: TurnEngineCartLine[] }) {
  return out.cart.filter(l => typeof l.menu_item_id === "string");
}

Deno.test("decide() (Gyro Meat phantom item, real incident conv s2-v557): 'a small Margherita pizza with gyro meat and bacon' -> ONE Margherita line with both toppings, no Gyro Pizza line", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "small Margherita pizza", quantity: 1, choices: [{ group_id: MARGHERITA_TOPPINGS_GROUP, choice_id: "m-bacon-whole" }] },
      { item_span: "gyro meat", quantity: 1, choices: [
        { group_id: GYRO_TOPPINGS_GROUP, choice_id: "g-gyro-meat-whole" },
        { group_id: GYRO_TOPPINGS_GROUP, choice_id: "g-bacon-whole" },
      ] },
    ],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], MENU, LEXICON, undefined, MESSAGE);
  const lines = cartLines(out);
  assertEquals(lines.length, 1, `expected exactly ONE cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(lines[0].menu_item_id, MARGHERITA_ID);
  const optionsJson = JSON.stringify(lines[0].options ?? {});
  assertEquals(optionsJson.includes("Gyro Meat (Whole pizza)"), true, `Gyro Meat must be on the Margherita line — got ${optionsJson}`);
  assertEquals(optionsJson.includes("Bacon (Whole pizza)"), true, `Bacon must be on the Margherita line — got ${optionsJson}`);
  assertEquals(lines[0].price_cents, 2245, `expected $22.45 (2245 cents) total, got ${lines[0].price_cents}`);
});

Deno.test("decide() (Gyro Meat phantom item, reversed order): the phantom Gyro Pizza add listed FIRST still merges into the Margherita, regardless of PROPOSE's own array order", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "gyro meat", quantity: 1, choices: [
        { group_id: GYRO_TOPPINGS_GROUP, choice_id: "g-gyro-meat-whole" },
        { group_id: GYRO_TOPPINGS_GROUP, choice_id: "g-bacon-whole" },
      ] },
      { item_span: "small Margherita pizza", quantity: 1, choices: [{ group_id: MARGHERITA_TOPPINGS_GROUP, choice_id: "m-bacon-whole" }] },
    ],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], MENU, LEXICON, undefined, MESSAGE);
  const lines = cartLines(out);
  assertEquals(lines.length, 1, `expected exactly ONE cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(lines[0].menu_item_id, MARGHERITA_ID);
  assertEquals(lines[0].price_cents, 2245, `expected $22.45 (2245 cents) total, got ${lines[0].price_cents}`);
});

Deno.test("decide() (Gyro Meat phantom item, no false positive): two genuinely DIFFERENT real pizzas named together still land as TWO lines", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "small Margherita pizza", quantity: 1, choices: [] },
      { item_span: "small gyro pizza", quantity: 1, choices: [] },
    ],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], MENU, LEXICON, undefined,
    "a small Margherita pizza and a small gyro pizza");
  const lines = cartLines(out);
  assertEquals(lines.length, 2, `a genuinely separate second pizza must still land as its own line — got ${JSON.stringify(out.cart)}`);
});
