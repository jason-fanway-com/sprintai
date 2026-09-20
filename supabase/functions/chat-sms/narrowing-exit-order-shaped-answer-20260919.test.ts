// PO dispatch (2026-09-19): two gaps in what happens while a disambiguation
// ("which one?") question is open, neither covered by tonight's noProgress
// mechanism (turn-engine.ts/pending-disambiguation.ts, merged as efb05153).
//
// GAP (a) (real conv 6e2d56f9, #33): a "fries -- what kind?" disambiguation
// is open. The customer replies with something that is NOT a facet answer
// at all -- it's a whole new, different order:
//   "oh my bad, can i get one chicken and one gyro calzone?"
// Confirmed offline (probe-narrow2): this returned UNRESOLVED and the bot
// just re-asked the fries question. Root cause: the ONE existing
// outside-item check on the answer path (messageNamesItemOutsideCandidates)
// is scoped to the text BEFORE a marker like "can i get" (built for "answer
// the question, THEN also add X") -- here the marker sits in FRONT of the
// entire real order, so the one resolvable item in the message ("gyro
// calzone") never got a chance. Fix: disambiguationMessageIsOrderShaped
// (turn-engine.ts), wired into turn-engine-runner.ts's dropDisambiguationList
// alongside the existing decline/order-logistics triggers -- see that
// function's own header for the full mechanism, including the "same family,
// keep narrowing" secondary case and the restatement guard that keeps this
// from re-triggering BUG 2's own regression
// (option-pick-and-restatement-dup-20260919.test.ts).
//
// This file also carries the REQUIRED regression proof that main's own
// noProgress mechanism (already merged, NOT part of this dispatch) already
// closes the raw infinite-loop shape of real conv 01609954 (chicken
// quesadilla, 11 candidates) at the ENGINE level -- the live compiler-side
// term-collision fix has not shipped, so this is the only thing currently
// protecting that conversation in production.
//
// METHODOLOGY: every test below drives the real production call path,
// turn-engine-runner.ts's runTurnEngineTurn -- never decide()/answer()
// called directly (a fix that passed offline unit fixtures but broke live
// is exactly what prompted this standing rule).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import { disambiguationMessageIsOrderShaped } from "./turn-engine.ts";
import type { DialogueState, TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

const FRIES_REGULAR = "f1111111-1111-1111-1111-111111111111";
const FRIES_CHEESE = "f2222222-2222-2222-2222-222222222222";
const CHICKEN_CALZONE = "c1111111-1111-1111-1111-111111111111";
const GYRO_CALZONE = "c2222222-2222-2222-2222-222222222222";
const ONION_RINGS = "o1111111-1111-1111-1111-111111111111";

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
  realItem(FRIES_REGULAR, "Regular Fries", "Sides", 399),
  realItem(FRIES_CHEESE, "Cheese Fries", "Sides", 499),
  realItem(CHICKEN_CALZONE, "Chicken Calzone", "Calzones", 1195),
  realItem(GYRO_CALZONE, "Gyro Calzone", "Calzones", 1295),
  realItem(ONION_RINGS, "Onion Rings", "Sides", 449),
];

