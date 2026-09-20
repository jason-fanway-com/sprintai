// Dispatch 00-AT (500-conversation adversarial sim, dominant defect —
// question asked 3+ times 246/500, item asked about and never added
// 148/500, item in cart the customer never typed 46/500). One behaviour,
// three property failures: while a disambiguation or a required slot
// question is open, ANSWER's own resolver already gets first crack at the
// customer's next message; before this fix, a miss there fell straight
// through to PROPOSE, which re-reads the FULL cart+history context every
// time and re-adds/re-sums whatever is already fully resolved there
// (conv 8b9636c9's California Cheesesteak: 2 -> 4 -> 6 -> 12) while the
// item the open question was actually about never enters the cart at all.
//
// The fix (turn-engine-runner.ts): while `priorState.open.kind` is "slot"
// or "disambiguation" and ANSWER cannot resolve the message (including its
// own closure/affirmation backstop), PROPOSE is never consulted — the SAME
// question is re-asked, the cart is not mutated. Paired with a strengthened
// `resolvePendingDisambiguation` (pending-disambiguation.ts) that now also
// matches on a candidate's own NAME/display_name words, not category alone
// — category is frequently identical across every candidate a
// disambiguation offers (three pizza sizes are all "Pizza"; a soup's Bowl
// and Cup are the same category), so naming the actual distinguishing word
// ("Medium", "the bowl") used to fall through every tier and never resolve.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runTurnEngineTurn, type RunTurnDeps, type RunTurnInput, type RunTurnShopContext } from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// ── Fake Supabase — same minimal shape turn-engine-runner.test.ts uses ─────
function makeFakeSupabase(lexicon: Array<{ term: string; target_id: string }>) {
  const orderCartsUpdates: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  function builder(table: string): any {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? lexicon : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      update(row: Record<string, unknown>) {
        if (table === "order_carts") orderCartsUpdates.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert() {
        // Support both `await ...insert(r)` (plain-await callers) and
        // `await ...insert(r).select("id").single()` (persistTurn/saveMessage).
        return {
          select: (_cols: unknown) => ({
            single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }),
          }),
          then(resolve: (v: { error: null }) => void, reject?: (e: unknown) => void) {
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { supabase: { from: (t: string) => builder(t) } as any, orderCartsUpdates };
}

const SHOP_CONTEXT: RunTurnShopContext = {
  deliveryEnabled: false, orderType: "pickup", deliveryAddressKnown: false,
  driverTipCents: null, pickupName: "Jason", deliveryFeeCents: null,
};

// ── Fixture: conv 8b9636c9's real shape — California Cheesesteak (resolves
// uniquely, no required options — Bread is left out of this fixture on
// purpose, it's a separate, already-working slot-resolution path exercised
// elsewhere) and three same-category Jack's Special sizes that tie on the
// bare lexicon term "jacks special", exactly like the real Vito's menu tied
// on the bare term across three pizza sizes. ──────────────────────────────

const CHEESESTEAK_ID = "california-cheesesteak";
const JACKS_MEDIUM_ID = "jacks-special-medium";
const JACKS_LARGE_ID = "jacks-special-large";
const JACKS_SMALL_ID = "jacks-special-small";

function noStepsAskPlan(displayName: string, priceCents: number) {
  return { compiled_at: "", compiler_version: 1, display_name: displayName, base_price_cents: priceCents, recap_template: "", ticket_template: "", steps: [] };
}

const CHEESESTEAK_MENU: TurnEngineMenuItem[] = [
  { id: CHEESESTEAK_ID, name: "California Cheesesteak", category: "Sandwiches", price_cents: 1199, bot_state: "orderable", ask_plan: noStepsAskPlan("California Cheesesteak", 1199) },
  { id: JACKS_MEDIUM_ID, name: "Jack's Special - Medium (14\")", category: "Pizza", price_cents: 2199, bot_state: "orderable", ask_plan: noStepsAskPlan("Jack's Special - Medium (14\")", 2199) },
  { id: JACKS_LARGE_ID, name: "Jack's Special - Large (16\")", category: "Pizza", price_cents: 2499, bot_state: "orderable", ask_plan: noStepsAskPlan("Jack's Special - Large (16\")", 2499) },
  { id: JACKS_SMALL_ID, name: "Jack's Special - Small (10\")", category: "Pizza", price_cents: 1295, bot_state: "orderable", ask_plan: noStepsAskPlan("Jack's Special - Small (10\")", 1295) },
];

const CHEESESTEAK_LEXICON = [
  { term: "california cheesesteak", target_id: CHEESESTEAK_ID },
  // Bare "jack s special" (resolve-item.ts's normalize() strips the
  // apostrophe to a space) ties all three sizes at the same longest match —
  // the real Vito's shape. PO dispatch 2026-09-19 (M1 rule 2, REOPENED,
  // conv d95306c8 #26): turn 0's customer message below deliberately
  // withholds the size ("2 Jack's Special", not "2 Jack's Special -
  // Medium") — a message that DOES state the size right next to the item's
  // own name now resolves it directly via narrowAmbiguousCandidatesBySpanSize
  // (turn-engine.ts), the exact fix this dispatch shipped, so it would no
  // longer reach this file's own disambiguation-open scenario at all. This
  // fixture still needs a genuine, unresolvable-without-asking tie to
  // exercise the ANSWER-priority-over-PROPOSE protection below, so the size
  // is now supplied only in turn 1's answer, never in turn 0's proposal.
  { term: "jack s special", target_id: JACKS_MEDIUM_ID },
  { term: "jack s special", target_id: JACKS_LARGE_ID },
  { term: "jack s special", target_id: JACKS_SMALL_ID },
];

function cheesesteakLine(quantity: number): TurnEngineCartLine {
  return { menu_item_id: CHEESESTEAK_ID, name: "California Cheesesteak", quantity, price_cents: 1199, modifiers: [] };
}

function distinctMenuItemIds(cart: TurnEngineCartLine[]): string[] {
  return [...new Set(cart.filter(l => typeof l.menu_item_id === "string").map(l => l.menu_item_id))];
}

function assertOneLinePerItem(cart: TurnEngineCartLine[], label: string) {
  const ids = cart.filter(l => typeof l.menu_item_id === "string").map(l => l.menu_item_id);
  assertEquals(ids.length, new Set(ids).size, `${label}: exactly one line per distinct item, got: ${JSON.stringify(cart)}`);
}

Deno.test("RED->GREEN (conv 8b9636c9): while the Jack's Special disambiguation is open, restating the order never re-adds California Cheesesteak, and naming 'Medium' resolves the pizza without ever consulting PROPOSE", async () => {
  const { supabase, orderCartsUpdates } = makeFakeSupabase(CHEESESTEAK_LEXICON);
  let proposeCalls = 0;

  const deps: RunTurnDeps = {
    supabase,
    apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeCalls === 1) {
        // Turn 0: the customer's real first order. This is the one turn in
        // the whole transcript PROPOSE may ever be called on.
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: {
            intent: "order",
            adds: [
              // No size stated here — see CHEESESTEAK_LEXICON's own header
              // (M1 rule 2, REOPENED) for why this fixture withholds it.
              { item_span: "Jack's Special", quantity: 2, choices: [] },
              { item_span: "California Cheesesteak", quantity: 2, choices: [] },
            ],
            removes: [], modifies: [],
          },
        });
      }
      // Every later PROPOSE call in this test is a bug by construction: the
      // whole point of the fix is that none of turns 1-3 below ever reach
      // here (their message is answered, or the open disambiguation blocks
      // PROPOSE outright). If this ever fires again, fail loudly rather
      // than silently returning a plausible-looking proposal that could
      // mask the regression.
      return Promise.reject(new Error(`PROPOSE must not be called again — this is call ${proposeCalls}`));
    },
  };

  function turn(message: string, cart: TurnEngineCartLine[], dialogueState: DialogueState | null) {
    const input: RunTurnInput = {
      conversationId: "conv-8b9636c9", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
      message, history: [], menu: CHEESESTEAK_MENU, cart, dialogueState, shopContext: SHOP_CONTEXT,
    };
    return runTurnEngineTurn(input, deps);
  }

  // ── Turn 0: the full order, Jack's Special ties ambiguous, Cheesesteak resolves ──
  const r0 = await turn("Hey! I'd like to order 2 Jack's Special with pepperoni on the whole pizza and onions on half. Also, 2 California Cheesesteaks. Thanks!", [], null);
  assertEquals(r0.cart.filter(l => l.menu_item_id === CHEESESTEAK_ID)[0]?.quantity, 2, "turn 0: Cheesesteak enters at exactly the quantity asked for");
  assertOneLinePerItem(r0.cart, "turn 0");
  assertEquals(r0.dialogueState.open?.kind, "disambiguation", `turn 0 must open the Jack's Special disambiguation, got: ${JSON.stringify(r0.dialogueState.open)}`);
  assertEquals(proposeCalls, 1);

  // ── Turn 1: "I want 2x Jack's Special - Medium (14")." — this is the
  // exact message that, against un-fixed resolvePendingDisambiguation,
  // matched no category (all three candidates are "Pizza"), no ordinal, no
  // price, and fell through to PROPOSE — which is where conv 8b9636c9's
  // Cheesesteak first grew from 2 to 4. Fixed: the NAME tier resolves
  // "Medium" against the one candidate whose own name contains it. ────────
  const r1 = await turn("I want 2x Jack's Special - Medium (14\").", r0.cart, r0.dialogueState);
  assertEquals(proposeCalls, 1, "turn 1: PROPOSE must NOT be consulted — the disambiguation resolves deterministically");
  assertEquals(r1.cart.find(l => l.menu_item_id === CHEESESTEAK_ID)?.quantity, 2, "turn 1: California Cheesesteak must never exceed the quantity actually asked for");
  assert(r1.cart.some(l => l.menu_item_id === JACKS_MEDIUM_ID), "turn 1: the Jack's Special enters the cart once the customer names the Medium");
  assertEquals(r1.cart.some(l => l.menu_item_id === JACKS_LARGE_ID || l.menu_item_id === JACKS_SMALL_ID), false, "turn 1: no line for a size the customer never named");
  assertOneLinePerItem(r1.cart, "turn 1");

  // ── Turns 2-3: pure restatements ("I still want the 2x Jack's Special -
  // Medium. Thanks!", repeated) after the disambiguation has already
  // closed. Nothing new is being asked for, so a reasonable model reports
  // nothing to add — this proves DECIDE/ASK stay inert on a no-op proposal,
  // not that PROPOSE itself would always behave this well (that's PROPOSE's
  // own prompt-quality question, explicitly out of this dispatch's scope).
  proposeCalls = 0;
  const emptyProposal: ProposeResult = { ok: true, attempts: 1, proposal: { intent: "other", adds: [], removes: [], modifies: [] } };
  deps.proposeTurnFn = () => { proposeCalls++; return Promise.resolve(emptyProposal); };

  let cart = r1.cart;
  let state = r1.dialogueState;
  for (const msg of ["I still want the 2x Jack's Special - Medium (14\"). Thanks!", "I still want the 2x Jack's Special - Medium (14\"). Thanks!"]) {
    const r = await turn(msg, cart, state);
    assertEquals(r.cart.find(l => l.menu_item_id === CHEESESTEAK_ID)?.quantity, 2, `restatement turn: Cheesesteak must never exceed 2, got cart: ${JSON.stringify(r.cart)}`);
    assertEquals(r.cart.filter(l => l.menu_item_id === JACKS_MEDIUM_ID).length, 1, "restatement turn: still exactly one Jack's Special Medium line");
    assertOneLinePerItem(r.cart, "restatement turn");
    assert(!r.cart.some(l => l.name === "Pepperoni"), "restatement turn: no phantom 'Pepperoni' line the customer never typed as its own item");
    cart = r.cart;
    state = r.dialogueState;
  }

  assertEquals(orderCartsUpdates.length, 4, "one persisted update per turn (0-3), matching the 4 assertions above");
});

