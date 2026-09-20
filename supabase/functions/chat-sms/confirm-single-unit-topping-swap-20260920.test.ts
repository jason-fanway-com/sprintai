// 2026-09-20 PO dispatch — REAL LIVE MONEY BUG (X2), v572 50-run, conv
// 46c39215 #36. Real conv 70bc7d0b (v575) found a second gap in the first
// fix for this: every real topping on this item compiles as a Whole/Half
// PAIR ("Grilled Chicken (Whole pizza)" + "Grilled Chicken (Half pizza)"),
// so a bare newModifierPhrase with no placement word ("grilled chicken")
// stem-matches BOTH -- the fixture below now carries both variants (real
// ids, queried live) so this file's own tests can no longer pass while the
// live bug reproduces the way the first attempt's did.
//
// Cart at the read-back/confirm state: Large White Pizza + 2x Large Gyro
// Pizza (Sausage). Customer: "I actually wanted one of the Gyro pizzas with
// grilled chicken instead of the other sausage one! Please update that."
// Actual (broken, pre-fix): applyNamedLineRemovals (mechanism 3) reads
// "pizza" as removal language shared by BOTH pizza lines' own names (the
// Gyro's AND the unrelated White Pizza's — the bare word "pizza" overlaps
// both), soft-correction verb "instead of" is present, and the whole cart
// gets wiped — the customer never mentioned the White Pizza at all.
//
// Same class of bug as fix/replacement-targets-named-line-and-holds-
// removal-20260919 ("a correction names the line it changes; a line the
// customer did not name is never touched"), generalized to the confirm
// path and to a correction naming only ONE unit of an already-multi-
// quantity line, not a whole different line.
//
// A first pass at this fix (merged as 75a29a9f, reverted as 92a1b93c) only
// closed the Whole/Half ambiguity inside applySingleUnitToppingSwap and
// left the call site's fallthrough in place -- ANY other reason the swap
// failed to resolve (a genuinely different-topping ambiguity, an old
// topping that isn't actually selected, a missing ask_plan, ...) still fell
// through to applyNamedLineRemovals and wiped the cart the same way. This
// version closes both: the Whole/Half collapse itself (so the common real
// case actually applies the swap), AND the call site (so any OTHER
// unresolved case from this same message shape declines by name instead of
// ever reaching mechanism 3) -- see the "still ambiguous" and "old topping
// not on the order" tests below for the fallthrough class specifically.
//
// REQUIRED METHODOLOGY: runner-level, driving the real turn-engine-
// runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses. MENU below is Vito's own real
// active menu_items/option_groups/option_choices rows for shop_id
// e0000000-0000-0000-0000-000000000001, queried live, read-only, on
// 2026-09-20 — every id/price below is real, not invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Real Vito's data (queried live, 2026-09-20, shop_id e0000000-0000-0000-0000-000000000001) ──

const GYRO_LARGE_ID = "713b447f-9798-4188-8930-967f03cb3678";
const WHITE_LARGE_ID = "e0c4018f-ae3f-4898-a511-cde01ebe4014";
const GYRO_TOPPINGS_GROUP_ID = "29bd83e0-a3e3-4fed-a075-4b4f78368173";
const SAUSAGE_CHOICE_ID = "7e888e14-40df-4477-89cf-7306d3d5028e";
const SAUSAGE_HALF_CHOICE_ID = "ab195ee9-b43a-4c31-ac30-89737130bcb9";
const GRILLED_CHICKEN_CHOICE_ID = "42869158-63da-406b-a2c7-3e9f223eb250";
const GRILLED_CHICKEN_HALF_CHOICE_ID = "85c7dd13-9921-4daf-9478-d6d735d76694";
const CHICKEN_STEAK_CHOICE_ID = "c95e143a-66d8-4a6b-a84c-e50e5650cc00";
const CHICKEN_STEAK_HALF_CHOICE_ID = "e37f5660-c4fa-4bf9-bd70-b6ece142c196";

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
            { id: SAUSAGE_HALF_CHOICE_ID, display: "Sausage (Half pizza)", price_delta_cents: 350 },
            { id: GRILLED_CHICKEN_CHOICE_ID, display: "Grilled Chicken (Whole pizza)", price_delta_cents: 500 },
            { id: GRILLED_CHICKEN_HALF_CHOICE_ID, display: "Grilled Chicken (Half pizza)", price_delta_cents: 400 },
            { id: CHICKEN_STEAK_CHOICE_ID, display: "Chicken Steak (Whole pizza)", price_delta_cents: 500 },
            { id: CHICKEN_STEAK_HALF_CHOICE_ID, display: "Chicken Steak (Half pizza)", price_delta_cents: 400 },
          ],
        },
      ],
    },
    option_groups: [{ id: GYRO_TOPPINGS_GROUP_ID, name: "Toppings", default_choice_id: null }],
  },
  {
    id: WHITE_LARGE_ID, name: "Large White Pizza", category: "Pizza", price_cents: 1999, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Large White Pizza", base_price_cents: 1999,
      recap_template: "", ticket_template: "", steps: [],
    },
  },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-46c39215-repro",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true,
      orderType: "pickup",
      deliveryAddressKnown: false,
      driverTipCents: 0,
      pickupName: null,
      deliveryFeeCents: null,
    },
    ...overrides,
  };
}

