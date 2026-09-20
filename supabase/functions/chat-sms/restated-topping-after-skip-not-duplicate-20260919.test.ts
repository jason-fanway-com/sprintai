// PO dispatch (2026-09-19), REAL LIVE MONEY BUG (v565 50-run, conv 4191ab8e
// #14). Real Vito's data: Medium Chicken Bacon Ranch Pizza $19.99
// (dca6fae3-2d94-4a18-b0a9-760474cec7c1), Italian Wrap $9.99
// (644b5847-f02d-46f3-b042-8710aa47bfdf). Turn 1 puts a Medium CBR line in
// the cart with NO anchovies. Later in the same conversation the customer
// says "I also wanted the Chicken Bacon Ranch pizza, medium with half
// anchovies" -- a restatement of the SAME line, naming a topping it doesn't
// have yet. Methodology: this file drives runTurnEngineTurn end to end
// (turn 1 seeds the cart through the real add path, never hand-crafted, so
// the "before" line has the exact shape production would produce), with
// PROPOSE mocked to the deterministic model-proposal shape this codebase's
// other runner-level tests already use.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const CBR_MEDIUM_ID = "dca6fae3-2d94-4a18-b0a9-760474cec7c1";
const ITALIAN_WRAP_ID = "644b5847-f02d-46f3-b042-8710aa47bfdf";
const TOPPINGS_GROUP_ID = "4c31b9ef-a2c3-45f7-8a2c-5e70d8af899d";

