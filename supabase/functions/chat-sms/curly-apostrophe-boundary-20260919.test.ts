// PO follow-up dispatch (2026-09-19), curly-apostrophe boundary. Earlier
// tonight's fix (commit 31d627ff) normalized curly apostrophes (U+2019)
// inside impliesClosure() ONLY — a single local call site. Grepping the
// current file after that landed found the same iOS-autocorrect defect
// (`don'?t`/`i'?m`-style literals that only ever anticipated a straight `'`
// or none) still exposed in every OTHER apostrophe-literal regex, including
// several that are the exact enforcement mechanism behind the SAME night's
// N1/S3 money fixes.
//
// FIX: turn-engine-runner.ts's runTurnEngineTurn now normalizes the
// customer's message ONCE, at the boundary where index.ts (frozen/legacy)
// hands the raw inbound SMS text in as RunTurnInput.message — before any
// regex in turn-engine.ts (or any other module downstream of the runner)
// ever sees it. See runTurnEngineTurn's own header for the two literal-
// preservation exceptions (PROPOSE's error-log write, the guard-deny
// error-log write) that deliberately keep reading `rawInput.message`
// instead.
//
// Below: three of the real apostrophe-literal regexes this exposed,
// verified against the CURRENT file (not the PO relay's own grep pass,
// which the dispatch itself warned may have drifted) —
//   1. TIP_DECLINE_ANYWHERE_RE (readTipReply, "tip" case) — "I don't want a
//      tip" is the P0 tip-decline fixture from tonight's own
//      tip-step-p0-20260919.test.ts.
//   2. SLOT_ITEM_REJECTION_CUES / NEGATED_DECLINE_VERB_RE
//      (isNamedSlotItemRejection, "slot" case) — the exact N1 real-live
//      conversation (624967ed #16, $55.48 -> $15.50 money bug) from
//      dont-forget-slot-answer-20260919.test.ts.
//   3. CONFIRM_NEGATION_RE (isConfirmAffirmative, "confirm" case) — "don't
//      confirm yet" is one of confirm-gate-20260917.test.ts's own existing
//      straight-apostrophe fixtures ("anything hesitant, negated or
//      corrective must NOT place the order").
//
// A fourth regex the dispatch also named, UPSELL_DECLINE_IDIOM_RE's
// `i'?m\s+good`/`we'?re\s+good` alternatives (the literal S3 "I'm good for
// drinks" idiom) — VERIFIED EMPIRICALLY (via decide() directly, both
// apostrophe forms) to make NO observable difference to
// removeHasRemovalLanguage's outcome for that exact message: the "no
// thanks" alternative (no apostrophe at all) already strips the bare "no"
// that would otherwise trip HARD_REMOVAL_VERBS, regardless of whether
// "i'm good" is also stripped, and none of HARD_REMOVAL_VERBS/
// SOFT_CORRECTION_VERBS overlaps textually with "i'm"/"good"/"we're" — so
// stripping that idiom or not never changes the verb check either way. The
// PO relay's own hypothesis ("a curly 'I'm good' would not be stripped,
// meaning S3's exact fix could fail") does not hold up against the current
// file; the S3 money fix is protected by an apostrophe-free alternative,
// not this one. Covered below anyway as a non-regression check: the real
// S3 conversation shape resolves identically (Pierogies kept, no phantom
// Mozzarella Sticks) whether "we're good" arrives straight or curly.
//
// REQUIRED METHODOLOGY: every test below drives the real
// turn-engine-runner.ts runTurnEngineTurn — the same call path index.ts's
// turn_engine_enabled branch actually uses — never decide()/answer() called
// directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
  type RunTurnShopContext,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

