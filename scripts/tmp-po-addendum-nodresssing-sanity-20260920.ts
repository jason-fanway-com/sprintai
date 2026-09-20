// Quick sanity check of the rule-3 fix's regex behavior, no DB/LLM needed.
import { decide, type TurnEngineCartLine, type TurnEngineMenuItem } from "../supabase/functions/chat-sms/turn-engine.ts";

const HOUSE_SALAD_ID = "a9f637bb-8264-44ef-b6c1-a5ffb4a83391";
const MIKES_MEDIUM_ID = "0c4c4803-77dc-4543-bb5f-e6c0c19df7fe";

const MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_SALAD_ID, name: "House", category: "Salads", price_cents: 899, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "House", base_price_cents: 899, recap_template: "", ticket_template: "", steps: [] },
  },
  {
    id: MIKES_MEDIUM_ID, name: "Mikes Hot n Honey - Medium (14\")", category: "Pizza", price_cents: 1999, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Medium Mikes Hot N Honey Pizza", base_price_cents: 1999, recap_template: "", ticket_template: "", steps: [] },
  },
];

const cart: TurnEngineCartLine[] = [
  { menu_item_id: HOUSE_SALAD_ID, name: "House", quantity: 1, price_cents: 899, modifiers: ["Ranch", "Black Diamond Steak"], line_key: "salad-1" },
  { menu_item_id: HOUSE_SALAD_ID, name: "House", quantity: 1, price_cents: 899, modifiers: ["Ranch", "Black Diamond Steak"], line_key: "salad-2" },
  { menu_item_id: MIKES_MEDIUM_ID, name: "Mikes Hot n Honey - Medium (14\")", quantity: 1, price_cents: 1999, modifiers: [], line_key: "pizza-1" },
];

const message = "oh wait, just the house salads no dressing. sry! so just 2x house salads. thx!";

// Simulate the model hallucinating (or correctly proposing) removal of both
// salad lines, the exact shape "House removed." for both lines implies.
const proposal = {
  intent: "order" as const,
  adds: [],
  removes: [{ line_key: "salad-1" }, { line_key: "salad-2" }],
  modifies: [],
};

const result = decide(proposal, cart, MENU, [], undefined, message);
console.log("resulting cart line_keys:", result.cart.map(l => l.line_key));
console.log("salad-1 survives:", result.cart.some(l => l.line_key === "salad-1"));
console.log("salad-2 survives:", result.cart.some(l => l.line_key === "salad-2"));
console.log("pizza-1 survives:", result.cart.some(l => l.line_key === "pizza-1"));
console.log("guardDroppedRemoves / declines:", JSON.stringify(result.declines));
