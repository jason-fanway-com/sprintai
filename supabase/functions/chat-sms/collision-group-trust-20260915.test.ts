// PO fix (00-BK): a group in the collision set — the exact predicate
// groupNeedsNumericStems (ask-plan-engine.ts, already computed by 00-BJ for
// numeric-stem significance) — never trusts a model-asserted choice_id on
// its own. decide()'s structured add/modify path (turn-engine.ts:609/:657)
// always calls the underlying resolver with customerMessage="" for this
// branch, so for a collision group matchChoiceInText("", ...) trivially
// returns null and the assertion is rejected; the slot re-asks instead.
//
// This closes the CONFIRMED live wings bug (00-BE/00-BF: bare "2" ->
// "20 Pieces", +$8.00) at its real, empirically-traced location (00-BH),
// without decide() gaining a customer message it doesn't have — the fourth
// scoping attempt on this defect, after three that were wrong (00-BG Part
// 1, 00-BH Part B alone, 00-BI's global numeric-stem hypothesis).
//
// A non-collision group (Temp, Size, ...) is completely unaffected:
// matchAssertedChoice still runs unconditionally there, so one-shot adds
// that previously worked ("medium cheeseburger", "large pepperoni pizza")
// must keep working — asserted explicitly below, since these are exactly
// what the three prior, wrong scoping attempts broke.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import {
  resolveAskPlan,
  applyCompiledAddItem,
  type CompiledMenuItem,
  type CompiledCartLine,
} from "./ask-plan-engine.ts";
import { decide, type Proposal, type TurnEngineMenuItem } from "./turn-engine.ts";
import type { LexiconTerm } from "./resolve-item.ts";

