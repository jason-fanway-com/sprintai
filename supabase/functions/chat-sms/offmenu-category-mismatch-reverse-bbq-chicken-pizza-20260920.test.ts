// PO dispatch (2026-09-20), found by offline-probing 7e7ab0c1 (the
// fries off-menu-category-mismatch fix) before deploying it:
//
//   > can I get a side of buffalo chicken fries?
//   bot: declines, offers real fries options.                    PASS
//
//   > can I change that to a small BBQ Chicken pizza instead?
//   bot: "Which one -- Buffalo Chicken small / Thai Sweet Chili small?"  FAIL
//
// BBQ Chicken exists at Vito's ONLY as a Flatbread (id
// 80d49c72-d238-4ef9-8b29-12ec7097b213, $10.50) -- there is no "BBQ Chicken
// pizza." This is the SAME rule 7e7ab0c1 already applies (a span whose head
// noun/category word names a category the resolved item is NOT in is
// off-menu), just the mirror direction: 7e7ab0c1's own case ("fries") had NO
// real item in that word's own family at all; this case has a real item —
// just filed under a DIFFERENT real category than the one the customer also
// (correctly) named.
//
// ROOT CAUSE (resolve-item.ts, confirmed directly against resolveItem before
// this fix -- see this repo's PO_SCRATCH_bbq_probe.ts, run against real
// active Vito's lexicon and deleted before this commit):
// resolveItem("small bbq chicken pizza", ...) returned
// `{ kind: "ambiguous", candidates: [SMALL_BUFFALO_CHICKEN_PIZZA,
// SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA] }`. longestMatch's own tie-break
// finds TWO DIFFERENT winning terms at the identical length 2: "bbq chicken"
// (BBQ Chicken Flatbread's own, unique, correctly-spelled name) and "chicken
// pizza" (a generic, derived 2-word term shared by BOTH Buffalo Chicken
// Pizza and Thai Sweet Chili Chicken Pizza, matching only because "chicken"
// and the trailing category word "pizza" happen to sit next to each other
// in the span). resolveItem's own namedCategories filter (the mechanism
// 7e7ab0c1's own offMenuCategoryMismatchWord deliberately EXEMPTS "pizza"
// from, deferring to this filter instead) correctly narrows the 3-way tie
// down to the two Pizza candidates ("pizza" really is a live category
// dimension here) -- but discards BBQ Chicken Flatbread for the RIGHT
// reason (it's not a pizza) while its OWN distinguishing word, "bbq", is
// left completely unaccounted for by either surviving candidate's own
// matched term. A customer who typed "bbq" was never asking about Buffalo
// Chicken or Thai Sweet Chili at all.
//
// THE FIX: categoryFilterDiscardedRealItemId (resolve-item.ts) checks,
// exactly once, right after resolveItem's own named-category filter narrows
// a genuine tie: did the filter discard a candidate whose own matched-term
// words are NOT fully covered by the surviving candidates' own matched
// words? If so, resolveItem now returns `{ kind: "unresolved" }` instead of
// the unfiltered "ambiguous" list -- and findCategoryFilterDiscardedRealItem
// (same caller-facing shape as findOffMenuCategoryMismatch) redoes that
// computation for turn-engine.ts so it can decline by NAME, naming the real
// item and its real category, instead of opening a which-one question
// between two items nobody asked for.
//
// This fires in BOTH places resolveItem's result reaches turn-engine.ts:
// the top-level proposal.adds loop, AND the "change X to Y instead"
// replacement branch parseReplacementIntent/resolveReplacementTargetLine
// feed (this file's own turn-engine.ts already has a comment, near
// parseReplacementIntent, independently documenting a real live repro with
// this exact phrase: "change that pizza to a small BBQ Chicken pizza
// instead" -- confirming the PO's probe message matches a real production
// shape, not a hypothetical). Both call sites now share one decline-message
// builder, categoryFilterDiscardDecline, so the wording can never drift.
//
// METHODOLOGY (standing rule, same as 7e7ab0c1): drives the REAL production
// call path, turn-engine-runner.ts's runTurnEngineTurn -- PROPOSE mocked,
// everything downstream (resolveItem, decide, render) is the genuine,
// unmodified production code. Every id/name/category/price/lexicon term
// below is REAL Vito's live data (shop_id
// e0000000-0000-0000-0000-000000000001), queried directly 2026-09-20 and
// reproduced verbatim -- never invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineCartLine, TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-20 -- see this file's own header.
const SPICY_CHAPO_LARGE = "e8bbc779-7956-466c-8c3b-2761852f4a02"; // $21.99, already in cart (unrelated to BBQ Chicken)
const BBQ_CHICKEN_FLATBREAD = "80d49c72-d238-4ef9-8b29-12ec7097b213"; // $10.50, Flatbreads -- the real item
const SMALL_BUFFALO_CHICKEN_PIZZA = "0aa10696-753c-4595-bc0e-c4ca1956805a"; // $12.95, Pizza
const SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA = "113d647d-aaa9-48ba-8c00-1e4f9f082f91"; // $12.95, Pizza
const LARGE_BUFFALO_CHICKEN_PIZZA = "d00325b6-fe25-46d8-8827-55acd7794228"; // $22.99, Pizza -- real pizza order regression

