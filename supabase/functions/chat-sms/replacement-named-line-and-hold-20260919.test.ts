// 2026-09-19 PO dispatch — REAL LIVE MONEY BUG, v560 rerun, conv 59cb90c9 #12.
//
// Cart: Small Chicken Bacon Ranch Pizza (Broccoli) + Cup Chicken Noodle Soup.
// Bot has just asked "Anything else?" Customer: "Actually, can I change that
// pizza to a small BBQ Chicken pizza instead?"
//
// REQUIRED METHODOLOGY: runner-level, driving the real turn-engine-runner.ts
// runTurnEngineTurn — the same call path index.ts's turn_engine_enabled
// branch actually uses. MENU/LEXICON below are Vito's own real active
// menu_items/item-lexicon rows for shop_id
// e0000000-0000-0000-0000-000000000001, queried live via the DB-shaping
// pattern in ~/po-scratch/probe-bbqchicken-offmenu-20260919.ts (compileMenu +
// normalizeMenuItems -> real lexicon_terms), not hand-typed — see
// ~/po-scratch/probe-cbr-soup-replace-20260919.ts for the exact query this
// file's constants were copied from. Confirmed against real data (not this
// file's toy expectation): resolveItem("small bbq chicken pizza", <real
// lexicon>) is genuinely AMBIGUOUS between Small Buffalo Chicken Pizza and
// Small Thai Sweet Chili Chicken Pizza on Vito's real menu today (there is no
// real "BBQ Chicken pizza" — only a BBQ Chicken flatbread, a separate,
// already-built fixture on fix/offmenu-similar-name-different-category-20260919;
// this file's job is independent of what "BBQ Chicken pizza" ultimately
// resolves to and never asserts a specific resolution for it).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Real Vito's data (queried live, 2026-09-19, shop_id e0000000-0000-0000-0000-000000000001) ──

const CBR_SMALL = "f320da06-15d2-4503-97b2-001c17b444bf";
const SOUP_CUP = "721d8cd0-5d93-49cf-9a00-94dfd4ad6bc9";
const BUFFALO_CHICKEN_SMALL = "0aa10696-753c-4595-bc0e-c4ca1956805a";
const THAI_SWEET_CHILI_SMALL = "113d647d-aaa9-48ba-8c00-1e4f9f082f91";
const ROMA_SMALL = "8ac60a76-7691-4b00-a722-bbf83ef042b4";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

// Real menu_items rows (id, display_name, category, price_cents).
const MENU: TurnEngineMenuItem[] = [
  realItem(CBR_SMALL, "Small Chicken Bacon Ranch Pizza", "Pizza", 1295),
  realItem(SOUP_CUP, "Cup Chicken Noodle Soup", "Soups", 499),
  realItem(BUFFALO_CHICKEN_SMALL, "Small Buffalo Chicken Pizza", "Pizza", 1295),
  realItem(THAI_SWEET_CHILI_SMALL, "Small Thai Sweet Chili Chicken Pizza", "Pizza", 1295),
  realItem(ROMA_SMALL, "Small Roma Pizza", "Pizza", 1295),
];

// Real active item_lexicon rows for shop e0000000-0000-0000-0000-000000000001
// (term, target_id, category, size_label) — copied verbatim from a live
// query (probe-cbr-soup-replace-20260919.ts), not invented. Trimmed to the
// rows this repro's own resolution actually depends on.
const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "chicken bacon ranch", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chicken bacon ranch pizza", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small chicken bacon ranch", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small chicken bacon ranch pizza", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "pizza", target_id: CBR_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chicken noodle soup", target_id: SOUP_CUP, category: "Soups", size_label: "Cup" },
  { term: "cup chicken noodle soup", target_id: SOUP_CUP, category: "Soups", size_label: "Cup" },
  { term: "noodle soup", target_id: SOUP_CUP, category: "Soups", size_label: "Cup" },
  { term: "soup", target_id: SOUP_CUP, category: "Soups", size_label: "Cup" },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "buffalo chicken pizza", target_id: BUFFALO_CHICKEN_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small buffalo chicken pizza", target_id: BUFFALO_CHICKEN_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chicken pizza", target_id: BUFFALO_CHICKEN_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "pizza", target_id: BUFFALO_CHICKEN_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "thai sweet chili chicken", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "thai sweet chili chicken pizza", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small thai sweet chili chicken pizza", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "sweet chili chicken", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chili chicken", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "chicken pizza", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "pizza", target_id: THAI_SWEET_CHILI_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "roma", target_id: ROMA_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "roma pizza", target_id: ROMA_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "small roma pizza", target_id: ROMA_SMALL, category: "Pizza", size_label: "Small (10\")" },
  { term: "pizza", target_id: ROMA_SMALL, category: "Pizza", size_label: "Small (10\")" },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-59cb90c9-repro",
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

