// PO dispatch (2026-09-20, live money regression, v575 rerun #41, real conv
// b71cbbdc-8eb0-4fa2-abea-c73fae10c279, PAID): the customer's first message
// named FOUR things in one breath -- "2 house salads", "bleu cheese
// dressing", "shrimp", "black diamond steak" -- and PROPOSE split them into
// four separate `adds` (real error_log propose_success row, quoted verbatim
// below). "shrimp"/"black diamond steak" correctly fold onto the House
// Salad's own Add-ons (00-BF modifier floor, unaffected by this fix) with no
// decline at all. "bleu cheese dressing" did NOT: findVetoedOffMenuTerm
// (resolve-item.ts) found the shop's real, curated, but EXCLUDED "bleu
// cheese" item term (a display_only Pizza-Finish row) and vetoed the guess,
// producing a wrong, customer-facing decline -- "We don't have a 'bleu
// cheese' side on its own, but it's a real option on our Pizza" -- even
// though "Bleu Cheese" is ALSO a genuine, exact Dressing CHOICE on the House
// Salad the SAME message already resolved. The customer went on to order a
// medium Mikes Hot n Honey pizza and 2 Grandma's pizzas across the next few
// turns; the conversation was paid at $46.97 for 2 House Salads only -- the
// pizza and the two Grandma's never entered the cart, and nothing in the
// conversation ever told the customer that.
//
// 4e0ad853 (fix/offmenu-veto-never-blocks-real-resolve-20260920, landed
// earlier the same night) already stopped this veto from firing once a span
// resolves as a real ITEM elsewhere -- confirmed by reading that commit's
// own diff (`git show 4e0ad853`): it only widened findLongerInactiveTerm to
// skip an inactive term whose target_id is already among the caller's own
// resolvedTargetIds. That fix has NO effect here: "bleu cheese dressing"
// never resolves as an item anywhere (Bleu Cheese is not a standalone menu
// item at Vito's) -- it's a genuine CHOICE belonging to a DIFFERENT add
// (House Salad) in the same proposal, a shape 4e0ad853's own fix never
// covered. The dispatch that reported this bug described it as "the wording
// bug was already fixed at 4e0ad853, but something else must still be
// wrong" and guessed there might be a second, stale render site for the
// decline text. Verified false: `grep -rn "real option on our"` across the
// entire repo (both chat-sms engines) finds exactly ONE call site
// (turn-engine.ts's add-resolution loop, the `else` branch below the
// "ambiguous" case) -- there is no second path. The wrong "Pizza" wording
// was not a stale copy; it's `findOffMenuChoiceAlternative` scanning the
// FULL, unordered `menu` array for the first ANY item whose ask_plan has an
// exact "Bleu Cheese" choice -- Vito's data has "Bleu Cheese" as a real
// choice on several unrelated Pizza-family items' own topping/finish steps
// AND on House Salad's own Dressing step, so which category prints is
// incidental to menu array order, not a second code path (confirmed by
// running this same scenario against the LIVE lexicon/menu with
// ~/po-scratch/probe-decide.ts: an unordered menu_items fetch returned
// "Salads" one run and would return "Pizza" on another ordering -- the same
// single call site, non-deterministic output). Both symptoms (bug 1 and bug
// 2) share one root cause and are closed by the SAME fix below; the
// wrong-category selection for a genuinely standalone off-menu ask (nothing
// else in the message to fold onto -- resolve-item.ts's own DEFECT 3
// scenario) is a separate, narrower latent issue this dispatch does NOT fix
// (see this file's own "standalone" test below, which intentionally still
// declines) -- fixing it would require deciding which of several real,
// equally-valid categories to name when a term is a genuine choice on more
// than one, which is a product call, not a confirmed bug tied to this live
// regression.
//
// FIX (turn-engine.ts, decide()'s add-resolution loop, the veto branch):
// before creating a decline from `findVetoedOffMenuTerm`'s result, check
// whether the vetoed span is a real choice (or fully decomposes into real
// choices) of an item this SAME message's proposal has already resolved so
// far -- the exact same two helpers (`spanIsWholeChoiceOfAnyAdd`,
// `spanFoldTargetForAmbiguousOrUnresolvedSpan`) this file already uses,
// post-loop, to keep an ordinary (non-vetoed) unresolved span from opening a
// bogus "I didn't catch that" decline once it turns out to double as a
// sibling's own choice. When either matches, the veto decline never fires --
// the span instead falls through to the exact same `genuinelyUnresolvedSpans`
// path an ordinary unresolved span already takes, and the SAME downstream
// mechanisms handle it exactly as they already handle "shrimp"/"black
// diamond steak" in this real message: a MODIFIER choice (Add-ons) is picked
// up by the 00-BF modifier floor with no question asked; a SLOT choice
// (Dressing) is -- BY EXISTING, UNCHANGED, DELIBERATE DESIGN
// ("slots are ASKED, never inferred", spanFoldTargetForAmbiguousOrUnresolvedSpan's
// own header) -- still asked as a normal dressing question, never silently
// guessed. That last point matters: a WORKING (non-buggy) real conversation
// with the identical shape (run-v575-0325.log, session 09ff84fe, no veto
// ever fired because that draw's proposal never split off a standalone
// "bleu cheese dressing" add) ALSO asks "Which dressing on the House?" in
// this exact situation -- so this fix does not, and should not, make that
// question disappear; it only stops the wrong DECLINE from firing in front
// of it. Whether the still-open Dressing question then blocks the Mikes Hot
// n Honey / Grandma's pizzas from landing on the FOLLOWING turn is a
// SEPARATE, already-existing, deliberate guard
// (turn-engine-runner.ts's REMAINDER_ELIGIBLE_OUTCOME_KINDS deliberately
// excludes "slot_resolved", per its own header dated the SAME night: "once a
// turn sets a slot, no item search runs on that turn, full stop" -- added
// specifically to kill a WORSE, real, confirmed money bug where a bonus item
// said alongside a slot answer opened a phantom $91.96-for-$45.98
// disambiguation) -- NOT something this dispatch changes; see this
// dispatch's own PO report for why reverting that guard is out of scope
// here.
//
// METHODOLOGY: drives the real production call path, turn-engine-runner.ts's
// runTurnEngineTurn -- PROPOSE mocked with the REAL captured proposal
// (error_log row 17905e30, conversation 923fe1e3, a same-shape earlier draw
// of this exact persona/goal-seed pair -- b71cbbdc's OWN turn 0 propose_call
// was not logged with a distinct row id but is byte-identical in shape,
// confirmed against the manifest's own turn 0 capture), everything
// downstream (resolveItem, decide, ask, render) is the genuine, unmodified
// production code. MENU/LEXICON below are Vito's own real House Salad
// ask_plan and the real active/inactive item-lexicon rows this repro
// depends on, queried live 2026-09-20 (shop_id
// e0000000-0000-0000-0000-000000000001) -- never hand-invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runTurnEngineTurn,
  type RunTurnInput,
  type RunTurnDeps,
} from "./turn-engine-runner.ts";
import type { ProposeResult } from "./propose.ts";
import type { TurnEngineMenuItem } from "./turn-engine.ts";