function menuItem(id: string, name: string, display_name: string, category: string, price_cents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name, base_price_cents: price_cents,
      recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  menuItem(SPICY_CHAPO_LARGE, "Spicy Chapo - Large (16\")", "Large Spicy Chapo Pizza", "Pizza", 2199),
  menuItem(BBQ_CHICKEN_FLATBREAD, "BBQ Chicken", "BBQ Chicken", "Flatbreads", 1050),
  menuItem(SMALL_BUFFALO_CHICKEN_PIZZA, "Buffalo Chicken - Small (10\")", "Small Buffalo Chicken Pizza", "Pizza", 1295),
  menuItem(SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA, "Thai Sweet Chili Chicken - Small (10\")", "Small Thai Sweet Chili Chicken Pizza", "Pizza", 1295),
  menuItem(LARGE_BUFFALO_CHICKEN_PIZZA, "Buffalo Chicken - Large (16\")", "Large Buffalo Chicken Pizza", "Pizza", 2299),
];

// Real, active item-lexicon rows for exactly these items (shop_id
// e0000000-0000-0000-0000-000000000001), queried live 2026-09-20 -- term/
// target_id pairs only, exactly as loadItemLexicon's own `select` loads
// them; category/size_label are joined separately in production
// (loadLexiconItemMetadata) and in this fixture's fake supabase below, off
// the real MENU array, same convention as
// offmenu-category-mismatch-generalized-20260920.test.ts's own fixture.
const ACTIVE_ITEM_LEXICON: Array<{ term: string; target_id: string }> = [
  { term: "buffalo chicken", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chicken pizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chicken pizzas", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chickens", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalochicken", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalochickens", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "chicken pizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "chicken pizzas", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "pizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "pizzas", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "small buffalo chicken", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "small buffalo chicken pizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "small buffalo chicken pizzas", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "small buffalo chickens", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "smallbuffalochicken", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "smallbuffalochickenpizza", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "smallbuffalochickenpizzas", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "smallbuffalochickens", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "smalls", target_id: SMALL_BUFFALO_CHICKEN_PIZZA },
  { term: "chicken pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "chicken pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "chili chicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "chili chicken pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "chili chicken pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "chili chickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "small thai sweet chili chicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "small thai sweet chili chicken pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "small thai sweet chili chicken pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "small thai sweet chili chickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "smalls", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "smallthaisweetchilichicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "smallthaisweetchilichickenpizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "smallthaisweetchilichickenpizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "smallthaisweetchilichickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken - small 10 inch", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken - small 10 inches", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken small", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chicken smalls", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "sweet chili chickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken - small 10 inch", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken - small 10 inches", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken pizza", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken pizzas", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken small", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chicken smalls", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thai sweet chili chickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichicken", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichicken-small10inch", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichicken-small10inches", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichickens", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichickensmall", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "thaisweetchilichickensmalls", target_id: SMALL_THAI_SWEET_CHILI_CHICKEN_PIZZA },
  { term: "bbq chicken", target_id: BBQ_CHICKEN_FLATBREAD },
  { term: "bbq chickens", target_id: BBQ_CHICKEN_FLATBREAD },
  { term: "bbqchicken", target_id: BBQ_CHICKEN_FLATBREAD },
  { term: "bbqchickens", target_id: BBQ_CHICKEN_FLATBREAD },
  { term: "buffalo chicken", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chicken pizza", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chicken pizzas", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalo chickens", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalochicken", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "buffalochickens", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "chicken pizza", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "chicken pizzas", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "large buffalo chicken", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "large buffalo chicken pizza", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "large buffalo chicken pizzas", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "large buffalo chickens", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "largebuffalochicken", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "largebuffalochickenpizza", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "largebuffalochickenpizzas", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "largebuffalochickens", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "pizza", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
  { term: "pizzas", target_id: LARGE_BUFFALO_CHICKEN_PIZZA },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-bbq-chicken-pizza-offmenu-reverse",
    shopId: "e0000000-0000-0000-0000-000000000001",
    tenantId: "e0000000-0000-0000-0000-000000000001",
    cartId: "cart-1",
    message: "",
    history: [],
    menu: MENU,
    cart: [],
    dialogueState: null,
    shopContext: {
      deliveryEnabled: true, orderType: null, deliveryAddressKnown: false,
      driverTipCents: null, pickupName: null, deliveryFeeCents: null,
    },
    ...overrides,
  };
}

// Same fake-supabase shape as offmenu-category-mismatch-generalized-20260920.test.ts's
// own makeFakeSupabase.
// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder(table: string) {
    const eqFilters: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b; },
      eq(col: string, val: unknown) { eqFilters[col] = val; return b; },
      is() { return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      range(from: number, to: number) {
        if (table !== "lexicon") return Promise.resolve({ data: [], error: null });
        const filtered = eqFilters["active"] === true ? ACTIVE_ITEM_LEXICON : [];
        return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
      },
      in(column: string, values: unknown[]) {
        if (table !== "menu_items") return Promise.resolve({ data: [], error: null });
        const matches = MENU
          .filter(m => values.includes((m as unknown as Record<string, unknown>)[column]))
          .map(m => ({ id: m.id, category: m.category, size_label: null, bot_state: m.bot_state }));
        return Promise.resolve({ data: matches, error: null });
      },
      update() { return { eq: () => Promise.resolve({ error: null }) }; },
      insert() {
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg-1" }, error: null }) }),
          then(resolve: (v: { error: null }) => void) { return Promise.resolve({ error: null }).then(resolve); },
        };
      },
      then(resolve: (v: { data: unknown; error: null; count?: number }) => void) {
        if (table === "lexicon") {
          const filtered = eqFilters["active"] === true ? ACTIVE_ITEM_LEXICON : [];
          return Promise.resolve({ data: null, error: null, count: filtered.length }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

function newLineKeyCounter() {
  let n = 0;
  return () => `line-${++n}`;
}

function cartWithSpicyChapo(): TurnEngineCartLine[] {
  return [
    { menu_item_id: SPICY_CHAPO_LARGE, name: "Spicy Chapo - Large (16\")", quantity: 1, price_cents: 2199, modifiers: [], line_key: "chapo-line" },
  ];
}

// PROPOSE returns exactly what a real model returns for "can I change that
// to a small BBQ Chicken pizza instead?" -- no add/remove/modify at all
// (turn-engine.ts's own parseReplacementIntent regex handles "change ... to
// ... instead" entirely itself, before PROPOSE's own proposal is even
// consulted for this span).
function proposeNothing(): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true, attempts: 1,
    proposal: { intent: "order", adds: [], removes: [], modifies: [] },
  });
}