// Real ask_plan pulled live from Vito's menu_items.ask_plan for
// dca6fae3-2d94-4a18-b0a9-760474cec7c1 (probe: po-scratch/probe-cbr-
// anchovies-restated-20260919.ts, 2026-09-20). Trimmed to the toppings this
// fixture actually exercises (Anchovies half/whole) plus a few siblings, to
// keep the fixture readable -- every kept choice/price is verbatim real data.
const CBR_MEDIUM: TurnEngineMenuItem = {
  id: CBR_MEDIUM_ID,
  name: "Chicken Bacon Ranch - Medium (14\")",
  category: "Pizza",
  price_cents: 1999,
  size_label: "Medium (14\")",
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T03:45:32.014Z",
    compiler_version: 1,
    display_name: "Medium Chicken Bacon Ranch Pizza",
    base_price_cents: 1999,
    recap_template: "{qty} {display_name}{, with {modifiers}}",
    ticket_template: "{name}{\n  + {choice.display} x{qty}}",
    steps: [{
      group_id: TOPPINGS_GROUP_ID,
      slot_key: null,
      kind: "modifier",
      ask_mode: "on_request",
      prompt_template: "toppings.on_request",
      choices: [
        { id: "549cdbca-dc74-4125-ba5f-e48feb66d0f2", display: "Pepperoni (Half pizza)", price_delta_cents: 350 },
        { id: "a4baa5c2-be0f-4d02-b437-be6ff7bfcc12", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
        { id: "8c2f3afe-2477-4d84-9d0e-78e4512f2bac", display: "Bacon (Half pizza)", price_delta_cents: 350 },
        { id: "d75aa2c2-0469-4d2b-8256-c3260d663e03", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
        { id: "6f9cefbb-fec7-4d9d-9b9c-b55984d60a77", display: "Anchovies (Half pizza)", price_delta_cents: 350 },
        { id: "ebbb1eba-80e0-48e7-a5cb-5eb4ed7940e3", display: "Anchovies (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPINGS_GROUP_ID, name: "Toppings" }],
} as unknown as TurnEngineMenuItem;

const ITALIAN_WRAP: TurnEngineMenuItem = {
  id: ITALIAN_WRAP_ID,
  name: "Italian",
  category: "Wraps",
  price_cents: 999,
  bot_state: "orderable",
  ask_plan: {
    compiled_at: "2026-09-20T03:45:32.014Z",
    compiler_version: 1,
    display_name: "Italian Wrap",
    base_price_cents: 999,
    recap_template: "{qty} {display_name}",
    ticket_template: "{name}",
    steps: [],
  },
} as unknown as TurnEngineMenuItem;

const MENU: TurnEngineMenuItem[] = [CBR_MEDIUM, ITALIAN_WRAP];

// Real lexicon rows for both target ids (probe script, same run).
const LEXICON = [
  { term: "chicken bacon ranch", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "bacon ranch", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "bacon ranch pizza", target_id: CBR_MEDIUM_ID, category: "Pizza", size_label: "Medium (14\")" },
  { term: "italian", target_id: ITALIAN_WRAP_ID, category: "Wraps", size_label: null },
  { term: "italian wrap", target_id: ITALIAN_WRAP_ID, category: "Wraps", size_label: null },
  { term: "wrap", target_id: ITALIAN_WRAP_ID, category: "Wraps", size_label: null },
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
      then(resolve: (v: { data: unknown; error: null }) => void) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
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
    conversationId: "conv-4191ab8e",
    shopId: "shop-vitos",
    tenantId: "shop-vitos",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 },
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function proposeAdds(spans: Array<{ item_span: string; quantity?: number }>): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true,
    attempts: 1,
    proposal: {
      intent: "order",
      adds: spans.map(s => ({ item_span: s.item_span, quantity: s.quantity ?? 1, choices: [] })),
      removes: [], modifies: [],
    },
  });
}

Deno.test("runner-level (money bug, real Vito's data): turn 1 seeds Medium CBR (no anchovies) + Italian Wrap; turn 2 restates 'the Chicken Bacon Ranch pizza, medium with half anchovies' -- must MODIFY the existing line, never duplicate it", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  // Turn 1: real add path, no hand-crafted cart line.
  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "I'll get a medium chicken bacon ranch pizza and an italian wrap" }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "medium chicken bacon ranch pizza" },
        { item_span: "italian wrap" },
      ]),
    },
  );

  const cbrAfterTurn1 = turn1.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrAfterTurn1.length, 1, `precondition: turn 1 must seed exactly one Medium CBR line: ${JSON.stringify(turn1.cart)}`);
  assertEquals(cbrAfterTurn1[0].price_cents, 1999, "precondition: no anchovies yet, base price only");
  const wrapAfterTurn1 = turn1.cart.filter(l => l.menu_item_id === ITALIAN_WRAP_ID);
  assertEquals(wrapAfterTurn1.length, 1, "precondition: turn 1 must seed exactly one Italian Wrap line");
  assertEquals(wrapAfterTurn1[0].price_cents, 999);


  // Turn 2: the real money bug repro.
  const turn2 = await runTurnEngineTurn(
    baseInput({
      message: "I also wanted the Chicken Bacon Ranch pizza, medium with half anchovies",
      cart: turn1.cart,
      // By real turn 14 (this test's turn 2), any early order-type/address
      // question from turn 1 has long since been answered -- no question is
      // open. Using turn1.dialogueState.open unmodified here would leave the
      // order_type question open and trip decide()'s own
      // treatCartMatchAsRestatement (priorState.open !== null), which is a
      // DIFFERENT code path (silent no-op) than the live bug (duplicate
      // line) -- see this file's own RED-run finding.
      dialogueState: { ...turn1.dialogueState, open: null },
    }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "chicken bacon ranch pizza medium with half anchovies" },
      ]),
    },
  );

  const cbrLines = turn2.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrLines.length, 1, `must be exactly ONE Medium CBR line, never a duplicate: ${JSON.stringify(turn2.cart)}`);
  assertEquals(cbrLines[0].quantity, 1, "must never bump quantity -- this is a topping add, not a second pizza");
  assertEquals(cbrLines[0].price_cents, 2349, `Medium CBR ($19.99) + Anchovies Half ($3.50) = $23.49 exactly: ${JSON.stringify(cbrLines[0])}`);
  const optionsJson = JSON.stringify(cbrLines[0].options ?? {});
  assert(optionsJson.includes("Anchovies (Half pizza)"), `Anchovies must be applied as HALF, matching the customer's own words: ${optionsJson}`);
  assert(!optionsJson.includes("Anchovies (Whole pizza)"), `Anchovies must NOT be applied as whole: ${optionsJson}`);

  const wrapLines = turn2.cart.filter(l => l.menu_item_id === ITALIAN_WRAP_ID);
  assertEquals(wrapLines.length, 1, "the unrelated Italian Wrap line must be completely untouched");
  assertEquals(wrapLines[0].price_cents, 999);
  assertEquals(wrapLines[0].quantity, 1);

  assertEquals(turn2.cart.length, 2, `final cart must be exactly the CBR line + the wrap line, nothing else: ${JSON.stringify(turn2.cart)}`);

  const subtotal = turn2.cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  assertEquals(subtotal, 3348, `subtotal must be $23.49 (pizza) + $9.99 (wrap) = $33.48, never a multi-line overcharge: ${subtotal}`);
});

