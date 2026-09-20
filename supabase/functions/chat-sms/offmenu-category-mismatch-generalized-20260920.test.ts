// PO dispatch (2026-09-20), REAL LIVE MONEY BUG, v580 50-run, conv 75b6e542:
//
//   cart: Large Spicy Chapo (with toppings) already in progress
//   > Also, can I get a side of buffalo chicken fries?
//   bot: "Large Buffalo Chicken Pizza added" ($22.99)   <- WRONG: customer
//     asked for FRIES, got charged for a PIZZA.
//
// ROOT CAUSE (resolve-item.ts): "buffalo chicken fries" ties resolveItem's
// own real, correct 2-word term "buffalo chicken" across Buffalo Chicken
// Pizza (S/M/L), Flatbread, and Wrap — a real word-pair — but the span's own
// head noun "fries" names a real, separate dish family (French Fries, Crab
// Fries, Cali Fries, Texas Fries, Nacho Cheese Fries, Bacon Cheese Fries,
// Sweet Potato Fries, Crazy Fries, Chicken Fingers (5) with french fries,
// Shrimp in Basket with french fries — every one of Vito's ten real fries
// items) that NONE of the tied candidates belong to. Confirmed directly
// against resolveItem before this fix (~/po-scratch-style probe, real
// lexicon/menu data pulled live from shop_id e0000000-0000-0000-0000-
// 000000000001): resolveItem("buffalo chicken fries", ...) and
// resolveItem("side of buffalo chicken fries", ...) both returned
// `{ kind: "ambiguous" }` across the 5 Buffalo Chicken items, never even
// considering the category mismatch.
//
// FIX: offMenuCategoryMismatchWord (resolve-item.ts) generalizes the SAME
// class of defect the already-shipped DEFECT 3 (bleu-cheese) veto and
// uniqueBaseCategoryConflict fix for a UNIQUE base match — to a genuine TIE,
// and to a head noun ("fries") that has no DB `category` of its own on this
// shop (Vito's files all ten fries items under "Appetizers" alongside a
// dozen unrelated dishes) by also indexing each item's own stated NAME
// words, not just the shop's DB category taxonomy. resolveItem now returns
// `{ kind: "unresolved" }` for this tie; findOffMenuCategoryMismatch
// (turn-engine.ts's new caller-facing pair, same shape as
// findVetoedOffMenuTerm/findOffMenuChoiceAlternative) names the real
// alternative fries items in the decline instead of a bare "didn't catch
// that."
//
// METHODOLOGY (standing rule): drives the REAL production call path,
// turn-engine-runner.ts's runTurnEngineTurn — PROPOSE mocked, everything
// downstream (resolveItem, decide, render) is the genuine, unmodified
// production code. Every id, name, category, and price below is REAL
// Vito's live data (shop_id e0000000-0000-0000-0000-000000000001), queried
// directly 2026-09-20 and reproduced verbatim — never invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-20 — see this file's own header.
const SPICY_CHAPO_LARGE = "e8bbc779-7956-466c-8c3b-2761852f4a02"; // $21.99, already in cart
const BUFFALO_CHICKEN_SMALL = "0aa10696-753c-4595-bc0e-c4ca1956805a"; // $12.95
const BUFFALO_CHICKEN_MEDIUM = "42189675-84e8-4213-bb5c-ea9b6643d0ff"; // $19.99
const BUFFALO_CHICKEN_LARGE = "d00325b6-fe25-46d8-8827-55acd7794228"; // $22.99 — the wrong live charge
const BUFFALO_CHICKEN_FLATBREAD = "41a9e8cd-b24a-4b4b-996b-8ae536d207da"; // $10.50
const BUFFALO_CHICKEN_WRAP = "eba622ba-354d-4f7b-9dd6-18759e8dfe14"; // $9.99
const CRAB_FRIES = "76b08c64-fa1e-4807-835c-34464aa2ccaf"; // $8.99
const FRENCH_FRIES = "1d0ad29e-7b35-4824-9a5a-1e17fecdd355"; // $4.99
const CALI_FRIES = "f327154c-b18d-466e-b92d-e2bc059b0a33"; // $9.99
const TEXAS_FRIES = "b4e82cea-0ef8-466a-87ca-e79a30dc8c57"; // $9.99
const NACHO_CHEESE_FRIES = "e06d3c81-87c7-43c0-83cd-69d0e963124b"; // $6.99
const BACON_CHEESE_FRIES = "1cc3493a-b681-4eb5-931f-20bda140d5d4"; // $8.49
const SWEET_POTATO_FRIES = "f6ae4b2a-69d8-4137-8126-ff07f9ce7751"; // $6.49
const CRAZY_FRIES = "1d5534e4-39ea-4025-ae98-a31b0233e453"; // $9.99
const CHICKEN_FINGERS_5 = "0108ffa8-5f3c-437a-b51e-4a177f4ff0da"; // $10.95, with french fries
const SHRIMP_BASKET = "cc362a93-fe87-43fe-8586-2d80e76083b4"; // $12.50, with french fries