interface FakeState {
  orderCartsUpdates: Array<Record<string, unknown>>;
}

function makeFakeSupabase() {
  const state: FakeState = { orderCartsUpdates: [] };
  // deno-lint-ignore no-explicit-any
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
          .map(m => ({ id: m.id, category: m.category, size_label: LEXICON.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") state.orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
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
  const supabase = { from: (table: string) => builder(table) } as any;
  return { supabase, state };
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function baseCart(): TurnEngineCartLine[] {
  return [
    { menu_item_id: CBR_SMALL, name: "Small Chicken Bacon Ranch Pizza", quantity: 1, price_cents: 1295, modifiers: ["Broccoli"], line_key: "pizza-line" },
    { menu_item_id: SOUP_CUP, name: "Cup Chicken Noodle Soup", quantity: 1, price_cents: 499, modifiers: [], line_key: "soup-line" },
  ];
}

// "Anything else?" open state — the exact dialogue phase the real conv was
// in when the customer said "Actually, can I change that pizza..."
function anythingElseState(): DialogueState {
  return { phase: "ordering", open: null, upsell_offered: true, asked_message_id: null, openRepeatCount: 0 };
}

Deno.test("T1 (RED pre-fix / GREEN post-fix): 'change that pizza to a small BBQ Chicken pizza instead' must hold the pizza line and never touch the soup, even though PROPOSE's own remove targets the soup's line_key", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    // Modeled on the real live propose_success shape for this exact turn
    // (conv 59cb90c9 #12): the model proposed removing the SOUP's own
    // line_key (wrong target) alongside the BBQ Chicken add — this is
    // exactly the shape decide()'s remove-guard must catch and refuse.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "small BBQ Chicken pizza", quantity: 1, choices: [] }],
        removes: [{ line_key: "soup-line" }],
        modifies: [],
      },
    }),
  };
  const t1 = await runTurnEngineTurn(
    baseInput({
      message: "Actually, can I change that pizza to a small BBQ Chicken pizza instead?",
      cart: baseCart(),
      dialogueState: anythingElseState(),
    }),
    deps,
  );
  assert(
    t1.cart.some(l => l.menu_item_id === SOUP_CUP),
    `the soup line must NEVER be removed — the customer never named it: ${JSON.stringify(t1.cart)}`,
  );
  assert(
    t1.cart.some(l => l.menu_item_id === CBR_SMALL),
    `the pizza line must stay in the cart, HELD, until the BBQ Chicken replacement resolves — it must not vanish either: ${JSON.stringify(t1.cart)}`,
  );
  assertEquals(t1.cart.length, 2, `no third line may be added while the replacement is still ambiguous: ${JSON.stringify(t1.cart)}`);
  assertEquals(t1.dialogueState.open?.kind, "disambiguation", `a real ambiguity (Buffalo vs Thai Sweet Chili) must open a narrowing question, never silently guess: ${JSON.stringify(t1.dialogueState)}`);
  if (t1.dialogueState.open?.kind === "disambiguation") {
    assertEquals(
      [...t1.dialogueState.open.candidates].sort(),
      [BUFFALO_CHICKEN_SMALL, THAI_SWEET_CHILI_SMALL].sort(),
    );
    assertEquals(t1.dialogueState.open.replacementSourceLineKey, "pizza-line", "the held line must ride along so answering the narrowing question removes THIS pizza, not the soup");
  }
});

Deno.test("T1-clean (acceptance, resolves cleanly): 'change that pizza to a small Roma pizza instead' replaces the CBR pizza line in place, soup untouched, no disambiguation opened", async () => {
  const { supabase } = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "small Roma pizza", quantity: 1, choices: [] }],
        removes: [{ line_key: "soup-line" }],
        modifies: [],
      },
    }),
  };
  const t1 = await runTurnEngineTurn(
    baseInput({
      message: "Actually, can I change that pizza to a small Roma pizza instead?",
      cart: baseCart(),
      dialogueState: anythingElseState(),
    }),
    deps,
  );
  assert(t1.cart.some(l => l.menu_item_id === SOUP_CUP), `soup must remain untouched: ${JSON.stringify(t1.cart)}`);
  assert(!t1.cart.some(l => l.menu_item_id === CBR_SMALL), `the CBR pizza must actually be replaced once Y resolves cleanly: ${JSON.stringify(t1.cart)}`);
  assert(t1.cart.some(l => l.menu_item_id === ROMA_SMALL), `the Roma pizza must be added in the CBR's place: ${JSON.stringify(t1.cart)}`);
  assertEquals(t1.cart.length, 2, `still exactly two lines — a swap, not an addition: ${JSON.stringify(t1.cart)}`);
  assertEquals(t1.dialogueState.open, null, `nothing ambiguous here — no disambiguation should open: ${JSON.stringify(t1.dialogueState)}`);
});