// ============================================================
// MUST NOT SWALLOW A GENUINELY CONFLICTING TOPPING: the existing line
// already has Pepperoni (Whole pizza) resolved on the toppings group; naming
// Pepperoni (Half pizza) for "the same" pizza is a REPLACEMENT within the
// same modifier group, not a pure addition -- same rule
// toppingsCompatibleWithCartLine already enforces on the ANSWER path. Must
// still open a real second line, never silently overwrite the existing
// selection.
// ============================================================
Deno.test("runner-level (must not swallow a conflicting topping): restating the Medium CBR pizza with a DIFFERENT selection in an ALREADY-resolved group opens a real second line", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "a medium chicken bacon ranch pizza with pepperoni and an italian wrap" }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "medium chicken bacon ranch pizza with pepperoni" },
        { item_span: "italian wrap" },
      ]),
    },
  );
  const cbrAfterTurn1 = turn1.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrAfterTurn1.length, 1);
  assert(JSON.stringify(cbrAfterTurn1[0].options ?? {}).includes("Pepperoni (Whole pizza)"), `precondition: Pepperoni must already be resolved as WHOLE: ${JSON.stringify(cbrAfterTurn1[0])}`);

  const turn2 = await runTurnEngineTurn(
    baseInput({
      message: "I also wanted the chicken bacon ranch pizza medium with half pepperoni instead",
      cart: turn1.cart,
      dialogueState: { ...turn1.dialogueState, open: null },
    }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "chicken bacon ranch pizza medium with half pepperoni" },
      ]),
    },
  );

  const cbrLines = turn2.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  assertEquals(cbrLines.length, 2, `a genuinely conflicting topping selection must NOT be swallowed into the existing line: ${JSON.stringify(turn2.cart)}`);
  const original = cbrLines.find(l => JSON.stringify(l.options ?? {}).includes("Pepperoni (Whole pizza)"));
  assert(original, "the original Pepperoni (Whole pizza) line must still be present, untouched");
});

// ============================================================
// MUST NOT SILENTLY FOLD AN EXPLICIT SECOND UNIT: quantity 2 is a real
// request for more pizzas, never silently merged into the existing single
// line's topping set.
// ============================================================
Deno.test("runner-level (must not fold an explicit quantity-2 request): '2 medium chicken bacon ranch pizzas with anchovies' never merges into the existing single line", async () => {
  const supabase = makeFakeSupabase();
  const newLineKey = newLineKeyCounter();

  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "a medium chicken bacon ranch pizza and an italian wrap" }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "medium chicken bacon ranch pizza" },
        { item_span: "italian wrap" },
      ]),
    },
  );

  const turn2 = await runTurnEngineTurn(
    baseInput({
      message: "I also wanted 2 more medium chicken bacon ranch pizzas with anchovies",
      cart: turn1.cart,
      dialogueState: { ...turn1.dialogueState, open: null },
    }),
    {
      supabase, apiKey: "test-key", newLineKey,
      proposeTurnFn: proposeAdds([
        { item_span: "2 medium chicken bacon ranch pizzas with anchovies", quantity: 2 },
      ]),
    },
  );

  const cbrLines = turn2.cart.filter(l => l.menu_item_id === CBR_MEDIUM_ID);
  const totalCbrQuantity = cbrLines.reduce((s, l) => s + l.quantity, 0);
  assertEquals(totalCbrQuantity, 3, `an explicit request for 2 more pizzas must add 2 more units (1 existing + 2 new = 3 total), never merge into the existing line's topping set: ${JSON.stringify(turn2.cart)}`);
  const plainLine = cbrLines.find(l => Object.keys(l.options ?? {}).length === 0);
  assert(plainLine && plainLine.quantity === 1, `the original plain (no anchovies) line must still exist at quantity 1, untouched: ${JSON.stringify(turn2.cart)}`);
});