function menuItem(id: string, name: string, category: string, price_cents: number): TurnEngineMenuItem {
  return {
    id, name, category, price_cents, bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: name,
      base_price_cents: price_cents, recap_template: "", ticket_template: "", steps: [],
    },
  };
}

const MENU: TurnEngineMenuItem[] = [
  menuItem(SPICY_CHAPO_LARGE, "Spicy Chapo - Large (16\")", "Pizza", 2199),
  menuItem(BUFFALO_CHICKEN_SMALL, "Buffalo Chicken - Small (10\")", "Pizza", 1295),
  menuItem(BUFFALO_CHICKEN_MEDIUM, "Buffalo Chicken - Medium (14\")", "Pizza", 1999),
  menuItem(BUFFALO_CHICKEN_LARGE, "Buffalo Chicken - Large (16\")", "Pizza", 2299),
  menuItem(BUFFALO_CHICKEN_FLATBREAD, "Buffalo Chicken", "Flatbreads", 1050),
  menuItem(BUFFALO_CHICKEN_WRAP, "Buffalo Chicken", "Wraps", 999),
  menuItem(CRAB_FRIES, "Crab Fries", "Appetizers", 899),
  menuItem(FRENCH_FRIES, "French Fries", "Appetizers", 499),
  menuItem(CALI_FRIES, "Cali Fries", "Appetizers", 999),
  menuItem(TEXAS_FRIES, "Texas Fries", "Appetizers", 999),
  menuItem(NACHO_CHEESE_FRIES, "Nacho Cheese Fries", "Appetizers", 699),
  menuItem(BACON_CHEESE_FRIES, "Bacon Cheese Fries", "Appetizers", 849),
  menuItem(SWEET_POTATO_FRIES, "Sweet Potato Fries", "Appetizers", 649),
  menuItem(CRAZY_FRIES, "Crazy Fries", "Appetizers", 999),
  menuItem(CHICKEN_FINGERS_5, "Chicken Fingers (5) with french fries", "Appetizers", 1095),
  menuItem(SHRIMP_BASKET, "Shrimp in Basket with french fries", "Appetizers", 1250),
];

