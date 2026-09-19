// PO dispatch 00-AL: ask()'s finite input space, enumerated once and swept
// against 8 invariants, instead of one more example test per live bug found
// by hand (order_type re-asked, address re-asked, address swallowed,
// "Anything else?" over an empty cart — the last two fixed in 00-AH/00-AK).
// ask() (turn-engine.ts) is a pure, total function of (cart, priorState,
// turnEvents, shopContext, menu) — this file enumerates the cross product of
// that space's real dimensions and asserts structural invariants on EVERY
// combination, in one normal `deno test` pass, no mocking of ask() itself.
//
// TEST-ONLY DISPATCH. Do not read a passing run as "ask() is correct" and do
// not read a failing run as something to silently patch here — the failure
// map (which invariant, how many, one concrete example each) IS the
// deliverable the PO asked for. See this file's own report in the dispatch
// thread for the actual counts from the last run.
//
// ─── Why the cross product is exactly 188,160 and not the full type space ──
//
// The six enumerated dimensions below are a DELIBERATE narrowing of the
// underlying types, matching the dispatch's own instructions line for line
// (not every field of DialogueState / AskShopContext / AskTurnEvents gets
// its own axis):
//
//   cart               4   (empty; one line w/ unresolved required slot;
//                            one line fully resolved; two lines resolved)
//   order type         3   (unknown; known-pickup; known-delivery — this
//                            collapses AskShopContext's two independent
//                            fields orderTypeKnown/orderTypeIsDelivery to
//                            the 3 combinations that mean something; the
//                            4th, orderTypeKnown=false + orderTypeIsDelivery
//                            =true, is nonsensical prose, not a real dialogue
//                            state, and isn't one of the 3 named variants the
//                            dispatch asked for)
//   5 booleans        32   (deliveryAddressKnown, driverTipKnown,
//                            pickupNameKnown, deliveryEnabled, upsellEnabled
//                            — full 2^5)
//   priorState.phase   7   (the real 7-value union read off DialogueState)
//   priorState.open   10   (null + the real 9 non-null kinds read off
//                            DialogueState)
//   turnEvents         7   (the 7 variants the dispatch named explicitly as
//                            a minimum — not the full independent 2^4 x 2
//                            product of AskTurnEvents' fields)
//
//   4 * 3 * 32 * 7 * 10 * 7 = 188,160
//
// ─── Skip predicates: NONE — and why that's the honest answer ─────────────
//
// DialogueState.phase, DialogueState.open, AskShopContext's seven booleans,
// and AskTurnEvents' six fields are ALL structurally independent in their
// type definitions — nothing in turn-engine.ts ties e.g. `phase: "confirm"`
// to any particular `open` value, or `pickupNameKnown: true` to any
// particular phase. There is no TypeScript-level cross-field invariant that
// makes any cell of this cross product impossible to construct — every one
// of the 188,160 combinations is a legally typed DialogueState /
// AskShopContext / AskTurnEvents triple. Some are unrealistic dialogue
// histories (e.g. phase "confirm" with an empty cart, or order_type already
// known while priorState.open is still the order_type question) — but
// "unrealistic" is not "unreachable," and stale/adversarial DialogueState is
// exactly the class of live bug this dispatch exists to catch generically
// instead of one transcript at a time. So: 0 states skipped. If a future
// version of this file finds a genuine type-level impossibility, add a named
// predicate function here, wire it into `isSkipped` below, and increment
// SKIPPED_COUNT accordingly — do not silently narrow the loops instead.
const SKIP_PREDICATES: Array<{ name: string; reason: string }> = [];
function isSkipped(_combo: unknown): boolean {
  return false;
}

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ask,
  type DialogueState,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type AskTurnEvents,
  type AskShopContext,
} from "./turn-engine.ts";
import { identityKey } from "./turn-reconciler.ts";