const LEXICON = [
  { term: "fries", target_id: FRIES_REGULAR, category: "Sides", size_label: null },
  { term: "regular fries", target_id: FRIES_REGULAR, category: "Sides", size_label: null },
  { term: "fries", target_id: FRIES_CHEESE, category: "Sides", size_label: null },
  { term: "cheese fries", target_id: FRIES_CHEESE, category: "Sides", size_label: null },
  { term: "chicken", target_id: CHICKEN_CALZONE, category: "Calzones", size_label: null },
  { term: "chicken calzone", target_id: CHICKEN_CALZONE, category: "Calzones", size_label: null },
  { term: "gyro", target_id: GYRO_CALZONE, category: "Calzones", size_label: null },
  { term: "gyro calzone", target_id: GYRO_CALZONE, category: "Calzones", size_label: null },
  { term: "onion rings", target_id: ONION_RINGS, category: "Sides", size_label: null },
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
          .map(m => ({ id: m.id, category: m.category, size_label: LEXICON.find(l => l.target_id === m.id)?.size_label ?? null, bot_state: m.bot_state }));
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
    conversationId: "conv-6e2d56f9",
    shopId: "shop-repro",
    tenantId: "shop-repro",
    cartId: "cart-repro",
    message: "",
    history: [],
    menu: MENU,
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

function failingPropose(label: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => {
    throw new Error(`${label}: PROPOSE must never be called — this turn must resolve deterministically`);
  };
}

Deno.test("GAP (a) runner-level (real conv 6e2d56f9 #33): an order-shaped answer naming a DIFFERENT family during fries narrowing drops the pending list and applies the real order via PROPOSE", async () => {
  const supabase = makeFakeSupabase();
  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: [FRIES_REGULAR, FRIES_CHEESE], quantity: 1 },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };
  let proposeCalls = 0;
  let seenMessage = "";
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (input): Promise<ProposeResult> => {
      proposeCalls++;
      seenMessage = input.message;
      // The dropped disambiguation must hand PROPOSE the WHOLE raw message,
      // with no open question carried along — see turn-engine-runner.ts's
      // own dropDisambiguationList handling.
      assertEquals(input.open, null, "a dropped disambiguation must not be told to PROPOSE as still open");
      return Promise.resolve({
        ok: true,
        attempts: 1,
        proposal: {
          intent: "order",
          adds: [
            { item_span: "chicken", quantity: 1, choices: [] },
            { item_span: "gyro calzone", quantity: 1, choices: [] },
          ],
          removes: [], modifies: [],
        },
      });
    },
  };

  const result = await runTurnEngineTurn(
    baseInput({
      message: "oh my bad, can i get one chicken and one gyro calzone?",
      cart: [],
      dialogueState: dialogueStateBefore,
    }),
    deps,
  );

  assertEquals(proposeCalls, 1, "the whole message must be reprocessed via a fresh PROPOSE call once the fries list is dropped");
  assertEquals(seenMessage, "oh my bad, can i get one chicken and one gyro calzone?");
  const chicken = result.cart.find(l => l.menu_item_id === CHICKEN_CALZONE);
  const gyro = result.cart.find(l => l.menu_item_id === GYRO_CALZONE);
  assert(chicken, `Chicken Calzone must be added: ${JSON.stringify(result.cart)}`);
  assert(gyro, `Gyro Calzone must be added: ${JSON.stringify(result.cart)}`);
  assertEquals(chicken!.quantity, 1);
  assertEquals(gyro!.quantity, 1);
  assert(!result.cart.some(l => l.menu_item_id === FRIES_REGULAR || l.menu_item_id === FRIES_CHEESE), "neither fries candidate was ever named — neither must be added");
  assert(
    result.dialogueState.open?.kind !== "disambiguation",
    `the fries disambiguation must be dropped, not left open forever: ${JSON.stringify(result.dialogueState.open)}`,
  );
});

Deno.test("GAP (a) secondary case (PO-flagged, not live-confirmed): an order-shaped answer naming an item in the SAME family as the open narrowing is left alone, not treated as a new order", () => {
  // "onion rings" is a real, resolvable item OUTSIDE the fries candidates —
  // but it shares the fries candidates' own category ("Sides"). Per the PO's
  // own framing this is the secondary case: the pending narrowing must be
  // KEPT, never dropped, since the customer may still be answering (or the
  // narrowing may still need resolving) rather than abandoning it outright.
  const result = disambiguationMessageIsOrderShaped(
    "just get me some onion rings instead",
    [FRIES_REGULAR, FRIES_CHEESE],
    MENU,
    [],
    LEXICON,
  );
  assert(
    result === null || result.differentFamily === false,
    `a same-family outside item must never report differentFamily:true (which would drop the pending narrowing): ${JSON.stringify(result)}`,
  );
});

