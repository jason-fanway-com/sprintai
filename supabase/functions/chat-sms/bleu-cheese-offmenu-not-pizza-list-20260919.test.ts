// PO dispatch (2026-09-19/20, real transcript conv 009de656 #5, live QA):
// "can I add a side of Bleu Cheese" wrongly ties resolveItem's own single-
// word "cheese" term across 3 unrelated Cheese Pizza sizes — the customer
// never asked for a pizza. DEFECT 3 (resolve-item.ts, already on main
// before this dispatch) fixed the RESOLVER half of this: once the shop's
// own excluded, more-specific term ("bleu cheese" -> the real "Bleu Cheese"
// row, bot_state "display_only", a Buffalo Chicken pizza finish, never a
// standalone orderable side) is visible to resolveItem via
// `inactiveLexicon`, it correctly refuses to guess and returns
// `{ kind: "unresolved" }` instead of the 3-pizza ambiguous list.
//
// What was still missing (this dispatch's own fix, turn-engine.ts): a bare
// "unresolved" rendered as the generic "Sorry, I didn't catch 'bleu
// cheese' — mind saying it again?" — misleading (the customer's words were
// heard just fine) and never mentions that "Bleu Cheese" IS real, curated,
// owner-confirmed data on this exact shop: every one of Vito's 14 real
// Salads items carries it as a genuine "Dressing" slot choice (verified
// directly against the shop's own live `menu_items.ask_plan`, shop_id
// e0000000-0000-0000-0000-000000000001, id a9f637bb-8264-44ef-b6c1-
// a5ffb4a83391 "House" — real choice id 1af6b431-0e2f-44f7-89fa-
// 388bad8fb334, real Dressing option_group). findVetoedOffMenuTerm
// (resolve-item.ts) + findOffMenuChoiceAlternative (turn-engine.ts) close
// that gap: the customer now gets told the real, specific alternative
// instead of a "didn't catch that" non-answer.
//
// METHODOLOGY (standing rule, 2026-09-19: a fix verified only against
// decide()/answer() unit fixtures shipped broken live): this drives the
// REAL production call path, turn-engine-runner.ts's runTurnEngineTurn —
// PROPOSE mocked, everything downstream (resolveItem, decide, render) is
// the genuine, unmodified production code. Every id, name, category, and
// ask_plan shape below is REAL Vito's data (shop_id e0000000-0000-0000-
// 0000-000000000001), queried directly and reproduced verbatim — never
// invented — matching this file's own DEFECT 3 sibling coverage in
// resolve-item.test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-19/20 — see this file's own header.
const CHEESE_LARGE = "8857b40a-e53b-44fa-8bf0-6fdafb7efa45";
const CHEESE_SMALL = "c7e77443-c55f-4a81-bca1-999b61cc55d3";
const CHEESE_MEDIUM = "fefa53d0-6ca0-4a9b-a507-a80801ae0ab2";
const BLEU_CHEESE_DISPLAY_ONLY_ID = "6074cba8-b25b-4be4-80ec-a8ce9816f19f";
const HOUSE_SALAD_ID = "a9f637bb-8264-44ef-b6c1-a5ffb4a83391";
const HOUSE_DRESSING_GROUP = "1c9f5bb5-aca0-4e41-ae6f-9b9e151fd35a";
const HOUSE_BLEU_CHEESE_CHOICE_ID = "1af6b431-0e2f-44f7-89fa-388bad8fb334";

const MENU: TurnEngineMenuItem[] = [
  {
    id: CHEESE_LARGE, name: "Cheese - Large (16\")", category: "Pizza", price_cents: 1650,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Cheese - Large (16\")",
      base_price_cents: 1650, recap_template: "", ticket_template: "", steps: [],
    },
  },
  {
    id: CHEESE_SMALL, name: "Cheese - Small (10\")", category: "Pizza", price_cents: 1295,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Cheese - Small (10\")",
      base_price_cents: 1295, recap_template: "", ticket_template: "", steps: [],
    },
  },
  {
    id: CHEESE_MEDIUM, name: "Cheese - Medium (14\")", category: "Pizza", price_cents: 1495,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Cheese - Medium (14\")",
      base_price_cents: 1495, recap_template: "", ticket_template: "", steps: [],
    },
  },
  // Real Vito's "House" salad — its own ask_plan's first step is a required
  // Dressing slot whose real choices include "Bleu Cheese" (id
  // 1af6b431-0e2f-44f7-89fa-388bad8fb334), verbatim off the live row.
  {
    id: HOUSE_SALAD_ID, name: "House", category: "Salads", price_cents: 899,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "House",
      base_price_cents: 899, recap_template: "", ticket_template: "",
      steps: [{
        kind: "slot", ask_mode: "ask", group_id: HOUSE_DRESSING_GROUP, slot_key: null,
        prompt_template: "dressing.ask",
        choices: [
          { id: "french-id", display: "French", price_delta_cents: 0 },
          { id: HOUSE_BLEU_CHEESE_CHOICE_ID, display: "Bleu Cheese", price_delta_cents: 0 },
          { id: "ranch-id", display: "Ranch", price_delta_cents: 0 },
        ],
      }],
    },
  },
];