// ─── Fixture menu: one item with a required slot, one plain upsell target —
// deliberately minimal (this sweep is about ask()'s own control flow, not
// menu-compilation fidelity; that's covered elsewhere, e.g. ask-plan-
// engine.test.ts / turn-engine.test.ts's real Vito's Cheese Burger fixture).

const ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ITEM_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const GROUP_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const CHOICE_ID = "cccccccc-0000-0000-0000-000000000001";
const GROUP_NAME = "Size";

const MENU: TurnEngineMenuItem[] = [
  {
    id: ITEM_ID,
    name: "Test Item",
    category: "Test",
    price_cents: 500,
    bot_state: "orderable",
    upsell: "Other Item +1.00",
    option_groups: [{ id: GROUP_ID, name: GROUP_NAME, default_choice_id: null }],
    ask_plan: {
      compiled_at: "2026-01-01T00:00:00.000Z",
      compiler_version: 1,
      display_name: "Test Item",
      base_price_cents: 500,
      recap_template: "{qty} {display_name}",
      ticket_template: "{name}",
      steps: [
        {
          kind: "slot",
          ask_mode: "ask",
          group_id: GROUP_ID,
          slot_key: null,
          prompt_template: "size.ask",
          choices: [{ id: CHOICE_ID, display: "Regular", price_delta_cents: 0 }],
        },
      ],
    },
  },
  {
    id: OTHER_ITEM_ID,
    name: "Other Item",
    category: "Test",
    price_cents: 100,
    bot_state: "orderable",
    option_groups: [],
    ask_plan: {
      compiled_at: "2026-01-01T00:00:00.000Z",
      compiler_version: 1,
      display_name: "Other Item",
      base_price_cents: 100,
      recap_template: "{qty} {display_name}",
      ticket_template: "{name}",
      steps: [],
    },
  },
];

function isRealCartLine(line: TurnEngineCartLine): boolean {
  return typeof line.menu_item_id === "string";
}
function effectiveLineKey(line: TurnEngineCartLine): string {
  return line.line_key ?? identityKey(line.menu_item_id, line.options);
}
function cloneCartLine(l: TurnEngineCartLine): TurnEngineCartLine {
  return {
    ...l,
    options: l.options ? { ...l.options } : undefined,
    ask_plan_selections: l.ask_plan_selections ? { ...l.ask_plan_selections } : undefined,
    pending_options: l.pending_options ? [...l.pending_options] : undefined,
  };
}

// ─── Dimension 1: cart (4) ──────────────────────────────────────────────────

function unresolvedLine(key: string): TurnEngineCartLine {
  return {
    menu_item_id: ITEM_ID, name: "Test Item", quantity: 1, price_cents: 500,
    modifiers: [], pending_options: [GROUP_NAME], line_key: key,
  };
}
function resolvedLine(key: string): TurnEngineCartLine {
  return {
    menu_item_id: ITEM_ID, name: "Test Item", quantity: 1, price_cents: 500,
    modifiers: [], ask_plan_selections: { [GROUP_ID]: CHOICE_ID }, options: { [GROUP_NAME]: ["Regular"] },
    line_key: key,
  };
}

const CART_VARIANTS: Array<{ name: string; build: () => TurnEngineCartLine[] }> = [
  { name: "empty", build: () => [] },
  { name: "oneLineUnresolvedSlot", build: () => [unresolvedLine("line-a")] },
  { name: "oneLineResolved", build: () => [resolvedLine("line-a")] },
  { name: "twoLinesResolved", build: () => [resolvedLine("line-a"), resolvedLine("line-b")] },
];

// ─── Dimension 2: order type (3) ────────────────────────────────────────────

const ORDER_TYPE_VARIANTS: Array<{ name: string; orderTypeKnown: boolean; orderTypeIsDelivery: boolean }> = [
  { name: "unknown", orderTypeKnown: false, orderTypeIsDelivery: false },
  { name: "known-pickup", orderTypeKnown: true, orderTypeIsDelivery: false },
  { name: "known-delivery", orderTypeKnown: true, orderTypeIsDelivery: true },
];