// Cart shape at the exact read-back/confirm state the real conv was in:
// Large White Pizza + 2x Large Gyro Pizza (Sausage), both units on one
// quantity-2 line (a cart line is N identical units sharing one options/
// price pair — see ask-plan-engine.ts's own ALL_UNITS_RE header).
function confirmCart(): TurnEngineCartLine[] {
  return [
    {
      menu_item_id: WHITE_LARGE_ID, name: "Large White Pizza", quantity: 1, price_cents: 1999,
      modifiers: [], line_key: "white-line",
    },
    {
      menu_item_id: GYRO_LARGE_ID, name: "Large Gyro Pizza", quantity: 2, price_cents: 2299 + 450,
      modifiers: [], options: { Toppings: ["Sausage (Whole pizza)"] },
      ask_plan_selections: { [GYRO_TOPPINGS_GROUP_ID]: SAUSAGE_CHOICE_ID },
      line_key: "gyro-line",
    },
  ];
}

function confirmState(): DialogueState {
  return { phase: "confirm", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };
}

// Same minimal fake-supabase pattern as turn-engine.test.ts's own mechanism
// 2 runner-level test — this correction never issues a real query, only
// order_carts/messages writes at the end of the turn.
function makeFakeSupabase() {
  function builder(table: string) {
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

const MESSAGE = "I actually wanted one of the Gyro pizzas with grilled chicken instead of the other sausage one! Please update that.";

Deno.test("runTurnEngineTurn (confirm-path correction targets named line, real conv 46c39215 #36, real Whole/Half menu): the White Pizza is NEVER touched — only the named Gyro unit changes", async () => {
  const deps: RunTurnDeps = {
    supabase: makeFakeSupabase(),
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => Promise.reject(new Error("PROPOSE must not be called — the correction resolves deterministically")),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: MESSAGE, cart: confirmCart(), dialogueState: confirmState() }),
    deps,
  );

  const whiteLines = result.cart.filter(l => l.menu_item_id === WHITE_LARGE_ID);
  assertEquals(whiteLines.length, 1, `the White Pizza line must survive, exactly once: ${JSON.stringify(result.cart)}`);
  assertEquals(whiteLines[0].quantity, 1, `the White Pizza's quantity must be untouched: ${JSON.stringify(result.cart)}`);
  assert(!result.reply.toLowerCase().includes("white"), `reply must never mention the White Pizza — it was never part of this correction: ${JSON.stringify(result.reply)}`);

  const gyroLines = result.cart.filter(l => l.menu_item_id === GYRO_LARGE_ID);
  assertEquals(gyroLines.length, 2, `the Gyro line must SPLIT into two quantity-1 lines, one per topping: ${JSON.stringify(result.cart)}`);
  // No "half" word in the customer's phrase -> defaults to Whole, same
  // convention recoverPlacementHits already uses elsewhere in this file.
  const sausageLine = gyroLines.find(l => (l.options?.Toppings ?? []).includes("Sausage (Whole pizza)"));
  const grilledChickenLine = gyroLines.find(l => (l.options?.Toppings ?? []).includes("Grilled Chicken (Whole pizza)"));
  assert(sausageLine, `one Gyro unit must keep Sausage — the customer said "the OTHER sausage one" stays: ${JSON.stringify(gyroLines)}`);
  assert(grilledChickenLine, `the other Gyro unit must become Grilled Chicken: ${JSON.stringify(gyroLines)}`);
  assertEquals(sausageLine!.quantity, 1);
  assertEquals(grilledChickenLine!.quantity, 1);
  assertEquals(result.cart.length, 3, `exactly three lines total — White (untouched) + Gyro Sausage + Gyro Grilled Chicken: ${JSON.stringify(result.cart)}`);
});

