// PO dispatch (2026-09-15): NJB gating found that two distinct, legitimate
// slot questions on the same item — "Meat Only Breakfast Sandwich"'s meat
// choice (Bacon/Ham/Sausage/Pork Roll) and bread choice (Bagel/Bread/Roll)
// — rendered as the IDENTICAL string, because both option groups carry the
// generic placeholder slot_key "choice" (not in TEMPLATE_QUESTIONS, so both
// fall to the same name-only fallback question). Commit 784cc701 "fixed"
// this by making turn-engine.ts's RENDER `case "slot"` pass `enumerate:
// true` to renderStepQuestion() — but that directly reverted 7044d7f8
// (2026-09-11), which deliberately made slot questions NON-enumerating by
// DEFAULT after measuring a live quality regression (70% -> 40%) on Vito's
// when enumeration was the default. 784cc701 was reverted (2026-09-15,
// same-day) for that reason. The REAL collision fix lives one layer
// upstream, at compile time (compile-menu/index.ts's derivedGroups no
// longer discards the clause label captured for a description slot like
// "choice of meat (...)" — see njb-slot-key-label-20260915.test.ts) so the
// two groups get distinct slot_keys ("meat" vs "choice") and thus distinct
// prompt_templates, without ever touching the default `enumerate` value
// here. renderStepQuestion's `enumerate` parameter stays opt-in, passed
// `true` ONLY for the two deterministic cases documented on its own
// declaration (no-match / customer asked for options) — anyone tempted to
// flip its default (or pass `true` from RENDER's slot case) to solve a
// "two questions render identically" bug should fix the upstream slot_key
// instead; this file pins the current, correct, non-enumerating default so
// that mistake fails loudly here first. Fixture below is the REAL compiled
// ask_plan for NJB's live "Meat Only Breakfast Sandwich" row (id
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

Deno.test("RENDER slot: default (non-enumerating) rendering is unaffected by 784cc701's revert — a fixture with two groups sharing slot_key \"choice\" still renders the SAME short question for both (this is exactly the bug; the fix is the upstream slot_key, not `enumerate`, see njb-slot-key-label-20260915.test.ts)", () => {
  const meatQuestion = renderSlotQuestion(NJB_MEAT_GROUP_ID);
  const breadQuestion = renderSlotQuestion(NJB_BREAD_GROUP_ID);
  assertEquals(meatQuestion, "What choice would you like for the Meat Only Breakfast Sandwich?");
  assertEquals(breadQuestion, "What choice would you like for the Meat Only Breakfast Sandwich?");
  assertEquals(meatQuestion, breadQuestion);
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

Deno.test("RENDER slot: Vito's real Cheese Burger Temp question stays the SHORT templated sentence (784cc701's enumerated wording is reverted — 7044d7f8 measured the enumerated default at 40% vs 70% short-form on Vito's live traffic)", () => {
  const state: DialogueState = {
    phase: "ordering",
    open: { kind: "slot", line_key: VITOS_CART_LINE.line_key!, group_id: VITOS_TEMP_GROUP_ID },
    upsell_offered: false,
    asked_message_id: null,
  };
  const cart = [VITOS_CART_LINE];
  const reply = render(cart, cart, state, [], VITOS_MENU);
  const question = reply.split("\n\n")[0];
  const SHORT = "How would you like the Cheese Burger cooked?"; // 7044d7f8's measured-good default
  const ENUMERATED = "How would you like the Cheese Burger cooked? Well Done, Medium, Rare, Medium Well, or Medium Rare."; // 784cc701's reverted wording
  assertEquals(question, SHORT, `RENDER must produce the short, non-enumerated question by default; 784cc701's reverted wording was: ${JSON.stringify(ENUMERATED)}`);
  assert(question !== ENUMERATED, "the revert must actually restore the live-shop wording, not no-op");
});
