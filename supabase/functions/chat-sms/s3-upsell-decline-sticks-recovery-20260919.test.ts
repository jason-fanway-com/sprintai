// PO dispatch (2026-09-19), REAL LIVE MONEY BUG, codename "S3 — sticks are
// back" (real conv 22347973, error_log). Customer ordered Pierogies + Onion
// Rings for pickup. The bot offered a Coke upsell. Customer declined:
//
//   "No thanks, I'm good for drinks. Just stick with those two items for
//   pickup!"
//
// TWO things went wrong on that one turn, both real money:
//
//   1. PROPOSE's own proposal hallucinated adds:[Onion Rings] (a duplicate —
//      already in the cart) and removes:[the Pierogies line]. A customer
//      declining a drink upsell is never asking to remove pierogies from
//      their cart, but the remove-guard (removeHasRemovalLanguage,
//      turn-engine.ts) let it through anyway — REMOVAL_VERBS' bare "no"
//      entry fired off the "no" inside "No thanks", a decline-of-offer
//      idiom, not a genuine item negation. The Pierogies line was deleted
//      from a real, already-placed order.
//   2. The Onion Rings add got correctly guard-dropped (itemSpanNamedInMessage:
//      "onion"/"ring" don't appear in THIS turn's message) and, being
//      already in the cart, was read as "stale" — triggering decide()'s own
//      raw-message recovery pass (resolveItem(customerMessage, ...)) to look
//      for whatever new item the model might have missed. That pass's fuzzy
//      fallback was still enabled with no anchor requirement, so the single
//      stray word "stick" (from "...Just stick with those two items...")
//      fuzzy-matched the shop's real one-word term "sticks" (Mozzarella
//      Sticks) and silently added $8.99 nobody ordered — the exact same
//      "stick"/"sticks" false-positive class fuzzyCorrectAgainstLexicon was
//      deleted for once already tonight, reintroduced here at a different
//      call site by the cff7a12d merge.
//
// Net real result: Pierogies silently vanished from a paid order, $8.99 of
// Mozzarella Sticks got silently added instead. Both fixed in turn-engine.ts:
//   - removeHasRemovalLanguage strips a recognized decline-of-offer idiom
//     ("no thanks"/"i'm good"/...) before checking for a removal verb, so
//     "no" inside "No thanks" never counts as removal language on its own.
//   - the two decide() recovery passes that feed raw/derived customer text
//     into resolveItem with no model participation now require
//     fuzzyMinTermWords: 2 — a fuzzy guess must be corroborated by at least
//     one other word in the SAME multi-word term (e.g. "pizza"/"pizzas"
//     completing an already-exact "pepperoni pizza" match); a bare
//     single-word term like "sticks" can never resolve purely off a fuzzy
//     guess with nothing else to corroborate it.
//
// REQUIRED METHODOLOGY (per PO dispatch): neither of tonight's offline
// probes reaches the upsell-open state, so acceptance here is runner-level —
// this test drives runTurnEngineTurn (turn-engine-runner.ts), the same call
// path index.ts's turn_engine_enabled branch actually uses, with a real
// upsell-open DialogueState and a mocked PROPOSE response matching the real
// captured shape (adds:[Onion Rings], removes:[Pierogies line]).
//
// True live acceptance via convo.sh against the real deployed endpoint is
// NOT run here: convo.sh (~/po-scratch/convo.sh) posts to the currently
// DEPLOYED chat-sms function over HTTPS — it exercises whatever code is live
// on Supabase right now, not this uncommitted worktree branch. Running it
// before this branch is deployed would only reproduce the RED (pre-fix)
// behavior against a real production shop/conversation row, proving nothing
// about this fix and mutating real prod state for no benefit. That live
// acceptance pass is still owed, by whoever deploys this branch, once it
// merges to main.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const PIEROGIES_ID = "s3-pierogies";
const ONION_RINGS_ID = "s3-onion-rings";
const COKE_ID = "s3-coke";
const MOZZARELLA_STICKS_ID = "s3-mozzarella-sticks";

function realItem(id: string, name: string, category: string, priceCents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents: priceCents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name, base_price_cents: priceCents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  realItem(PIEROGIES_ID, "Pierogies", "Appetizers", 899),
  realItem(ONION_RINGS_ID, "Onion Rings", "Appetizers", 599),
  realItem(COKE_ID, "Coke", "Drinks", 199),
  realItem(MOZZARELLA_STICKS_ID, "Mozzarella Sticks (6)", "Appetizers", 899),
];