// ─── Dimension 3: 5 independent booleans (32) ───────────────────────────────

const BOOLEAN_KEYS = ["deliveryAddressKnown", "driverTipKnown", "pickupNameKnown", "deliveryEnabled", "upsellEnabled"] as const;
type BooleanKey = typeof BOOLEAN_KEYS[number];

// ─── Dimension 4: priorState.phase (7 — the real union) ────────────────────

const PHASES: DialogueState["phase"][] = ["ordering", "order_type", "address", "tip", "name", "confirm", "link_sent"];

// ─── Dimension 5: priorState.open (null + the real 9 kinds) ────────────────
//
// The "slot" variant's line_key/group_id deliberately match CART_VARIANTS'
// own "line-a" / GROUP_ID rather than an arbitrary placeholder — this is
// what lets invariant 4's slot case actually detect "was this resolved
// since it was asked" against the oneLineResolved/twoLinesResolved cart
// variants, instead of the check being permanently inert because the key
// never matches any real line.

const OPEN_VARIANTS: Array<{ name: string; value: DialogueState["open"] }> = [
  { name: "null", value: null },
  { name: "slot", value: { kind: "slot", line_key: "line-a", group_id: GROUP_ID } },
  { name: "disambiguation", value: { kind: "disambiguation", candidates: [ITEM_ID, OTHER_ITEM_ID] } },
  { name: "upsell", value: { kind: "upsell", menu_item_id: OTHER_ITEM_ID } },
  { name: "order_type", value: { kind: "order_type" } },
  { name: "address", value: { kind: "address" } },
  { name: "tip", value: { kind: "tip" } },
  { name: "name", value: { kind: "name" } },
  { name: "confirm", value: { kind: "confirm" } },
  { name: "ordering", value: { kind: "ordering", askCount: 1 } },
];

// ─── Dimension 6: turnEvents (7 — the dispatch's named minimum set) ────────

const BASE_EVENTS: AskTurnEvents = {
  qualifyingAddMenuItemId: null, disambiguationCandidateIds: null,
  disambiguationSettledThisTurn: false, checkoutIntentThisTurn: false,
  confirmYes: false, confirmNo: false,
};
const TURN_EVENT_VARIANTS: Array<{ name: string; value: AskTurnEvents }> = [
  { name: "allFalse", value: { ...BASE_EVENTS } },
  { name: "confirmYes", value: { ...BASE_EVENTS, confirmYes: true } },
  { name: "confirmNo", value: { ...BASE_EVENTS, confirmNo: true } },
  { name: "checkoutIntentThisTurn", value: { ...BASE_EVENTS, checkoutIntentThisTurn: true } },
  { name: "qualifyingAddMenuItemId", value: { ...BASE_EVENTS, qualifyingAddMenuItemId: ITEM_ID } },
  { name: "disambiguationCandidateIds", value: { ...BASE_EVENTS, disambiguationCandidateIds: [ITEM_ID, OTHER_ITEM_ID] } },
  { name: "disambiguationSettledThisTurn", value: { ...BASE_EVENTS, disambiguationSettledThisTurn: true } },
];

// ─── Invariant 8's owning-phase map (read directly off ask()'s carry() call
// sites — see turn-engine.ts priority list) ─────────────────────────────────

const OWNING_PHASE: Record<string, DialogueState["phase"]> = {
  slot: "ordering", disambiguation: "ordering", upsell: "ordering", ordering: "ordering",
  order_type: "order_type", address: "address", tip: "tip", name: "name", confirm: "confirm",
};

