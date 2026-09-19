// PO freeze item 1 (2026-09-19, live report — sim #5, nearly every run):
// Vito's "Gyro (Beef or Chicken)" opened a slot question worded "What
// choice would you like for the Gyro Sandwich?" instead of naming beef or
// chicken.
//
// Root cause, confirmed by probing decide()+ask() against Vito's REAL menu/
// lexicon (menu_item 7d457415-b011-4182-86a1-5869aab665c3, "Gyro Sandwich",
// and 9369c1e7-38df-45da-985e-36d278d7a12c, "Gyro Salad" — both live,
// bot_state 'orderable' rows on shop e0000000-0000-0000-0000-000000000001):
// the compiled ask_plan for BOTH items carries two slot steps offering the
// identical Beef/Chicken choice set — a synthetic, DB-id-free step
// (group_id `derived:<item>:0`, slot_key "choice", compile-menu.ts's own
// comment calls this a "pre-infer normalize.ts placeholder slot_key",
// produced by parsing "(Beef or Chicken)" straight out of the item's raw
// NAME) AND the real, hand-defined "Beef or chicken" option_groups row
// (group_id a real UUID, prompt_template "beef_or_chicken.ask", provenance
// "stated"). The compiler never dedupes a name-derived slot against an
// already-existing real option group for the same real-world choice, so
// both land in ask_plan.steps. The derived step happens to sort first
// (compile-menu.ts's SLOT_RANK ranks its "choice" slot_key at 1, same as
// "protein"/"variant", ahead of the real step's unranked/null slot_key at
// 5.5) — so it's the derived, generically-worded step that customers see
// first, not the real one that would have rendered "Which protein..." (or
// similar) with an actual TEMPLATE_QUESTIONS row.
//
// NOT an infinite loop in practice: resolveAskPlan reapplies one turn's
// customerText to every still-open step in the same call, so a plain
// "beef"/"chicken" answer happened to resolve BOTH the derived and the real
// step in one shot in every phrasing probed live (this file's answer() test
// below pins that this stays true after the fix, for the RIGHT reason —
// the derived step no longer needs answering at all). But the customer was
// still shown one confusing, wrongly-worded question before ever answering
// anything, and the two steps only staying in sync was incidental to how
// much of the answer text overlapped, not guaranteed by design.
//
// Fix (ask-plan-engine.ts's isRedundantDerivedStep, wired into
// resolveAskPlan/allSlotsResolved, and turn-engine.ts's ask() priority-1
// open-slot scan): a `derived:`-prefixed step is never asked and never
// required for allSlotsResolved when a REAL (non-derived) step elsewhere in
// the same plan offers the exact same choice set — the real step, with
// real option ids and real prices, always wins. General fix, not
// gyro-specific: scoped to the `derived:` id prefix (only ever produced by
// the compiler's name/description parser, never a real option_groups id),
// so it fires for any item on any shop with this exact shape.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import { renderStepQuestion } from "./ask-plan-engine.ts";
import { ask, answer, type DialogueState, type TurnEngineCartLine, type TurnEngineMenuItem, type AskShopContext, type AskTurnEvents } from "./turn-engine.ts";

