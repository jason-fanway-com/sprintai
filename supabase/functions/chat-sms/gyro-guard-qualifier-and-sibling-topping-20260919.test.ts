// PO dispatch 2026-09-19 (regression in tonight's own fe102300/456bb1fb
// "gyro meat phantom pizza" fix, live probe-decide): mergeAddsThatAreNamed-
// PlacementChoiceOfAnotherAdd (turn-engine.ts) correctly stops a topping
// name from opening a phantom second item, but it merged the topping in
// with two real defects of its own:
//
//   Bug 1 (qualifier lost, real overcharge): "a large cheese pizza with
//   half pepperoni" landed Pepperoni as a WHOLE topping ($21.00) instead of
//   HALF ($20.00) — the guard read whole/half off the PHANTOM CANDIDATE's
//   own resolved span ("pepperoni"), which never carries the word "half"
//   even when the customer said it, instead of the customer's real message.
//
//   Bug 2 (sibling topping silently dropped): "a small Margherita pizza
//   with gyro meat and bacon" — when PROPOSE's own adds are just [Margherita,
//   gyro meat] with bacon nowhere in either add's choices — landed the
//   Margherita with ONLY Gyro Meat; the bacon named in the very same "with
//   ..." phrase vanished with no trace, because the guard only ever merged
//   the ONE span it was checking, never scanned for siblings.
//
// Root cause and fix: see mergeAddsThatAreNamedPlacementChoiceOfAnotherAdd's
// and applyEveryToppingNamedInHostsOwnPhrase's own headers, turn-engine.ts.
//
// METHODOLOGY: per the standing rule (a fix that passed offline decide()
// fixtures once already shipped broken live), this file drives the REAL
// production call path, turn-engine-runner.ts's runTurnEngineTurn, with
// PROPOSE mocked to return the exact proposal shapes the PO's own
// probe-decide repro captured -- never decide() called directly as the only
// proof.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

const CHEESE_LARGE = "aaaaaaaa-1111-1111-1111-111111111111";
const PEPPERONI_LOOKUP = "aaaaaaaa-2222-2222-2222-222222222222";
const TOPPINGS_GROUP_CHEESE = "grp-toppings-cheese";

const CHEESE_MENU: TurnEngineMenuItem[] = [
  {
    id: CHEESE_LARGE, name: "Cheese - Large (16\")", category: "Pizza", price_cents: 1650,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Cheese Pizza",
      base_price_cents: 1650, recap_template: "", ticket_template: "",
      steps: [{
        group_id: TOPPINGS_GROUP_CHEESE, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "toppings.ask",
        choices: [
          { id: "pep-whole", display: "Pepperoni (Whole pizza)", price_delta_cents: 450 },
          { id: "pep-half", display: "Pepperoni (Half pizza)", price_delta_cents: 350 },
        ],
      }],
    },
    option_groups: [{ id: TOPPINGS_GROUP_CHEESE, name: "Toppings" }],
  },
  {
    id: PEPPERONI_LOOKUP, name: "Pepperoni Pizza - Large (16\")", category: "Pizza", price_cents: 1800,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Pepperoni Pizza",
      base_price_cents: 1800, recap_template: "", ticket_template: "", steps: [],
    },
    option_groups: [],
  },
];
const CHEESE_LEXICON = [
  { term: "cheese pizza", target_id: CHEESE_LARGE, category: "Pizza", size_label: "Large" },
  { term: "large cheese pizza", target_id: CHEESE_LARGE, category: "Pizza", size_label: "Large" },
  { term: "pepperoni", target_id: PEPPERONI_LOOKUP, category: "Pizza", size_label: "Large" },
];

const MARGHERITA_ID = "bbbbbbbb-1111-1111-1111-111111111111";
const GYRO_PIZZA_ID = "bbbbbbbb-2222-2222-2222-222222222222";
const MARGHERITA_TOPPINGS_GROUP = "grp-margherita-toppings";
const GYRO_TOPPINGS_GROUP = "grp-gyro-toppings";
const MARGHERITA_BASE_CENTS = 1295;