// ─── Invariant 4 ("PROGRESS"): per open-kind "was this resolved THIS turn"
// derivation. slot/disambiguation/confirm have a real signal in the actual
// inputs ask() receives (the cart's own resolvedness for slot,
// disambiguationSettledThisTurn, confirmYes/confirmNo); order_type/address/
// tip/name have no turn-local signal at all in AskTurnEvents — the only
// observable fact is shopContext's "known" boolean, which conflates "became
// known this turn" with "was already known before this question was even
// opened" (an inconsistent-but-constructible prior state, part of this
// sweep's adversarial coverage on purpose). Using "known" as the proxy is
// the correct read for the REAL caller (turn-engine-runner.ts only flips a
// "known" flag to true as a direct consequence of resolving that exact
// question this turn) even though it's an assumption imposed on, not derived
// from, this synthetic per-cell sweep. upsell/ordering have NO derivable
// resolution signal from the inputs at all (upsell_offered flips true the
// INSTANT it's opened, not on resolution, so it can't distinguish "just
// asked" from "just resolved"; the "ordering" nudge question has no
// before/after cart pair in a single static cell) — those two kinds return
// `false` (never assert) rather than fabricate a signal that isn't there.

function progressViolation(
  priorState: DialogueState, result: DialogueState, cart: TurnEngineCartLine[],
  shop: AskShopContext, turnEvents: AskTurnEvents,
): boolean {
  const priorOpen = priorState.open;
  if (!priorOpen) return false;
  const resultOpen = result.open;
  const sameKind = !!resultOpen && resultOpen.kind === priorOpen.kind;

  switch (priorOpen.kind) {
    case "slot": {
      const idx = cart.findIndex(l => isRealCartLine(l) && effectiveLineKey(l) === priorOpen.line_key);
      if (idx < 0) return false;
      const line = cart[idx];
      const resolvedNow = !!(line.ask_plan_selections && Object.prototype.hasOwnProperty.call(line.ask_plan_selections, priorOpen.group_id));
      if (!resolvedNow) return false;
      return sameKind && (resultOpen as { line_key: string; group_id: string }).line_key === priorOpen.line_key
        && (resultOpen as { line_key: string; group_id: string }).group_id === priorOpen.group_id;
    }
    case "order_type":
      return shop.orderTypeKnown && sameKind;
    case "address":
      return shop.deliveryAddressKnown && sameKind;
    case "tip":
      // Round 3, item 2b: "resolved this turn" for tip is now
      // turnEvents.tipResolvedThisTurn, not shop.driverTipKnown — see
      // resolveOpen's "tip" case and DialogueState.driverTipResolved's own
      // doc in turn-engine.ts.
      return turnEvents.tipResolvedThisTurn === true && sameKind;
    case "name":
      return shop.pickupNameKnown && sameKind;
    case "confirm":
      return (turnEvents.confirmYes || turnEvents.confirmNo) && sameKind;
    case "disambiguation": {
      if (!turnEvents.disambiguationSettledThisTurn) return false;
      if (!sameKind) return false;
      const rc = (resultOpen as { candidates: string[] }).candidates;
      const pc = priorOpen.candidates;
      return rc.length === pc.length && rc.every((c, i) => c === pc[i]);
    }
    case "upsell":
    case "ordering":
      return false; // no derivable "resolved this turn" signal — see comment above
    // Round 2, item 1 (2026-09-19): "multi_size" is not one of this sweep's
    // enumerated open-kinds (see this file's header count) — added only to
    // satisfy the exhaustive switch now that DialogueState carries it.
    case "multi_size":
      return false;
    // 2026-09-19 PO dispatch (freeze-queue item 4): same reasoning as
    // "multi_size" immediately above — "category_confirm" is not one of
    // this sweep's enumerated open-kinds, added only to satisfy the
    // exhaustive switch now that DialogueState carries it.
    case "category_confirm":
      return false;
  }
}