// Mirrors the REAL compiled ask_plan read live from Vito's DB (menu_item
// 7d457415-b011-4182-86a1-5869aab665c3, "Gyro Sandwich", 2026-09-19) —
// choice ids/display order taken verbatim from that row's ask_plan JSON.
const DERIVED_CHOICE_STEP: CompiledStep = {
  group_id: "derived:7d457415-b011-4182-86a1-5869aab665c3:0",
  slot_key: "choice",
  kind: "slot",
  ask_mode: "ask",
  prompt_template: "choice.ask",
  choices: [
    { id: "derived:7d457415-b011-4182-86a1-5869aab665c3:0:0", display: "Beef", price_delta_cents: 0 },
    { id: "derived:7d457415-b011-4182-86a1-5869aab665c3:0:1", display: "Chicken", price_delta_cents: 0 },
  ],
};
const REAL_BEEF_OR_CHICKEN_STEP: CompiledStep = {
  group_id: "d9bb5d81-9c98-42d3-b9a9-ff434f0bdbee",
  slot_key: null,
  kind: "slot",
  ask_mode: "ask",
  prompt_template: "beef_or_chicken.ask",
  choices: [
    { id: "92815677-125e-4ecd-ba05-71f421e943ce", display: "Chicken", price_delta_cents: 400 },
    { id: "f72e1df2-fde0-4bc4-a50a-b24409a1a89d", display: "Beef", price_delta_cents: 0 },
  ],
};
const GYRO_SANDWICH_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-19T16:43:21.051Z",
  compiler_version: 1,
  display_name: "Gyro Sandwich",
  recap_template: "{qty} {display_name}{, with {modifiers}}",
  ticket_template: "{name}{\n  + {choice.display} x{qty}}",
  base_price_cents: 1099,
  steps: [DERIVED_CHOICE_STEP, REAL_BEEF_OR_CHICKEN_STEP],
};

Deno.test("renderStepQuestion: the real 'beef_or_chicken' step (no TEMPLATE_QUESTIONS row) reads naturally, never 'What choice would you like' or 'What beef or chicken would you like'", () => {
  const q = renderStepQuestion(REAL_BEEF_OR_CHICKEN_STEP, "Gyro Sandwich");
  assertEquals(q, "Would you like Chicken or Beef for the Gyro Sandwich?");
  assert(!q.toLowerCase().includes("what choice"));
  assert(!q.toLowerCase().includes("what beef"));
});