Deno.test("a message that cannot answer an open disambiguation re-asks it once and leaves the cart untouched (never reaches PROPOSE)", async () => {
  const { supabase } = makeFakeSupabase(CHEESESTEAK_LEXICON);
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("PROPOSE must never be called")); },
  };
  const openState: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [JACKS_MEDIUM_ID, JACKS_LARGE_ID, JACKS_SMALL_ID] },
    upsell_offered: false, asked_message_id: null,
  };
  const cartBefore = [cheesesteakLine(2)];
  const input: RunTurnInput = {
    conversationId: "conv-1", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "Bleu Cheese, Beef", // names neither category, ordinal, price, nor either candidate's distinguishing word
    history: [], menu: CHEESESTEAK_MENU, cart: cartBefore, dialogueState: openState, shopContext: SHOP_CONTEXT,
  };

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "an unanswerable message while a disambiguation is open must never reach PROPOSE");
  assertEquals(result.cart, cartBefore, "the cart must be byte-identical — nothing here answers the open question");
  assertEquals(result.dialogueState.open, openState.open, "the SAME disambiguation, same candidates, must be re-asked");
  assert(result.reply.includes("Jack's Special"), `must re-ask the disambiguation: ${result.reply}`);
});

// ── Synthesized-but-faithful repro of the second sim finding (the exact
// full transcript wasn't captured in the dispatch, only its shape: "a
// customer protesting 'I only want 2 regular slices' had them re-added on
// every complaint, 2 to 12"). Same mechanism as conv 8b9636c9 above, with a
// required SLOT standing in for the disambiguation: a customer who protests
// instead of answering the open question must never see quantity grow. ───

