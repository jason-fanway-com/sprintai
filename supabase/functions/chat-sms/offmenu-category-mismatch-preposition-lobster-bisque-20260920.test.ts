// PO dispatch (2026-09-20), REAL LIVE LOST-ITEM BUG, v586, conv befc0c6a:
//
//   > Hi, I'd like to order a cup of Lobster Bisque, please.
//   bot: 'We don't have of like "cup of Lobster Bisque" - real of options:
//        Bowl Soup Of The Day, Cup Soup Of The Day.'
//   > What? I just want a cup of lobster bisque. Is that not on the menu?
//   bot: "Yes, it is on the menu. A cup of Lobster Bisque is available."
//        + the SAME veto line again, three more times.
//
// ROOT CAUSE (resolve-item.ts): the off-menu category-mismatch veto
// (offMenuCategoryMismatchWord, shipped f1a9e154, extended d9fa1d6d) scans
// a span's words in reverse looking for a "head noun" the tied candidates
// don't carry. For "cup of Lobster Bisque" the tie is the real Cup/Bowl
// Lobster Bisque Soup pair (matched on the shared "lobster bisque" term);
// scanning past the matched words "bisque"/"lobster" lands on "of" next --
// which is NOT a dish word at all, but Vito's own "Cup Soup Of The Day" /
// "Bowl Soup Of The Day" items genuinely carry the literal word "of" in
// their own stated item name, so nameWordIndex has real "owners" for it
// that aren't among the tied Lobster Bisque candidates -- exactly the shape
// the veto exists to catch, just aimed at a preposition instead of a real
// dish word. resolveItem returned `{ kind: "unresolved" }` for a span that
// is a completely real, resolvable $4.95 menu item.
//
// FIX (three-part, all in this repo):
//   1. offMenuCategoryMismatchWord's veto (resolve-item.ts) now runs AFTER
//      named-category/size narrowing has had its own chance to collapse a
//      real tie to one candidate, so it can never override a span that DOES
//      resolve/narrow to a real item (mirrors 4e0ad853's guarantee for the
//      original off-menu veto).
//   2. OFF_MENU_HEAD_NOUN_STOPWORDS (resolve-item.ts) -- "of", "a", "an",
//      "the", "side", "cup", "order" -- are now skipped outright by the
//      head-noun scan, so a preposition/quantity word can never itself be
//      picked as "the category word to check against".
//   3. turn-engine.ts's decline-message render site guards against ever
//      printing a stopword as if it were a real category name, as a
//      last-resort safety net even if the extractor's own skip somehow
//      doesn't apply.
//
// REGRESSION COVERAGE (must not be undone, see those files' own tests):
//   - offmenu-category-mismatch-generalized-20260920.test.ts ("a side of
//     buffalo chicken fries" must still decline -- "fries" narrows nothing,
//     the 5-way Buffalo Chicken tie survives narrowing and still trips the
//     veto exactly as before).
//   - offmenu-category-mismatch-reverse-bbq-chicken-pizza-20260920.test.ts
//     ("a small BBQ Chicken pizza" reverse-direction fix).
//
// METHODOLOGY: drives the REAL production call path, turn-engine-runner.ts's
// runTurnEngineTurn -- PROPOSE mocked, everything downstream (resolveItem,
// decide, render) is the genuine, unmodified production code. Menu/lexicon
// shapes reconstruct the real Vito's data implied by the live transcript
// (Lobster Bisque Cup/Bowl with a shared bare "lobster bisque" lexicon term
// and no "cup"/"bowl" word in the term itself -- same documented shape as
// soup-size-cup-bowl-20260919.test.ts's own fixture -- plus the real "Cup
// Soup Of The Day"/"Bowl Soup Of The Day" items whose OWN stated name is
// exactly what the live bot's decline message named as "real options",
// confirming they are what nameWordIndex found as the false "owner" of
// "of").

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";
import { findOffMenuCategoryMismatch, OFF_MENU_HEAD_NOUN_STOPWORDS } from "./resolve-item.ts";

const BISQUE_CUP = "f0000000-0000-0000-0000-000000000011";
const BISQUE_BOWL = "f0000000-0000-0000-0000-000000000012";
const SOTD_CUP = "f0000000-0000-0000-0000-000000000013";
const SOTD_BOWL = "f0000000-0000-0000-0000-000000000014";
const CHIX_NOODLE_CUP = "f0000000-0000-0000-0000-000000000015";
const CHIX_NOODLE_BOWL = "f0000000-0000-0000-0000-000000000016";

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
  realItem(BISQUE_CUP, "Lobster Bisque - Cup", "Soup", 495),
  realItem(BISQUE_BOWL, "Lobster Bisque - Bowl", "Soup", 695),
  realItem(SOTD_CUP, "Cup Soup Of The Day", "Soup", 395),
  realItem(SOTD_BOWL, "Bowl Soup Of The Day", "Soup", 550),
  realItem(CHIX_NOODLE_CUP, "Chicken Noodle Soup - Cup", "Soup", 395),
  realItem(CHIX_NOODLE_BOWL, "Chicken Noodle Soup - Bowl", "Soup", 550),
];