function makeFakeSupabase(lexiconRows: Array<Record<string, unknown>> = []) {
  const state = { orderCartsUpdates: [] as Array<Record<string, unknown>> };
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? lexiconRows : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in() { return Promise.resolve({ data: [], error: null }); },
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

const SHOP_CONTEXT: RunTurnShopContext = {
  deliveryEnabled: true, orderType: "delivery", deliveryAddressKnown: true,
  driverTipCents: null, pickupName: null, deliveryFeeCents: 499,
};

// ── 1. TIP_DECLINE_ANYWHERE_RE (readTipReply, "tip" case) ──────────────────

const BURGER_ID = "curly-tip-burger";
const TIP_MENU: TurnEngineMenuItem[] = [
  { id: BURGER_ID, name: "Cheese Burger", category: "Burgers", price_cents: 849, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849, recap_template: "", ticket_template: "", steps: [] } },
];
function burgerCart(): TurnEngineCartLine[] {
  return [{ menu_item_id: BURGER_ID, name: "Cheese Burger", quantity: 1, price_cents: 849, modifiers: [] } as unknown as TurnEngineCartLine];
}
const TIP_OPEN_STATE: DialogueState = { phase: "tip", open: { kind: "tip" }, upsell_offered: false, asked_message_id: null };

for (const [label, apostrophe] of [["straight", "'"], ["curly", "’"]] as const) {
  Deno.test(`TIP_DECLINE_ANYWHERE_RE (${label} apostrophe): "I don${apostrophe}t want a tip" resolves as a tip decline, never reaches PROPOSE`, async () => {
    const { supabase, state } = makeFakeSupabase();
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key",
      proposeTurnFn: () => Promise.reject(new Error("PROPOSE must never be called — tip decline resolves deterministically")),
    };
    const input: RunTurnInput = {
      conversationId: "conv-tip-curly", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
      message: `No, I don${apostrophe}t want a tip`,
      history: [], menu: TIP_MENU, cart: burgerCart(), dialogueState: TIP_OPEN_STATE,
      shopContext: SHOP_CONTEXT,
    };
    const result = await runTurnEngineTurn(input, deps);
    const lastUpdate = state.orderCartsUpdates.at(-1);
    assertEquals(lastUpdate?.driver_tip_cents, 0, `tip decline must zero the tip, never leave it unresolved: ${JSON.stringify(lastUpdate)}`);
    assert(result.dialogueState.open?.kind !== "tip", `tip question must not still be open after a clear decline: ${JSON.stringify(result.dialogueState.open)}`);
  });
}

// ── 2. SLOT_ITEM_REJECTION_CUES / NEGATED_DECLINE_VERB_RE ───────────────────
// (isNamedSlotItemRejection, "slot" case) — real conv 624967ed #16.

const BUFFALO_ID = "curly-buffalo-chicken-med";
const GLUTEN_FREE_ID = "curly-gluten-free-med";
const DRESSING_GROUP_ID = "curly-buffalo-dressing-group";
const BUFFALO_LINE_KEY = "line-buffalo-1";
const GLUTEN_FREE_LINE_KEY = "line-gf-1";

const N1_MENU: TurnEngineMenuItem[] = [
  {
    id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", category: "Pizza", price_cents: 1999,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Medium Buffalo Chicken Pizza", base_price_cents: 1999,
      recap_template: "", ticket_template: "",
      steps: [
        { kind: "slot", ask_mode: "ask", group_id: DRESSING_GROUP_ID, slot_key: "dressing", prompt_template: "dressing.ask",
          choices: [
            { id: "dressing-bleu-cheese", display: "Bleu Cheese", price_delta_cents: 0 },
            { id: "dressing-ranch", display: "Ranch", price_delta_cents: 0 },
          ] },
      ],
    },
  },
  { id: GLUTEN_FREE_ID, name: "Medium Gluten-Free Pizza", category: "Pizza", price_cents: 1550, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Medium Gluten-Free Pizza", base_price_cents: 1550, recap_template: "", ticket_template: "", steps: [] } },
];
function n1CartBefore(): TurnEngineCartLine[] {
  return [
    { menu_item_id: BUFFALO_ID, name: "Medium Buffalo Chicken Pizza", quantity: 2, price_cents: 1999, modifiers: [], line_key: BUFFALO_LINE_KEY, ask_plan_selections: {} } as unknown as TurnEngineCartLine,
    { menu_item_id: GLUTEN_FREE_ID, name: "Medium Gluten-Free Pizza", quantity: 1, price_cents: 1550, modifiers: [], line_key: GLUTEN_FREE_LINE_KEY } as unknown as TurnEngineCartLine,
  ];
}
const DRESSING_SLOT_STATE: DialogueState = {
  phase: "ordering", open: { kind: "slot", line_key: BUFFALO_LINE_KEY, group_id: DRESSING_GROUP_ID },
  upsell_offered: false, asked_message_id: null,
};

