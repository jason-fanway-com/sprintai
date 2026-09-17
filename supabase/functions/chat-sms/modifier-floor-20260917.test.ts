// 00-BF: a choice the customer plainly said, that the model never asserted,
// must not be silently lost. "2 Regular Slices with sausage" lost the sausage
// 4 times out of 4 against the live build.
//
// The dangerous direction here is the opposite of most fixes on this engine:
// a false positive ADDS A PAID TOPPING the customer never asked for, and they
// cannot undo it after paying. So most of these tests are about NOT matching.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recoverAssertedChoiceFromText } from "./turn-engine.ts";

const TOPPINGS = [
  { id: "c-sausage", display: "Sausage" },
  { id: "c-onions", display: "Onions" },
  { id: "c-bacon", display: "Bacon" },
  { id: "c-steak", display: "Steak" },
  { id: "c-chicken-steak", display: "Chicken Steak" },
];

Deno.test("00-BF: the live repro — the sausage is recovered", () => {
  assertEquals(recoverAssertedChoiceFromText("2 Regular Slices with sausage", TOPPINGS), "c-sausage");
  assertEquals(recoverAssertedChoiceFromText("with bacon on it please", TOPPINGS), "c-bacon");
});

Deno.test("00-BF: negation must never add a paid topping", () => {
  for (const t of [
    "2 slices no sausage",
    "slices without sausage",
    "hold the bacon",
    "skip the onions",
    "no bacon please",
    "everything except bacon",
    "leave off the onions",
  ]) {
    assertEquals(recoverAssertedChoiceFromText(t, TOPPINGS), null, `must not add for: ${t}`);
  }
});

Deno.test("00-BF: an ambiguous match resolves NOTHING, never a guess", () => {
  // "chicken steak" contains "steak" — two choices match, so nothing applies.
  assertEquals(recoverAssertedChoiceFromText("with chicken steak", TOPPINGS), null);
  // two distinct toppings named — this floor only ever recovers a single one
  assertEquals(recoverAssertedChoiceFromText("with sausage and onions", TOPPINGS), null);
});

Deno.test("00-BF: no match, empty input, and short display names are all inert", () => {
  assertEquals(recoverAssertedChoiceFromText("just a plain slice", TOPPINGS), null);
  assertEquals(recoverAssertedChoiceFromText("", TOPPINGS), null);
  assertEquals(recoverAssertedChoiceFromText("   ", TOPPINGS), null);
  assertEquals(recoverAssertedChoiceFromText("anything", []), null);
  // a 2-letter choice is never matched — too collision-prone to risk money on
  assertEquals(recoverAssertedChoiceFromText("I want it xl", [{ id: "c-xl", display: "XL" }]), null);
});

Deno.test("00-BF: a word inside another item's name must not become a topping claim", () => {
  // scopedModifierText strips the item's own name before this is called; this
  // asserts the floor itself does not match on a substring of a longer word.
  assertEquals(recoverAssertedChoiceFromText("sausages", TOPPINGS), null);
  assertEquals(recoverAssertedChoiceFromText("baconator", TOPPINGS), null);
});

// ── end to end through decide(), not just the helper ──────────────────────
// The helper passing proves nothing about whether the floor is WIRED. That
// mistake was made earlier today with a guard whose test passed with the guard
// disabled, so this drives the real decision path.

import { decide } from "./turn-engine.ts";
import type { TurnEngineCartLine, TurnEngineMenuItem, Proposal } from "./turn-engine.ts";

const SLICE = "item-slice";
const TOPPING_GROUP = "grp-toppings";
const SLICE_MENU: TurnEngineMenuItem[] = [{
  id: SLICE, name: "Regular Slice", category: "Pizza", price_cents: 285, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Regular Slice",
    base_price_cents: 285, recap_template: "", ticket_template: "",
    steps: [{
      group_id: TOPPING_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "toppings.ask",
      choices: [
        { id: "c-sausage", display: "Sausage", price_delta_cents: 50 },
        { id: "c-onions", display: "Onions", price_delta_cents: 50 },
      ],
    }],
  },
  option_groups: [{ id: TOPPING_GROUP, name: "Toppings" }],
}];
const SLICE_LEX = [{ term: "regular slices", target_id: SLICE }, { term: "regular slice", target_id: SLICE }];

// The model resolves the ITEM but asserts NO choices — the live failure.
const addNoChoices: Proposal = {
  intent: "order", removes: [], modifies: [],
  adds: [{ item_span: "2 Regular Slices", quantity: 2, choices: [] }],
};

Deno.test("00-BF END TO END: the sausage survives the real decision path", () => {
  const out = decide(addNoChoices, [] as TurnEngineCartLine[], SLICE_MENU, SLICE_LEX, undefined,
                     "a Chicken Fajita and 2 Regular Slices with sausage, please");
  const line = out.cart.find(l => l.menu_item_id === SLICE);
  const opts = JSON.stringify(line?.options ?? {});
  assertEquals(opts.includes("Sausage"), true, `the sausage must be on the line — got ${opts}`);
});

Deno.test("00-BF END TO END: 'no sausage' must NOT put a paid topping on the line", () => {
  const out = decide(addNoChoices, [] as TurnEngineCartLine[], SLICE_MENU, SLICE_LEX, undefined,
                     "2 Regular Slices with no sausage please");
  const line = out.cart.find(l => l.menu_item_id === SLICE);
  assertEquals(JSON.stringify(line?.options ?? {}).includes("Sausage"), false, "negation must block it");
});
