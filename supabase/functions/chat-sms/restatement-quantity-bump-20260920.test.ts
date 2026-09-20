// PO dispatch (2026-09-20), REAL LIVE MONEY BUG, v569 50-run, conv a37c43f8
// #43, real Vito's data (Small Spicy Chapo Pizza, c6e7f330-77e7-4a50-b6aa-
// f2cb8910ee45, $12.95; Mushrooms Whole/Half pizza, 2e0883d3-8174-4013-
// b885-bfc55526a511 / f85e496e-36ce-47e3-a7b1-265da8080886, $4.50/$3.50 --
// pulled live via ~/po-scratch/probe-spicychapo.ts, 2026-09-20).
//
// ROOT CAUSE (confirmed against the live error_log rows for this exact
// conversation, not guessed): decide()'s `adds` loop already refuses to let
// a restatement bump quantity -- see its own `restating` guard, right at
// the top of the `for (const add of addGroups.values())` loop. The
// `modifies` loop a few hundred lines below has NO equivalent guard at all
// and applies PROPOSE's own `quantity` unconditionally. Live, turn 4 of
// this exact conversation ("I already told you, just the Spicy Chapo -
// Small (10") with mushrooms for pickup!" -- no number anywhere in it) got
// back a model proposal shaped `modifies: [{quantity: 2, remove_choices:
// [...]}]` (captured verbatim below from the live error_log row) and the
// cart silently doubled: "Small Spicy Chapo Pizza — now 2." The customer
// then had to notice and fight to undo it ("I only wanted one... not
// two!").
//
// FIX: the `modifies` loop now applies the SAME restatement discipline the
// `adds` loop already has -- a restatement (isRestatementOfExistingOrder)
// that does not carry an EXPLICIT number for this line authorizes NO
// quantity change; the proposed quantity is dropped, keeping the line's
// current quantity. An explicit number ("I only wanted ONE... not two")
// still applies exactly as before -- this guard only ever narrows a
// quantity change, never widens one.
//
// REQUIRED METHODOLOGY: drives the real turn-engine-runner.ts
// runTurnEngineTurn end to end. Turn 1 seeds the cart through the real add
// path (never hand-crafted, so the "before" line has the exact shape
// production would produce). Turns 2-4 use PROPOSE mocks built from the
// REAL captured proposals in this conversation's own error_log rows (ids
// and shapes copied verbatim, only the line_key substituted for the one
// this test's own turn 1 actually mints) -- never invented shapes.
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
// One real sibling topping id per the live conv's own turn-4 remove_choices
// list (trimmed to a few of the real 30 -- every id kept is verbatim real
// data; the full list is not needed to prove the guard).
const PEPPERONI_WHOLE_ID = "319c703f-88cb-4506-8f92-d66bb1e0c52f";
const BROCCOLI_HALF_ID = "01d7d320-53be-4489-a806-42747d8d95cc";

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
        { id: BROCCOLI_HALF_ID, display: "Broccoli (Half pizza)", price_delta_cents: 400 },
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

function proposeAdds(spans: Array<{ item_span: string; choices?: Array<{ group_id: string; choice_id: string }> }>): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true,
    attempts: 1,
    proposal: {
      intent: "order",
      adds: spans.map(s => ({ item_span: s.item_span, quantity: 1, choices: s.choices ?? [] })),
      removes: [], modifies: [],
    },
  });
}

// The exact shape captured live in this conversation's own error_log row
// for turn 4 (propose_success, 2026-09-20T05:46:03Z) -- a hallucinated
// quantity bump with no supporting number anywhere in the customer's own
// words, plus a `remove_choices` list for toppings that were never actually
// selected (harmless no-op either way; kept here only because it's what
// production really sent).
function proposeQuantityBumpModify(lineKey: string, quantity: number): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true,
    attempts: 1,
    proposal: {
      intent: "order",
      adds: [],
      removes: [],
      modifies: [{
        line_key: lineKey,
        quantity,
        remove_choices: [PEPPERONI_WHOLE_ID, BROCCOLI_HALF_ID],
      }],
    },
  });
}

