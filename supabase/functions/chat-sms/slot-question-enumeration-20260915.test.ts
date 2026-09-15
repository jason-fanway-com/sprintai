// PO dispatch (2026-09-15): NJB gating found that two distinct, legitimate
// slot questions on the same item — "Meat Only Breakfast Sandwich"'s meat
// choice (Bacon/Ham/Sausage/Pork Roll) and bread choice (Bagel/Bread/Roll)
// — rendered as the IDENTICAL string, because both option groups carry the
// generic placeholder slot_key "choice" (not in TEMPLATE_QUESTIONS, so both
// fall to the same name-only fallback question) and turn-engine.ts's RENDER
// `case "slot"` called renderStepQuestion() without its existing `enumerate`
// argument, so it always defaulted to `false`. Fixture below is the REAL
// compiled ask_plan for NJB's live "Meat Only Breakfast Sandwich" row (id
// f2268e5e-a829-4b20-8963-02f49b1ce773), read directly from the DB
// 2026-09-15 — not guessed.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { render, type DialogueState, type TurnEngineCartLine, type TurnEngineMenuItem } from "./turn-engine.ts";

const NJB_SANDWICH_ID = "f2268e5e-a829-4b20-8963-02f49b1ce773";
const NJB_MEAT_GROUP_ID = "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:0";
const NJB_BREAD_GROUP_ID = "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:1";

