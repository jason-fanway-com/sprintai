// PO dispatch 2026-09-19: three live rough edges surfaced after b65c5bea's
// half-pepperoni fix (see that commit's own header for the modifier-floor
// mechanism these build on).
//
//   (a) a topping already consumed as a modifier of a named host item must
//       not ALSO open a "did you mean X or Y?" disambiguation for the same
//       word.
//   (b) "a pepperoni stromboli" must resolve the same way "a pepperoni
//       pizza" does — a category named by a word that is a real synonym for
//       one of the tied candidates' own category, even on a genuine TIE
//       (not just the pre-existing unique-base case).
//   (c) two toppings named with their own placement in one clause ("half
//       pepperoni half sausage") must BOTH land, not both silently drop.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  recoverAssertedChoiceFromText,
  recoverAssertedChoicesFromText,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";

// ── Unit level: the placement-aware modifier floor itself ─────────────────

const PIZZA_TOPPINGS = [
  { id: "c-pepperoni-whole", display: "Pepperoni (Whole pizza)" },
  { id: "c-pepperoni-half", display: "Pepperoni (Half pizza)" },
  { id: "c-sausage-whole", display: "Sausage (Whole pizza)" },
  { id: "c-sausage-half", display: "Sausage (Half pizza)" },
];

Deno.test("recoverAssertedChoiceFromText (wart a): a bare topping mention with no half/whole word recovers the Whole variant", () => {
  assertEquals(recoverAssertedChoiceFromText("a large cheese pizza with pepperoni", PIZZA_TOPPINGS), "c-pepperoni-whole");
});

Deno.test("recoverAssertedChoiceFromText (regression, b65c5bea): an explicit half still recovers the Half variant, never Whole", () => {
  assertEquals(recoverAssertedChoiceFromText("a large cheese pizza with half pepperoni", PIZZA_TOPPINGS), "c-pepperoni-half");
});

Deno.test("recoverAssertedChoiceFromText (wart c contract): two toppings named at once still resolves NOTHING via the singular floor — this is exactly why the plural floor below exists, not a relaxation of it", () => {
  assertEquals(recoverAssertedChoiceFromText("a large pizza half pepperoni half sausage", PIZZA_TOPPINGS), null);
});

Deno.test("recoverAssertedChoicesFromText (wart c): 'half pepperoni half sausage' recovers BOTH half choices, neither dropped", () => {
  const hits = recoverAssertedChoicesFromText("a large pizza half pepperoni half sausage", PIZZA_TOPPINGS);
  assertEquals([...hits].sort(), ["c-pepperoni-half", "c-sausage-half"].sort());
});

Deno.test("recoverAssertedChoicesFromText (wart c, word order): 'sausage on one half, pepperoni on the other' still recovers both halves regardless of order", () => {
  const hits = recoverAssertedChoicesFromText("sausage on one half pepperoni on the other half", PIZZA_TOPPINGS);
  assertEquals([...hits].sort(), ["c-pepperoni-half", "c-sausage-half"].sort());
});

Deno.test("recoverAssertedChoicesFromText (wart a via plural entry point): a bare single topping still recovers only its Whole variant", () => {
  assertEquals(recoverAssertedChoicesFromText("with pepperoni", PIZZA_TOPPINGS), ["c-pepperoni-whole"]);
});

Deno.test("recoverAssertedChoicesFromText: negation still blocks everything, even with placement language present", () => {
  assertEquals(recoverAssertedChoicesFromText("no pepperoni, half sausage", PIZZA_TOPPINGS), []);
});

Deno.test("recoverAssertedChoicesFromText: plain (non-placement) choices keep the pre-existing single-recovery-only contract — two named, neither guessed", () => {
  const plain = [
    { id: "c-sausage", display: "Sausage" },
    { id: "c-onions", display: "Onions" },
  ];
  assertEquals(recoverAssertedChoicesFromText("with sausage and onions", plain), []);
  assertEquals(recoverAssertedChoicesFromText("with sausage", plain), ["c-sausage"]);
});