Deno.test("T2 (RED pre-fix / GREEN post-fix, real conv 59cb90c9 #12/#13): a restatement during the held replacement's narrowing question that declines both offered candidates and doesn't resolve to anything usable must re-ask, never collapse to checkout name-capture", async () => {
  const { supabase } = makeFakeSupabase();
  const deps1: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "small BBQ Chicken pizza", quantity: 1, choices: [] }],
        removes: [{ line_key: "soup-line" }],
        modifies: [],
      },
    }),
  };
  const t1 = await runTurnEngineTurn(
    baseInput({
      message: "Actually, can I change that pizza to a small BBQ Chicken pizza instead?",
      cart: baseCart(),
      dialogueState: anythingElseState(),
    }),
    deps1,
  );
  assertEquals(t1.dialogueState.open?.kind, "disambiguation");

  let t2ProposeCalled = false;
  const deps2: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => {
      t2ProposeCalled = true;
      return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
    },
  };
  const t2 = await runTurnEngineTurn(
    baseInput({
      message: "I meant to say BBQ Chicken - Small (10\") pizza, not Buffalo or Thai. Can we do that instead?",
      cart: t1.cart,
      dialogueState: t1.dialogueState,
    }),
    deps2,
  );
  assert(t2.cart.some(l => l.menu_item_id === SOUP_CUP), `soup must stay untouched across turn 2 as well: ${JSON.stringify(t2.cart)}`);
  assert(t2.cart.some(l => l.menu_item_id === CBR_SMALL), `the pizza must STILL be held — neither removed nor replaced by an unresolved restatement: ${JSON.stringify(t2.cart)}`);
  assertEquals(t2.cart.length, 2, `no line may be added for an item that never actually resolved: ${JSON.stringify(t2.cart)}`);
  assertEquals(
    t2.dialogueState.phase,
    "ordering",
    `must NOT collapse to checkout name-capture — this is the exact real live defect (bot asked "What's the name for the order?" with the replacement never resolved either way): ${JSON.stringify(t2.dialogueState)}`,
  );
  assertEquals(t2.dialogueState.open?.kind, "disambiguation", `the SAME narrowing question must still be open, asking again: ${JSON.stringify(t2.dialogueState)}`);
  if (t2.dialogueState.open?.kind === "disambiguation") {
    assertEquals(t2.dialogueState.open.replacementSourceLineKey, "pizza-line", "the hold must survive an unresolved restatement, not just the first turn");
  }
  assert(!/name for the order/i.test(t2.reply), `reply must never jump to checkout name-capture mid-replacement: ${JSON.stringify(t2.reply)}`);

  // Turn 3: the customer finally answers the still-open Buffalo-vs-Thai
  // question directly -- the hold must still be alive and complete the
  // atomic swap exactly as it would have on turn 1, proving this fix
  // doesn't just re-ask forever but actually lets a real answer land.
  const deps3: RunTurnDeps = { supabase, apiKey: "test-key", newLineKey: newLineKeyCounter() };
  const t3 = await runTurnEngineTurn(
    baseInput({ message: "Buffalo Chicken", cart: t2.cart, dialogueState: t2.dialogueState }),
    deps3,
  );
  assert(t3.cart.some(l => l.menu_item_id === SOUP_CUP), `soup must remain untouched through the whole exchange: ${JSON.stringify(t3.cart)}`);
  assert(!t3.cart.some(l => l.menu_item_id === CBR_SMALL), `the held CBR pizza must finally be removed once Y genuinely resolves: ${JSON.stringify(t3.cart)}`);
  assert(t3.cart.some(l => l.menu_item_id === BUFFALO_CHICKEN_SMALL), `the Buffalo Chicken pizza must be added in its place: ${JSON.stringify(t3.cart)}`);
  assertEquals(t3.cart.length, 2, `still exactly two lines — a completed swap: ${JSON.stringify(t3.cart)}`);
});
