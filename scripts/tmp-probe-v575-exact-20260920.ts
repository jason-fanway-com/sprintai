// Probe: exact live v575 wording (conversation_id 70bc7d0b-bd7e-4a73-a277-6091b9560a92,
// message row 9bea647b-c60e-47df-a481-fec9d4d85120, created_at 2026-09-20T07:36:18.944499+00:00)
// against current main to confirm the already-merged fix (b26f0240 / 2a006d09) covers the
// "I just realized ..." prefixed phrasing, not just the shorter wording pinned in
// confirm-single-unit-topping-swap-20260920.test.ts.
import { runTurnEngineTurn, type RunTurnInput, type RunTurnDeps } from "../supabase/functions/chat-sms/turn-engine-runner.ts";
import type { ProposeResult } from "../supabase/functions/chat-sms/propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "../supabase/functions/chat-sms/turn-engine.ts";

const GYRO_LARGE_ID = "713b447f-9798-4188-8930-967f03cb3678";
const WHITE_LARGE_ID = "e0c4018f-ae3f-4898-a511-cde01ebe4014";
const GYRO_TOPPINGS_GROUP_ID = "29bd83e0-a3e3-4fed-a075-4b4f78368173";
const SAUSAGE_CHOICE_ID = "7e888e14-40df-4477-89cf-7306d3d5028e";
const GRILLED_CHICKEN_CHOICE_ID = "42869158-63da-406b-a2c7-3e9f223eb250";

const MENU: TurnEngineMenuItem[] = [
  {
    id: GYRO_LARGE_ID, name: "Large Gyro Pizza", category: "Pizza", price_cents: 2299, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Large Gyro Pizza", base_price_cents: 2299,
      recap_template: "", ticket_template: "",
      steps: [
        {
          group_id: GYRO_TOPPINGS_GROUP_ID, slot_key: null, kind: "modifier",
          ask_mode: "on_request", prompt_template: "",
          choices: [
            { id: SAUSAGE_CHOICE_ID, display: "Sausage (Whole pizza)", price_delta_cents: 450 },
            { id: GRILLED_CHICKEN_CHOICE_ID, display: "Grilled Chicken (Whole pizza)", price_delta_cents: 500 },
          ],
        },
      ],
    },
    option_groups: [{ id: GYRO_TOPPINGS_GROUP_ID, name: "Toppings", default_choice_id: null }],
  } as unknown as TurnEngineMenuItem,
  {
    id: WHITE_LARGE_ID, name: "Large White Pizza", category: "Pizza", price_cents: 1999, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Large White Pizza", base_price_cents: 1999,
      recap_template: "", ticket_template: "", steps: [],
    },
  } as unknown as TurnEngineMenuItem,
];

function confirmCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: WHITE_LARGE_ID, name: "Large White Pizza", quantity: 1, price_cents: 1999, modifiers: [], line_key: "white-line" },
    {
      menu_item_id: GYRO_LARGE_ID, name: "Large Gyro Pizza", quantity: 2, price_cents: 2299 + 450,
      modifiers: [], options: { Toppings: ["Sausage (Whole pizza)"] },
      ask_plan_selections: { [GYRO_TOPPINGS_GROUP_ID]: SAUSAGE_CHOICE_ID },
      line_key: "gyro-line",
    },
  ];
}

function confirmState(): DialogueState {
  return { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 } as DialogueState;
}

function makeFakeSupabase() {
  function builder(_table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range() { return Promise.resolve({ data: [], error: null }); },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (table: string) => builder(table) } as any;
}

// Exact real live wording, v575, error_log/messages row 9bea647b-c60e-47df-a481-fec9d4d85120.
const MESSAGE = "I just realized I actually wanted one of the Gyro pizzas with grilled chicken instead of the other sausage one! Please update that";

const deps: RunTurnDeps = {
  supabase: makeFakeSupabase(),
  apiKey: "test-key",
  proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called for this shape")),
};

const input: RunTurnInput = {
  conversationId: "conv-70bc7d0b-repro",
  shopId: "e0000000-0000-0000-0000-000000000001",
  tenantId: "e0000000-0000-0000-0000-000000000001",
  cartId: "cart-repro",
  message: MESSAGE,
  history: [],
  menu: MENU,
  cart: confirmCart(),
  dialogueState: confirmState(),
  shopContext: {
    deliveryEnabled: true,
    orderType: "pickup",
    deliveryAddressKnown: false,
    driverTipCents: 0,
    pickupName: "Alex",
    deliveryFeeCents: null,
  },
};

console.log("BEFORE cart:", JSON.stringify(confirmCart(), null, 2));
console.log("MESSAGE:", JSON.stringify(MESSAGE));

const result = await runTurnEngineTurn(input, deps);

console.log("\nAFTER cart:", JSON.stringify(result.cart, null, 2));
console.log("\nREPLY:", JSON.stringify(result.reply));

const whiteLines = result.cart.filter(l => l.menu_item_id === WHITE_LARGE_ID);
const gyroLines = result.cart.filter(l => l.menu_item_id === GYRO_LARGE_ID);
const sausageLine = gyroLines.find(l => (l.options?.Toppings ?? []).includes("Sausage (Whole pizza)"));
const grilledChickenLine = gyroLines.find(l => (l.options?.Toppings ?? []).includes("Grilled Chicken (Whole pizza)"));

console.log("\n=== ASSERTIONS ===");
console.log("White pizza survives (qty 1):", whiteLines.length === 1 && whiteLines[0].quantity === 1);
console.log("Gyro split into 2 lines:", gyroLines.length === 2);
console.log("One Gyro stays Sausage:", !!sausageLine && sausageLine.quantity === 1);
console.log("One Gyro becomes Grilled Chicken:", !!grilledChickenLine && grilledChickenLine.quantity === 1);
console.log("Total cart lines === 3:", result.cart.length === 3);
