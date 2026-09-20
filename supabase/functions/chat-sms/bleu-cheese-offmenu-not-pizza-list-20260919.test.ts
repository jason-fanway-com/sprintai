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
// Real Vito's Pepperoni pizza (large), used only by the multi-add/
// restatement fixtures below -- 2026-09-20 PO dispatch, real conv f72f7387
// #5 follow-up (see this file's own header addendum below).
const PEPPERONI_LARGE = "c4aaf384-fb4d-47c0-b2f3-b28e499d9c39";

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
  {
    id: PEPPERONI_LARGE, name: "Large Pepperoni Pizza", category: "Pizza", price_cents: 2100,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "", compiler_version: 1, display_name: "Large Pepperoni Pizza",
      base_price_cents: 2100, recap_template: "", ticket_template: "", steps: [],
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
  { term: "pepperoni pizza", target_id: PEPPERONI_LARGE, active: true },
  { term: "pepperoni", target_id: PEPPERONI_LARGE, active: true },
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

// 2026-09-20 PO dispatch (follow-up, real conv f72f7387 #5, live $16.50
// charge): the fix above was verified only against "Bleu Cheese" as the
// WHOLE message, alone. The real live fixture names it as ONE OF SEVERAL
// items in the SAME multi-add proposal ("a large pepperoni pizza and 1
// Bleu Cheese"), and the customer then RESTATES it alone on the next turn
// after the first mention correctly declines. Root-caused (not merely
// re-verified) via a fixed decide()-direct probe against real, live Vito's
// data (~/po-scratch/probe-decide-with-inactive.ts -- the pre-existing
// ~/po-scratch/probe-decide.ts never fetches or passes decide()'s
// inactiveLexicon argument at all, defaulting it to `[]`; running that
// UNFIXED probe against this exact multi-add fixture reproduces the "3
// Cheese pizzas" bug on this exact branch, but it is the probe tool that is
// missing the wiring, not turn-engine.ts -- production's
// turn-engine-runner.ts already loads and threads inactiveLexicon through
// every decide() call site, single-item or multi-item alike, unconditionally
// (loadExcludedItemLexicon, called once per turn, never scoped to how many
// adds the proposal carries or what else is in the message).
//
// Concretely: resolveItem's veto (findLongerInactiveTerm, resolve-item.ts)
// fires once per add.item_span, independently, before ANY add's ambiguous/
// resolved branch is reached (turn-engine.ts's per-add loop) -- so a second,
// unrelated, cleanly-resolved add earlier or later in the SAME proposal
// (the pepperoni pizza here) never gets a chance to leak a stray size word
// into "Bleu Cheese"'s own resolution, because the veto already converted
// that add to `unresolved` before narrowAmbiguousCandidatesBySpanSize (the
// function whose own rawMessageSizeWordForSpan fallback scans the RAW
// customer message for ANY size word, real live bug mechanism: "large"
// from "a large pepperoni pizza..." narrowing an ambiguous "Bleu Cheese"
// tie down to Large Cheese Pizza) ever runs at all -- that function is
// gated strictly behind resolveItem returning "ambiguous", which the veto
// preempts. The restatement turn re-enters this exact same per-add loop
// fresh (a brand-new PROPOSE, decide()'s own restating-guard territory --
// see 00-BD's own doc above decide()'s signature) precisely BECAUSE the
// first turn's veto already stopped a disambiguation from ever opening for
// "Bleu Cheese" -- there is no pending "which one?" question left open for
// the restatement to answer instead, so it never reaches answer()'s
// completely separate resolver family (messageNamesItemOutsideCandidates /
// resolveKindClauseViaLexicon), which is the ONLY code path in this file
// that does not receive inactiveLexicon (AnswerExternalInputs carries no
// such field) -- confirmed by inspection this dispatch, not exercised by
// either fixture below, since nothing is ever left open for it to answer.
Deno.test("runner (PO dispatch, real conv f72f7387 #5, multi-add): 'a large pepperoni pizza and 1 Bleu Cheese' adds only the pizza, never the 3 Cheese pizzas", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { item_span: "large pepperoni pizza", quantity: 1, choices: [] },
          { item_span: "Bleu Cheese", quantity: 1, choices: [] },
        ],
        removes: [], modifies: [],
      },
    }),
  };

  const result = await runTurnEngineTurn(
    baseInput({ message: "a large pepperoni pizza and 1 Bleu Cheese" }),
    deps,
  );

  assertEquals(result.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `must add exactly the pepperoni pizza, nothing for Bleu Cheese: ${JSON.stringify(result.cart)}`);
  assertEquals(result.cart[0].menu_item_id, PEPPERONI_LARGE,
    `the one cart line must be the pepperoni pizza, never a Cheese pizza: ${JSON.stringify(result.cart)}`);
  assert(!/cheese - (large|small|medium)/i.test(result.reply), `must never offer the Cheese pizza list: ${JSON.stringify(result.reply)}`);
  assert(!/which one would you like/i.test(result.reply), `must never open a disambiguation for Bleu Cheese: ${JSON.stringify(result.reply)}`);
  assert(/bleu cheese/i.test(result.reply), `must name what the customer actually asked for: ${JSON.stringify(result.reply)}`);
  assert(/pepperoni pizza added/i.test(result.reply), `the real item must still be confirmed added: ${JSON.stringify(result.reply)}`);

  // Turn 2: restate the declined item alone, after the pizza already landed.
  const deps2: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [{ item_span: "1 Bleu Cheese", quantity: 1, choices: [] }],
        removes: [], modifies: [],
      },
    }),
  };
  const turn2 = await runTurnEngineTurn(
    baseInput({
      message: "And I still want the 1 Bleu Cheese",
      cart: result.cart,
      dialogueState: result.dialogueState,
      history: [
        { role: "user", content: "a large pepperoni pizza and 1 Bleu Cheese" },
        { role: "assistant", content: result.reply },
      ],
    }),
    deps2,
  );

  assertEquals(turn2.cart.filter(l => typeof l.menu_item_id === "string").length, 1,
    `restating must never add a second cart line: ${JSON.stringify(turn2.cart)}`);
  assertEquals(turn2.cart[0].menu_item_id, PEPPERONI_LARGE,
    `cart must still hold only the pepperoni pizza -- never a Cheese pizza -- after the restatement: ${JSON.stringify(turn2.cart)}`);
  assert(!/large cheese pizza added/i.test(turn2.reply), `must never silently add a Cheese pizza on restatement: ${JSON.stringify(turn2.reply)}`);
  assert(!/cheese - (large|small|medium)/i.test(turn2.reply), `must never offer the Cheese pizza list on restatement: ${JSON.stringify(turn2.reply)}`);
  assert(/bleu cheese/i.test(turn2.reply), `restatement must still get the same honest off-menu decline: ${JSON.stringify(turn2.reply)}`);
});