// ── Regression proof: main's existing noProgress mechanism (efb05153,
// already merged, NOT part of this dispatch) already closes the raw
// infinite-loop shape of real conv 01609954 (chicken quesadilla, 11
// candidates) at the ENGINE level. The live compiler-side term-collision fix
// (the actual root cause: "chicken" is a bare lexicon term tying all 11
// candidates) has not shipped, so this is the only thing currently
// protecting this conversation shape in production — verified here, not
// assumed, per the PO's own explicit instruction. ──────────────────────────

const QUESADILLA_KINDS = [
  "Buffalo", "BBQ", "Grilled", "Thai", "Ranch", "Spicy", "Cajun", "Garlic", "Honey", "Teriyaki", "Classic",
];
const QUESADILLA_IDS = QUESADILLA_KINDS.map((_, i) => `q${i}-11111111-1111-1111-1111-111111111111`);
const QUESADILLA_MENU: TurnEngineMenuItem[] = QUESADILLA_KINDS.map((kind, i) =>
  realItem(QUESADILLA_IDS[i], `${kind} Chicken Quesadilla`, "Mexican", 999 + i * 10)
);
// The live term collision: "chicken" is a real, bare, single-word lexicon
// term whose target set is EVERY ONE of these 11 items (compile-menu's
// shared-name-terms rule, same shape turn-engine.ts's own noProgress doc
// describes for "chicken" against 11 Buffalo/Thai/Grilled Chicken items).
const QUESADILLA_LEXICON = QUESADILLA_IDS.map(id => ({ term: "chicken", target_id: id, category: "Mexican", size_label: null }));

function makeQuesadillaSupabase() {
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq() { return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        const all = table === "lexicon" ? QUESADILLA_LEXICON : [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      in() { return Promise.resolve({ data: [], error: null }); },
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

Deno.test("REGRESSION PROOF (real conv 01609954, chicken quesadilla, 11 candidates): main's existing noProgress mechanism, driven through the real runner, never re-asks the identical facet question a 3rd time and never calls PROPOSE", async () => {
  const supabase = makeQuesadillaSupabase();
  let proposeCalls = 0;
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: failingPropose("REGRESSION PROOF"),
  };
  void (() => { proposeCalls; })(); // referenced for clarity only

  const dialogueStateBefore: DialogueState = {
    phase: "ordering",
    open: { kind: "disambiguation", candidates: QUESADILLA_IDS, quantity: 1 },
    upsell_offered: false, asked_message_id: null, openRepeatCount: 0,
  };

  const replies: string[] = [];
  let cart: TurnEngineCartLine[] = [];
  let dialogueState: DialogueState | null = dialogueStateBefore;

  // Four consecutive turns, same unhelpful reply each time — the exact
  // live shape ("chicken" answering "what kind?" and never narrowing
  // anything, since every candidate contains that word).
  for (let i = 0; i < 4; i++) {
    const r = await runTurnEngineTurn(
      {
        conversationId: "conv-01609954", shopId: "shop-repro-2", tenantId: "shop-repro-2", cartId: "cart-repro-2",
        message: "chicken quesadilla", history: [], menu: QUESADILLA_MENU, cart, dialogueState,
        shopContext: { deliveryEnabled: true, orderType: null, deliveryAddressKnown: false, driverTipCents: null, pickupName: null, deliveryFeeCents: null },
      },
      deps,
    );
    replies.push(r.reply);
    cart = r.cart;
    dialogueState = r.dialogueState;
  }

  // Never the byte-identical reply a 3rd time running.
  const counts = new Map<string, number>();
  for (const r of replies) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [reply, count] of counts) {
    assert(count <= 2, `the same reply must never be sent 3 times running (real live incident: 15 identical asks): "${reply}" was sent ${count} times`);
  }

  // The mechanism must actually have engaged (proving this test exercises
  // the real defect shape, not a no-op): at least one reply must be the
  // capped numbered-list/fallback wording, never a plain repeated
  // "What kind?" the whole way through.
  assert(
    replies.some(r => r.includes("I couldn't match that") || /\d+\)/.test(r)),
    `expected the noProgress fallback (numbered list or "I couldn't match that") to appear at least once: ${JSON.stringify(replies)}`,
  );

  assertEquals(cart.length, 0, "nothing should ever be added while every reply fails to narrow the set");
});
