// PO fix (00-BH Part B — narrowed from 00-BG Part 1, which unconditionally
// gated the SHARED resolveAskPlan and broke 4 pre-existing tests: 00-BG
// Part 1 could not tell "the model guessed from ambiguous free text" (the
// confirmed wings bug) apart from "decide()'s structured add/modify path
// carries the model's own already-parsed choice_ids with customerMessage
// always ''" (a completely different, legitimate trust channel — see
// ask-plan-engine.test.ts:960, turn-engine-stale-line-key.test.ts:196,
// turn-engine.test.ts:699/781).
//
// `requireTextualSupportForSlots` is an opt-in flag (default false,
// unchanged behavior everywhere) threaded resolveAskPlan ->
// resolveAndPriceSelections -> applyCompiledModifyItem, set true ONLY at
// turn-engine.ts's answer() "slot" call — the free-text fallback path.
// When true, a model-asserted choice is never trusted for a slot; only
// matchChoiceInText's own read of the customer's text counts.
//
// 00-BH confirmed EMPIRICALLY (a real proposeTurn() call, then decide(),
// both against the real Zio's Boneless Wings ask_plan) that the CONFIRMED
// live wings bug (00-BE/00-BF: bare "2" -> "20 Pieces", +$8.00) flows
// through decide()'s structured ADD path (turn-engine.ts:609), not
// answer()'s slot case (turn-engine.ts:360) — which already passes `[]`
// for modelAssertedChoiceTexts today, by construction, and so was never
// reachable via a model assertion in the first place. This narrower fix
// does NOT close that bug — see 00-BH's report. It still closes a real,
// adjacent gap: the free-text answer path no longer trusts a model
// assertion with zero textual support, should any future change to that
// call site ever start passing one.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import {
  resolveAskPlan,
  applyCompiledAddItem,
  applyCompiledModifyItem,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "./ask-plan-engine.ts";

