// Turn Engine, Phase 3c gate (docs/specs/2026-09-14-turn-engine-oversight.md
// §4 Phase 3) — money-correctness coverage for the shared Stripe checkout
// call (createCheckoutSession) and the engine path's own wiring into it
// (index.ts's appendEngineCheckoutLinkIfReady). Every dependency is a fake
// — zero network, zero real Stripe key, zero real Postgres — same DI
// discipline as turn-engine-runner.test.ts.
//
// This is deliberately a MONEY test file, not a schema-validity one (see
// the dispatch's own acceptance criteria): test 1 below asserts the created
// session's total equals an independently-computed itemizer total to the
// cent, not "a positive number".
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createCheckoutSession,
  buildEngineCheckoutSessionInput,
  appendCheckoutLink,
  type CreateCheckoutSessionInput,
} from "./checkout-session.ts";
import { appendEngineCheckoutLinkIfReady, type EngineCheckoutDeps } from "./index.ts";
import type { TurnEngineCartLine } from "./turn-engine.ts";
import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";

// ── Fakes ────────────────────────────────────────────────────────────────

function makeFakeStripe() {
  const createCalls: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  const stripe: any = {
    checkout: {
      sessions: {
        create(params: Record<string, unknown>) {
          createCalls.push(params);
          const id = `sess_${createCalls.length}`;
          return Promise.resolve({ id, url: `https://checkout.stripe.com/${id}` });
        },
      },
    },
  };
  return { stripe, createCalls };
}