// Real, active item-lexicon rows for exactly these items (shop_id
// e0000000-0000-0000-0000-000000000001), queried live 2026-09-20 —
// term/target_id pairs only, exactly as loadItemLexicon's own `select`
// loads them; category/size_label are joined separately in production
// (loadLexiconItemMetadata) and in this fixture's fake supabase below.
const ACTIVE_ITEM_LEXICON: Array<{ term: string; target_id: string }> = [
  { term: "large spicy chapo", target_id: SPICY_CHAPO_LARGE },
  { term: "large spicy chapo pizza", target_id: SPICY_CHAPO_LARGE },
  { term: "spicy chapo large", target_id: SPICY_CHAPO_LARGE },
  { term: "spicy chapo", target_id: SPICY_CHAPO_LARGE },
  { term: "chapo", target_id: SPICY_CHAPO_LARGE },
  { term: "pizza", target_id: SPICY_CHAPO_LARGE },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_SMALL },
  { term: "small buffalo chicken", target_id: BUFFALO_CHICKEN_SMALL },
  { term: "buffalo chicken pizza", target_id: BUFFALO_CHICKEN_SMALL },
  { term: "small buffalo chicken pizza", target_id: BUFFALO_CHICKEN_SMALL },
  { term: "pizza", target_id: BUFFALO_CHICKEN_SMALL },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "medium buffalo chicken", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "buffalo chicken pizza", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "medium buffalo chicken pizza", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "chicken pizza", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "pizza", target_id: BUFFALO_CHICKEN_MEDIUM },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "large buffalo chicken", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "buffalo chicken pizza", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "large buffalo chicken pizza", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "chicken pizza", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "pizza", target_id: BUFFALO_CHICKEN_LARGE },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_FLATBREAD },
  { term: "buffalo chicken flatbread", target_id: BUFFALO_CHICKEN_FLATBREAD },
  { term: "chicken flatbread", target_id: BUFFALO_CHICKEN_FLATBREAD },
  { term: "flatbread", target_id: BUFFALO_CHICKEN_FLATBREAD },
  { term: "buffalo chicken", target_id: BUFFALO_CHICKEN_WRAP },
  { term: "buffalo chicken wrap", target_id: BUFFALO_CHICKEN_WRAP },
  { term: "chicken wrap", target_id: BUFFALO_CHICKEN_WRAP },
  { term: "wrap", target_id: BUFFALO_CHICKEN_WRAP },
  { term: "crab fries", target_id: CRAB_FRIES },
  { term: "fries", target_id: CRAB_FRIES },
  { term: "appetizer", target_id: CRAB_FRIES },
  { term: "french fries", target_id: FRENCH_FRIES },
  { term: "fries", target_id: FRENCH_FRIES },
  { term: "appetizer", target_id: FRENCH_FRIES },
  { term: "cali fries", target_id: CALI_FRIES },
  { term: "fries", target_id: CALI_FRIES },
  { term: "appetizer", target_id: CALI_FRIES },
  { term: "texas fries", target_id: TEXAS_FRIES },
  { term: "fries", target_id: TEXAS_FRIES },
  { term: "appetizer", target_id: TEXAS_FRIES },
  { term: "nacho cheese fries", target_id: NACHO_CHEESE_FRIES },
  { term: "cheese fries", target_id: NACHO_CHEESE_FRIES },
  { term: "fries", target_id: NACHO_CHEESE_FRIES },
  { term: "appetizer", target_id: NACHO_CHEESE_FRIES },
  { term: "bacon cheese fries", target_id: BACON_CHEESE_FRIES },
  { term: "cheese fries", target_id: BACON_CHEESE_FRIES },
  { term: "fries", target_id: BACON_CHEESE_FRIES },
  { term: "appetizer", target_id: BACON_CHEESE_FRIES },
  { term: "sweet potato fries", target_id: SWEET_POTATO_FRIES },
  { term: "potato fries", target_id: SWEET_POTATO_FRIES },
  { term: "fries", target_id: SWEET_POTATO_FRIES },
  { term: "appetizer", target_id: SWEET_POTATO_FRIES },
  { term: "crazy fries", target_id: CRAZY_FRIES },
  { term: "fries", target_id: CRAZY_FRIES },
  { term: "appetizer", target_id: CRAZY_FRIES },
  { term: "chicken fingers", target_id: CHICKEN_FINGERS_5 },
  { term: "chicken fingers 5", target_id: CHICKEN_FINGERS_5 },
  { term: "chicken fingers 5 with french fries", target_id: CHICKEN_FINGERS_5 },
  { term: "fingers", target_id: CHICKEN_FINGERS_5 },
  { term: "appetizer", target_id: CHICKEN_FINGERS_5 },
  { term: "shrimp in basket with french fries", target_id: SHRIMP_BASKET },
  { term: "shrimps", target_id: SHRIMP_BASKET },
  { term: "appetizer", target_id: SHRIMP_BASKET },
];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-75b6e542-buffalo-chicken-fries",
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

// Same fake-supabase shape as bleu-cheese-offmenu-not-pizza-list-20260919's
// own makeFakeSupabase — distinguishes the `active` eq() filter per query so
// loadItemLexicon's active=true rows and loadExcludedItemLexicon's
// active=false rows are genuinely different sets, and joins category off
// the real MENU array the same way production's loadLexiconItemMetadata
// joins menu_items. This shop has no inactive item-lexicon rows in scope
// for this fix, so ALL_LEXICON_ROWS is just the active set.
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
        // No inactive rows in this fixture — active=false always empty.
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

function proposeAdd(itemSpan: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true, attempts: 1,
    proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity: 1, choices: [] }], removes: [], modifies: [] },
  });
}

