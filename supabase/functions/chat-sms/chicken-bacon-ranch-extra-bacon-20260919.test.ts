// Freeze-queue item 6, part B (2026-09-19 PO dispatch): real Vito's item
// "Chicken Bacon Ranch - Medium (14\")" (display "Medium Chicken Bacon Ranch
// Pizza") carries real "Bacon (Whole pizza)"/"Bacon (Half pizza)" toppings —
// the same pizza whose own name contains the word "bacon". The
// isSubsetOfItemName guard added for the a7266e41 regression (see
// turn-engine.ts's own header on that fix) correctly stops "bacon" from
// being charged as a phantom topping when a customer only NAMES the item
// ("2 Medium Chicken Bacon Ranch pizzas") — but it had no way to tell that
// case apart from a customer explicitly asking for MORE of that same word
// as an addition ("extra bacon"), since the topping's own name is a subset
// of the item's name either way. This file proves both directions: the
// explicit-addition case now resolves, and the original bare-name-leftover
// case this guard exists for is still blocked.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  recoverAssertedChoiceFromText,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";

// Real Vito's raw `name` (not display_name) — this is what scopedModifierText
// strips against, and what recoverAssertedChoiceFromText receives as itemName
// in the real call path (turn-engine.ts line ~3717).
const REAL_ITEM_RAW_NAME = 'Chicken Bacon Ranch - Medium (14")';

const REAL_TOPPINGS = [
  { id: "c-bacon-whole", display: "Bacon (Whole pizza)" },
  { id: "c-bacon-half", display: "Bacon (Half pizza)" },
  { id: "c-sausage-whole", display: "Sausage (Whole pizza)" },
];

// ── Unit level: the modifier floor itself ──────────────────────────────────

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part B): 'extra bacon' on the real Chicken Bacon Ranch pizza recovers the Whole Bacon topping", () => {
  assertEquals(recoverAssertedChoiceFromText("extra bacon", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), "c-bacon-whole");
});

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part B): 'with extra bacon' recovers the same Whole Bacon topping", () => {
  assertEquals(recoverAssertedChoiceFromText("with extra bacon", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), "c-bacon-whole");
});

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part B): 'extra half bacon' recovers the Half variant, not Whole", () => {
  assertEquals(recoverAssertedChoiceFromText("extra half bacon", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), "c-bacon-half");
});

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part B): unaffected toppings ('extra sausage') keep working exactly as before", () => {
  assertEquals(recoverAssertedChoiceFromText("extra sausage", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), "c-sausage-whole");
});

Deno.test("recoverAssertedChoiceFromText (a7266e41 regression, still guarded): a bare 'bacon' leftover with NO explicit-addition word stays blocked — this is the original bug the guard exists for", () => {
  assertEquals(recoverAssertedChoiceFromText("bacon", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), null);
});

Deno.test("recoverAssertedChoiceFromText (a7266e41 regression, still guarded): the negation gate still wins even with 'extra' present ('no extra bacon')", () => {
  assertEquals(recoverAssertedChoiceFromText("no extra bacon", REAL_TOPPINGS, REAL_ITEM_RAW_NAME), null);
});

// ── End to end through decide() ────────────────────────────────────────────

const CBR_PIZZA_ID = "item-cbr-medium";
const TOPPING_GROUP = "grp-toppings";

const CBR_MENU: TurnEngineMenuItem[] = [{
  id: CBR_PIZZA_ID, name: REAL_ITEM_RAW_NAME, category: "Pizza", price_cents: 1795, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Medium Chicken Bacon Ranch Pizza",
    base_price_cents: 1795, recap_template: "", ticket_template: "",
    steps: [{
      group_id: TOPPING_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "toppings.ask",
      choices: [
        { id: "c-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
        { id: "c-bacon-half", display: "Bacon (Half pizza)", price_delta_cents: 350 },
        { id: "c-sausage-whole", display: "Sausage (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPING_GROUP, name: "Toppings" }],
}];

const CBR_LEXICON = [
  { term: "chicken bacon ranch", target_id: CBR_PIZZA_ID },
  { term: "medium chicken bacon ranch pizza", target_id: CBR_PIZZA_ID },
];

Deno.test("decide() (freeze-queue item 6, part B END TO END): 'a Chicken Bacon Ranch pizza with extra bacon' adds ONE pizza with the Bacon topping applied as an addition", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "chicken bacon ranch", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], CBR_MENU, CBR_LEXICON, undefined,
                     "a Chicken Bacon Ranch pizza with extra bacon");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(JSON.stringify(lines[0].options ?? {}).includes("Bacon (Whole pizza)"), true,
    `the Bacon topping must be applied as an addition — got ${JSON.stringify(lines[0].options)}`);
});

Deno.test("decide() (a7266e41 regression END TO END, still guarded): '2 Medium Chicken Bacon Ranch pizzas' with no addition language never charges a phantom Bacon topping", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "chicken bacon ranch", quantity: 2, choices: [] }],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], CBR_MENU, CBR_LEXICON, undefined,
                     "2 Medium Chicken Bacon Ranch pizzas");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  for (const line of lines) {
    assertEquals(JSON.stringify(line.options ?? {}).includes("Bacon"), false,
      `naming the item alone must never add a phantom Bacon topping — got ${JSON.stringify(line.options)}`);
  }
});