// ── End to end through decide() ────────────────────────────────────────────

const PIZZA_ID = "item-cheese-pizza";
const PEPPERONI_PIZZA_ID = "item-pepperoni-pizza"; // a DIFFERENT real menu item sharing the bare "pepperoni" lexicon term
const PEPPERONI_ROLL_ID = "item-pepperoni-roll";   // ditto, from a different category entirely
const TOPPING_GROUP = "grp-toppings";

const PIZZA_MENU: TurnEngineMenuItem[] = [{
  id: PIZZA_ID, name: "Large Cheese Pizza", category: "Pizza", price_cents: 1650, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Large Cheese Pizza",
    base_price_cents: 1650, recap_template: "", ticket_template: "",
    steps: [{
      group_id: TOPPING_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "toppings.ask",
      choices: [
        { id: "c-pepperoni-whole", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
        { id: "c-pepperoni-half", display: "Pepperoni (Half pizza)", price_delta_cents: 350 },
        { id: "c-sausage-whole", display: "Sausage (Whole pizza)", price_delta_cents: 450 },
        { id: "c-sausage-half", display: "Sausage (Half pizza)", price_delta_cents: 350 },
      ],
    }],
  },
  option_groups: [{ id: TOPPING_GROUP, name: "Toppings" }],
}];

// resolveItem is only ever exercised via decide() here — the ambiguous
// "pepperoni" tie against two REAL other items is the exact shape that
// wrongly re-opened a disambiguation question after b65c5bea's own fix
// already recovered the topping as this pizza's own modifier.
const PIZZA_LEXICON = [
  { term: "cheese pizza", target_id: PIZZA_ID },
  { term: "large cheese pizza", target_id: PIZZA_ID },
  { term: "pepperoni", target_id: PEPPERONI_PIZZA_ID },
  { term: "pepperoni", target_id: PEPPERONI_ROLL_ID },
];

Deno.test("decide() (wart a END TO END): 'a large cheese pizza with pepperoni' adds ONE pizza with the Whole pepperoni modifier and asks NO disambiguation question", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "large cheese pizza", quantity: 1, choices: [] },
      { item_span: "pepperoni", quantity: 1, choices: [] },
    ],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], PIZZA_MENU, PIZZA_LEXICON, undefined,
                     "a large cheese pizza with pepperoni");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(JSON.stringify(lines[0].options ?? {}).includes("Pepperoni (Whole pizza)"), true,
    `the Whole pepperoni modifier must be on the line — got ${JSON.stringify(lines[0].options)}`);
  assertEquals(out.disambiguationCandidateIds, null,
    `a topping already consumed as this pizza's own modifier must not also open a disambiguation question — got ${JSON.stringify(out.disambiguationCandidateIds)}`);
});

Deno.test("decide() (regression, b65c5bea END TO END): 'a large cheese pizza with half pepperoni' still adds ONE pizza with the Half modifier, not two lines", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      { item_span: "large cheese pizza", quantity: 1, choices: [] },
      { item_span: "pepperoni", quantity: 1, choices: [] },
    ],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], PIZZA_MENU, PIZZA_LEXICON, undefined,
                     "a large cheese pizza with half pepperoni");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(JSON.stringify(lines[0].options ?? {}).includes("Pepperoni (Half pizza)"), true,
    `the Half pepperoni modifier must be on the line — got ${JSON.stringify(lines[0].options)}`);
});

Deno.test("decide() (wart c END TO END): 'half pepperoni half sausage' on one pizza adds BOTH toppings, neither dropped", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "large cheese pizza", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], PIZZA_MENU, PIZZA_LEXICON, undefined,
                     "a large cheese pizza half pepperoni half sausage");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  const opts = JSON.stringify(lines[0].options ?? {});
  assertEquals(opts.includes("Pepperoni (Half pizza)"), true, `pepperoni must be on the line — got ${opts}`);
  assertEquals(opts.includes("Sausage (Half pizza)"), true, `sausage must be on the line — got ${opts}`);
});
