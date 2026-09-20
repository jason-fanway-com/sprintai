// PO dispatch (2026-09-20), REAL LIVE BUG, v569 50-run, conv a37c43f8 #43,
// real Vito's data (Small Spicy Chapo Pizza, c6e7f330-77e7-4a50-b6aa-
// f2cb8910ee45, $12.95 -- pulled live via ~/po-scratch/probe-spicychapo.ts,
// 2026-09-20).
//
// Real transcript, turn 2 (byte-for-byte, pulled from the live `messages`
// table for this conversation):
//   CUSTOMER: "I want the Spicy Chapo - Small (10") with mushrooms, I
//     already said! Let's just get that done. I can't think of anything
//     else right now."
//   ASSISTANT: "Anything else?" (repeated a 3rd/4th time over the next two
//     turns too -- see error_log for this conversation)
//
// ROOT CAUSE: impliesClosure()/CLOSURE_ANYWHERE_RE (turn-engine.ts) never
// recognized "let's just get that done" or "I can't think of anything else
// [right now]" as closure -- only "that's it/all/everything" and "nothing
// else/more" shapes existed before this fix. With open===null ("Anything
// else?"), answer() fell through to PROPOSE, which (correctly, per the
// OTHER real bug in this same turn -- see restatement-quantity-bump-and-
// closure-not-heard-20260920's sibling fixture) proposed a restatement add
// that the `restating` guard silently swallowed, leaving the turn
// "resolved" with nothing to say except re-asking "Anything else?".
//
// FIX: CLOSURE_ANYWHERE_RE widened with two more alternatives, same
// anywhere-in-message + CLOSURE_BLOCKED_BY_RE-guarded discipline as every
// existing tier (see turn-engine.ts's own comment on the change).
//
// REQUIRED METHODOLOGY: the acceptance test below drives the real
// turn-engine-runner.ts runTurnEngineTurn -- the same call path index.ts's
// turn_engine_enabled branch actually uses -- never decide()/answer()
// called directly. proposeTurnFn rejects on any call: proving ANSWER
// resolves this deterministically, exactly as the live bug needed and did
// not get.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { impliesClosure } from "./turn-engine.ts";
import { runTurnEngineTurn, type RunTurnInput, type RunTurnDeps } from "./turn-engine-runner.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Unit level: impliesClosure itself, the two new phrasings ──────────────

Deno.test("impliesClosure: 'Let's just get that done.' (real live phrasing, conv a37c43f8) reads as closure over a non-empty cart", () => {
  assert(impliesClosure("Let's just get that done.", true));
});

Deno.test("impliesClosure: 'I can't think of anything else right now.' (real live phrasing) reads as closure over a non-empty cart", () => {
  assert(impliesClosure("I can't think of anything else right now.", true));
});

Deno.test("impliesClosure: the exact real live message (both phrases + a restatement clause together) reads as closure", () => {
  assert(impliesClosure(
    "I want the Spicy Chapo - Small (10\") with mushrooms, I already said! Let's just get that done. I can't think of anything else right now.",
    true,
  ));
});

Deno.test("impliesClosure: 'that's all I want' (the third PO-named equivalent) already reads as closure -- no regression", () => {
  assert(impliesClosure("that's all I want", true));
});

Deno.test("impliesClosure: 'Let's get that done' (contraction-free variant) also reads as closure", () => {
  assert(impliesClosure("Let's get that done", true));
});

Deno.test("impliesClosure: neither new phrase closes over an EMPTY cart (00-P0 ae0eb19b rule, unchanged)", () => {
  assertEquals(impliesClosure("Let's just get that done.", false), false);
  assertEquals(impliesClosure("I can't think of anything else right now.", false), false);
});

Deno.test("impliesClosure: 'let's get that done, also add a coke' is still BLOCKED -- a real addition riding along must never close", () => {
  assertEquals(impliesClosure("let's get that done, also add a coke", true), false);
});

Deno.test("impliesClosure: 'I can't think of anything else, but wait, change the size' is still BLOCKED", () => {
  assertEquals(impliesClosure("I can't think of anything else, but wait, change the size", true), false);
});

// ── Runner level: the real live shape, real call path, real Vito's data ────

const SPICY_CHAPO_SMALL_ID = "c6e7f330-77e7-4a50-b6aa-f2cb8910ee45";
const TOPPINGS_GROUP_ID = "726cf1ec-5792-4a3c-8279-1e0d9ede3c07";
const MUSHROOMS_WHOLE_ID = "2e0883d3-8174-4013-b885-bfc55526a511";
const MUSHROOMS_HALF_ID = "f85e496e-36ce-47e3-a7b1-265da8080886";