const REPRO_MESSAGE = "can I change that to a small BBQ Chicken pizza instead?";

for (let run = 1; run <= 3; run++) {
  Deno.test(`runner (PO fixture run ${run}/3, real PO probe): 'can I change that to a small BBQ Chicken pizza instead?' with a Large Spicy Chapo already in cart declines cleanly, offers the real BBQ Chicken Flatbread, never opens a which-one question between Buffalo Chicken and Thai Sweet Chili`, async () => {
    const supabase = makeFakeSupabase();
    const deps: RunTurnDeps = {
      supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
      proposeTurnFn: proposeNothing(),
    };
    const result = await runTurnEngineTurn(
      baseInput({ message: REPRO_MESSAGE, cart: cartWithSpicyChapo() }),
      deps,
    );

    assertEquals(result.cart.length, 1, `the Spicy Chapo must stay exactly as it was, nothing added or removed: ${JSON.stringify(result.cart)}`);
    assertEquals(result.cart[0].menu_item_id, SPICY_CHAPO_LARGE, `held line must still be the Spicy Chapo: ${JSON.stringify(result.cart)}`);
    assert(!/which one/i.test(result.reply), `must never open a which-one question for this: ${JSON.stringify(result.reply)}`);
    assert(!/buffalo chicken.*added|thai sweet chili.*added/i.test(result.reply), `must never silently add either unrelated pizza: ${JSON.stringify(result.reply)}`);
    assert(
      result.dialogueState?.open?.kind !== "disambiguation",
      `must never leave a disambiguation open between the two unrelated pizzas: ${JSON.stringify(result.dialogueState)}`,
    );
    assert(/bbq chicken/i.test(result.reply), `must name the real item the customer actually asked for: ${JSON.stringify(result.reply)}`);
    assert(/flatbread/i.test(result.reply), `must name BBQ Chicken's real category (Flatbreads), not silently list it as a pizza option: ${JSON.stringify(result.reply)}`);
  });
}