Deno.test("ask(): a fresh Gyro Sandwich line opens the REAL beef_or_chicken step, never the derived synthetic 'choice' step", () => {
  const menu: TurnEngineMenuItem[] = [
    { id: "gyro-sandwich", name: "Gyro (Beef or Chicken)", category: "Hot Sandwiches", price_cents: 1099, bot_state: "orderable", ask_plan: GYRO_SANDWICH_ASK_PLAN, option_groups: [{ id: REAL_BEEF_OR_CHICKEN_STEP.group_id, name: "Beef or chicken" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "gyro-sandwich", name: "Gyro Sandwich", quantity: 1, price_cents: 1099, modifiers: [], line_key: "line-1" },
  ];
  const priorState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null };
  const turnEvents: AskTurnEvents = { qualifyingAddMenuItemId: "gyro-sandwich", disambiguationCandidateIds: null, disambiguationQuantity: undefined, disambiguationSpanText: undefined, carriedDisambiguationCandidateIds: [], heldModifierText: null, checkoutIntentThisTurn: false, disambiguationSettledThisTurn: false, confirmYes: false, confirmNo: false };
  const shopContext: AskShopContext = { deliveryEnabled: true, upsellEnabled: false, orderTypeKnown: false, orderTypeIsDelivery: false, deliveryAddressKnown: false, driverTipKnown: false, pickupNameKnown: false };

  const state = ask(cart, priorState, turnEvents, shopContext, menu, "a gyro sandwich");

  assert(state.open?.kind === "slot", `expected an open slot question, got ${JSON.stringify(state.open)}`);
  assertEquals((state.open as { group_id: string }).group_id, REAL_BEEF_OR_CHICKEN_STEP.group_id, "must open the REAL group, not the derived synthetic one");
});

Deno.test("answer(): 'beef' against the real open step resolves the line with exactly ONE ask_plan_selections key (the real group) — the derived duplicate is never asked and never blocks resolution", () => {
  const menu: TurnEngineMenuItem[] = [
    { id: "gyro-sandwich", name: "Gyro (Beef or Chicken)", category: "Hot Sandwiches", price_cents: 1099, bot_state: "orderable", ask_plan: GYRO_SANDWICH_ASK_PLAN, option_groups: [{ id: REAL_BEEF_OR_CHICKEN_STEP.group_id, name: "Beef or chicken" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "gyro-sandwich", name: "Gyro Sandwich", quantity: 1, price_cents: 1099, modifiers: [], line_key: "line-1" },
  ];
  const openState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: REAL_BEEF_OR_CHICKEN_STEP.group_id }, upsell_offered: false, asked_message_id: null };

  const result = answer(openState, cart, "beef", menu, {});

  assert(result.resolved, "must resolve");
  assertEquals(result.outcome, { kind: "slot_resolved" });
  assertEquals(cart[0].ask_plan_selections, { [REAL_BEEF_OR_CHICKEN_STEP.group_id]: "f72e1df2-fde0-4bc4-a50a-b24409a1a89d" }, "exactly one key — the derived group_id must never appear");
  assertEquals(cart[0].price_cents, 1099, "Beef carries no delta");
});

Deno.test("answer(): 'chicken' resolves with the real step's $4.00 delta, not the derived step's $0 — pricing must come from the real option group", () => {
  const menu: TurnEngineMenuItem[] = [
    { id: "gyro-sandwich", name: "Gyro (Beef or Chicken)", category: "Hot Sandwiches", price_cents: 1099, bot_state: "orderable", ask_plan: GYRO_SANDWICH_ASK_PLAN, option_groups: [{ id: REAL_BEEF_OR_CHICKEN_STEP.group_id, name: "Beef or chicken" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "gyro-sandwich", name: "Gyro Sandwich", quantity: 1, price_cents: 1099, modifiers: [], line_key: "line-1" },
  ];
  const openState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: REAL_BEEF_OR_CHICKEN_STEP.group_id }, upsell_offered: false, asked_message_id: null };

  const result = answer(openState, cart, "chicken", menu, {});

  assert(result.resolved, "must resolve");
  assertEquals(cart[0].ask_plan_selections, { [REAL_BEEF_OR_CHICKEN_STEP.group_id]: "92815677-125e-4ecd-ba05-71f421e943ce" });
  assertEquals(cart[0].price_cents, 1499, "1099 base + 400 real chicken delta");
});

Deno.test("ask(): once the real step is answered, the line has no further open slot (the derived duplicate never re-opens as a second question)", () => {
  const menu: TurnEngineMenuItem[] = [
    { id: "gyro-sandwich", name: "Gyro (Beef or Chicken)", category: "Hot Sandwiches", price_cents: 1099, bot_state: "orderable", ask_plan: GYRO_SANDWICH_ASK_PLAN, option_groups: [{ id: REAL_BEEF_OR_CHICKEN_STEP.group_id, name: "Beef or chicken" }] },
  ];
  const cart: TurnEngineCartLine[] = [
    { menu_item_id: "gyro-sandwich", name: "Gyro Sandwich", quantity: 1, price_cents: 1099, modifiers: [], line_key: "line-1", ask_plan_selections: { [REAL_BEEF_OR_CHICKEN_STEP.group_id]: "f72e1df2-fde0-4bc4-a50a-b24409a1a89d" } },
  ];
  const priorState: DialogueState = { phase: "ordering", open: { kind: "slot", line_key: "line-1", group_id: REAL_BEEF_OR_CHICKEN_STEP.group_id }, upsell_offered: false, asked_message_id: null };
  const turnEvents: AskTurnEvents = { qualifyingAddMenuItemId: null, disambiguationCandidateIds: null, disambiguationQuantity: undefined, disambiguationSpanText: undefined, carriedDisambiguationCandidateIds: [], heldModifierText: null, checkoutIntentThisTurn: false, disambiguationSettledThisTurn: false, confirmYes: false, confirmNo: false };
  const shopContext: AskShopContext = { deliveryEnabled: true, upsellEnabled: false, orderTypeKnown: false, orderTypeIsDelivery: false, deliveryAddressKnown: false, driverTipKnown: false, pickupNameKnown: false };

  const state = ask(cart, priorState, turnEvents, shopContext, menu, "beef");

  assert(state.open?.kind !== "slot" || (state.open as { group_id: string }).group_id !== DERIVED_CHOICE_STEP.group_id, "the derived duplicate must never become the next open question");
});
