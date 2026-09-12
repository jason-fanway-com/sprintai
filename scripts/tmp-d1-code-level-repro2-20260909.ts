import { applyCompiledAddItem, applyCompiledModifyItem, type CompiledCartLine, type CompiledMenuItem } from "../supabase/functions/chat-sms/ask-plan-engine.ts";

const raw = JSON.parse(await Deno.readTextFile("/tmp/zios-cheese-item.json"));
const menuItem: CompiledMenuItem = {
  ask_plan: raw.ask_plan,
  bot_state: raw.bot_state,
  option_groups: [
    { id: "83e4035d-065a-4826-a9a3-31099f38c849", name: "Make it" },
    { id: "c61917b8-f553-4a7b-b138-8bf640069d72", name: "Add Toppings" },
  ],
};
const menuItemId = raw.id;

console.log("=== SCENARIO B: 2x plain add_item (both no toppings) then modify_item(Extra Cheese) ===");
const cart: CompiledCartLine[] = [];
const consumed = new Set<string>();

applyCompiledAddItem(cart, menuItem, menuItemId, 1, "a large cheese pizza", null, consumed, [], undefined, 0);
applyCompiledAddItem(cart, menuItem, menuItemId, 1, "a plain large cheese pizza", null, consumed, [], undefined, 1);
console.log("after 2x add_item:", JSON.stringify(cart, null, 2));

const modResult = applyCompiledModifyItem(
  cart, menuItem, menuItemId, undefined,
  "with extra cheese on one", ["Extra Cheese"], consumed, undefined, undefined,
);
console.log("modify_item result:", JSON.stringify(modResult.result, null, 2));
console.log("after modify_item:", JSON.stringify(cart, null, 2));
const total = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
console.log(`\nACTUAL cart total: $${(total/100).toFixed(2)} across ${cart.length} line(s)`);
console.log("BUG: extra cheese priced once ($4.00) but applied to a qty=2 line -> charged twice in the total.");