const REGULAR_SLICE_ID = "regular-slice";
const STYLE_GROUP_ID = "slice-style-group";
const GYRO_CHOICE_ID = "slice-style-gyro";

const SLICE_MENU: TurnEngineMenuItem[] = [
  {
    id: REGULAR_SLICE_ID, name: "Regular Slice", category: "Slices", price_cents: 285, bot_state: "orderable",
    option_groups: [{ id: STYLE_GROUP_ID, name: "Style" }],
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Regular Slice", base_price_cents: 285,
      recap_template: "", ticket_template: "",
      steps: [{
        kind: "slot", ask_mode: "ask", group_id: STYLE_GROUP_ID, slot_key: null, prompt_template: "style.ask",
        choices: [
          { id: GYRO_CHOICE_ID, display: "Gyro Meat", price_delta_cents: 150 },
          { id: "slice-style-cheese", display: "Cheese", price_delta_cents: 0 },
        ],
      }],
    },
  },
];
const SLICE_LEXICON = [{ term: "regular slice", target_id: REGULAR_SLICE_ID }, { term: "regular slices", target_id: REGULAR_SLICE_ID }];

function sliceOpenState(lineKey: string): DialogueState {
  return { phase: "ordering", open: { kind: "slot", line_key: lineKey, group_id: STYLE_GROUP_ID }, upsell_offered: false, asked_message_id: null };
}