Deno.test("ACCEPTANCE (conv a37c43f8 #43, MONEY): three restatements of an already-in-cart line never bump its quantity, even when PROPOSE itself hallucinates one", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  // Turn 1: real add path, no hand-crafted cart line -- matches the real
  // conversation's own turn 1 (mushrooms itself was declined that turn on a
  // separate, unrelated defect -- see decline-wording-specific-20260920's
  // sibling fixture; irrelevant to this quantity-bump repro, so turn 1 here
  // adds the plain item only).
  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "I want a Spicy Chapo - Small (10\") for pickup." }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeAdds([{ item_span: "Spicy Chapo - Small (10\")" }]) },
  );
  const afterTurn1 = turn1.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(afterTurn1.length, 1, `precondition: exactly one Small Spicy Chapo line: ${JSON.stringify(turn1.cart)}`);
  assertEquals(afterTurn1[0].quantity, 1, "precondition: quantity starts at 1");
  const lineKey = afterTurn1[0].line_key as string;
  assert(lineKey, "precondition: turn 1's line must have a stable line_key");

  // Restatement #1 (real turn 3 text, verbatim) -- model restates the add,
  // exactly as production really returned this turn. The pre-existing
  // `adds`-loop restating guard already handles this shape; asserted here
  // only as a precondition the rest of the test builds on.
  const turn2 = await runTurnEngineTurn(
    baseInput({ message: "No, just the Spicy Chapo - Small (10\") with mushrooms for pickup!", cart: turn1.cart, dialogueState: { ...turn1.dialogueState, open: null } }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeAdds([{ item_span: "Spicy Chapo - Small (10\")", choices: [{ group_id: TOPPINGS_GROUP_ID, choice_id: MUSHROOMS_WHOLE_ID }] }]) },
  );
  const afterTurn2 = turn2.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(afterTurn2.length, 1, `restatement #1 must never duplicate the line: ${JSON.stringify(turn2.cart)}`);
  assertEquals(afterTurn2[0].quantity, 1, "restatement #1 must never bump quantity");

  // Restatement #2 (real turn 4 text, verbatim) -- the live money bug: the
  // model itself proposed a `modifies: [{quantity: 2, ...}]` for this exact
  // line, with no number anywhere in the customer's own words. THE GUARD
  // under test.
  const turn3 = await runTurnEngineTurn(
    baseInput({ message: "I already told you, just the Spicy Chapo - Small (10\") with mushrooms for pickup!", cart: turn2.cart, dialogueState: { ...turn2.dialogueState, open: null } }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeQuantityBumpModify(lineKey, 2) },
  );
  const afterTurn3 = turn3.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(afterTurn3.length, 1, `restatement #2 must never duplicate the line: ${JSON.stringify(turn3.cart)}`);
  assertEquals(afterTurn3[0].quantity, 1, `restatement #2 (the live bug turn) must NEVER bump quantity to 2 -- this is the exact live overcharge: ${JSON.stringify(turn3.cart)}`);

  // Restatement #3 (a further repeat, proving the guard holds under
  // repetition, not just once) -- same hallucinated bump proposed again.
  const turn4 = await runTurnEngineTurn(
    baseInput({ message: "I already told you, just the Spicy Chapo - Small (10\") with mushrooms for pickup!", cart: turn3.cart, dialogueState: { ...turn3.dialogueState, open: null } }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeQuantityBumpModify(lineKey, 2) },
  );
  const afterTurn4 = turn4.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(afterTurn4.length, 1);
  assertEquals(afterTurn4[0].quantity, 1, `restatement #3 must still never bump quantity: ${JSON.stringify(turn4.cart)}`);
});

Deno.test("REGRESSION GUARD: an EXPLICIT quantity correction inside a restatement still applies -- 'I only wanted one... not two!' (real turn 5 text) still drops 2 back to 1", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  // Seed a line already sitting at quantity 2 (the pre-existing bug state,
  // reached the same way turn 1 + a bump would reach it) -- this test cares
  // only about whether an EXPLICIT correction still lands, not about how it
  // got to 2.
  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "I want 2 Spicy Chapo - Small (10\") for pickup." }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeAdds([{ item_span: "2 Spicy Chapo - Small (10\")" }]) },
  );
  const seeded = turn1.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(seeded.length, 1);
  assertEquals(seeded[0].quantity, 2, `precondition: line starts at quantity 2: ${JSON.stringify(turn1.cart)}`);
  const lineKey = seeded[0].line_key as string;

  // Real turn 5 text, verbatim: an explicit correction back down to one,
  // proposed by the model as `modifies: [{quantity: 1}]` (also verbatim
  // from the live error_log row for this turn).
  const turn2 = await runTurnEngineTurn(
    baseInput({ message: "I only wanted one Spicy Chapo - Small (10\"), not two! Just confirm that one, okay?", cart: turn1.cart, dialogueState: { ...turn1.dialogueState, open: null } }),
    { supabase, apiKey: "test-key", newLineKey, proposeTurnFn: proposeQuantityBumpModify(lineKey, 1) },
  );
  const afterTurn2 = turn2.cart.filter(l => l.menu_item_id === SPICY_CHAPO_SMALL_ID);
  assertEquals(afterTurn2.length, 1);
  assertEquals(afterTurn2[0].quantity, 1, `an EXPLICIT "one... not two" correction must still apply -- the guard must never block a real correction: ${JSON.stringify(turn2.cart)}`);
});