Deno.test("answer (confirm-path correction targets named line): a topping that isn't a real choice on this item declines by name, touching nothing", async () => {
  const { answer } = await import("./turn-engine.ts");
  const cart = confirmCart();
  const result = answer(confirmState(), cart, "I actually wanted one of the Gyro pizzas with anchovies instead of the other sausage one! Please update that.", MENU);
  assert(result.resolved);
  assertEquals(result.cartChanged, false);
  assertEquals((result.outcome as { kind: string }).kind, "unit_modification_unavailable");
  assertEquals(cart, confirmCart(), "cart must be byte-identical to before — nothing touched when the swap can't resolve");
});

// Fallthrough-hardening test 1: "chicken" alone (no "grilled", no "steak")
// stem-matches BOTH "Grilled Chicken" and "Chicken Steak" -- two genuinely
// DIFFERENT toppings, not a Whole/Half pair of the SAME topping, so the
// collapse above can never narrow this. Before the call-site fix, this
// null return from applySingleUnitToppingSwap fell through to
// applyNamedLineRemovals and wiped the whole cart exactly like the
// Whole/Half case did; now it must decline by name, touching nothing.
Deno.test("answer (confirm-path correction targets named line): two genuinely different toppings both matching the new phrase declines by name, touching nothing (never falls through to remove the whole cart)", async () => {
  const { answer } = await import("./turn-engine.ts");
  const cart = confirmCart();
  const result = answer(
    confirmState(),
    cart,
    "I actually wanted one of the Gyro pizzas with chicken instead of the other sausage one! Please update that.",
    MENU,
  );
  assert(result.resolved);
  assertEquals(result.cartChanged, false, `nothing should be touched when the new topping is ambiguous: ${JSON.stringify(cart)}`);
  assertEquals((result.outcome as { kind: string }).kind, "unit_modification_unavailable");
  assertEquals(cart, confirmCart(), "cart must be byte-identical to before — nothing touched, and specifically NOT wiped");
});

// Fallthrough-hardening test 2: the OLD topping named doesn't match what's
// actually selected on the line at all ("the pepperoni one" when the line
// is Sausage) -- applySingleUnitToppingSwap's modifier-step loop never
// finds an oldCandidates match and returns null after the loop, a
// different code path to null than either ambiguity case above. Same
// requirement: decline by name, never fall through to a full-cart wipe.
Deno.test("answer (confirm-path correction targets named line): an old topping that isn't actually on the line declines by name, touching nothing", async () => {
  const { answer } = await import("./turn-engine.ts");
  const cart = confirmCart();
  const result = answer(
    confirmState(),
    cart,
    "I actually wanted one of the Gyro pizzas with grilled chicken instead of the other pepperoni one! Please update that.",
    MENU,
  );
  assert(result.resolved);
  assertEquals(result.cartChanged, false, `nothing should be touched when the named old topping isn't on the line: ${JSON.stringify(cart)}`);
  assertEquals((result.outcome as { kind: string }).kind, "unit_modification_unavailable");
  assertEquals(cart, confirmCart(), "cart must be byte-identical to before — nothing touched, and specifically NOT wiped");
});

// Fixture B guard: the message shape this file exercises is scoped tightly
// enough that it must never fire outside the exact "confirm" phase this
// mechanism runs in — the ambiguity-narrowing regression (a customer's bare
// "4 large pizzas" reaching a "what kind?" question, not the name-ask) lives
// entirely in a different phase (ordering, no confirm question open yet)
// and a completely different message shape, so it can never reach this
// code path at all. Pinned here as a structural guard, not a duplicate of
// the ambiguity-narrowing tests elsewhere in this suite.
Deno.test("answer (confirm-path correction targets named line): an ordinary ambiguous-item message ('4 large pizzas') never matches this mechanism outside the confirm phase", async () => {
  const { answer } = await import("./turn-engine.ts");
  const orderingState: DialogueState = { phase: "ordering", open: null, upsell_offered: false, asked_message_id: null, openRepeatCount: 0 };
  const cart: TurnEngineCartLine[] = [];
  const result = answer(orderingState, cart, "4 large pizzas", MENU);
  // Whatever this resolves to, it must never be this mechanism's own outcome
  // kinds -- those only ever fire from the "confirm" case.
  if (result.resolved) {
    const kind = (result.outcome as { kind: string }).kind;
    assert(kind !== "unit_modified_at_confirm" && kind !== "unit_modification_unavailable", `must not resolve via the single-unit-topping-swap mechanism outside confirm: ${kind}`);
  }
});