// Real Vito's ids (shop_id e0000000-0000-0000-0000-000000000001), queried
// live 2026-09-20.
const HOUSE_SALAD = "a9f637bb-8264-44ef-b6c1-a5ffb4a83391";
const BLEU_CHEESE_DISPLAY_ONLY = "6074cba8-b25b-4be4-80ec-a8ce9816f19f";

// Real House Salad ask_plan (queried live) -- Dressing is a required SLOT
// (ask_mode "ask"), Extra Dressing and Add-ons (Chicken/Blackened Salmon/
// Black Diamond Steak/Shrimp) are on_request MODIFIER steps.
const MENU: TurnEngineMenuItem[] = [
  {
    id: HOUSE_SALAD, name: "House", category: "Salads", price_cents: 899,
    bot_state: "orderable",
    ask_plan: {
      compiled_at: "2026-09-20T04:42:49.794Z", compiler_version: 1, display_name: "House",
      base_price_cents: 899, recap_template: "{qty} {display_name}{, with {modifiers}}",
      ticket_template: "{name}{\n  + {choice.display} x{qty}}",
      steps: [
        {
          kind: "slot", ask_mode: "ask", group_id: "1c9f5bb5-aca0-4e41-ae6f-9b9e151fd35a",
          slot_key: null, prompt_template: "dressing.ask",
          choices: [
            { id: "1715bc67-3d08-4c06-a400-af84f6478a73", display: "French", price_delta_cents: 0 },
            { id: "1af6b431-0e2f-44f7-89fa-388bad8fb334", display: "Bleu Cheese", price_delta_cents: 0 },
            { id: "3206e27a-7e46-48e4-b68a-e740994a0baf", display: "Thousand Island", price_delta_cents: 0 },
            { id: "49a84279-7181-4856-b01d-a4ef639a3720", display: "Caesar", price_delta_cents: 0 },
            { id: "51044484-f31d-41b4-a483-3abe0fdd959b", display: "Jalapeno Ranch", price_delta_cents: 0 },
            { id: "6252125b-9699-40cb-9314-b551e99fbd09", display: "Creamy Italian", price_delta_cents: 0 },
            { id: "9c034fb5-77bc-4e66-b3ad-9367441119b6", display: "Oil-Vinegar", price_delta_cents: 0 },
            { id: "bea28a16-6274-487c-b5cf-0e9193beb68a", display: "Raspberry Vinaigrette", price_delta_cents: 0 },
            { id: "c5e46dfb-c6ec-4270-a460-c0c354020f16", display: "Cilantro Lime", price_delta_cents: 0 },
            { id: "cef0542e-6ce8-47c8-b53d-4879fcb48312", display: "Ranch", price_delta_cents: 0 },
            { id: "e8960d77-8cce-4392-89c2-f9950524e6fb", display: "Honey Mustard", price_delta_cents: 0 },
            { id: "f7ac26da-9b22-4bc6-b643-d9d051fa133a", display: "Italian", price_delta_cents: 0 },
            { id: "f7ec8aa5-734b-4304-ab5a-6139091b9045", display: "House Balsamic", price_delta_cents: 0 },
          ],
        },
        {
          kind: "modifier", ask_mode: "on_request", group_id: "c54a2f6a-3331-47af-acd3-7a84e3ecd4f4",
          slot_key: null, prompt_template: "extra_dressing.on_request",
          choices: [{ id: "e05ba2b4-955e-4f3f-a737-8c2670b7a923", display: "Extra Dressing", price_delta_cents: 50 }],
        },
        {
          kind: "modifier", ask_mode: "on_request", group_id: "df0444a4-149f-4c03-8e7b-4ef4f88e76c1",
          slot_key: null, prompt_template: "add-ons.on_request",
          choices: [
            { id: "619c0983-1827-4b80-9e6e-cbb88ed518a4", display: "Chicken", price_delta_cents: 400 },
            { id: "832329a7-ab84-4755-9e4c-1c08040db2e6", display: "Blackened Salmon", price_delta_cents: 800 },
            { id: "8cf98102-2faa-4869-a1be-f5c22d81d4e8", display: "Black Diamond Steak", price_delta_cents: 800 },
            { id: "a93d731e-e8f6-4dda-800b-ce65c6050fc0", display: "Shrimp", price_delta_cents: 600 },
          ],
        },
      ],
    },
  },
];

