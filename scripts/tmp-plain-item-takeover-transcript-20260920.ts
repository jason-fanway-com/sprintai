// PO dispatch (2026-09-20, live regression report): in-process verification
// transcript for the "cheeseburger" cart-empty miss, run through the REAL
// runTurnEngineTurn entry point (not probe-decide), with the model's
// propose call short-circuited to reproduce the exact reported failure
// shape: {intent:"order", adds:[]} for a bare one-word item message. Same
// fake-supabase harness pattern as turn-engine-runner.test.ts (zero real
// I/O, zero network, zero secrets needed) so this can be run standalone
// without hitting a live shop. Prints cart + reply for both fixture shapes
// from the PO's acceptance spec: a fresh conversation (no preceding
// question) and turn 2, immediately after a "Pickup or delivery today?"
// opener (order_type still open).
import {
  runTurnEngineTurn,
  type RunTurnDeps,
  type RunTurnInput,
} from "../supabase/functions/chat-sms/turn-engine-runner.ts";
import type { DialogueState, TurnEngineMenuItem } from "../supabase/functions/chat-sms/turn-engine.ts";
import type { ProposeResult } from "../supabase/functions/chat-sms/propose.ts";

const MENU: TurnEngineMenuItem[] = [
  {
    id: "item-cheeseburger", name: "Cheese Burger", category: "Burgers", price_cents: 849,
    bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849, recap_template: "", ticket_template: "", steps: [] },
  },
];

function makeFakeSupabase(lexicon: Array<{ term: string; target_id: string }>) {
  // deno-lint-ignore no-explicit-any
  function builder(table: string): any {
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        return Promise.resolve({
          data: MENU.filter((m) => values.includes(m.id)).map((m) => ({ id: m.id, category: m.category, size_label: null, bot_state: m.bot_state })),
          error: null,
        });
      },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert(row: Record<string, unknown>) {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: table === "lexicon" ? lexicon : null, error: null }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (table: string) => builder(table) } as any;
}

function emptyAddsProposeFn(): Promise<ProposeResult> {
  return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-1", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "cheeseburger", history: [], menu: MENU, cart: [], dialogueState: null,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
    ...overrides,
  };
}

async function run(label: string, dialogueState: DialogueState | null) {
  const supabase = makeFakeSupabase([{ term: "cheeseburger", target_id: "item-cheeseburger" }]);
  const deps: RunTurnDeps = { supabase, apiKey: "test-key", proposeTurnFn: emptyAddsProposeFn };
  const input = baseInput({ dialogueState });
  const result = await runTurnEngineTurn(input, deps);
  console.log(`\n=== ${label} ===`);
  console.log(`customer: "${input.message}"`);
  console.log(`forced proposal: {intent:"order", adds:[]}`);
  console.log(`prior dialogueState.open: ${JSON.stringify(dialogueState?.open ?? null)}`);
  console.log(`cart: ${JSON.stringify(result.cart)}`);
  console.log(`reply: ${JSON.stringify(result.reply)}`);
  const landed = result.cart.length === 1 && result.cart[0].menu_item_id === "item-cheeseburger" && result.cart[0].price_cents === 849;
  console.log(landed ? "PASS: Cheese Burger $8.49 landed" : "FAIL: item did not land");
  return landed;
}

const r1 = await run("Fresh conversation, no preceding question", null);
const r2 = await run(
  "Turn 2, immediately after 'Pickup or delivery today?' (order_type open)",
  { phase: "order_type", open: { kind: "order_type" }, upsell_offered: false, asked_message_id: null },
);

console.log(`\nOverall: ${r1 && r2 ? "PASS" : "FAIL"}`);
if (!r1 || !r2) Deno.exit(1);