// Real Zio's Boneless Wings + Bone In Wings choice ids/prices, read live
// from menu_items.ask_plan 2026-09-15 (00-BF's family scan).
const BONELESS_SAUCE_STEP: CompiledStep = {
  group_id: "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d", slot_key: "flavor", kind: "slot", ask_mode: "ask", prompt_template: "flavor.ask",
  choices: [
    { id: "sweet-hot", display: "Sweet & Hot Sauce", price_delta_cents: 0 },
    { id: "mild", display: "Mild Sauce", price_delta_cents: 0 },
    { id: "hot", display: "Hot Sauce", price_delta_cents: 0 },
    { id: "bbq", display: "BBQ Sauce", price_delta_cents: 0 },
    { id: "plain", display: "Plain", price_delta_cents: 0 },
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

Deno.test("resolveAskPlan, flag ON (matches turn-engine.ts's answer() call): bare '2' against Boneless Wings Quantity (10|20 Pieces) resolves NOTHING even when the model asserts '20 Pieces'", () => {
  const result = resolveAskPlan(
    BONELESS_WINGS_PLAN, "2", new Set(["b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d"]), new Map(),
    undefined, ["20 Pieces"], // the exact live PROPOSE assertion captured in 00-BE
    undefined, true, // requireTextualSupportForSlots
  );
  assertEquals(result.resolved, [], "with the flag on, the model's own asserted choice_id must not resolve a slot the customer's text doesn't support");
  assertEquals(result.nextStep?.group_id, "8774670c-7f71-4ee9-b9b4-a80552309321", "the Quantity slot must still be the open question");
  assertEquals(result.totalDeltaCents, 0, "no price delta — the $8.00 upcharge must never be applied");
});

// PO fix (00-BK, INVERTED from its original 00-BH assertion — see git blame
// for the before): this test used to document that the flag-OFF path (which
// is exactly decide()'s add/modify shape) still trusted the model's
// assertion for Boneless Wings Quantity — the live money bug, left open on
// purpose while 00-BH's narrower fix was scoped. 00-BK closed that specific
// gap: Boneless Wings Quantity is in the collision set (groupNeedsNumericStems),
// and a collision-set group never trusts a model assertion regardless of
// requireTextualSupportForSlots. "Never weaken a gate to make something
// pass" — this test is not deleted, it now pins the fix instead of the hole.
Deno.test("resolveAskPlan, flag OFF but Boneless Wings Quantity is a COLLISION group (00-BK): bare '2' resolves NOTHING even though the model asserts '20 Pieces' — the confirmed live wings bug, closed", () => {
  const result = resolveAskPlan(
    BONELESS_WINGS_PLAN, "2", new Set(["b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d"]), new Map(),
    undefined, ["20 Pieces"], // the exact live PROPOSE assertion captured in 00-BE
    // requireTextualSupportForSlots omitted -> defaults to false, but the
    // collision-group gate (00-BK) is independent of this flag.
  );
  assertEquals(result.resolved, [], "a collision-set group never trusts a model assertion, flag or no flag — this is the fix, not the hole, as of 00-BK");
  assertEquals(result.totalDeltaCents, 0, "no price delta — the $8.00 upcharge must never be applied");
});

Deno.test("resolveAskPlan, flag ON: bare '2' against Bone In Wings Quantity (8|14 Pieces) resolves NOTHING even when the model asserts '14 Pieces'", () => {
  const result = resolveAskPlan(
    BONE_IN_WINGS_PLAN, "2", new Set(), new Map(),
    undefined, ["14 Pieces"],
    undefined, true,
  );
  assertEquals(result.resolved, []);
  assertEquals(result.nextStep?.group_id, "4bf0c277-fa9e-4d48-bc18-4f3705c94baf");
  assertEquals(result.totalDeltaCents, 0);
});

Deno.test("full cart level, matches the real answer() call site exactly: bare '2' answering the Boneless Wings Quantity slot writes nothing to ask_plan_selections, changes no price, and re-asks", () => {
  const menuItem: CompiledMenuItem = {
    ask_plan: BONELESS_WINGS_PLAN, bot_state: "orderable",
    option_groups: [
      { id: "b87b7548-9f75-4ce2-a89b-f0b60aeb4d2d", name: "Choose Sauce", default_choice_id: null },
      { id: "8774670c-7f71-4ee9-b9b4-a80552309321", name: "Quantity", default_choice_id: null },
    ],
  };
  const cart: CompiledCartLine[] = [];
  applyCompiledAddItem(cart, menuItem, "wings-id", 2, "boneless wings", undefined, undefined, []);
  cart[0] = { ...cart[0], menu_item_id: "wings-id" } as CompiledCartLine;
  // Resolve sauce first with a phrase matchChoiceInText resolves on its OWN
  // (both of "Hot Sauce"'s stems — "hot" AND "sauce" — literally present),
  // so this test isolates the Quantity slot.
  applyCompiledModifyItem(cart, menuItem, "wings-id", undefined, "hot sauce", ["Hot Sauce"], undefined, undefined, undefined, true, true);
  const before = JSON.stringify(cart[0].ask_plan_selections);
  const beforePrice = cart[0].price_cents;

  // requireTextualSupportForSlots: true — matches turn-engine.ts's real
  // answer() slot-case call exactly (11 positional args, last one `true`).
  const result = applyCompiledModifyItem(cart, menuItem, "wings-id", undefined, "2", ["20 Pieces"], undefined, undefined, undefined, true, true);

  assertEquals(JSON.stringify(cart[0].ask_plan_selections), before, "ask_plan_selections must be byte-unchanged — nothing written for the Quantity slot");
  assertEquals(cart[0].price_cents, beforePrice, "no price change — the $8.00 upcharge must never be applied");
  assertEquals(result.cartChanged, false, "nothing about the cart changed — the Quantity slot is still unanswered, not silently resolved");
  assertEquals(cart[0].pending_options, ["Quantity"], "the Quantity slot question must still be pending, not silently answered");
});