// Real active item-lexicon rows targeting House Salad (queried live).
const ACTIVE_ITEM_LEXICON = [
  { term: "house", target_id: HOUSE_SALAD, active: true },
  { term: "house salad", target_id: HOUSE_SALAD, active: true },
  { term: "houses", target_id: HOUSE_SALAD, active: true },
];
// Real excluded (active=false) item-lexicon row that fires the veto: Vito's
// own "Bleu Cheese" row is a real, curated, display_only Pizza-Finish item
// (category "Pizza Finish (Buffalo Chicken)", queried live) -- never a
// standalone orderable side, which is exactly why it's correctly excluded
// from the active item lexicon in the first place.
const INACTIVE_ITEM_LEXICON = [
  { term: "bleu cheese", target_id: BLEU_CHEESE_DISPLAY_ONLY, active: false },
];
const ALL_LEXICON_ROWS = [...ACTIVE_ITEM_LEXICON, ...INACTIVE_ITEM_LEXICON];

function baseInput(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    conversationId: "conv-b71cbbdc-house-bleu-cheese",
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

// Same shape as offmenu-veto-real-item-never-vetoed-20260920.test.ts's own
// makeFakeSupabase -- splits active/inactive lexicon rows by the `active`
// eq() filter, exactly as production's loadItemLexicon/loadExcludedItemLexicon
// actually do live.
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

Deno.test("runner (PO fixture, live conv b71cbbdc, v575 rerun #41): 'bleu cheese dressing' named alongside 'house salads' in the same message never off-menu-declines, and the real Add-ons still fold with no question asked", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    // Real error_log propose_success capture (row 17905e30, conv 923fe1e3 --
    // same persona/goal-seed pair as b71cbbdc's own turn 0, byte-identical
    // shape to the manifest's own capture for b71cbbdc), quoted verbatim.
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: {
        intent: "order",
        adds: [
          { item_span: "house salads", quantity: 2, choices: [] },
          { item_span: "bleu cheese dressing", quantity: 1, choices: [] },
          { item_span: "shrimp", quantity: 1, choices: [] },
          { item_span: "black diamond steak", quantity: 1, choices: [] },
        ],
        removes: [], modifies: [],
      },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "hey! i wanna place an order. lemme get 2 house salads w/ bleu cheese dressing and can i add shrimp and black diamond steak to those?" }),
    deps,
  );

  assert(!/we don't have a/i.test(result.reply), `must never off-menu-decline "bleu cheese dressing" -- it's a real Dressing choice on the House salad named in the same message: ${JSON.stringify(result.reply)}`);
  assert(!/pizza/i.test(result.reply), `must never suggest an unrelated Pizza item for a salad dressing: ${JSON.stringify(result.reply)}`);

  const house = result.cart.find(l => l.menu_item_id === HOUSE_SALAD);
  assert(house, `House salad must be in the cart: ${JSON.stringify(result.cart)}`);
  assertEquals(house!.quantity, 2);
  // 00-BF's modifier floor (unaffected by this fix) already folds MODIFIER
  // choices named in the same message with no question asked -- unchanged,
  // real pre-existing behavior, asserted here only to prove this fix didn't
  // regress it.
  const addOns = house!.ask_plan_selections?.["df0444a4-149f-4c03-8e7b-4ef4f88e76c1"];
  const addOnIds = Array.isArray(addOns) ? addOns : addOns ? [addOns] : [];
  assert(addOnIds.includes("8cf98102-2faa-4869-a1be-f5c22d81d4e8"), `Black Diamond Steak must still fold onto the House add-ons: ${JSON.stringify(house)}`);
  assert(addOnIds.includes("a93d731e-e8f6-4dda-800b-ce65c6050fc0"), `Shrimp must still fold onto the House add-ons: ${JSON.stringify(house)}`);
  // Dressing is a required SLOT -- by existing, unchanged, deliberate design
  // ("slots are ASKED, never inferred"), it is never auto-filled from raw
  // text even when the customer already said "Bleu Cheese" in the same
  // breath. This fix only stops the WRONG DECLINE from firing in front of
  // that question; it does not (and must not) make the question disappear.
  assert(/dressing/i.test(result.reply), `must still ask which dressing (real design, unchanged) instead of guessing: ${JSON.stringify(result.reply)}`);
});

Deno.test("runner (PO fixture, DEFECT 3 regression guard): a standalone off-menu ask with NOTHING else in the message still declines -- this fix must not silence a real off-menu ask that has no sibling item to fold onto", async () => {
  const supabase = makeFakeSupabase();
  const deps: RunTurnDeps = {
    supabase, apiKey: "test-key", newLineKey: newLineKeyCounter(),
    proposeTurnFn: (): Promise<ProposeResult> => Promise.resolve({
      ok: true, attempts: 1,
      proposal: { intent: "order", adds: [{ item_span: "Bleu Cheese", quantity: 1, choices: [] }], removes: [], modifies: [] },
    }),
  };
  const result = await runTurnEngineTurn(
    baseInput({ message: "Can I also get a side of Bleu Cheese?" }),
    deps,
  );
  assert(/we don't have a/i.test(result.reply), `a genuinely standalone off-menu ask (no sibling item in the message to fold onto) must still decline: ${JSON.stringify(result.reply)}`);
  assertEquals(result.cart.length, 0, `nothing should be added for a standalone off-menu ask: ${JSON.stringify(result.cart)}`);
});