for (const [label, apostrophe] of [["straight", "'"], ["curly", "’"]] as const) {
  Deno.test(`N1 (${label} apostrophe, real conv 624967ed #16): "Don${apostrophe}t forget the Medium Gluten-Free Pizza too" never removes the Buffalo Chicken line`, async () => {
    const { supabase } = makeFakeSupabase();
    let proposeCalls = 0;
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => {
        proposeCalls++;
        return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
      },
    };
    const input: RunTurnInput = {
      conversationId: "conv-624967ed-curly", shopId: "shop-1", tenantId: "shop-1", cartId: "cart-1",
      message: `I${apostrophe}d like ranch with the Buffalo Chicken pizzas, please! Don${apostrophe}t forget the Medium Gluten-Free Pizza too.`,
      history: [], menu: N1_MENU, cart: n1CartBefore(), dialogueState: DRESSING_SLOT_STATE,
      shopContext: SHOP_CONTEXT,
    };
    const result = await runTurnEngineTurn(input, deps);
    assertEquals(proposeCalls, 0, "the dressing slot answer must resolve deterministically, never reaching PROPOSE");
    const buffalo = result.cart.find(l => l.menu_item_id === BUFFALO_ID);
    const glutenFree = result.cart.find(l => l.menu_item_id === GLUTEN_FREE_ID);
    assert(buffalo, `Buffalo Chicken Pizza line must NOT be removed: ${JSON.stringify(result.cart)}`);
    assert(glutenFree, `Gluten-Free Pizza line must still be present: ${JSON.stringify(result.cart)}`);
    assertEquals(buffalo!.quantity, 2, "quantity must stay at 2");
    assert(!/removed/i.test(result.reply), `reply must never say anything was removed: ${JSON.stringify(result.reply)}`);
  });
}

// ── 3. CONFIRM_NEGATION_RE (isConfirmAffirmative, "confirm" case) ──────────
// "don't confirm yet" is one of confirm-gate-20260917.test.ts's own
// existing straight-apostrophe fixtures for "must NOT place the order".

const PIZZA_ID = "curly-confirm-pizza";
const CONFIRM_MENU: TurnEngineMenuItem[] = [
  { id: PIZZA_ID, name: "Cheese Pizza", category: "Pizza", price_cents: 1200, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: "Cheese Pizza", base_price_cents: 1200, recap_template: "", ticket_template: "", steps: [] } },
];
function confirmCart(): TurnEngineCartLine[] {
  return [{ menu_item_id: PIZZA_ID, name: "Cheese Pizza", quantity: 1, price_cents: 1200, modifiers: [] } as unknown as TurnEngineCartLine];
}
const CONFIRM_OPEN_STATE: DialogueState = { phase: "ordering", open: { kind: "confirm" }, upsell_offered: false, asked_message_id: null };

for (const [label, apostrophe] of [["straight", "'"], ["curly", "’"]] as const) {
  Deno.test(`CONFIRM_NEGATION_RE (${label} apostrophe): "Yes, don${apostrophe}t confirm yet" must never place the order — falls to PROPOSE, not a false confirm_yes`, async () => {
    const { supabase } = makeFakeSupabase();
    let proposeCalls = 0;
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key",
      proposeTurnFn: (): Promise<ProposeResult> => {
        proposeCalls++;
        return Promise.resolve({ ok: true, attempts: 1, proposal: { intent: "order", adds: [], removes: [], modifies: [] } });
      },
    };
    const input: RunTurnInput = {
      conversationId: "conv-confirm-curly", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
      message: `Yes, don${apostrophe}t confirm yet`,
      history: [], menu: CONFIRM_MENU, cart: confirmCart(), dialogueState: CONFIRM_OPEN_STATE,
      shopContext: SHOP_CONTEXT,
    };
    const result = await runTurnEngineTurn(input, deps);
    assertEquals(proposeCalls, 1, "a negated 'yes' must be UNRESOLVED by deterministic ANSWER and fall to PROPOSE, never short-circuit as a false confirm_yes");
    assert(!/order (?:is )?(?:placed|confirmed)/i.test(result.reply), `must never tell the customer the order was placed/confirmed: ${JSON.stringify(result.reply)}`);
  });
}