// ─── Invariant 5 ("TERMINATION") ───────────────────────────────────────────
//
// Step cap: 30. The longest legitimate priority chain from any of this
// sweep's cart variants is: (>=1 unresolved slot, at most 2 lines x 1 slot
// each in this fixture) -> order_type -> address -> tip -> upsell ->
// "anything else"/ordering-nudge -> name -> confirm -> link_sent, roughly 8
// real stages. 30 is a ~3.5x buffer over that for any combination of
// re-asks the synthetic resolver below might trigger without calling it a
// bug — a state that still hasn't reached link_sent after 30 real ask()
// calls, each one synthetically answering exactly what was just asked, is
// treated as a genuine non-termination finding, not a tuning miss.
const MAX_STEPS = 30;

// Synthetically "answers" whatever `state.open` asked, mutating a cloned
// cart/shopContext and producing the next turn's AskTurnEvents — the
// minimum viable resolution for each kind, not a full ANSWER-step
// simulation (ANSWER itself is out of scope for this dispatch; see header).
function resolveOpen(
  state: DialogueState, cart: TurnEngineCartLine[], shop: AskShopContext,
): { cart: TurnEngineCartLine[]; shop: AskShopContext; events: AskTurnEvents } {
  const nextShop = { ...shop };
  const nextCart = cart.map(cloneCartLine);
  const nextEvents: AskTurnEvents = { ...BASE_EVENTS };
  const open = state.open;

  if (open === null) {
    if (state.phase !== "link_sent") nextEvents.checkoutIntentThisTurn = true;
    return { cart: nextCart, shop: nextShop, events: nextEvents };
  }

  switch (open.kind) {
    case "slot": {
      const idx = nextCart.findIndex(l => isRealCartLine(l) && effectiveLineKey(l) === open.line_key);
      if (idx >= 0) {
        const line = nextCart[idx];
        const menuItem = MENU.find(m => m.id === line.menu_item_id);
        const step = menuItem?.ask_plan?.steps.find(s => s.group_id === open.group_id);
        const groupName = menuItem?.option_groups?.find(g => g.id === open.group_id)?.name ?? open.group_id;
        if (step && step.choices.length > 0) {
          const choice = step.choices[0];
          line.ask_plan_selections = { ...(line.ask_plan_selections ?? {}), [open.group_id]: choice.id };
          line.options = { ...(line.options ?? {}), [groupName]: [choice.display] };
          line.pending_options = (line.pending_options ?? []).filter(n => n !== groupName);
        }
      }
      break;
    }
    case "disambiguation":
      nextEvents.disambiguationSettledThisTurn = true;
      break;
    case "upsell":
      break; // self-resolves: carry()'s upsell_offered=true on priorState blocks re-offer next call
    case "order_type":
      nextShop.orderTypeKnown = true;
      nextShop.orderTypeIsDelivery = false; // resolve to pickup — shortest path, doesn't drag in address/tip
      break;
    case "address":
      nextShop.deliveryAddressKnown = true;
      break;
    case "tip":
      nextShop.driverTipKnown = true;
      // Round 3, item 2b (2026-09-19): ask()'s tip gate no longer trusts
      // shopContext.driverTipKnown (order_carts.driver_tip_cents is NOT
      // NULL DEFAULT 0, so that signal reads "known" from cart creation,
      // before the tip is ever asked — the live bug this fix closes; see
      // DialogueState.driverTipResolved's own doc in turn-engine.ts). The
      // simulated resolution must also produce the turnEvent that's now the
      // real source of truth, or this sweep's own termination loop re-opens
      // "tip" forever.
      nextEvents.tipResolvedThisTurn = true;
      break;
    case "name":
      nextShop.pickupNameKnown = true;
      break;
    case "confirm":
      nextEvents.confirmYes = true;
      break;
    case "ordering":
      nextCart.push(resolvedLine(`sim-${nextCart.length}`));
      nextEvents.qualifyingAddMenuItemId = ITEM_ID;
      break;
  }
  return { cart: nextCart, shop: nextShop, events: nextEvents };
}

