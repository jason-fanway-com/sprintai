// 00-AW: the key published to the model must be the key the lookup uses.
//
// Live repro on the deployed build before this fix:
//   "a cheeseburger"                       -> Cheese Burger added.
//   "medium"                               -> Cheese Burger (Temp: Medium) $8.49
//   "actually remove the cheeseburger"     -> "That item wasn't in your order."  [still there]
//   "make it two cheeseburgers"            -> "Cheese Burger - now 3."  $25.47
//   "change the cheeseburger to well done" -> "That item wasn't in your order."
//
// The customer asked for two and was charged for three. Corrections were
// impossible on every shop from the day they were flipped to this engine.
//
// This test takes the key STRAIGHT OUT of the real cart index — the same
// function that builds the model's prompt — and feeds it to a remove. Nothing
// is hand-written on either side. That is the whole point: both halves were
// already tested in isolation and both passed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCartIndex } from "./propose.ts";
import { decide } from "./turn-engine.ts";
import type { TurnEngineCartLine, TurnEngineMenuItem, Proposal } from "./turn-engine.ts";

const MENU: TurnEngineMenuItem[] = [{
  id: "item-burger", name: "Cheese Burger", category: "Burgers", price_cents: 849,
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Cheese Burger",
    base_price_cents: 849, recap_template: "", ticket_template: "", steps: [],
  },
  option_groups: [],
}];

// A line as it really exists once added: it carries a minted UUID line_key.
function realCart(): TurnEngineCartLine[] {
  return [{
    menu_item_id: "item-burger", name: "Cheese Burger", quantity: 1, price_cents: 849,
    modifiers: [], line_key: "24ba8429-432d-442c-9f2c-460a04301ae2",
  }];
}

Deno.test("00-AW: a remove using the key the MODEL was actually given removes the line", () => {
  const cart = realCart();

  // Exactly what the model sees — not a hand-written key.
  const published = buildCartIndex(cart, MENU);
  assertEquals(published.length, 1);
  const keyTheModelSees = published[0].line_key;

  const proposal: Proposal = {
    intent: "order", adds: [], modifies: [],
    removes: [{ line_key: keyTheModelSees }],
  };

  const result = decide(proposal, cart, MENU, []);

  assertEquals(
    result.cart.filter(l => l.menu_item_id === "item-burger").length, 0,
    `the line must be gone. Published key was ${JSON.stringify(keyTheModelSees)}; ` +
    `the line's real key is ${JSON.stringify(cart[0].line_key)}. ` +
    `Declines: ${JSON.stringify(result.declines)}`,
  );
  assert(
    !result.declines.some(d => d.reason.includes("wasn't in your order")),
    `must not tell the customer their item wasn't in the order: ${JSON.stringify(result.declines)}`,
  );
});

Deno.test("00-AW: the published key IS the lookup key — stated directly", () => {
  const cart = realCart();
  const published = buildCartIndex(cart, MENU);
  assertEquals(
    published[0].line_key, cart[0].line_key,
    "the cart index must publish the line's own key, not a value derived from item id and options",
  );
});