const GYRO_MENU: TurnEngineMenuItem[] = [
  {
    id: MARGHERITA_ID, name: "Margherita - Small (10\")", category: "Pizza", price_cents: MARGHERITA_BASE_CENTS,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Margherita Pizza",
      base_price_cents: MARGHERITA_BASE_CENTS, recap_template: "", ticket_template: "",
      steps: [{
        group_id: MARGHERITA_TOPPINGS_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "toppings.ask",
        choices: [
          { id: "m-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
          { id: "m-bacon-half", display: "Bacon (Half pizza)", price_delta_cents: 350 },
          { id: "m-gyro-meat-whole", display: "Gyro Meat (Whole pizza)", price_delta_cents: 500 },
          { id: "m-gyro-meat-half", display: "Gyro Meat (Half pizza)", price_delta_cents: 400 },
        ],
      }],
    },
    option_groups: [{ id: MARGHERITA_TOPPINGS_GROUP, name: "Toppings" }],
  },
  {
    id: GYRO_PIZZA_ID, name: "Gyro - Small (10\")", category: "Pizza", price_cents: 1345,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Gyro Pizza",
      base_price_cents: 1345, recap_template: "", ticket_template: "",
      steps: [{
        group_id: GYRO_TOPPINGS_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
        prompt_template: "toppings.ask",
        choices: [
          { id: "g-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
          { id: "g-gyro-meat-whole", display: "Gyro Meat (Whole pizza)", price_delta_cents: 500 },
        ],
      }],
    },
    option_groups: [{ id: GYRO_TOPPINGS_GROUP, name: "Toppings" }],
  },
];
const GYRO_LEXICON = [
  { term: "margherita", target_id: MARGHERITA_ID, category: "Pizza", size_label: "Small" },
  { term: "margherita pizza", target_id: MARGHERITA_ID, category: "Pizza", size_label: "Small" },
  { term: "small margherita pizza", target_id: MARGHERITA_ID, category: "Pizza", size_label: "Small" },
  { term: "gyro meat", target_id: GYRO_PIZZA_ID, category: "Pizza", size_label: "Small" },
  { term: "gyro pizza", target_id: GYRO_PIZZA_ID, category: "Pizza", size_label: "Small" },
];

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(menu: TurnEngineMenuItem[], lexicon: typeof CHEESE_LEXICON): any {
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
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
        const matches = menu
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: lexicon.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
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
    conversationId: "conv-gyro-guard-fix",
    shopId: "shop-repro",
    tenantId: "shop-repro",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: CHEESE_MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: null,
      deliveryAddressKnown: false,
      driverTipCents: null,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

Deno.test("runner (Bug 1, PO probe-decide repro): 'a large cheese pizza with half pepperoni' -> Pepperoni applied as HALF, $20.00 total (matches pre-regression v560 behavior)", async () => {
  const supabase = makeFakeSupabase(CHEESE_MENU, CHEESE_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true,
      attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { item_span: "large cheese pizza", quantity: 1, choices: [] },
          { item_span: "pepperoni", quantity: 1, choices: [] },
        ],
        removes: [], modifies: [],
      },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "a large cheese pizza with half pepperoni", menu: CHEESE_MENU }),
    deps,
  );

  const lines = result.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly ONE cart line, got ${JSON.stringify(result.cart)}`);
  assertEquals(lines[0].menu_item_id, CHEESE_LARGE);
  const optionsJson = JSON.stringify(lines[0].options ?? {});
  assert(optionsJson.includes("Pepperoni (Half pizza)"), `Pepperoni must be applied as HALF — got ${optionsJson}`);
  assert(!optionsJson.includes("Pepperoni (Whole pizza)"), `Pepperoni must NOT be applied as whole — got ${optionsJson}`);
  assertEquals(lines[0].price_cents, 2000, `expected $20.00 (2000 cents), got ${lines[0].price_cents}`);
});

Deno.test("runner (Bug 2, PO probe-decide repro): 'a small Margherita pizza with gyro meat and bacon' -> ONE Margherita line with BOTH toppings, no phantom Gyro pizza, $22.45 total", async () => {
  const supabase = makeFakeSupabase(GYRO_MENU, GYRO_LEXICON);
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    // Model proposal per the PO's own dispatch: adds [small Margherita pizza,
    // gyro meat] -- bacon is NOT in the model's own proposal at all, only
    // implied by the raw message text.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true,
      attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { item_span: "small Margherita pizza", quantity: 1, choices: [] },
          { item_span: "gyro meat", quantity: 1, choices: [] },
        ],
        removes: [], modifies: [],
      },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "a small Margherita pizza with gyro meat and bacon", menu: GYRO_MENU }),
    deps,
  );

  const lines = result.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(lines.length, 1, `expected exactly ONE cart line (no phantom Gyro pizza), got ${JSON.stringify(result.cart)}`);
  assertEquals(lines[0].menu_item_id, MARGHERITA_ID);
  const optionsJson = JSON.stringify(lines[0].options ?? {});
  assert(optionsJson.includes("Gyro Meat (Whole pizza)"), `Gyro Meat must be on the Margherita line — got ${optionsJson}`);
  assert(optionsJson.includes("Bacon (Whole pizza)"), `Bacon must be on the Margherita line (named in the same phrase, dropped by the regression) — got ${optionsJson}`);
  assertEquals(lines[0].price_cents, 2245, `expected $22.45 (2245 cents), got ${lines[0].price_cents}`);
});
