// PO dispatch (2026-09-20, live money regression, v567 50-run conv 7ecc60e6
// #30): the bleu-cheese off-menu veto (findVetoedOffMenuTerm /
// findLongerInactiveTerm, resolve-item.ts, landed tonight as 33ca23ad) fires
// whenever an INACTIVE lexicon term matches MORE of the span than the
// active-lexicon match it's about to guess with -- correct when the longer,
// excluded term names something that genuinely isn't orderable (bleu
// cheese), wrong here: real Vito's compiler emits an active, SHORTER alias
// ("chicken noodle", 2 words, ties Cup AND Bowl) alongside an INACTIVE,
// longer, full-name term for the exact same real item ("chicken noodle -
// cup"/"- bowl", 3 words, target_id = that same Cup/Bowl item). The veto
// can't tell "this excluded term names nothing real" apart from "this
// excluded term is just this SAME real item's own fuller name" -- it fired
// on the latter, and "I'd like a Chicken Noodle Cup" got refused outright on
// a real, live, $4.99/$7.99 orderable soup that landed correctly on every
// build before v566.
//
// Root cause confirmed live against Vito's own data (shop_id
// e0000000-0000-0000-0000-000000000001): every lexicon row below (both
// active and inactive) and both menu items (ids, size_label, price_cents,
// ask_plan.display_name) are the shop's REAL rows, queried directly
// 2026-09-20 -- never invented.
//
// Fix (resolve-item.ts, findLongerInactiveTerm): only veto when the longer
// inactive term's OWN target_id is not already among the candidates the
// normal (active-lexicon) resolution path already resolved or tied to. If
// the real resolution already reaches that same item -- resolved OR tied --
// the veto is not naming something absent from the menu, so it never fires.
// Bleu Cheese still vetoes: its excluded term's target (a display_only
// Buffalo-finish row) is never among the 3 unrelated Cheese pizzas the bare
// "cheese" term ties to.
//
// METHODOLOGY (standing rule tonight): drives the REAL production call path,
// turn-engine-runner.ts's runTurnEngineTurn -- PROPOSE mocked, everything
// downstream (resolveItem, decide, render) is the genuine, unmodified
// production code, exactly like this file's own bleu-cheese sibling
// (bleu-cheese-offmenu-not-pizza-list-20260919.test.ts). Both the active AND
// inactive lexicon rows below are threaded through, matching production's
// own loadItemLexicon/loadExcludedItemLexicon split -- the exact wiring gap
// (~/po-scratch/probe-decide.ts silently defaulting inactiveLexicon to `[]`)
// that caused real confusion earlier tonight is avoided here the same way
// this file's own bleu-cheese sibling avoids it (makeFakeSupabase's `active`
// eq() filter actually splits the two sets, as it does live).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-20 -- see this file's own header.
const CHICKEN_NOODLE_CUP = "721d8cd0-5d93-49cf-9a00-94dfd4ad6bc9";
const CHICKEN_NOODLE_BOWL = "3139ab05-94f3-41da-858b-efcc044ee859";

const MENU: TurnEngineMenuItem[] = [
  {
    id: CHICKEN_NOODLE_CUP, name: "Chicken Noodle - Cup", category: "Soups", price_cents: 499,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "Cup Chicken Noodle Soup",
      base_price_cents: 499, recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}", steps: [],
    },
  },
  {
    id: CHICKEN_NOODLE_BOWL, name: "Chicken Noodle - Bowl", category: "Soups", price_cents: 799,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "Bowl Chicken Noodle Soup",
      base_price_cents: 799, recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}", steps: [],
    },
  },
];

