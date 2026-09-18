// 00-BD: restating an order you already placed must not order it again.
//
// All three of these are verbatim from one 100-conversation run:
//   "Nope, that's it. Just to recap: 1x Gyro - Small pizza..."  -> "House - now 2."
//   "I didn't order anything else! Just the 2 Italian wraps..." -> "Italian Wrap - now 4."
//   "I think there's a mistake. I just wanted a small White..." -> "Small White Pizza - now 2."
//
// Two of them are the customer complaining about an error and being charged
// more for complaining.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decide, isRestatementOfExistingOrder } from "./turn-engine.ts";
import type { TurnEngineCartLine, TurnEngineMenuItem, Proposal } from "./turn-engine.ts";

const WRAP = "item-wrap";
const MENU: TurnEngineMenuItem[] = [{
  id: WRAP, name: "Italian Wrap", category: "Wraps", price_cents: 999, bot_state: "orderable",
  ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Italian Wrap", base_price_cents: 999, recap_template: "", ticket_template: "", steps: [] },
  option_groups: [],
}];
const LEX = [{ term: "italian wrap", target_id: WRAP }, { term: "italian wraps", target_id: WRAP }];

function cartWithTwoWraps(): TurnEngineCartLine[] {
  return [{ menu_item_id: WRAP, name: "Italian Wrap", quantity: 2, price_cents: 999, modifiers: [], line_key: "line-1" }];
}
const reAdd: Proposal = {
  intent: "order", removes: [], modifies: [],
  adds: [{ item_span: "2 Italian wraps", quantity: 2, choices: [] }],
};

Deno.test("00-BD: the live message that produced 'Italian Wrap - now 4' must not grow the quantity", () => {
  const cart = cartWithTwoWraps();
  const result = decide(reAdd, cart, MENU, LEX, undefined, "I didn't order anything else! Just the 2 Italian wraps for pickup.");
  const wrap = result.cart.find(l => l.menu_item_id === WRAP);
  assertEquals(wrap?.quantity, 2, `restating must not re-order — cart: ${JSON.stringify(result.cart)}`);
});

Deno.test("00-BD: the other two live restatements behave the same", () => {
  for (const msg of [
    "Nope, that's it. Just to recap: 1x Gyro - Small pizza with tomatoes and spinach.",
    "I think there's a mistake. I just wanted a small White pizza with roasted peppers.",
  ]) {
    const result = decide(reAdd, cartWithTwoWraps(), MENU, LEX, undefined, msg);
    assertEquals(result.cart.find(l => l.menu_item_id === WRAP)?.quantity, 2, msg);
  }
});

Deno.test("00-BD: a GENUINE second order is untouched — this is the dangerous direction", () => {
  // 2026-09-18: each message pairs with its OWN item_span, genuinely
  // present in that message — the fixed "2 Italian wraps" span reAdd
  // above uses would fail the same day's item_span-verbatim-in-message
  // guard (turn-engine.ts's itemSpanNamedInMessage) for three of these
  // four, since none of them literally say "2 Italian wraps".
  for (const [msg, itemSpan, quantity] of [
    ["can I get another Italian wrap", "Italian wrap", 1],
    ["one more Italian wrap please", "Italian wrap", 1],
    ["also add an Italian wrap", "Italian wrap", 1],
    ["I'd like 2 Italian wraps", "2 Italian wraps", 2],   // no restatement marker at all
  ] as const) {
    const proposal: Proposal = { intent: "order", removes: [], modifies: [], adds: [{ item_span: itemSpan, quantity, choices: [] }] };
    const result = decide(proposal, cartWithTwoWraps(), MENU, LEX, undefined, msg);
    const q = result.cart.find(l => l.menu_item_id === WRAP)?.quantity ?? 0;
    assert(q > 2, `a real add must still land for "${msg}" — got quantity ${q}`);
  }
});

Deno.test("00-BD: the detector itself, both directions", () => {
  assertEquals(isRestatementOfExistingOrder("Just to recap: 1x pizza"), true);
  assertEquals(isRestatementOfExistingOrder("that's it, just the wraps"), true);
  assertEquals(isRestatementOfExistingOrder("I just wanted a small pizza"), true);
  // an addition marker always wins, even alongside a restatement phrase
  assertEquals(isRestatementOfExistingOrder("that's it, but also add a coke"), false);
  assertEquals(isRestatementOfExistingOrder("just the wraps and another coke"), false);
  assertEquals(isRestatementOfExistingOrder("a large pepperoni pizza"), false);
  assertEquals(isRestatementOfExistingOrder(undefined), false);
});