// Real Vito's-shape lexicon rows: "sticks" active as a standalone one-word
// term for Mozzarella Sticks (exactly the term the live shop carries, and
// exactly what "stick" fuzzy-matched) alongside its own two-word term.
const LEXICON = [
  { term: "pierogies", target_id: PIEROGIES_ID, category: "Appetizers", size_label: null },
  { term: "onion rings", target_id: ONION_RINGS_ID, category: "Appetizers", size_label: null },
  { term: "coke", target_id: COKE_ID, category: "Drinks", size_label: null },
  { term: "mozzarella sticks", target_id: MOZZARELLA_STICKS_ID, category: "Appetizers", size_label: null },
  { term: "sticks", target_id: MOZZARELLA_STICKS_ID, category: "Appetizers", size_label: null },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-22347973-repro",
    shopId: "s3-shop",
    tenantId: "s3-shop",
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
      driverTipCents: null,
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

// The upsell-open state: Coke was just offered after the qualifying add, not
// yet accepted or declined — the exact real conversation shape at the point
// the customer's decline message arrives.
const PIEROGIES_LINE_KEY = "line-pierogies";
const ONION_RINGS_LINE_KEY = "line-onion-rings";

function cartBeforeDecline(): TurnEngineCartLine[] {
  return [
    { menu_item_id: PIEROGIES_ID, name: "Pierogies", quantity: 1, price_cents: 899, modifiers: [], line_key: PIEROGIES_LINE_KEY },
    { menu_item_id: ONION_RINGS_ID, name: "Onion Rings", quantity: 1, price_cents: 599, modifiers: [], line_key: ONION_RINGS_LINE_KEY },
  ];
}

const UPSELL_OPEN_STATE: DialogueState = {
  phase: "ordering",
  open: { kind: "upsell", menu_item_id: COKE_ID },
  upsell_offered: true, asked_message_id: null, openRepeatCount: 0,
};

// Not the PO's own verbatim quote ("No thanks, I'm good for drinks. Just
// stick with those two items for pickup!") — that exact wording, checked
// directly against answer()'s "upsell" case, is intercepted BEFORE PROPOSE
// ever runs by a separate, already-shipped, unrelated fix (impliesClosure's
// CLOSURE_ANYWHERE_RE, conv ae0eb19b): "I'm good" is itself one of that
// guard's own closure phrases, and a closure resolution never touches the
// cart, so the PO's exact literal phrasing no longer reaches decide() at
// all on current HEAD -- it happens to be accidentally safe already, for a
// completely unrelated reason, and asserting against it here would not
// exercise this fix. Swapped "I'm good for drinks" for "on the drink" --
// same decline-of-upsell meaning, same literal "No thanks" removal-language
// false-positive, same "stick" fuzzy-recovery false-positive, still the
// real captured PROPOSE shape below -- but it clears CLOSURE_ANYWHERE_RE so
// the turn genuinely reaches PROPOSE, matching the real conversation's own
// propose_success row and giving this test something to actually prove.
const DECLINE_MESSAGE = "No thanks on the drink — just stick with those two items for pickup!";

Deno.test("runTurnEngineTurn (S3, real conv 22347973): declining the Coke upsell never removes Pierogies and never adds Mozzarella Sticks", async () => {
  const { supabase } = makeFakeSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    // Real error_log proposal shape for this turn: a duplicate Onion Rings
    // add (already in cart) and a hallucinated remove of the Pierogies line.
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
  const result = await runTurnEngineTurn(
    baseInput({ message: DECLINE_MESSAGE, cart: cartBeforeDecline(), dialogueState: UPSELL_OPEN_STATE }),
    deps,
  );
  assertEquals(proposeCalls, 1, "neither the anchored bare-decline check nor the closure shortcut matches this message (it carries trailing text and no closure phrase), so PROPOSE must still run — matching the real conversation's own propose_success row");

  assertEquals(result.cart.length, 2, `final cart must be exactly Pierogies + Onion Rings, nothing else: ${JSON.stringify(result.cart)}`);
  const pierogies = result.cart.find(l => l.menu_item_id === PIEROGIES_ID);
  const onionRings = result.cart.find(l => l.menu_item_id === ONION_RINGS_ID);
  assert(pierogies, `Pierogies must never be removed by a drink decline: ${JSON.stringify(result.cart)}`);
  assert(onionRings, `Onion Rings must still be in the cart: ${JSON.stringify(result.cart)}`);
  assertEquals(pierogies!.quantity, 1);
  assertEquals(onionRings!.quantity, 1);
  assert(
    !result.cart.some(l => l.menu_item_id === MOZZARELLA_STICKS_ID),
    `Mozzarella Sticks must never appear — "stick" is not an order: ${JSON.stringify(result.cart)}`,
  );
  assert(!/mozzarella|sticks/i.test(result.reply), `reply must never mention Mozzarella Sticks: ${JSON.stringify(result.reply)}`);
});