const NJB_MENU: TurnEngineMenuItem[] = [
  {
    id: NJB_SANDWICH_ID,
    name: "Meat Only Breakfast Sandwich",
    category: "Breakfast Sandwiches",
    price_cents: 500,
    bot_state: "orderable",
    option_groups: [
      { id: NJB_MEAT_GROUP_ID, name: "Meat", default_choice_id: null },
      { id: NJB_BREAD_GROUP_ID, name: "Bread", default_choice_id: null },
    ],
    ask_plan: {
      compiled_at: "2026-09-15T20:10:49.579Z",
      compiler_version: 1,
      display_name: "Meat Only Breakfast Sandwich",
      base_price_cents: 500,
      recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: NJB_MEAT_GROUP_ID, slot_key: "choice", prompt_template: "choice.ask",
          choices: [
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:0:0", display: "Bacon", price_delta_cents: 0 },
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:0:1", display: "Ham", price_delta_cents: 0 },
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:0:2", display: "Sausage", price_delta_cents: 0 },
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:0:3", display: "Pork Roll", price_delta_cents: 0 },
          ],
        },
        {
          kind: "slot", ask_mode: "ask", group_id: NJB_BREAD_GROUP_ID, slot_key: "choice", prompt_template: "choice.ask",
          choices: [
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:1:0", display: "Bagel", price_delta_cents: 0 },
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:1:1", display: "Bread", price_delta_cents: 0 },
            { id: "derived:f2268e5e-a829-4b20-8963-02f49b1ce773:1:2", display: "Roll", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

const NJB_CART_LINE: TurnEngineCartLine = {
  menu_item_id: NJB_SANDWICH_ID,
  name: "Meat Only Breakfast Sandwich",
  quantity: 1,
  price_cents: 500,
  modifiers: [],
  line_key: `${NJB_SANDWICH_ID}::`,
};

function renderSlotQuestion(groupId: string): string {
  const state: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: NJB_CART_LINE.line_key!, group_id: groupId },
    upsell_offered: false,
    asked_message_id: null,
  };
  const cart = [NJB_CART_LINE];
  // cartBefore === cartAfter (same line) so RENDER adds no add-confirmation
  // or recap — isolates the reply to just the slot question + ledger footer.
  const reply = render(cart, cart, state, [], NJB_MENU);
  return reply.split("\n\n")[0];
}

Deno.test("RENDER slot: NJB Meat Only Breakfast Sandwich's meat-choice and bread-choice questions must be DISTINCT, not the same generic string", () => {
  const meatQuestion = renderSlotQuestion(NJB_MEAT_GROUP_ID);
  const breadQuestion = renderSlotQuestion(NJB_BREAD_GROUP_ID);
  assert(
    meatQuestion !== breadQuestion,
    `meat-choice and bread-choice slot questions rendered identically — a customer cannot tell these are two different questions: both are ${JSON.stringify(meatQuestion)}`,
  );
  assertEquals(meatQuestion, "What choice would you like for the Meat Only Breakfast Sandwich? Bacon (no extra charge), Ham (no extra charge), Sausage (no extra charge), or Pork Roll (no extra charge).");
  assertEquals(breadQuestion, "What choice would you like for the Meat Only Breakfast Sandwich? Bagel (no extra charge), Bread (no extra charge), or Roll (no extra charge).");
});

// ── Vito's-shaped: real live Cheese Burger Temp question (same fixture as
// turn-engine.test.ts's gate-item-1 walkthrough — id 442f650d-dc96-4a95-
// 9762-f6b571a4dd8c / group cb066502-4a62-4d6e-a65a-70d8f7be7298, read from
// the DB 2026-09-14). This deliberately changes live-shop wording (the
// question used to say only "How would you like the Cheese Burger cooked?"
// — now it also lists the five real Temp choices) — PO wants to read the
// exact before/after here to judge it. ──────────────────────────────────
const VITOS_CHEESE_BURGER_ID = "442f650d-dc96-4a95-9762-f6b571a4dd8c";
const VITOS_TEMP_GROUP_ID = "cb066502-4a62-4d6e-a65a-70d8f7be7298";

const VITOS_MENU: TurnEngineMenuItem[] = [
  {
    id: VITOS_CHEESE_BURGER_ID,
    name: "Cheese Burger",
    category: "Angus Burgers & Specialty",
    price_cents: 849,
    bot_state: "orderable",
    option_groups: [{ id: VITOS_TEMP_GROUP_ID, name: "Temp", default_choice_id: null }],
    ask_plan: {
      compiled_at: "2026-09-11T20:02:51.758Z",
      compiler_version: 1,
      display_name: "Cheese Burger",
      base_price_cents: 849,
      recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: VITOS_TEMP_GROUP_ID, slot_key: null, prompt_template: "temp.ask",
          choices: [
            { id: "11fd4137-a1dc-4caa-9cc8-f1386bda6393", display: "Well Done", price_delta_cents: 0 },
            { id: "3678d936-ff8a-4fa0-8bec-f2021a7de7d1", display: "Medium", price_delta_cents: 0 },
            { id: "399bc846-9b41-4e28-9aa2-50af5be3b45e", display: "Rare", price_delta_cents: 0 },
            { id: "51fb77cf-dc9e-444d-a948-f355886c0ab6", display: "Medium Well", price_delta_cents: 0 },
            { id: "fbbcc56d-44bd-4bb7-abba-489a29c5dc01", display: "Medium Rare", price_delta_cents: 0 },
          ],
        },
      ],
    },
  },
];

const VITOS_CART_LINE: TurnEngineCartLine = {
  menu_item_id: VITOS_CHEESE_BURGER_ID,
  name: "Cheese Burger",
  quantity: 1,
  price_cents: 849,
  modifiers: [],
  line_key: `${VITOS_CHEESE_BURGER_ID}::`,
};

Deno.test("RENDER slot: Vito's real Cheese Burger Temp question now reads as the templated sentence PLUS its choices enumerated (before/after for PO judgment)", () => {
  const state: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: VITOS_CART_LINE.line_key!, group_id: VITOS_TEMP_GROUP_ID },
    upsell_offered: false,
    asked_message_id: null,
  };
  const cart = [VITOS_CART_LINE];
  const reply = render(cart, cart, state, [], VITOS_MENU);
  const question = reply.split("\n\n")[0];
  const BEFORE = "How would you like the Cheese Burger cooked?"; // pre-fix RENDER output (unenumerated default)
  const AFTER = "How would you like the Cheese Burger cooked? Well Done, Medium, Rare, Medium Well, or Medium Rare.";
  assertEquals(question, AFTER, `post-fix RENDER must produce the enumerated question; before-fix was: ${JSON.stringify(BEFORE)}`);
  assert(question !== BEFORE, "the fix must actually change the live-shop wording, not no-op");
});