// Real Vito's active item-lexicon rows for the Cheese Pizza family — the
// exact fixture this file's DEFECT 3 sibling test in resolve-item.test.ts
// (REAL_VITOS_CHEESE_LEXICON) already documents.
const ACTIVE_ITEM_LEXICON = [
  { term: "cheese", target_id: CHEESE_LARGE, active: true },
  { term: "cheese", target_id: CHEESE_SMALL, active: true },
  { term: "cheese", target_id: CHEESE_MEDIUM, active: true },
];
// The real, excluded (bot_state "display_only") "bleu cheese" item-lexicon
// row — production's loadExcludedItemLexicon own query (active=false).
const INACTIVE_ITEM_LEXICON = [
  { term: "bleu cheese", target_id: BLEU_CHEESE_DISPLAY_ONLY_ID, active: false },
];
const ALL_LEXICON_ROWS = [...ACTIVE_ITEM_LEXICON, ...INACTIVE_ITEM_LEXICON];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-009de656-bleu-cheese",
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

// Distinguishes the `active` eq() filter per query (unlike this suite's
// other fake-supabase helpers, which return the same rows regardless of
// `active` — fine for those files' own scenarios, but this fix depends
// entirely on loadItemLexicon's active=true rows and loadExcludedItemLexicon's
// active=false rows actually being DIFFERENT sets, exactly as they are live).
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
        // Serves loadItemLexicon's own post-pagination count-only query
        // (`.select("id", {count:"exact", head:true}).eq(...).eq(...)
        // .eq("active", true)`), awaited directly off the builder chain
        // with no further `.range()` call.
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

Deno.test("runner (PO fixture, real conv 009de656): 'can I add a side of Bleu Cheese' never offers the 3 Cheese pizzas, names the real Salads Dressing alternative instead", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "Bleu Cheese", quantity: 1, choices: [] }],
        removes: [], modifies: [],
      },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I add a side of Bleu Cheese" }),
    deps,
  );

  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 0,
    `must never silently add anything: ${JSON.stringify(result.cart)}`);
  assert(!/cheese - (large|small|medium)/i.test(result.reply), `must never offer the Cheese pizza list: ${JSON.stringify(result.reply)}`);
  assert(!/\$16\.50|\$12\.95|\$14\.95/.test(result.reply), `must never quote a pizza price as if it were the answer: ${JSON.stringify(result.reply)}`);
  assert(!/didn't catch/i.test(result.reply), `must not claim it mis-heard a clearly-typed item: ${JSON.stringify(result.reply)}`);
  assert(/bleu cheese/i.test(result.reply), `must name what the customer actually asked for: ${JSON.stringify(result.reply)}`);
  assert(/salad/i.test(result.reply), `must point at the real alternative (Bleu Cheese is a genuine Salads Dressing choice): ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (no regression): a genuinely different, real ambiguous case (no size stated) still falls back to the existing ambiguous-list behavior", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "cheese pizza", quantity: 1, choices: [] }],
        removes: [], modifies: [],
      },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "can I get a cheese pizza" }),
    deps,
  );

  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 0,
    `no size stated -> must never silently pick a size: ${JSON.stringify(result.cart)}`);
  assert(!/we don't have a/i.test(result.reply), `this fix's new off-menu decline must not fire for a genuine, real tie: ${JSON.stringify(result.reply)}`);
  assert(/size|small|medium|large|10|14|16/i.test(result.reply), `must still ask which size, exactly as before this fix: ${JSON.stringify(result.reply)}`);
});