Deno.test("RED->GREEN (slices repro): protesting instead of answering an open Style slot never regrows quantity, 2 -> 4 -> 6 -> 12", async () => {
  const { supabase } = makeFakeSupabase(SLICE_LEXICON);
  let proposeCalls = 0;

  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: (): Promise<ProposeResult> => {
      proposeCalls++;
      if (proposeCalls === 1) {
        return Promise.resolve({
          ok: true, attempts: 1,
          proposal: { intent: "order", adds: [{ item_span: "regular slices", quantity: 2, choices: [] }], removes: [], modifies: [] },
        });
      }
      // Same discipline as the acceptance test above: any later PROPOSE
      // call in this transcript is exactly the defect being fixed, so it
      // fails loudly rather than modeling what the buggy model actually
      // did (which would just restate the bug in the test itself).
      return Promise.reject(new Error(`PROPOSE must not be called again while the Style slot is open — this is call ${proposeCalls}`));
    },
  };

  const r0 = await runTurnEngineTurn(
    { conversationId: "c1", shopId: "s1", tenantId: "t1", cartId: "cart-1", message: "2 regular slices with gyro meat",
      history: [], menu: SLICE_MENU, cart: [], dialogueState: null, shopContext: SHOP_CONTEXT },
    deps,
  );
  assertEquals(r0.cart.length, 1);
  assertEquals(r0.cart[0].quantity, 2, "turn 0: quantity is exactly what was asked for");
  assert(r0.dialogueState.open?.kind === "slot", `turn 0 must open the Style slot, got: ${JSON.stringify(r0.dialogueState.open)}`);
  assertEquals(proposeCalls, 1);

  let cart = r0.cart;
  let state = r0.dialogueState;
  for (const msg of ["I didn't order anything yet", "I only want 2", "why do I have 6"]) {
    const r = await runTurnEngineTurn(
      { conversationId: "c1", shopId: "s1", tenantId: "t1", cartId: "cart-1", message: msg,
        history: [], menu: SLICE_MENU, cart, dialogueState: state, shopContext: SHOP_CONTEXT },
      deps,
    );
    assertEquals(proposeCalls, 1, `"${msg}": PROPOSE must never be consulted while the Style slot is stuck open`);
    assertEquals(r.cart.length, 1, `"${msg}": no phantom second line`);
    assertEquals(r.cart[0].quantity, 2, `"${msg}": quantity must stay 2, never grow toward 4/6/12`);
    assertEquals(r.cart, cart, `"${msg}": the cart must be byte-identical to before this turn`);
    assertEquals(r.dialogueState.open, state.open, `"${msg}": the SAME Style question must be re-asked`);
    cart = r.cart;
    state = r.dialogueState;
  }
});

Deno.test("a message that cannot answer an open required slot re-asks it once and leaves the cart untouched (never reaches PROPOSE)", async () => {
  const { supabase } = makeFakeSupabase(SLICE_LEXICON);
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key",
    proposeTurnFn: () => { proposeCalls++; return Promise.reject(new Error("PROPOSE must never be called")); },
  };
  const cartBefore: TurnEngineCartLine[] = [
    { menu_item_id: REGULAR_SLICE_ID, name: "Regular Slice", quantity: 2, price_cents: 285, modifiers: [], line_key: "slice-line-1" },
  ];
  const openState = sliceOpenState("slice-line-1");
  const input: RunTurnInput = {
    conversationId: "conv-1", shopId: "shop-1", tenantId: "tenant-1", cartId: "cart-1",
    message: "why do I have 6",
    history: [], menu: SLICE_MENU, cart: cartBefore, dialogueState: openState, shopContext: SHOP_CONTEXT,
  };

  const result = await runTurnEngineTurn(input, deps);

  assertEquals(proposeCalls, 0, "an unanswerable message while a slot is open must never reach PROPOSE");
  assertEquals(result.cart, cartBefore, "the cart must be byte-identical — nothing here answers the open question");
  assertEquals(result.dialogueState.open, openState.open, "the SAME slot question must be re-asked");
  assert(result.reply.length > 0);
});