function makeFakeSupabase(initialCartRow: Record<string, unknown> = {}) {
  const state = {
    cartRow: { ...initialCartRow } as Record<string, unknown>,
    orderCartsUpdates: [] as Array<Record<string, unknown>>,
    payLinksInserted: [] as Array<Record<string, unknown>>,
  };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      single() {
        if (table === "order_carts") return Promise.resolve({ data: { ...state.cartRow }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") {
          state.orderCartsUpdates.push(row);
          Object.assign(state.cartRow, row);
        }
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert(row: Record<string, unknown>) {
        if (table === "pay_links") state.payLinksInserted.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

function line(overrides: Partial<TurnEngineCartLine> = {}): TurnEngineCartLine {
  return {
    menu_item_id: "item-x",
    name:         "Item",
    quantity:     1,
    price_cents:  0,
    modifiers:    [],
    ...overrides,
  };
}

// ── Test 1: money exactness — session total equals the itemizer's own sum ─

Deno.test("createCheckoutSession: session total matches an independently-computed itemizer total to the cent (2 lines, a priced modifier, delivery fee, and a tip)", async () => {
  // Independently built here, NOT by calling any production summation code —
  // mirrors the same subtotal/total formula the customer's own reply footer
  // uses (money-footer-20260909.ts's renderMoneyFooterLines): subtotal =
  // sum(price_cents * quantity); total = subtotal + fee + delivery + tip.
  const CHEESEBURGER_UNIT_CENTS = 849;             // base item
  const BACON_MODIFIER_CENTS = 150;                // priced modifier baked into the line's own price_cents
  const BACON_CHEESEBURGER_UNIT_CENTS = CHEESEBURGER_UNIT_CENTS + BACON_MODIFIER_CENTS; // 999
  const FRIES_UNIT_CENTS = 349;
  const FRIES_QTY = 2;
  const DELIVERY_FEE_CENTS = 350;
  const TIP_CENTS = 500;

  const expectedSubtotalCents = BACON_CHEESEBURGER_UNIT_CENTS * 1 + FRIES_UNIT_CENTS * FRIES_QTY;
  const expectedTotalCents = expectedSubtotalCents + SERVICE_FEE_CENTS + DELIVERY_FEE_CENTS + TIP_CENTS;

  const input: CreateCheckoutSessionInput = {
    cartId:   "cart-money-1",
    shopName: "Vito's",
    testMode: true,
    lineItems: [
      { name: "Bacon Cheeseburger", quantity: 1, unitAmountCents: BACON_CHEESEBURGER_UNIT_CENTS, description: "Add bacon" },
      { name: "Fries", quantity: FRIES_QTY, unitAmountCents: FRIES_UNIT_CENTS },
    ],
    subtotalCents:    expectedSubtotalCents,
    serviceFeeCents:  SERVICE_FEE_CENTS,
    deliveryFeeCents: DELIVERY_FEE_CENTS,
    tipCents:         TIP_CENTS,
    orderType:        "delivery",
  };

  const { stripe, createCalls } = makeFakeStripe();
  const { supabase, state } = makeFakeSupabase();

  const result = await createCheckoutSession(input, { supabase, stripe });

  assert(result.ok, "session creation must succeed");
  if (!result.ok) return;
  assertEquals(result.totalCents, expectedTotalCents, "createCheckoutSession's own returned total must equal the itemizer total");

  // The actual Stripe API call — sum every line item's unit_amount*quantity,
  // the number Stripe will actually charge, and assert it EXACTLY equals the
  // independently-computed itemizer total. Not "positive", not "roughly
  // right" — to the cent.
  assertEquals(createCalls.length, 1);
  // deno-lint-ignore no-explicit-any
  const stripeLineItems = createCalls[0].line_items as any[];
  const stripeChargeTotalCents = stripeLineItems.reduce(
    (s, li) => s + (li.price_data.unit_amount as number) * (li.quantity as number),
    0,
  );
  assertEquals(stripeChargeTotalCents, expectedTotalCents, "the actual Stripe charge total must equal the itemizer total to the cent");

  // And the persisted order_carts row must agree too.
  assertEquals(state.cartRow.total_cents, expectedTotalCents);
  assertEquals(state.cartRow.subtotal_cents, expectedSubtotalCents);
});

// ── Test 2: idempotency — a double-submit of the same cart creates ONE ────
// session, never two.

Deno.test("appendEngineCheckoutLinkIfReady: submitting the same cart twice creates exactly one Stripe session", async () => {
  const { stripe, createCalls } = makeFakeStripe();
  const { supabase } = makeFakeSupabase({ order_type: "pickup", delivery_fee_cents: 0, driver_tip_cents: 0, notes: null, stripe_checkout_session_id: null });

  const deps: EngineCheckoutDeps = {
    supabase,
    resolveStripeKey: () => "sk_test_fake",
    createStripeClient: () => stripe,
  };

  const cartLines: TurnEngineCartLine[] = [line({ menu_item_id: "item-cb", name: "Cheese Burger", price_cents: 849, quantity: 1 })];

  const callParams = {
    cartId:     "cart-dup-1",
    shopName:   "Vito's",
    testMode:   true,
    priorPhase: "confirm" as const,
    nextPhase:  "link_sent" as const,
    cartLines,
    reply:      "All good — confirm?",
    isSms:      false,
  };

  const firstReply = await appendEngineCheckoutLinkIfReady(callParams, deps);
  const secondReply = await appendEngineCheckoutLinkIfReady(callParams, deps);

  assertEquals(createCalls.length, 1, "a second submit of the same cart must not create a second Stripe session");
  assert(firstReply.includes("pay.getsprintai.com/o/"), "first call must surface the payment link");
  // Second call finds the session already persisted on the cart row (the
  // fake supabase's update() mutates its own in-memory cartRow, same as a
  // real UPDATE would) and returns the reply unmodified rather than
  // fabricating a second link.
  assertEquals(secondReply, callParams.reply);
});

// ── Test 3: the engine path's reply contains the payment link when a ──────
// session was successfully created.

Deno.test("appendEngineCheckoutLinkIfReady: reply contains the payment link once a session is created", async () => {
  const { stripe } = makeFakeStripe();
  const { supabase } = makeFakeSupabase({ order_type: "pickup", delivery_fee_cents: 0, driver_tip_cents: 0, notes: null, stripe_checkout_session_id: null });
  const deps: EngineCheckoutDeps = {
    supabase,
    resolveStripeKey: () => "sk_test_fake",
    createStripeClient: () => stripe,
  };
  const cartLines: TurnEngineCartLine[] = [line({ menu_item_id: "item-cb", name: "Cheese Burger", price_cents: 849, quantity: 1 })];

  const reply = await appendEngineCheckoutLinkIfReady(
    {
      cartId:     "cart-link-1",
      shopName:   "Vito's",
      testMode:   true,
      priorPhase: "confirm",
      nextPhase:  "link_sent",
      cartLines,
      reply:      "All good — confirm?",
      isSms:      false,
    },
    deps,
  );

  assert(reply.includes("Pay here: https://pay.getsprintai.com/o/"), `reply must contain the payment link, got: ${reply}`);
});

// ── Supporting coverage: no session is (re-)created on turns that don't ───
// newly reach link_sent, and a session is never created for an empty cart.

Deno.test("appendEngineCheckoutLinkIfReady: no-op when the phase was already link_sent before this turn", async () => {
  const { stripe, createCalls } = makeFakeStripe();
  const { supabase } = makeFakeSupabase({ stripe_checkout_session_id: "sess_existing" });
  const deps: EngineCheckoutDeps = { supabase, resolveStripeKey: () => "sk_test_fake", createStripeClient: () => stripe };

  const reply = await appendEngineCheckoutLinkIfReady(
    {
      cartId: "cart-2", shopName: "Vito's", testMode: true,
      priorPhase: "link_sent", nextPhase: "link_sent",
      cartLines: [line()], reply: "Anything else?", isSms: false,
    },
    deps,
  );

  assertEquals(createCalls.length, 0);
  assertEquals(reply, "Anything else?");
});

Deno.test("appendEngineCheckoutLinkIfReady: no-op when this turn didn't reach link_sent at all", async () => {
  const { stripe, createCalls } = makeFakeStripe();
  const { supabase } = makeFakeSupabase();
  const deps: EngineCheckoutDeps = { supabase, resolveStripeKey: () => "sk_test_fake", createStripeClient: () => stripe };

  const reply = await appendEngineCheckoutLinkIfReady(
    {
      cartId: "cart-3", shopName: "Vito's", testMode: true,
      priorPhase: "confirm", nextPhase: "confirm",
      cartLines: [line()], reply: "All good — confirm?", isSms: false,
    },
    deps,
  );

  assertEquals(createCalls.length, 0);
  assertEquals(reply, "All good — confirm?");
});

Deno.test("createCheckoutSession: rejects an empty cart rather than creating a zero-item Stripe session", async () => {
  const { stripe, createCalls } = makeFakeStripe();
  const { supabase } = makeFakeSupabase();
  const result = await createCheckoutSession(
    {
      cartId: "cart-empty", shopName: "Vito's", testMode: true,
      lineItems: [], subtotalCents: 0, serviceFeeCents: SERVICE_FEE_CENTS,
      deliveryFeeCents: 0, tipCents: 0, orderType: "pickup",
    },
    { supabase, stripe },
  );
  assertEquals(result.ok, false);
  assertEquals(createCalls.length, 0);
});

// ── SMS truncation parity (mirrors index.ts's own checkoutUrl-append logic)

Deno.test("appendCheckoutLink: adds the link under the SMS budget, never doubles an already-present link", () => {
  const url = "https://pay.getsprintai.com/o/abcd1234";
  assertEquals(appendCheckoutLink("All set!", url, false), `All set!\n\nPay here: ${url}`);
  assertEquals(appendCheckoutLink(`Already has ${url} in it`, url, true), `Already has ${url} in it`);
  assertEquals(appendCheckoutLink("hi", undefined, true), "hi");
});

// ── buildEngineCheckoutSessionInput: pure adapter, no bundle branch needed
// (TurnEngineCartLine has no bundle variant) ───────────────────────────────

Deno.test("buildEngineCheckoutSessionInput: sums only real cart lines, ignores a line with no menu_item_id", () => {
  const cartLines: TurnEngineCartLine[] = [
    line({ menu_item_id: "a", name: "Cheese Burger", price_cents: 849, quantity: 1 }),
    line({ menu_item_id: "b", name: "Fries", price_cents: 349, quantity: 2, modifiers: ["Extra crispy"] }),
    // A synthetic non-real line (no menu_item_id) must never be priced.
    { name: "placeholder", quantity: 1, price_cents: 99999, modifiers: [] } as unknown as TurnEngineCartLine,
  ];
  const built = buildEngineCheckoutSessionInput({
    cartId: "cart-4", shopName: "Vito's", testMode: true, cartLines,
    orderType: "delivery", deliveryFeeCents: 300, tipCents: 200, notes: "ring bell",
  });
  assertEquals(built.lineItems.length, 2);
  assertEquals(built.subtotalCents, 849 + 349 * 2);
  assertEquals(built.deliveryFeeCents, 300);
  assertEquals(built.tipCents, 200);
  assertEquals(built.notes, "ring bell");
  assertEquals(built.lineItems[1].description, "Extra crispy");
});