// ── Real Zio's Boneless Wings / Bone In Wings shapes (00-BF's family scan). ─
const BONELESS_SAUCE_STEP: CompiledStep = {
  group_id: "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d", slot_key: "flavor", kind: "slot", ask_mode: "ask", prompt_template: "flavor.ask",
  choices: [
    { id: "hot", display: "Hot Sauce", price_delta_cents: 0 },
    { id: "bbq", display: "BBQ Sauce", price_delta_cents: 0 },
  ],
};
const BONELESS_QTY_STEP: CompiledStep = {
  group_id: "8774670c-7f71-4ee9-b9b4-a80552309321", slot_key: null, kind: "slot", ask_mode: "ask", prompt_template: "quantity.ask",
  choices: [
    { id: "10pc", display: "10 Pieces", price_delta_cents: 0 },
    { id: "20pc", display: "20 Pieces", price_delta_cents: 800 },
  ],
};
const BONELESS_WINGS_PLAN: AskPlan = {
  compiled_at: "2026-09-15T21:51:39.877Z", compiler_version: 1, display_name: "Boneless Wings", base_price_cents: 1000,
  steps: [BONELESS_SAUCE_STEP, BONELESS_QTY_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

const BONE_IN_QTY_STEP: CompiledStep = {
  group_id: "4bf0c277-fa9e-4d48-bc18-4f3705c94baf", slot_key: null, kind: "slot", ask_mode: "ask", prompt_template: "quantity.ask",
  choices: [
    { id: "8pc", display: "8 Pieces", price_delta_cents: 0 },
    { id: "14pc", display: "14 Pieces", price_delta_cents: 700 },
  ],
};
const BONE_IN_WINGS_PLAN: AskPlan = {
  compiled_at: "2026-09-15T21:51:39.877Z", compiler_version: 1, display_name: "Bone In Wings", base_price_cents: 1200,
  steps: [BONE_IN_QTY_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

// ── Item 1: confirmed live case, exact decide()-path shape (customerText="") ─
Deno.test("00-BK item 1: Boneless Wings Quantity, decide()-path shape (customerText=''), model asserts '20 Pieces' — writes nothing, no price delta", () => {
  const result = resolveAskPlan(
    BONELESS_WINGS_PLAN, "", new Set(["b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d"]), new Map(),
    undefined, ["20 Pieces"], // the exact live PROPOSE assertion captured in 00-BE
  );
  assertEquals(result.resolved, [], "the model's own asserted choice_id must not resolve a collision-set slot with no customer text");
  assertEquals(result.nextStep?.group_id, "8774670c-7f71-4ee9-b9b4-a80552309321");
  assertEquals(result.totalDeltaCents, 0, "no price delta — the $8.00 upcharge must never be applied");
});

Deno.test("00-BK item 1 (full cart level): applyCompiledAddItem, sauce already resolved, model asserts '20 Pieces' for Quantity via a structured choices array — nothing written, price unchanged, slot still pending", () => {
  const menuItem: CompiledMenuItem = {
    ask_plan: BONELESS_WINGS_PLAN, bot_state: "orderable",
    option_groups: [
      { id: "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d", name: "Choose Sauce", default_choice_id: null },
      { id: "8774670c-7f71-4ee9-b9b4-a80552309321", name: "Quantity", default_choice_id: null },
    ],
  };
  const cart: CompiledCartLine[] = [{
    menu_item_id: "wings-id", name: "Boneless Wings", quantity: 2, price_cents: 1000,
    modifiers: [], pending_options: ["Quantity"],
    ask_plan_selections: { "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d": "hot" },
  }];
  const before = JSON.stringify(cart[0].ask_plan_selections);
  const beforePrice = cart[0].price_cents;

  // Mirrors decide()'s real ADD path exactly: customerMessage="", texts from
  // resolveChoiceDisplays for a structured {group_id, choice_id} the model proposed.
  const result = applyCompiledAddItem(cart, menuItem, "wings-id", 2, "", undefined, undefined, ["20 Pieces"]);

  assertEquals(JSON.stringify(cart[0].ask_plan_selections), before, "ask_plan_selections must be byte-unchanged");
  assertEquals(cart[0].price_cents, beforePrice, "no price change — the $8.00 upcharge must never be applied");
});

Deno.test("00-BK item 2: Bone In Wings Quantity (8|14 Pieces), decide()-path shape, model asserts '14 Pieces' — writes nothing, no price delta", () => {
  const result = resolveAskPlan(
    BONE_IN_WINGS_PLAN, "", new Set(), new Map(),
    undefined, ["14 Pieces"],
  );
  assertEquals(result.resolved, []);
  assertEquals(result.nextStep?.group_id, "4bf0c277-fa9e-4d48-bc18-4f3705c94baf");
  assertEquals(result.totalDeltaCents, 0);
});

// ── Item 3: one-shot adds on NON-collision groups must be completely unaffected ─
const TEMP_STEP: CompiledStep = {
  group_id: "grp-temp", slot_key: null, kind: "slot", ask_mode: "ask", prompt_template: "temp.ask",
  choices: [
    { id: "well", display: "Well Done", price_delta_cents: 0 },
    { id: "med", display: "Medium", price_delta_cents: 0 },
    { id: "rare", display: "Rare", price_delta_cents: 0 },
  ],
};
const CHEESEBURGER_PLAN: AskPlan = {
  compiled_at: "2026-09-15T00:00:00Z", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849,
  steps: [TEMP_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

Deno.test("00-BK item 3a: 'medium cheeseburger' still resolves Temp in one shot via decide()'s structured path (customerText='', model asserts 'Medium')", () => {
  const result = resolveAskPlan(CHEESEBURGER_PLAN, "", new Set(), new Map(), undefined, ["Medium"]);
  assertEquals(result.resolved.length, 1, "Temp is NOT a collision group — the model's assertion must still be trusted");
  assertEquals(result.resolved[0].choice.display, "Medium");
});

const PIZZA_SIZE_STEP: CompiledStep = {
  group_id: "grp-size", slot_key: null, kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
  choices: [
    { id: "c-small", display: "Small", price_delta_cents: 0 },
    { id: "c-large", display: "Large", price_delta_cents: 500 },
  ],
};
const PIZZA_TOPPING_STEP: CompiledStep = {
  group_id: "grp-top", slot_key: null, kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.on_request",
  choices: [{ id: "pepperoni", display: "Pepperoni", price_delta_cents: 300 }],
};
const PEPPERONI_PIZZA_PLAN: AskPlan = {
  compiled_at: "2026-09-15T00:00:00Z", compiler_version: 1, display_name: "Cheese Pizza", base_price_cents: 1200,
  steps: [PIZZA_SIZE_STEP, PIZZA_TOPPING_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

Deno.test("00-BK item 3b: 'large pepperoni pizza' still resolves Size AND the Pepperoni topping in one shot via decide()'s structured path", () => {
  const result = resolveAskPlan(PEPPERONI_PIZZA_PLAN, "", new Set(), new Map(), undefined, ["Large", "Pepperoni"]);
  const sizeResolved = result.resolved.find(r => r.group_id === "grp-size");
  const toppingResolved = result.resolved.find(r => r.group_id === "grp-top");
  assertEquals(sizeResolved?.choice.display, "Large", "Size is NOT a collision group — must still resolve from the model's assertion");
  assertEquals(toppingResolved?.choice.display, "Pepperoni", "modifiers resolve via a separate, already-trusted channel — unaffected");
});

// ── New coverage (00-BL, item added per Jason's "coverage must come out
// stronger, not equal"): the confirmed live bug's EXACT shape, pinned at
// decide() itself — not only at resolveAskPlan/applyCompiledAddItem one
// level down. Nothing before this test called decide() directly for a
// collision group with an empty-cart ADD proposal the way the live
// conversation actually did. RED on 6207ecea (pre-00-BK): resolves "20
// Pieces" and prices +$8.00. GREEN after 00-BK. ───────────────────────────
const WINGS_ID_DECIDE = "cb53dc5b-5abe-4110-a814-3beacec644e8";
const DECIDE_SAUCE_GROUP_ID = "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d";
const DECIDE_QTY_GROUP_ID = "8774670c-7f71-4ee9-b9b4-a80552309321";
const DECIDE_HOT_SAUCE_ID = "870dc306-c2a1-432e-b3af-aea31e109581";
const DECIDE_TWENTY_PIECES_ID = "dc16bc2d-72c0-42c1-b031-c792048b3fba";

const WINGS_MENU_FOR_DECIDE: TurnEngineMenuItem[] = [{
  id: WINGS_ID_DECIDE, name: "Boneless Wings", category: "Wings", price_cents: 1000, bot_state: "orderable", upsell: null,
  option_groups: [
    { id: DECIDE_SAUCE_GROUP_ID, name: "Choose Sauce", default_choice_id: null },
    { id: DECIDE_QTY_GROUP_ID, name: "Quantity", default_choice_id: null },
  ],
  ask_plan: {
    compiled_at: "2026-09-15T21:51:39.877Z", compiler_version: 1, display_name: "Boneless Wings", base_price_cents: 1000,
    recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [
      { kind: "slot", ask_mode: "ask", group_id: DECIDE_SAUCE_GROUP_ID, slot_key: "flavor", prompt_template: "flavor.ask",
        choices: [{ id: DECIDE_HOT_SAUCE_ID, display: "Hot Sauce", price_delta_cents: 0 }] },
      { kind: "slot", ask_mode: "ask", group_id: DECIDE_QTY_GROUP_ID, slot_key: null, prompt_template: "quantity.ask",
        choices: [
          { id: "10pc", display: "10 Pieces", price_delta_cents: 0 },
          { id: DECIDE_TWENTY_PIECES_ID, display: "20 Pieces", price_delta_cents: 800 },
        ] },
    ],
  } as AskPlan,
}];
const WINGS_LEXICON_FOR_DECIDE: LexiconTerm[] = [{ term: "boneless wings", target_id: WINGS_ID_DECIDE }];

Deno.test("00-BL new coverage: decide()'s ADD path, real captured live proposal (Hot Sauce + wrong '20 Pieces'), empty cart — resolves nothing for Quantity, no $8.00 upcharge", () => {
  const proposal: Proposal = {
    intent: "order",
    adds: [{
      item_span: "boneless wings", quantity: 2,
      choices: [
        { group_id: DECIDE_SAUCE_GROUP_ID, choice_id: DECIDE_HOT_SAUCE_ID },
        { group_id: DECIDE_QTY_GROUP_ID, choice_id: DECIDE_TWENTY_PIECES_ID }, // the model's actual wrong guess, captured live in 00-BE
      ],
    }],
    removes: [], modifies: [],
  };
  const result = decide(proposal, [], WINGS_MENU_FOR_DECIDE, WINGS_LEXICON_FOR_DECIDE);
  assertEquals(result.declines, []);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].price_cents, 1000, "base price only — the $8.00 upcharge for '20 Pieces' must never be applied");
  assertEquals(result.cart[0].options, { "Choose Sauce": ["Hot Sauce"] }, "Quantity must NOT appear — the collision group never resolves from the model's assertion alone");
  assertEquals(result.cart[0].pending_options, ["Quantity"], "the Quantity slot is still pending, correctly re-asked");
});
