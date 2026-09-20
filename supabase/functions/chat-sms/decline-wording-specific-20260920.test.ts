// PO dispatch (2026-09-20), REAL LIVE BUG, v569 50-run, conv a37c43f8 #43,
// real Vito's data (Small Spicy Chapo Pizza, c6e7f330-77e7-4a50-b6aa-
// f2cb8910ee45, $12.95; Mushrooms Whole/Half pizza, 2e0883d3-8174-4013-
// b885-bfc55526a511 / f85e496e-36ce-47e3-a7b1-265da8080886, $4.50/$3.50 --
// pulled live via ~/po-scratch/probe-spicychapo.ts, 2026-09-20).
//
// Real transcript, turn 1 (byte-for-byte, pulled from the live `messages`
// table for this conversation):
//   CUSTOMER: "I want a Spicy Chapo - Small (10") with mushrooms on it.
//     That's for pickup."
//   ASSISTANT: "Some of what was asked for on Spicy Chapo - Small (10")
//     isn't a real option — skipped. | Small Spicy Chapo Pizza added. |
//     Anything else?"
//
// ROOT CAUSE (confirmed against the live error_log row for this exact
// turn, not guessed): resolveChoiceDisplays() dropped the customer's
// mushroom topping because the model's own PROPOSE call sent a garbled
// {group_id, choice_id} pair -- the "group_id" it sent
// (f6cd542a-2147-4e1a-b35f-1f11543a20f6) is not a real toppings group at
// all; it's actually a DIFFERENT Spicy Chapo size's own menu_item id, and
// the "choice_id" it sent (56aafaf2-27c6-40f4-b19a-eda849fc6e80) does not
// exist anywhere in option_choices. This is a model hallucination, NOT a
// real "mushrooms isn't a real Spicy Chapo topping" menu fact -- confirmed
// two turns later in the same live conversation, once the model sent the
// correct ids, mushrooms landed cleanly as "Mushrooms (Whole pizza)
// (+$4.50)". The PO's own dispatch used "Spicy Chapo doesn't take
// toppings" as an illustrative example of a specific message, not a claim
// about this item's real menu data -- flagging that correction here per
// the dispatch's own hedge ("or whatever real Vito's data shows...").
//
// FIX (scoped to wording, per the dispatch -- not to why PROPOSE sent bad
// ids, a separate, deeper defect flagged in this report): the generic
// "Some of what was asked for on <item> isn't a real option — skipped."
// is replaced by describeDroppedChoiceForDecline(), which:
//   1. best-effort recovers WHAT the customer actually named, using the
//      same recoverAssertedChoiceFromText floor the modifier-recovery code
//      above already trusts, scoped to this item's OWN real choices only
//      -- never claims "isn't available" (that would be false for this
//      exact repro), only that it couldn't be applied;
//   2. falls back to the dropped choice's own modifier-GROUP name when the
//      customer's words don't resolve to a single real choice;
//   3. falls back to a still item-specific (never bare-generic) message
//      only when neither is available.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn end to end, replaying the EXACT real PROPOSE payload
// captured in this conversation's own live error_log row (ids copied
// verbatim) against this item's own real, live ask_plan.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineMenuItem } from "./turn-engine.ts";

const SPICY_CHAPO_SMALL_ID = "c6e7f330-77e7-4a50-b6aa-f2cb8910ee45";
const TOPPINGS_GROUP_ID = "726cf1ec-5792-4a3c-8279-1e0d9ede3c07";
const MUSHROOMS_WHOLE_ID = "2e0883d3-8174-4013-b885-bfc55526a511";
const MUSHROOMS_HALF_ID = "f85e496e-36ce-47e3-a7b1-265da8080886";
const PEPPERONI_WHOLE_ID = "319c703f-88cb-4506-8f92-d66bb1e0c52f";

// Real ask_plan pulled live from Vito's menu_items.ask_plan for
// c6e7f330-77e7-4a50-b6aa-f2cb8910ee45 (probe: po-scratch/probe-
// spicychapo.ts, 2026-09-20). Trimmed to Mushrooms half/whole plus one
// sibling topping.
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
        { id: PEPPERONI_WHOLE_ID, display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPINGS_GROUP_ID, name: "Toppings" }],
} as unknown as TurnEngineMenuItem;