// Regression (task requirement): a real pizza order — an item that IS
// actually a pizza — must still resolve normally through the ADD path, not
// get swept up by this fix.
Deno.test("runner (no regression): a real Buffalo Chicken pizza order (stated size) still resolves and adds cleanly", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "large buffalo chicken pizza", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get a large buffalo chicken pizza" }),
    deps,
  );

  assertEquals(result.cart.length, 1, `a genuine Buffalo Chicken pizza order must still add: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, LARGE_BUFFALO_CHICKEN_PIZZA, `must add the Large Buffalo Chicken pizza: ${JSON.stringify(result.cart)}`);
  assert(/buffalo chicken.*added/i.test(result.reply), `must confirm the real item added: ${JSON.stringify(result.reply)}`);
});

// Regression: this fix must never widen into a general "pizza" veto. A
// bare "chicken pizza" (no "bbq" word, no distinguishing signal for either
// side) is genuinely ambiguous between Buffalo Chicken and Thai Sweet
// Chili — the customer really could mean either, and the bot must still
// ask which one, not silently guess or wrongly decline.
Deno.test("runner (no regression): a genuinely ambiguous 'small chicken pizza' (no bbq word) still asks which one, never declined by this fix", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "small chicken pizza", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get a small chicken pizza" }),
    deps,
  );

  assertEquals(result.cart.length, 0, `nothing should be added while it's genuinely ambiguous: ${JSON.stringify(result.cart)}`);
  assert(
    result.dialogueState?.open?.kind === "disambiguation",
    `a genuine ambiguity between two real pizzas must still ask which one: ${JSON.stringify(result.dialogueState)}`,
  );
});

// Regression (task requirement): a real BBQ Chicken order with no "pizza"
// word at all must still resolve straight to the real Flatbread — this fix
// must never make BBQ Chicken itself harder to order.
Deno.test("runner (no regression): a bare 'BBQ Chicken' order (no 'pizza' word) still resolves to the real Flatbread", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "BBQ chicken", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get the BBQ chicken" }),
    deps,
  );

  assertEquals(result.cart.length, 1, `a genuine BBQ Chicken order must still add: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, BBQ_CHICKEN_FLATBREAD, `must add the real BBQ Chicken Flatbread: ${JSON.stringify(result.cart)}`);
});