// Real ask_plan pulled live from Vito's menu_items.ask_plan for
// c6e7f330-77e7-4a50-b6aa-f2cb8910ee45 (probe: po-scratch/probe-
// spicychapo.ts, 2026-09-20). Trimmed to Mushrooms half/whole plus one
// sibling topping to keep the fixture readable -- every kept choice/price
// is verbatim real data.
const SPICY_CHAPO_SMALL: TurnEngineMenuItem = {
  id: SPICY_CHAPO_SMALL_ID,
  name: "Spicy Chapo - Small (10\")",
  category: "Pizza",
  price_cents: 1295,
  size_label: "Small (10\")",
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T04:42:49.794Z",
    compiler_version: 1,
    display_name: "Small Spicy Chapo Pizza",
    base_price_cents: 1295,
    recap_template: "{qty} {display_name}{, with {modifiers}}",
    ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [{
      group_id: TOPPINGS_GROUP_ID,
      slot_key: null,
      kind: "modifier",
      ask_mode: "on_request",
      prompt_template: "toppings.on_request",
      choices: [
        { id: MUSHROOMS_WHOLE_ID, display: "Mushrooms (Whole pizza)", price_delta_cents: 450 },
        { id: MUSHROOMS_HALF_ID, display: "Mushrooms (Half pizza)", price_delta_cents: 350 },
        { id: "319c703f-88cb-4506-8f92-d66bb1e0c52f", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPINGS_GROUP_ID, name: "Toppings" }],
} as unknown as TurnEngineMenuItem;

const MENU: TurnEngineMenuItem[] = [SPICY_CHAPO_SMALL];

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder(_table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) { return Promise.resolve({ data: ([] as unknown[]).slice(from, to + 1), error: null }); },
      in() { return Promise.resolve({ data: [], error: null }); },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) { return Promise.resolve({ data: null, error: null }).then(resolve); },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { from: (table: string) => builder(table) } as any;
}

function realLiveCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: SPICY_CHAPO_SMALL_ID, name: "Small Spicy Chapo Pizza", quantity: 1, price_cents: 1295, modifiers: [], line_key: "line-1" },
  ];
}

Deno.test("ACCEPTANCE (conv a37c43f8 #43): the real live closure+restatement message moves past 'Anything else?', never re-asks it, PROPOSE never called", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called — closure must resolve deterministically via ANSWER")),
  };
  const cart = realLiveCart();
  // "Anything else?" is already open (askCount 1 -- the bot has already
  // asked it once, live, exactly matching turn 1's real reply).
  const priorState: DialogueState = { phase: "ordering", open: { kind: "ordering", askCount: 1 }, upsell_offered: false, asked_message_id: null } as unknown as DialogueState;
  const input: RunTurnInput = {
    conversationId: "conv-a37c43f8-repro", shopId: "shop-vitos", tenantId: "shop-vitos", cartId: "cart-repro",
    // Byte-for-byte turn 2 of the real live conversation.
    message: "I want the Spicy Chapo - Small (10\") with mushrooms, I already said! Let's just get that done. I can't think of anything else right now.",
    history: [], menu: MENU, cart, dialogueState: priorState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!/anything else/i.test(result.reply), `bot must never re-ask 'Anything else?' after this closure turn, got: ${JSON.stringify(result.reply)}`);
  assert(result.dialogueState.open?.kind !== "ordering", `the open question must move past 'ordering' once closure is recognized, got: ${JSON.stringify(result.dialogueState.open)}`);
  assertEquals(result.cart.length, 1, "closure must never drop the existing real cart line");
  assertEquals(result.cart[0].quantity, 1, "closure alone must never change the existing line's quantity");
});

Deno.test("ACCEPTANCE variant: the same real live message over open===null (no prior 'ordering' question object yet) also resolves via ANSWER, never PROPOSE", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: () => Promise.reject(new Error("PROPOSE must not be called")),
  };
  const cart = realLiveCart();
  const input: RunTurnInput = {
    conversationId: "conv-a37c43f8-repro-2", shopId: "shop-vitos", tenantId: "shop-vitos", cartId: "cart-repro",
    message: "I want the Spicy Chapo - Small (10\") with mushrooms, I already said! Let's just get that done. I can't think of anything else right now.",
    history: [], menu: MENU, cart, dialogueState: null,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
  };

  const result = await runTurnEngineTurn(input, deps);

  assert(!/anything else/i.test(result.reply), `got: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.length, 1);
  assertEquals(result.cart[0].quantity, 1);
});