const MENU: TurnEngineMenuItem[] = [SPICY_CHAPO_SMALL];

const LEXICON = [
  { term: "spicy chapo", target_id: SPICY_CHAPO_SMALL_ID, category: "Pizza", size_label: "Small (10\")" },
  { term: "spicy chapo small", target_id: SPICY_CHAPO_SMALL_ID, category: "Pizza", size_label: "Small (10\")" },
  { term: "spicy chapo - small (10\")", target_id: SPICY_CHAPO_SMALL_ID, category: "Pizza", size_label: "Small (10\")" },
];

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? LEXICON : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = MENU
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: (m as unknown as { size_label?: string }).size_label ?? null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
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

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-a37c43f8", shopId: "shop-vitos", tenantId: "shop-vitos", cartId: "cart-repro",
    message: "", history: [], menu: MENU, cart: [],
    dialogueState: { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 } as unknown as DialogueState,
    shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("ACCEPTANCE (conv a37c43f8 #43, turn 1): the real live hallucinated-id decline names the specific topping, not a generic 'some of what was asked for' message", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const result = await runTurnEngineTurn(
    baseInput({ message: "I want a Spicy Chapo - Small (10\") with mushrooms on it. That's for pickup." }),
    {
      supabase, apiKey: "test-key", newLineKey,
      // Verbatim from the live error_log row (propose_success,
      // 2026-09-20T05:45:33Z): a garbled group_id (actually a different
      // Spicy Chapo size's own item id) and a choice_id that exists
      // nowhere in option_choices.
      proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
        ok: true, attempts: 1,
        proposal: {
          intent: "order",
          adds: [{
            item_span: "Spicy Chapo - Small (10\")",
            quantity: 1,
            choices: [{ group_id: "f6cd542a-2147-4e1a-b35f-1f11543a20f6", choice_id: "56aafaf2-27c6-40f4-b19a-eda849fc6e80" }],
          }],
          removes: [], modifies: [],
        },
      }),
    },
  );

  assert(!/some of what was asked for/i.test(result.reply), `decline must never use the generic "some of what was asked for" wording, got: ${JSON.stringify(result.reply)}`);
  assert(/mushroom/i.test(result.reply), `decline must name the specific topping the customer actually asked for ("Mushrooms"), got: ${JSON.stringify(result.reply)}`);
  assert(!/isn'?t available/i.test(result.reply), `must never falsely claim mushrooms "isn't available" -- it IS a real, correctly priced choice on this item: ${JSON.stringify(result.reply)}`);

  const line = result.cart.find(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assert(line, "the plain item must still land even though its topping choice was unresolvable");
  assertEquals(Object.keys(line?.ask_plan_selections ?? {}).length, 0, "the hallucinated choice must never be silently applied, wording fix only");
});

Deno.test("when no candidate can be identified from the customer's own words, the decline still names the item and the modifier category, never the bare generic message", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const result = await runTurnEngineTurn(
    // No topping word anywhere in the customer's own message -- nothing for
    // the text-based recovery floor to latch onto, so this exercises the
    // group-name fallback tier.
    baseInput({ message: "I want a Spicy Chapo - Small (10\") for pickup." }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
        ok: true, attempts: 1,
        proposal: {
          intent: "order",
          adds: [{
            item_span: "Spicy Chapo - Small (10\")",
            quantity: 1,
            choices: [{ group_id: TOPPINGS_GROUP_ID, choice_id: "00000000-0000-0000-0000-000000000000" }],
          }],
          removes: [], modifies: [],
        },
      }),
    },
  );

  assert(!/some of what was asked for/i.test(result.reply), `must never fall back to the generic message, got: ${JSON.stringify(result.reply)}`);
  assert(/small spicy chapo pizza/i.test(result.reply), `must still name the item specifically, got: ${JSON.stringify(result.reply)}`);
  assert(/topping/i.test(result.reply), `must name the real modifier group ("Toppings") since a real group_id matched even though the choice_id didn't: ${JSON.stringify(result.reply)}`);
});
