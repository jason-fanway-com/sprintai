// Freeze-queue item 6, part C (2026-09-19 PO dispatch): the dispatch's own
// premise — a quesadilla with a required "protein CHOICE" option_group
// listing "grilled chicken" as one of its choices — does NOT exist on
// Vito's real live menu. Real query (menu_id 54a42842-32be-43b5-9e0c-
// 00fae0ce48fc, shop e0000000-0000-0000-0000-000000000001): the
// "Quesadillas" category has 5 items ("Chicken Fajita", "Chicken", "Steak",
// "Southwest Chicken", "Veggie Quesadilla"), each carrying one OPTIONAL
// "Add-ons" MODIFIER group (min_select 0, max_select 4) with choices
// Chicken ($4.00), Shrimp ($6.00), Blackened Salmon ($8.00), Black Diamond
// Steak ($8.00) — there is no required protein slot, and no choice
// anywhere on the menu is literally named "Grilled Chicken". See
// po-inbox-result.md for the full investigation writeup.
//
// The investigation surfaced a REAL, adjacent, reproduced defect in the
// same modifier-floor mechanism part B touched: the "Chicken" quesadilla
// item is itself named after its own protein, identically to its own
// Add-ons choice ("Chicken") — so isSubsetOfItemName's pre-fix blanket
// subset check treated the ENTIRE candidate as "just naming the item" and
// could never recover it, for ANY phrasing ("with chicken", "with grilled
// chicken"), even though it is a real, priced, listed add-on. This file
// proves the fix: an exact name match (the whole item IS the protein) no
// longer blocks recovery, while a fragment match (the real a7266e41 shape
// — a word embedded in a LONGER item name, like "bacon" in "Chicken Bacon
// Ranch") still does.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  recoverAssertedChoiceFromText,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";

// Real Vito's Quesadillas "Chicken" item (id ca76b6d2-351e-437a-a33b-
// b9a6ab6b23b2) — raw name and display_name are both literally "Chicken".
const QUESADILLA_RAW_NAME = "Chicken";
const REAL_ADDONS = [
  { id: "c-chicken", display: "Chicken" },
  { id: "c-shrimp", display: "Shrimp" },
  { id: "c-salmon", display: "Blackened Salmon" },
  { id: "c-steak", display: "Black Diamond Steak" },
];

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part C): 'with grilled chicken' on the real 'Chicken' quesadilla recovers the Chicken add-on — no 'Grilled Chicken' choice exists, this is the closest real match", () => {
  assertEquals(recoverAssertedChoiceFromText("with grilled chicken", REAL_ADDONS, QUESADILLA_RAW_NAME), "c-chicken");
});

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part C): plain 'with chicken' also now recovers the Chicken add-on (previously blocked for ANY phrasing, since the item's own name IS 'Chicken')", () => {
  assertEquals(recoverAssertedChoiceFromText("with chicken", REAL_ADDONS, QUESADILLA_RAW_NAME), "c-chicken");
});

Deno.test("recoverAssertedChoiceFromText (freeze-queue item 6, part C): unaffected add-ons ('with shrimp') keep working exactly as before", () => {
  assertEquals(recoverAssertedChoiceFromText("with shrimp", REAL_ADDONS, QUESADILLA_RAW_NAME), "c-shrimp");
});

Deno.test("recoverAssertedChoiceFromText (a7266e41 regression, still guarded): a FRAGMENT of a longer item name is still blocked — 'bacon' inside 'Chicken Bacon Ranch' is unaffected by the exact-match carve-out", () => {
  const cbrChoices = [
    { id: "bacon-whole", display: "Bacon (Whole pizza)" },
    { id: "bacon-half", display: "Bacon (Half pizza)" },
  ];
  assertEquals(recoverAssertedChoiceFromText("bacon", cbrChoices, 'Chicken Bacon Ranch - Medium (14")'), null);
});

// ── End to end through decide() ────────────────────────────────────────────

const QUESADILLA_ID = "item-chicken-quesadilla";
const ADDON_GROUP = "grp-addons";

const QUESADILLA_MENU: TurnEngineMenuItem[] = [{
  id: QUESADILLA_ID, name: QUESADILLA_RAW_NAME, category: "Quesadillas", price_cents: 1249, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Chicken",
    base_price_cents: 1249, recap_template: "", ticket_template: "",
    steps: [{
      group_id: ADDON_GROUP, slot_key: "addons", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "addons.ask",
      choices: [
        { id: "c-chicken", display: "Chicken", price_delta_cents: 400 },
        { id: "c-shrimp", display: "Shrimp", price_delta_cents: 600 },
        { id: "c-salmon", display: "Blackened Salmon", price_delta_cents: 800 },
        { id: "c-steak", display: "Black Diamond Steak", price_delta_cents: 800 },
      ],
    }],
  },
  option_groups: [{ id: ADDON_GROUP, name: "Add-ons" }],
}];

const QUESADILLA_LEXICON = [
  { term: "chicken", target_id: QUESADILLA_ID },
  { term: "chicken quesadilla", target_id: QUESADILLA_ID },
];

Deno.test("decide() (freeze-queue item 6, part C END TO END): 'a Chicken quesadilla with grilled chicken' adds ONE quesadilla with the Chicken add-on applied", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "chicken quesadilla", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], QUESADILLA_MENU, QUESADILLA_LEXICON, undefined,
                     "a Chicken quesadilla with grilled chicken");
  const lines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(JSON.stringify(lines[0].options ?? {}).includes("Chicken"), true,
    `the Chicken add-on must be applied — got ${JSON.stringify(lines[0].options)}`);
  assertEquals(out.disambiguationCandidateIds, null,
    `'grilled chicken' must resolve as this item's own add-on, never open a separate-item disambiguation — got ${JSON.stringify(out.disambiguationCandidateIds)}`);
});