function simulateToTermination(
  cart0: TurnEngineCartLine[], priorState0: DialogueState, events0: AskTurnEvents, shop0: AskShopContext,
): { reached: boolean; steps: number; trace: Array<{ phase: DialogueState["phase"]; open: DialogueState["open"] }> } {
  let cart = cart0.map(cloneCartLine);
  let shop = { ...shop0 };
  let events = events0;
  let state = priorState0;
  const trace: Array<{ phase: DialogueState["phase"]; open: DialogueState["open"] }> = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    state = ask(cart, state, events, shop, MENU);
    trace.push({ phase: state.phase, open: state.open });
    if (state.phase === "link_sent") return { reached: true, steps: step + 1, trace };
    const resolved = resolveOpen(state, cart, shop);
    cart = resolved.cart; shop = resolved.shop; events = resolved.events;
  }
  return { reached: false, steps: MAX_STEPS, trace };
}

// ─── The sweep ──────────────────────────────────────────────────────────────

interface ViolationExample {
  comboDesc: string;
  detail: string;
}

Deno.test("ask() exhaustive state-table sweep (00-AL)", () => {
  let totalEnumerated = 0;
  const SKIPPED_COUNT = 0;
  const violationCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
  const violationExamples: Record<number, ViolationExample> = {};

  function record(n: number, comboDesc: () => string, detail: string) {
    violationCounts[n]++;
    if (!violationExamples[n]) violationExamples[n] = { comboDesc: comboDesc(), detail };
  }

  const startedAt = performance.now();

  for (const cartVariant of CART_VARIANTS) {
    for (const orderType of ORDER_TYPE_VARIANTS) {
      for (let mask = 0; mask < 32; mask++) {
        const bools = {} as Record<BooleanKey, boolean>;
        BOOLEAN_KEYS.forEach((k, i) => { bools[k] = !!(mask & (1 << i)); });

        const shopContext: AskShopContext = {
          deliveryEnabled: bools.deliveryEnabled,
          upsellEnabled: bools.upsellEnabled,
          orderTypeKnown: orderType.orderTypeKnown,
          orderTypeIsDelivery: orderType.orderTypeIsDelivery,
          deliveryAddressKnown: bools.deliveryAddressKnown,
          driverTipKnown: bools.driverTipKnown,
          pickupNameKnown: bools.pickupNameKnown,
        };

        for (const phase of PHASES) {
          for (const openVariant of OPEN_VARIANTS) {
            // See OPEN_VARIANTS' comment for why upsell_offered is tied to
            // this axis rather than being its own dimension: carry() never
            // produces open.kind==="upsell" without upsell_offered=true in
            // the same call, so that's the only value consistent with how
            // this field is actually ever set — everywhere else it's false.
            const upsellOffered = openVariant.name === "upsell";

            for (const turnEventVariant of TURN_EVENT_VARIANTS) {
              const combo = { cartVariant: cartVariant.name, orderType: orderType.name, bools, phase, openVariant: openVariant.name, turnEventVariant: turnEventVariant.name };
              if (isSkipped(combo)) continue;
              totalEnumerated++;

              const cart = cartVariant.build();
              const priorState: DialogueState = {
                phase, open: openVariant.value, upsell_offered: upsellOffered, asked_message_id: null,
              };
              const turnEvents = turnEventVariant.value;

              const result = ask(cart, priorState, turnEvents, shopContext, MENU);

              const describeCombo = () => JSON.stringify({
                combo, cart, priorState, shopContext, turnEvents, result,
              }, null, 2);

              // Invariant 1
              const cartHasRealLine = cart.some(isRealCartLine);
              if (!cartHasRealLine && result.open === null && result.phase !== "link_sent") {
                record(1, describeCombo, "cart has no real line, but returned open===null && phase!=='link_sent' (renders as the closure/\"anything else\" question)");
              }

              // Invariant 2
              if (result.open?.kind === "order_type" && shopContext.orderTypeKnown) {
                record(2, describeCombo, "opened order_type while shopContext.orderTypeKnown===true");
              }
              if (result.open?.kind === "address" && shopContext.deliveryAddressKnown) {
                record(2, describeCombo, "opened address while shopContext.deliveryAddressKnown===true");
              }
              if (result.open?.kind === "name" && shopContext.pickupNameKnown) {
                record(2, describeCombo, "opened name while shopContext.pickupNameKnown===true");
              }
              // Round 3, item 2b: tip's own "known" signal moved off
              // shopContext.driverTipKnown (see resolveOpen's "tip" case
              // above for why) onto dialogue_state — checked the same way
              // ask() itself derives it.
              if (result.open?.kind === "tip" && (priorState.driverTipResolved === true || turnEvents.tipResolvedThisTurn === true)) {
                record(2, describeCombo, "opened tip while already resolved (priorState.driverTipResolved or turnEvents.tipResolvedThisTurn)");
              }

              // Invariant 3
              if (result.open?.kind === "address" && (!shopContext.deliveryEnabled || !shopContext.orderTypeIsDelivery)) {
                record(3, describeCombo, "opened address while orderTypeIsDelivery===false or deliveryEnabled===false");
              }

              // Invariant 4
              if (progressViolation(priorState, result, cart, shopContext, turnEvents)) {
                record(4, describeCombo, "priorState.open was resolved this turn but the identical question was re-opened");
              }

              // Invariant 6
              if (result.open && result.open.kind === "slot") {
                const openSlot = result.open;
                const exists = cart.some(l => isRealCartLine(l) && effectiveLineKey(l) === openSlot.line_key);
                if (!exists) record(6, describeCombo, "opened a slot whose line_key matches no real cart line");
              }

              // Invariant 7
              if (result.open?.kind === "upsell") {
                if (!shopContext.upsellEnabled) record(7, describeCombo, "opened upsell while shopContext.upsellEnabled===false");
                if (priorState.upsell_offered) record(7, describeCombo, "opened upsell while priorState.upsell_offered===true");
              }

              // Invariant 8
              if (result.open) {
                const expectedPhase = OWNING_PHASE[result.open.kind];
                if (result.phase !== expectedPhase) {
                  record(8, describeCombo, `open.kind===${result.open.kind} but phase===${result.phase} (expected ${expectedPhase})`);
                }
              }

              // Invariant 5
              const termination = simulateToTermination(cart, priorState, turnEvents, shopContext);
              if (!termination.reached) {
                record(5, describeCombo, `did not reach link_sent within ${MAX_STEPS} steps; trace=${JSON.stringify(termination.trace)}`);
              }
            }
          }
        }
      }
    }
  }

  const elapsedMs = performance.now() - startedAt;

  const totalViolations = Object.values(violationCounts).reduce((a, b) => a + b, 0);

  const lines: string[] = [];
  lines.push(`ask() exhaustive sweep: enumerated=${totalEnumerated} skipped=${SKIPPED_COUNT} elapsedMs=${elapsedMs.toFixed(1)}`);
  lines.push(`skip predicates: ${SKIP_PREDICATES.length === 0 ? "none — see file header for why" : SKIP_PREDICATES.map(p => `${p.name} (${p.reason})`).join("; ")}`);
  lines.push(`violations by invariant: ${JSON.stringify(violationCounts)}`);
  for (const n of Object.keys(violationExamples).map(Number).sort((a, b) => a - b)) {
    lines.push(`--- invariant ${n} example (${violationCounts[n]} total) ---`);
    lines.push(violationExamples[n].detail);
    lines.push(violationExamples[n].comboDesc);
  }
  const summary = lines.join("\n");
  console.log(summary);

  assert(totalViolations === 0, `${totalViolations} invariant violations found across ${totalEnumerated} enumerated states — see console output above for the per-invariant breakdown and one worked example each.\n${summary}`);
});