Deno.test("runner (PO fixture, real conv 75b6e542): 'a side of buffalo chicken fries' with a Large Spicy Chapo already in cart never adds the $22.99 Buffalo Chicken pizza, declines and offers the real fries list", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("side of buffalo chicken fries"),
  };
  const cartBefore = [{ menu_item_id: SPICY_CHAPO_LARGE, name: "Spicy Chapo - Large (16\")", quantity: 1, price_cents: 2199, modifiers: [], line_key: "l1" }];

  const result = await runTurnEngineTurn(
    baseInput({ message: "Also, can I get a side of buffalo chicken fries?", cart: cartBefore }),
    deps,
  );

  assertEquals(result.cart.length, 1, `must never add anything for the fries request: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, SPICY_CHAPO_LARGE, `the Spicy Chapo must stay exactly as it was: ${JSON.stringify(result.cart)}`);
  assert(!/buffalo chicken.*added/i.test(result.reply), `must never silently add a Buffalo Chicken item: ${JSON.stringify(result.reply)}`);
  assert(!/\$22\.99|\$19\.99|\$12\.95|\$10\.50|\$9\.99/.test(result.reply), `must never quote a Buffalo Chicken price as if it were the answer: ${JSON.stringify(result.reply)}`);
  assert(!/didn't catch/i.test(result.reply), `must not claim it mis-heard a clearly-typed item: ${JSON.stringify(result.reply)}`);
  assert(/fries/i.test(result.reply), `must name what the customer actually asked for: ${JSON.stringify(result.reply)}`);
  assert(/french fries|crab fries|cali fries|texas fries/i.test(result.reply), `must offer real fries items by name: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture, real conv 75b6e542, stays declined): restating the same off-menu span later in the conversation declines again, never re-adds the pizza", async () => {
  const supabase = makeFakeSupabase();
  const cartBefore = [{ menu_item_id: SPICY_CHAPO_LARGE, name: "Spicy Chapo - Large (16\")", quantity: 1, price_cents: 2199, modifiers: [], line_key: "l1" }];

  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("side of buffalo chicken fries"),
  };
  const turn1 = await runTurnEngineTurn(
    baseInput({ message: "Also, can I get a side of buffalo chicken fries?", cart: cartBefore }),
    deps,
  );
  assertEquals(turn1.cart.length, 1, `turn 1 must not add anything: ${JSON.stringify(turn1.cart)}`);

  const deps2: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("buffalo chicken fries"),
  };
  const turn2 = await runTurnEngineTurn(
    baseInput({
      message: "plus a side of buffalo chicken fries",
      cart: turn1.cart,
      dialogueState: turn1.dialogueState,
      history: [
        { role: "user", content: "Also, can I get a side of buffalo chicken fries?" },
        { role: "assistant", content: turn1.reply },
      ],
    }),
    deps2,
  );

  assertEquals(turn2.cart.length, 1, `restatement must never add the pizza: ${JSON.stringify(turn2.cart)}`);
  assertEquals(turn2.cart[0].menu_item_id, SPICY_CHAPO_LARGE, `cart must still hold only the Spicy Chapo after the restatement: ${JSON.stringify(turn2.cart)}`);
  assert(!/buffalo chicken.*added/i.test(turn2.reply), `must never silently add a Buffalo Chicken item on restatement: ${JSON.stringify(turn2.reply)}`);
  assert(!/\$22\.99/.test(turn2.reply), `must never quote the $22.99 Buffalo Chicken Large price on restatement: ${JSON.stringify(turn2.reply)}`);
  assert(/fries/i.test(turn2.reply), `restatement must still get the same honest off-menu decline: ${JSON.stringify(turn2.reply)}`);
});

Deno.test("runner (no regression): a real fries order by name still resolves and adds cleanly, never declined by the new category-mismatch guard", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("crab fries"),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get an order of crab fries" }),
    deps,
  );

  assertEquals(result.cart.length, 1, `the real fries item must add cleanly: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CRAB_FRIES, `must add Crab Fries specifically, not decline it: ${JSON.stringify(result.cart)}`);
  assert(/crab fries added/i.test(result.reply), `must confirm the real item added: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (no regression): a real Buffalo Chicken pizza order (stated size) still resolves and adds cleanly", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("large buffalo chicken pizza"),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get a large buffalo chicken pizza" }),
    deps,
  );

  assertEquals(result.cart.length, 1, `a genuine Buffalo Chicken pizza order must still add: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, BUFFALO_CHICKEN_LARGE, `must add the Large Buffalo Chicken pizza: ${JSON.stringify(result.cart)}`);
  assert(/buffalo chicken.*added/i.test(result.reply), `must confirm the real item added: ${JSON.stringify(result.reply)}`);
});