// Real Vito's active item-lexicon rows targeting these two items (queried
// live 2026-09-20). "chicken noodle" (2 words) ties BOTH items -- neither
// carries a 3-word ACTIVE alias naming its own size.
const ACTIVE_ITEM_LEXICON = [
  { term: "chickennoodles", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "noodles", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cupchickennoodlesoups", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cupchickennoodle", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "noodle", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cup chicken noodle soups", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "soups", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "noodle soup", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chicken noodle", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "noodle soups", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chicken noodles", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "bowlchickennoodlesoup", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "soup", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chickennoodle", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chicken noodle soups", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cup chicken noodle soup", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cupchickennoodlesoup", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cup chicken noodles", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chicken noodle soup", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "cup chicken noodle", target_id: CHICKEN_NOODLE_CUP, active: true },
  { term: "chicken noodle", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowl chicken noodle soups", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowlchickennoodle", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "noodle", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "chicken noodles", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "noodles", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "chicken noodle soups", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowlchickennoodles", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "soups", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "noodle soups", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "chickennoodles", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "noodle soup", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "chickennoodle", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowl chicken noodle soup", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "chicken noodle soup", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowl chicken noodles", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "bowl chicken noodle", target_id: CHICKEN_NOODLE_BOWL, active: true },
  { term: "soup", target_id: CHICKEN_NOODLE_BOWL, active: true },
];
// Real Vito's excluded (active=false) item-lexicon rows for these same two
// items -- these are the actual live rows that fire the veto (the ROOT
// CAUSE): each is just the item's OWN full name, longer than the 2-word
// active "chicken noodle" alias above, targeting the SAME real item.
const INACTIVE_ITEM_LEXICON = [
  { term: "bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "- bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chickennoodle-bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chickennoodle-bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "- bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "noodle bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chicken noodle - bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chicken noodle bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chickennoodlebowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "noodle - cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chickennoodlecup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chickennoodle-cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chickennoodle-cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "- cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chickennoodlecups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chicken noodle cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "- cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "noodle cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chicken noodle - cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chicken noodle cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "noodle bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "noodle cup", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "chicken noodle bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chicken noodle - cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "noodle - bowl", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "noodle - cups", target_id: CHICKEN_NOODLE_CUP, active: false },
  { term: "noodle - bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
  { term: "chicken noodle - bowls", target_id: CHICKEN_NOODLE_BOWL, active: false },
];
const ALL_LEXICON_ROWS = [...ACTIVE_ITEM_LEXICON, ...INACTIVE_ITEM_LEXICON];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-7ecc60e6-chicken-noodle",
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

// Same shape as this file's bleu-cheese sibling's own makeFakeSupabase --
// distinguishes the `active` eq() filter per query, exactly as production's
// loadItemLexicon (active=true) / loadExcludedItemLexicon (active=false)
// actually do live.
// deno-lint-ignore no-explicit-any
function makeFakeSupabase(): any {
  function builder(table: string) {
    // deno-lint-ignore no-explicit-any
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
        const filtered = ALL_LEXICON_ROWS.filter(r => r.active === eqFilters["active"]);
        return Promise.resolve({
          data: filtered.slice(from, to + 1).map(r => ({ term: r.term, target_id: r.target_id })),
          error: null,
        });
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
          const filtered = ALL_LEXICON_ROWS.filter(r => r.active === eqFilters["active"]);
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

async function runAdd(message: string, itemSpan: string) {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: itemSpan, quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  return runTurnEngineTurn(baseInput({ message }), deps);
}

Deno.test("runner (PO fixture, live conv 7ecc60e6 #30): 'Chicken Noodle - Cup' adds the real Cup Chicken Noodle Soup, never refused", async () => {
  const result = await runAdd("I'd like to order a Chicken Noodle Cup", "Chicken Noodle - Cup");
  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `must add exactly one real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CHICKEN_NOODLE_CUP,
    `must add the Cup soup, never the Bowl or nothing: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline a real, orderable item: ${JSON.stringify(result.reply)}`);
  assert(!/what would you like to order/i.test(result.reply), `must never bounce back to a blank prompt: ${JSON.stringify(result.reply)}`);
  assert(/chicken noodle soup added|cup chicken noodle soup/i.test(result.reply), `must confirm the real item added: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture, live conv 7ecc60e6 #30 variant): 'Chicken Noodle Cup' (no dash) also adds the Cup soup, never refused", async () => {
  const result = await runAdd("Just the Chicken Noodle Cup for pickup, please.", "Chicken Noodle Cup");
  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `must add exactly one real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CHICKEN_NOODLE_CUP, `must add the Cup soup: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline a real, orderable item: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture, live conv 7ecc60e6 #30): 'Chicken Noodle - Bowl' adds the real Bowl Chicken Noodle Soup, never refused", async () => {
  const result = await runAdd("Chicken Noodle - Bowl", "Chicken Noodle - Bowl");
  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `must add exactly one real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CHICKEN_NOODLE_BOWL,
    `must add the Bowl soup, never the Cup or nothing: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline a real, orderable item: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture, live conv 7ecc60e6 #30 variant): 'Chicken Noodle Bowl' (no dash) also adds the Bowl soup, never refused", async () => {
  const result = await runAdd("Chicken Noodle Bowl", "Chicken Noodle Bowl");
  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `must add exactly one real item: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, CHICKEN_NOODLE_BOWL, `must add the Bowl soup: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline a real, orderable item: ${JSON.stringify(result.reply)}`);
});
