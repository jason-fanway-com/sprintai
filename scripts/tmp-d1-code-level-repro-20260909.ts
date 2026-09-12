// Direct, deterministic repro of applyCompiledAddItem's merge behavior using
// Zio's REAL "Neapolitan Cheese Pizza - Large 18''" ask_plan (fetched live,
// saved to /tmp/zios-cheese-item.json). Bypasses the LLM entirely so the
// exact call sequence is controlled and reproducible.
import { applyCompiledAddItem, type CompiledCartLine, type CompiledMenuItem } from "../supabase/functions/chat-sms/ask-plan-engine.ts";

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

console.log("=== SCENARIO: two separate add_item calls, one turn ===");
console.log("Call 1: plain cheese pizza (no toppings asserted)");
console.log("Call 2: cheese pizza with extra cheese (Extra Cheese asserted)");
const cart: CompiledCartLine[] = [];
const consumed = new Set<string>();

const r1 = applyCompiledAddItem(
  cart, menuItem, menuItemId, 1,
  "a plain large cheese pizza", null,
  consumed, [], undefined, 0,
);
console.log("after call 1:", JSON.stringify(cart, null, 2));

const r2 = applyCompiledAddItem(
  cart, menuItem, menuItemId, 1,
  "a large cheese pizza with extra cheese", null,
  consumed, ["Extra Cheese"], undefined, 1,
);
console.log("after call 2:", JSON.stringify(cart, null, 2));

console.log("\n=== EXPECTED: 2 distinct lines (qty 1 each), one with Extra Cheese priced ===");
console.log(`ACTUAL: ${cart.length} line(s)`, cart.map(l => `qty=${l.quantity} options=${JSON.stringify(l.options)}`));