// ── 4. UPSELL_DECLINE_IDIOM_RE non-regression (real conv 22347973, S3) ─────
// See this file's own header: verified empirically that this exact idiom's
// apostrophe handling makes no observable difference for this message —
// covered here as a non-regression check, not a fails-then-passes proof.

const PIEROGIES_ID = "curly-s3-pierogies";
const ONION_RINGS_ID = "curly-s3-onion-rings";
const COKE_ID = "curly-s3-coke";
const MOZZARELLA_STICKS_ID = "curly-s3-mozzarella-sticks";

function s3Item(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return { id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: { compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [] } };
}
const S3_MENU: TurnEngineMenuItem[] = [
  s3Item(PIEROGIES_ID, "Pierogies", "Appetizers", 899),
  s3Item(ONION_RINGS_ID, "Onion Rings", "Appetizers", 599),
  s3Item(COKE_ID, "Coke", "Drinks", 199),
  s3Item(MOZZARELLA_STICKS_ID, "Mozzarella Sticks (6)", "Appetizers", 899),
];
const S3_LEXICON = [
  { term: "pierogies", target_id: PIEROGIES_ID, category: "Appetizers", size_label: null },
  { term: "onion rings", target_id: ONION_RINGS_ID, category: "Appetizers", size_label: null },
  { term: "coke", target_id: COKE_ID, category: "Drinks", size_label: null },
  { term: "mozzarella sticks", target_id: MOZZARELLA_STICKS_ID, category: "Appetizers", size_label: null },
  { term: "sticks", target_id: MOZZARELLA_STICKS_ID, category: "Appetizers", size_label: null },
];
const PIEROGIES_LINE_KEY = "line-pierogies";
const ONION_RINGS_LINE_KEY = "line-onion-rings";
function s3CartBeforeDecline(): TurnEngineCartLine[] {
  return [
    { menu_item_id: PIEROGIES_ID, name: "Pierogies", quantity: 1, price_cents: 899, modifiers: [], line_key: PIEROGIES_LINE_KEY },
    { menu_item_id: ONION_RINGS_ID, name: "Onion Rings", quantity: 1, price_cents: 599, modifiers: [], line_key: ONION_RINGS_LINE_KEY },
  ];
}
const S3_UPSELL_OPEN_STATE: DialogueState = {
  phase: "ordering", open: { kind: "upsell", menu_item_id: COKE_ID },
  upsell_offered: true, asked_message_id: null, openRepeatCount: 0,
};

for (const [label, apostrophe] of [["straight", "'"], ["curly", "’"]] as const) {
  Deno.test(`UPSELL_DECLINE_IDIOM_RE non-regression (${label} apostrophe, real conv 22347973): "we${apostrophe}re good on drinks, but stick with those two items" never removes Pierogies or adds Mozzarella Sticks`, async () => {
    const { supabase } = makeFakeSupabase(S3_LEXICON);
    let proposeCalls = 0;
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: (): Promise<ProposeResult> => {
        proposeCalls++;
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: {
            intent: "order",
            adds: [{ item_span: "Onion Rings", quantity: 1, choices: [] }],
            removes: [{ line_key: PIEROGIES_LINE_KEY }],
            modifies: [],
          },
        });
      },
    };
    const input: RunTurnInput = {
      conversationId: "conv-22347973-curly", shopId: "s3-shop", tenantId: "s3-shop", cartId: "cart-repro",
      message: `No thanks, we${apostrophe}re good on drinks, but stick with those two items for pickup!`,
      history: [], menu: S3_MENU, cart: s3CartBeforeDecline(), dialogueState: S3_UPSELL_OPEN_STATE,
      shopContext: { deliveryEnabled: true, orderType: "pickup", deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
    };
    const result = await runTurnEngineTurn(input, deps);
    assertEquals(proposeCalls, 1, "this message carries trailing text and no closure phrase, so PROPOSE must still run");
    const pierogies = result.cart.find(l => l.menu_item_id === PIEROGIES_ID);
    assert(pierogies, `Pierogies must never be removed by a drink decline: ${JSON.stringify(result.cart)}`);
    assert(!result.cart.some(l => l.menu_item_id === MOZZARELLA_STICKS_ID), `Mozzarella Sticks must never appear: ${JSON.stringify(result.cart)}`);
  });
}