// Deliberately no "cup"/"bowl" word inside the Lobster Bisque / Chicken
// Noodle terms themselves (same documented real-data gap
// soup-size-cup-bowl-20260919.test.ts's own fixture relies on) -- size comes
// from the item's own NAME via narrowAmbiguousCandidatesBySpanSize, not the
// lexicon term. "Soup Of The Day"'s own terms DO literally carry "cup"/
// "bowl"/"of" -- that's the real shape that fooled the old veto.
const LEXICON: Array<{ term: string; target_id: string; category: string | null; size_label: string | null }> = [
  { term: "lobster bisque", target_id: BISQUE_CUP, category: "Soup", size_label: null },
  { term: "lobster bisque", target_id: BISQUE_BOWL, category: "Soup", size_label: null },
  { term: "soup of the day", target_id: SOTD_CUP, category: "Soup", size_label: null },
  { term: "cup soup of the day", target_id: SOTD_CUP, category: "Soup", size_label: null },
  { term: "soup of the day", target_id: SOTD_BOWL, category: "Soup", size_label: null },
  { term: "bowl soup of the day", target_id: SOTD_BOWL, category: "Soup", size_label: null },
  { term: "chicken noodle soup", target_id: CHIX_NOODLE_CUP, category: "Soup", size_label: null },
  { term: "chicken noodle", target_id: CHIX_NOODLE_CUP, category: "Soup", size_label: null },
  { term: "chicken noodle soup", target_id: CHIX_NOODLE_BOWL, category: "Soup", size_label: null },
  { term: "chicken noodle", target_id: CHIX_NOODLE_BOWL, category: "Soup", size_label: null },
];

function makeFakeSupabase() {
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
    conversationId: "conv-befc0c6a-lobster-bisque",
    shopId: "shop-repro",
    tenantId: "shop-repro",
    cartId: "cart-repro",
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

function proposeAdd(itemSpan: string): RunTurnDeps["proposeTurnFn"] {
  return (): Promise<ProposeResult> => Promise.resolve({
    ok: true, attempts: 1,
    proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity: 1, choices: [] }], removes: [], modifies: [] },
  });
}

Deno.test("unit: offMenuCategoryMismatchWord never picks 'of' as the head noun for 'a cup of Lobster Bisque'", () => {
  const mismatch = findOffMenuCategoryMismatch("a cup of Lobster Bisque", LEXICON);
  assertEquals(mismatch, null, `must never veto a real, resolvable item on a preposition: ${JSON.stringify(mismatch)}`);
});

Deno.test("unit: OFF_MENU_HEAD_NOUN_STOPWORDS covers the exact words the PO named", () => {
  for (const w of ["of", "a", "side", "cup", "order"]) {
    assert(OFF_MENU_HEAD_NOUN_STOPWORDS.has(w), `stopword list must contain "${w}"`);
  }
});

Deno.test("runner (PO fixture, real conv befc0c6a): 'a cup of Lobster Bisque, please' lands the real $4.95 Cup Lobster Bisque Soup, no veto text", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Lobster Bisque - Cup"),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "Hi, I'd like to order a cup of Lobster Bisque, please." }),
    deps,
  );
  assertEquals(result.cart.length, 1, `must add the real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, BISQUE_CUP, `must add Cup Lobster Bisque specifically: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have/i.test(result.reply), `must never render the off-menu veto text: ${JSON.stringify(result.reply)}`);
  assert(!/"of"|like "of"/i.test(result.reply), `must never print the bare preposition "of" as a category: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture): 'a bowl of lobster bisque' lands the real Bowl Lobster Bisque Soup, no veto text", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Lobster Bisque - Bowl"),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get a bowl of lobster bisque" }),
    deps,
  );
  assertEquals(result.cart.length, 1, `must add the real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, BISQUE_BOWL, `must add Bowl Lobster Bisque specifically: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have/i.test(result.reply), `must never render the off-menu veto text: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture): 'a cup of chicken noodle soup' lands correctly, no veto text", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: proposeAdd("Chicken Noodle Soup - Cup"),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "a cup of chicken noodle soup please" }),
    deps,
  );
  assertEquals(result.cart.length, 1, `must add the real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CHIX_NOODLE_CUP, `must add the Cup Chicken Noodle Soup specifically: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have/i.test(result.reply), `must never render the off-menu veto text: ${JSON.stringify(result.reply)}`);
});
