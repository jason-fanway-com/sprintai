// Turn Engine, Phase 1 (docs/specs/2026-09-14-turn-engine-oversight.md, §3b).
//
// ROOT CAUSE this closes: code owned the cart, but nobody owned the
// conversation. Every guard in index.ts (26 of them) reverse-engineers
// dialogue state from the model's own prose — what was asked, what's still
// in progress, what the customer just answered. This module is the
// alternative: a code-owned dialogue record (DialogueState) plus four pure
// functions covering the four code-owned steps of one turn — ANSWER, DECIDE,
// ASK, RENDER. The model is called (a later phase, propose.ts) only when
// ANSWER cannot resolve the message deterministically against the ONE open
// question on record.
//
// This module is deliberately pure — plain data in, plain data out, no I/O,
// no Supabase client, no LLM call, no environment access — same discipline as
// turn-reconciler.ts and ask-plan-engine.ts. It is also New Files Only: it is
// not wired into index.ts anywhere in this phase (that's Phase 3, and needs
// the PO's explicit go-ahead). It reuses the existing, tested primitives
// throughout — ask-plan-engine.ts, turn-reconciler.ts, pending-disambiguation.ts,
// checkout-intent-gate-20260913.ts, intent-router.ts, action-confirmation.ts,
// itemizer.ts, upsell-offer-20260914.ts, and the newly-extracted
// dialogue-signals.ts — never a second copy of any of their logic.
//
// ── Spec gaps found while implementing this (flagged in the phase report,
// repeated here so the code and the report agree) ──────────────────────────
//
// 1. ADDRESS and TIP are real `open` kinds (§3a) that ANSWER is specified to
//    resolve (§3b step 2), but §3b step 5's own ASK priority list never
//    mentions either one. ask() below inserts them in the only place that
//    makes conversational sense — address right after order_type, tip right
//    after address, both gated on the order actually being a delivery order
//    — and documents the insertion at that call site. This is a judgment
//    call, not a literal reading of the spec text, and the PO should confirm
//    the placement.
//
// 2. FIXED (2026-09-15, live money bug — 10/20 canary failures, deploy
//    8da2227c, conversations 796faad0/88c00382/597384ff/4ec32aed/8d50a158
//    and five more). §3b's ANSWER step's "with no open question" checkout-
//    intent/closure branch used to be written as its own case, separate
//    from "if state.open != null." Taken literally, a bare "thats it" while
//    a NON-slot question (order_type/tip/address/name/confirm) was open and
//    didn't match that question's own expected words fell through to a
//    model call (PROPOSE) rather than being read as checkout intent, even
//    though isExplicitCheckoutIntent's own design principle is "an
//    unambiguous customer-initiated phrase always authorizes, regardless of
//    what the bot just asked." Concretely: cart holds a Cheese Burger
//    (Temp: Medium), order_type is open ("Pickup or delivery today?"), the
//    customer says "thats it" — meaning "I'm done ordering" — and the old
//    code handed that free text to the model against an open cart with no
//    other instruction, which read it as "one more of the same" and bumped
//    quantity to 2 ($8.49 -> $16.98). Same defect family as the LEGACY
//    engine's "thats it" bug (conversations 0e7b9fd7, 1eeab0c0) this whole
//    engine was built to make structurally impossible.
//
//    closureOrAffirmationFallback() below closes this: every `state.open.kind`
//    checks it — after that kind's own real answer shape has already had
//    first crack at the message, so a genuine tip decline ("no thanks" while
//    tip is open) still resolves as tip_resolved(0) exactly as before — and
//    before ever returning UNRESOLVED. A match never touches the cart and
//    never claims to answer the open question itself; it only prevents
//    PROPOSE from running, and ASK's own priority recompute naturally
//    re-asks the identical question next (nothing about cart/shop state
//    changed this turn).
//
//    UPDATE (2026-09-15, second live money bug — "two cheeseburgers and a
//    large fries" -> "medium" -> "thats it"): the first version of this fix
//    covered only the five non-slot kinds, reasoning that `slot`,
//    `disambiguation`, and `upsell` already had their own closure-shaped
//    resolution. That reasoning held for `disambiguation` and `upsell`
//    (isPendingDisambiguationDeclined, impliesUpsellDecline) but NOT for
//    `slot` — a slot question has no decline concept at all, so a bare
//    "thats it" while a Temp question was open fell all the way through to
//    PROPOSE exactly like the original bug, and the model added a THIRD
//    Cheese Burger line to a cart that already held two (a SEPARATE defect —
//    ask-plan-engine.ts's applyCompiledModifyItem split a quantity-2 line in
//    two the first time its required Temp slot was answered; see that
//    file's `suppressUnitSplit` param doc and this file's "slot" ANSWER case
//    below for that fix).
//    The original dispatch's own wording — "regardless of which question is
//    open" — always meant every kind, no exceptions; `slot` now checks this
//    same fallback too (after applyCompiledModifyItem's own real resolution
//    attempt misses), and `disambiguation`/`upsell` now call it explicitly
//    as their own backstop too, instead of returning UNRESOLVED bare, for
//    the same reason: a closed list must never quietly grow an exception.
//
// 3. The proposal contract (§3c) validates by CHOICE ID, but the only
//    existing, tested mutation pipeline (ask-plan-engine.ts's
//    applyCompiledAddItem / applyCompiledModifyItem) resolves selections
//    from TEXT, via an "asserted display string" channel. decide() below
//    translates each proposal choice id to its own real, compiled display
//    string (an id that doesn't resolve to a real choice for its named group
//    is simply dropped, never asserted) and feeds those strings through the
//    existing asserted-choice channel — full reuse of the tested pricing/
//    pending-question/dedup pipeline, at the cost of one extra translation
//    step. See resolveChoiceDisplays() below.
//
// 4. applyCompiledModifyItem finds its target line by menu_item_id alone —
//    it has no notion of "this specific identity, among several sharing a
//    menu_item_id." decide() below declines a `modify` whose line_key names
//    one of several same-item lines, rather than risk mutating the wrong
//    one. Pre-existing limitation of the reused primitive, not a Phase 1
//    regression — flagged for a later phase.

import type { AskPlan } from "../_shared/compile-menu.ts";
import {
  applyCompiledAddItem,
  applyCompiledModifyItem,
  priceSelections,
  renderStepQuestion,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "./ask-plan-engine.ts";
import { identityKey, removeCartLine, type ReconcilerCartLine } from "./turn-reconciler.ts";
import {
  resolvePendingDisambiguation,
  isPendingDisambiguationDeclined,
  renderAmbiguousItemQuestion,
  type PendingCandidate,
} from "./pending-disambiguation.ts";
import { isExplicitCheckoutIntent } from "./checkout-intent-gate-20260913.ts";
import { parseBareTipDollars } from "./intent-router.ts";
import {
  detectCartMutation,
  renderActionConfirmation,
  type MutationCartLine,
} from "./action-confirmation.ts";
import {
  renderItemizedRecap,
  renderLedgerFooter,
  type ItemizedCartLine,
} from "./itemizer.ts";
import { firstParseableUpsellName, renderUpsellOfferSentence } from "./upsell-offer-20260914.ts";
import {
  impliesUpsellAcceptance,
  impliesUpsellDecline,
  looksLikeCustomerName,
} from "./dialogue-signals.ts";
import { resolveItem, type LexiconTerm } from "./resolve-item.ts";

// ─── §3a: the state record — EXACT shape from the spec ─────────────────────

export interface DialogueState {
  phase: "ordering" | "order_type" | "address" | "tip" | "name" | "confirm" | "link_sent";
  open:
    | null
    | { kind: "slot"; line_key: string; group_id: string }
    | { kind: "disambiguation"; candidates: string[] }
    | { kind: "upsell"; menu_item_id: string }
    | { kind: "order_type" } | { kind: "address" } | { kind: "tip" }
    | { kind: "name"; suggested?: string } | { kind: "confirm" }
    // Dispatch 00-AK (live bug, conv 70c7c02a): every pre-order slot is
    // resolved (order_type/address/tip) but the cart is still EMPTY —
    // "Anything else?" presupposes a first item already exists, so ASK's
    // priority-7 branch (see ask() below) opens this instead whenever the
    // cart has no real line. `askCount` is the number of consecutive turns
    // this exact question has been re-asked with the cart still empty —
    // RENDER cycles three distinct phrasings off it (see render() below) so
    // a real customer who protests instead of ordering never hears the
    // identical sentence three times running, the exact live dead end this
    // closes. Purely a cart-emptiness check, never a model call.
    | { kind: "ordering"; askCount: number };
  upsell_offered: boolean;
  asked_message_id: string | null;
  // FIXED 2026-09-15 (turn-engine live bug — "two cheeseburgers and a large
  // fries" -> "medium" -> "thats it"): OTHER item_spans a customer's message
  // named that also came back ambiguous, each as its own candidate-id list,
  // in the order the customer said them, still waiting to be asked about.
  // This USED to live nested inside `open`'s `disambiguation` variant
  // (`carriedAmbiguous`) — which only ever survived a turn where
  // disambiguation ITSELF won ASK's priority that turn. The real transcript
  // above never resolves that way: "cheeseburgers" resolves outright (not
  // ambiguous) while "fries" ties ambiguous, but the still-open required
  // Temp slot (priority 1) always outranks disambiguation (priority 2), so
  // the fries candidates never once got a turn to be `open` — and with
  // nowhere else to live, decide()'s own ambiguous-span output for that turn
  // was simply discarded the instant `open` became `slot` instead. Moving
  // this queue to the top level, independent of whatever `open.kind` wins
  // priority THIS turn, is what makes a carried span survive regardless of
  // what blocks it — see ask()'s `pendingAmbiguous` computation below, which
  // is now the ONE place items are enqueued (decide()'s fresh output) and
  // dequeued (priority 2), never re-derived, never dropped on the floor.
  pendingAmbiguous?: string[][];
}

// ─── §3c: the proposal contract — EXACT shape from the spec ────────────────

export interface Proposal {
  intent: "order" | "checkout" | "cancel" | "question" | "other";
  // item_span (docs/specs/2026-09-15-code-owned-resolution.md §4): the
  // VERBATIM substring of the customer's own message naming the item —
  // nothing normalized, nothing invented. DECIDE below resolves it to a
  // real menu_item_id via resolve-item.ts's deterministic longest-match,
  // exactly once, before anything touches the cart. This replaces the old
  // model-chosen `menu_item_id` field — see this file's header and
  // resolve-item.ts's own header for why item identity is no longer a
  // model output.
  adds:     Array<{ item_span: string; quantity: number; choices: Array<{ group_id: string; choice_id: string }> }>;
  removes:  Array<{ line_key: string }>;
  modifies: Array<{ line_key: string; quantity?: number; choices?: Array<{ group_id: string; choice_id: string }>;
                    remove_choices?: string[] }>;
  answer_text?: string;
}

// ─── Cart / menu shapes this module operates on ────────────────────────────

// Reuses ask-plan-engine.ts's own cart-line shape directly — every function
// below that touches the cart (ANSWER's slot/disambiguation/upsell
// resolution, DECIDE) is really just a caller of applyCompiledAddItem /
// applyCompiledModifyItem, so there is no reason to invent a second shape.
export type TurnEngineCartLine = CompiledCartLine;

export interface TurnEngineMenuItem {
  id: string;
  name: string;
  category?: string | null;
  price_cents: number;
  bot_state?: string | null;
  ask_plan?: AskPlan | null;
  option_groups?: Array<{ id: string; name: string; default_choice_id?: string | null }>;
  // menu_items.upsell (migration 050) — semicolon-separated "Name +Price"
  // entries. See upsell-offer-20260914.ts's own header for the shape.
  upsell?: string | null;
}

function isRealCartLine(line: TurnEngineCartLine): boolean {
  return typeof line.menu_item_id === "string";
}

function toCompiledMenuItem(item: TurnEngineMenuItem, askPlan: AskPlan): CompiledMenuItem {
  return { ask_plan: askPlan, bot_state: item.bot_state, option_groups: item.option_groups };
}

// Stale-line_key fix (2026-09-15, docs/specs/2026-09-14-turn-engine-
// oversight.md Phase 1.5): a line's real identity is its own stable
// `line_key` when it has one (minted once by decide(), see below — never
// recomputed as the line's options later change); identityKey() is only a
// fallback for a line that predates the field. Every place in this module
// that used to match a stored key against `identityKey(...)` directly goes
// through this function now, so a key captured before an option group is
// answered still finds its line afterward.
function effectiveLineKey(line: TurnEngineCartLine) {
  return line.line_key ?? identityKey(line.menu_item_id, line.options);
}

function findLineByKey(cart: TurnEngineCartLine[], lineKey: string): number {
  return cart.findIndex(l => isRealCartLine(l) && effectiveLineKey(l) === lineKey);
}

// ─── STEP 2: ANSWER ─────────────────────────────────────────────────────────
//
// (state, cart, message, menu) => AnswerResult. If state.open is non-null,
// resolves the message deterministically against that ONE open question,
// using the existing resolvers named in the spec. Mutates `cart` in place
// exactly when it resolves an add/slot/upsell-accept (same convention as
// applyCompiledAddItem/applyCompiledModifyItem, which this function calls
// directly) — the caller never needs to separately apply an ANSWER outcome.
// Returns `{ resolved: false }` when nothing here can settle it — the ONLY
// case in which the caller may make a model call (PROPOSE, a later phase).

export type AnswerOutcome =
  | { kind: "slot_resolved" }
  | { kind: "disambiguation_resolved"; menuItemId: string }
  | { kind: "order_type_resolved"; orderType: "pickup" | "delivery" }
  | { kind: "address_resolved"; address: string; withinZone: boolean }
  | { kind: "address_declined" }
  | { kind: "tip_resolved"; tipCents: number }
  | { kind: "name_resolved"; name: string }
  | { kind: "confirm_yes" }
  | { kind: "confirm_no" }
  | { kind: "upsell_accepted" }
  | { kind: "upsell_declined" }
  | { kind: "checkout_intent" }
  | { kind: "closure" };

export type AnswerResult =
  | { resolved: false }
  | { resolved: true; outcome: AnswerOutcome; cartChanged: boolean };

const UNRESOLVED: AnswerResult = { resolved: false };

// The address slot's resolution needs a geocode/zone-check result, which is
// genuinely I/O (an external lookup) — the spec's own step-2 text names
// "the existing set_delivery_address resolver (geocode, zone check)" as the
// resolver for this case, which cannot run inside a pure module. The caller
// (a later, I/O-capable phase) runs the geocode BEFORE calling answer() and
// hands the result in here; this module only makes the deterministic
// decision given that result. Undefined = the caller hasn't attempted a
// geocode for this message yet (so this turn cannot resolve address at all,
// same as any other unresolved case); null = it attempted one and the
// address didn't resolve/was out of zone.
export interface AnswerExternalInputs {
  geocodedAddress?: { formatted: string; withinZone: boolean } | null;
}

const BARE_CLOSURE_RE = /^(?:no|nope|nah|none|nothing|that'?s all|thats all)[.!]?$/i;
const ORDER_TYPE_PICKUP_RE = /\bpick[\s-]?up\b/i;
const ORDER_TYPE_DELIVERY_RE = /\bdeliver(?:y|ed)?\b/i;
// Mirrors intent-router.ts's detectBareTipReply decline shape, narrowed to
// this module's own already-open-tip-question context (that function's own
// "did the prior assistant message offer a tip" half is redundant here —
// state.open.kind === "tip" already establishes that fact).
const TIP_DECLINE_RE = /^(?:no tip|no thanks|no thank you|not now|skip|none|pass|no)[.!]?$/i;
const TIP_AMOUNT_RE = /^\$?\s*\d+(?:\.\d{1,2})?\s*$/;
const CONFIRM_DECLINE_RE = /^(?:no|nope|nah|not yet|wait|hold on)[.!]?$/i;

// See this file's header note 2: the fallback that closes the "thats it
// while order_type is open" money bug. FIXED 2026-09-15 (turn-engine live
// bug, "two cheeseburgers and a large fries" -> "medium" -> "thats it"): a
// bare closure/affirmation phrase must never reach PROPOSE regardless of
// WHICH kind of question is open — this is now called from EVERY
// `state.open.kind` case below (slot, disambiguation, upsell included), and
// ONLY after that kind's own real answer shape already missed the message —
// so it never overrides a genuine resolution (a real tip decline, a real
// Temp answer, a real disambiguation pick, etc.), it only catches what's
// left. `slot`/`disambiguation`/`upsell` each still get first crack via
// their own real resolvers (applyCompiledModifyItem, resolvePending
// Disambiguation, impliesUpsellAcceptance/Decline) — this is the backstop
// AFTER those miss, never a replacement for them, and it never disturbs
// disambiguation's own correct decline semantics (isPendingDisambiguation
// Declined, checked first, still means "none of those candidates"; this
// fallback only fires when NEITHER a pick NOR a decline matched). Reuses the
// exact detectors already live elsewhere in this file, never a new phrase
// list: isExplicitCheckoutIntent and BARE_CLOSURE_RE already power the
// `state.open === null` branch above; impliesUpsellAcceptance/
// impliesUpsellDecline already power the `upsell` case's own first-pass
// checks. A match never mutates the cart (cartChanged is always false) and
// never claims to answer the open question — the caller's own ASK recompute
// naturally re-asks it (or moves on), since nothing about the cart or shop
// state moved this turn.
function closureOrAffirmationFallback(trimmed: string): AnswerResult | null {
  if (isExplicitCheckoutIntent(trimmed, null, false)) {
    return { resolved: true, outcome: { kind: "checkout_intent" }, cartChanged: false };
  }
  if (BARE_CLOSURE_RE.test(trimmed) || impliesUpsellDecline(trimmed) || impliesUpsellAcceptance(trimmed)) {
    return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
  }
  return null;
}

export function answer(
  state: DialogueState,
  cart: TurnEngineCartLine[],
  message: string,
  menu: TurnEngineMenuItem[],
  external: AnswerExternalInputs = {},
): AnswerResult {
  const trimmed = (message ?? "").trim();
  const menuById = new Map(menu.map(m => [m.id, m]));

  if (state.open === null) {
    if (isExplicitCheckoutIntent(trimmed, null, false)) {
      return { resolved: true, outcome: { kind: "checkout_intent" }, cartChanged: false };
    }
    if (BARE_CLOSURE_RE.test(trimmed)) {
      return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
    }
    return UNRESOLVED;
  }

  switch (state.open.kind) {
    case "slot": {
      const idx = findLineByKey(cart, state.open.line_key);
      if (idx < 0) return UNRESOLVED;
      const line = cart[idx];
      const menuItem = menuById.get(line.menu_item_id);
      if (!menuItem?.ask_plan) return UNRESOLVED;
      // suppressUnitSplit: true — see ask-plan-engine.ts's own doc on that
      // param. This call is always a required slot's FIRST-EVER answer (ASK
      // only opens a slot question when no unit on the line has it resolved
      // yet), never a "differentiate one of several already-resolved units"
      // correction, so the split-one-unit-off heuristic must never fire here.
      // requireTextualSupportForSlots: true (00-BH Part B) — this is the
      // free-text answer call site the fix is scoped to. modelAssertedChoiceTexts
      // is already `[]` here today, so this flag is a no-op in practice; it
      // makes the intent explicit rather than incidental. See ask-plan-
      // engine.ts's resolveAskPlan doc for why this alone does not close the
      // confirmed wings bug — that lives in decide()'s add/modify paths below
      // (:609/:657), explicitly out of scope for this fix.
      const result = applyCompiledModifyItem(
        cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), line.menu_item_id, undefined, trimmed, [],
        undefined, undefined, undefined, true, true,
      );
      if (!result.cartChanged) return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
      return { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true };
    }

    case "disambiguation": {
      const candidates: PendingCandidate[] = state.open.candidates
        .map(id => menuById.get(id))
        .filter((m): m is TurnEngineMenuItem => !!m)
        .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
      if (candidates.length === 0) return UNRESOLVED;
      if (isPendingDisambiguationDeclined(trimmed, candidates)) {
        return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
      }
      const resolved = resolvePendingDisambiguation(trimmed, candidates);
      if (!resolved) return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
      const menuItem = menuById.get(resolved.menu_item_id);
      if (!menuItem?.ask_plan) return UNRESOLVED;
      const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, 1, "", undefined, undefined, []);
      return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: menuItem.id }, cartChanged: result.cartChanged };
    }

    case "order_type": {
      const wantsPickup = ORDER_TYPE_PICKUP_RE.test(trimmed);
      const wantsDelivery = ORDER_TYPE_DELIVERY_RE.test(trimmed);
      if (wantsPickup && !wantsDelivery) return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "pickup" }, cartChanged: false };
      if (wantsDelivery && !wantsPickup) return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "delivery" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    case "address": {
      // Closure/checkout intent gets first crack, same as every other open
      // kind below — a bare "thats it"/"no thanks" while address is open
      // must resolve as closure, never as an address (declined or
      // otherwise), regardless of what the caller's geocode attempt (if any)
      // came back with for that same text.
      const fallback = closureOrAffirmationFallback(trimmed);
      if (fallback) return fallback;
      if (external.geocodedAddress === undefined) return UNRESOLVED;
      if (external.geocodedAddress === null) return { resolved: true, outcome: { kind: "address_declined" }, cartChanged: false };
      return {
        resolved: true,
        outcome: { kind: "address_resolved", address: external.geocodedAddress.formatted, withinZone: external.geocodedAddress.withinZone },
        cartChanged: false,
      };
    }

    case "tip": {
      if (TIP_DECLINE_RE.test(trimmed)) return { resolved: true, outcome: { kind: "tip_resolved", tipCents: 0 }, cartChanged: false };
      if (TIP_AMOUNT_RE.test(trimmed)) return { resolved: true, outcome: { kind: "tip_resolved", tipCents: parseBareTipDollars(trimmed) * 100 }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    case "name": {
      if (looksLikeCustomerName(trimmed)) return { resolved: true, outcome: { kind: "name_resolved", name: trimmed }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    case "confirm": {
      if (isExplicitCheckoutIntent(trimmed, "Confirm?", false)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      if (CONFIRM_DECLINE_RE.test(trimmed)) return { resolved: true, outcome: { kind: "confirm_no" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    case "upsell": {
      if (impliesUpsellAcceptance(trimmed)) {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (!menuItem?.ask_plan) return UNRESOLVED;
        const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, 1, "", undefined, undefined, []);
        return { resolved: true, outcome: { kind: "upsell_accepted" }, cartChanged: result.cartChanged };
      }
      if (impliesUpsellDecline(trimmed)) return { resolved: true, outcome: { kind: "upsell_declined" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    // "ordering" (00-AK): identical treatment to `state.open === null` above
    // — an empty cart has nothing to close, so this only catches an
    // explicit checkout phrase or a bare closure/affirmation before ever
    // reaching PROPOSE; naming an actual item is NOT this case's job (that
    // free text falls through UNRESOLVED to PROPOSE exactly as it always
    // has, regardless of which `open.kind` is on record).
    case "ordering": {
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }
  }
}

// ─── STEP 4: DECIDE ─────────────────────────────────────────────────────────
//
// (proposal, cart, menu) => DecideResult. Validates every element of the
// proposal against the menu and applies what's valid through the existing
// mutation pipeline. Never mutates the input `cart` array — returns a new
// one (same "plain data out" convention as turn-reconciler.ts's
// reconcileAddProposals).

export interface Decline {
  reason: string;
}

export interface DecideResult {
  cart: TurnEngineCartLine[];
  declines: Decline[];
  // The menu_item_id of a line that had a genuine "unit added" event this
  // turn (brand-new line or a merge growth) — feeds ASK's upsell-eligibility
  // check. Null if nothing qualifying happened. Last-one-wins when more than
  // one add qualifies in the same proposal — matches ASK's "at most one
  // question per turn" contract; a multi-add turn only ever gets one upsell
  // shot regardless, so which one is somewhat arbitrary but never absent.
  qualifyingAddMenuItemId: string | null;
  // Set by resolve-item.ts when an add's item_span ties across two or more
  // DIFFERENT menu items at the longest matched length -- the exact shape
  // ASK's existing `disambiguation` open-question kind already consumes
  // (AskTurnEvents.disambiguationCandidateIds). Null when no add this turn
  // was ambiguous. When MORE than one add in the same proposal is ambiguous,
  // this is the FIRST one in the customer's own message order (proposal.adds
  // order) -- never last-one-wins, never any other tiebreak -- and every
  // other ambiguous span's candidates are carried in
  // `carriedDisambiguationCandidateIds`, same order, so ASK can ask about
  // this one now and the rest on later turns instead of dropping them.
  disambiguationCandidateIds: string[] | null;
  // The ambiguous spans NOT chosen for `disambiguationCandidateIds` above,
  // in message order, each still carrying every one of its own tying
  // candidates unranked. Empty when at most one add this turn was
  // ambiguous. See DialogueState's `pendingAmbiguous` and ask()'s priority 2
  // for how this queue gets asked on a later turn.
  carriedDisambiguationCandidateIds: string[][];
}

interface ResolvedAdd {
  menu_item_id: string;
  quantity: number;
  choices: Array<{ group_id: string; choice_id: string }>;
}

function addIdentityKey(add: ResolvedAdd) {
  const choiceKey = (add.choices ?? []).map(c => `${c.group_id}=${c.choice_id}`).sort().join(";");
  return `${add.menu_item_id}::${choiceKey}`;
}

// See this file's header note 3: translates a proposal's id-based choices
// into the display strings applyCompiledAddItem/applyCompiledModifyItem's
// existing asserted-choice channel expects, validating legality as a side
// effect — a choice_id that isn't a real choice for its named group_id on
// this item's compiled ask_plan simply never produces a display string, so
// it can never be asserted. Returns how many were dropped so the caller can
// surface a decline for transparency without blocking the choices that DID
// resolve.
function resolveChoiceDisplays(
  askPlan: AskPlan,
  choices: Array<{ group_id: string; choice_id: string }>,
): { texts: string[]; droppedCount: number } {
  const texts: string[] = [];
  let droppedCount = 0;
  for (const c of choices) {
    const step = askPlan.steps.find(s => s.group_id === c.group_id);
    const choice = step?.choices.find(ch => ch.id === c.choice_id);
    if (choice) texts.push(choice.display);
    else droppedCount++;
  }
  return { texts, droppedCount };
}

function applyRemoveChoiceIds(
  line: TurnEngineCartLine,
  askPlan: AskPlan,
  itemGroups: NonNullable<TurnEngineMenuItem["option_groups"]>,
  removeIds: string[],
): void {
  const selections: Record<string, string | string[]> = { ...(line.ask_plan_selections ?? {}) };
  const removeSet = new Set(removeIds);
  for (const step of askPlan.steps) {
    if (step.kind !== "modifier") continue;
    const sel = selections[step.group_id];
    if (!sel) continue;
    const ids = Array.isArray(sel) ? sel : [sel];
    const remaining = ids.filter(id => !removeSet.has(id));
    if (remaining.length === ids.length) continue;
    if (remaining.length === 0) delete selections[step.group_id];
    else selections[step.group_id] = remaining.length === 1 ? remaining[0] : remaining;
  }
  const { resolvedOptions, priceCents } = priceSelections(askPlan, itemGroups, selections);
  line.ask_plan_selections = selections;
  line.options = Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined;
  line.price_cents = priceCents;
}

export function decide(
  proposal: Proposal,
  cart: TurnEngineCartLine[],
  menu: TurnEngineMenuItem[],
  // The shop's compiled item-level lexicon (the `lexicon` table, target_type
  // = 'item', active = true) -- the same shape propose.ts's own LexiconTerm
  // already carries. Every add's item_span is resolved against this,
  // exactly once, before anything below ever touches the cart. See
  // resolve-item.ts's header for why this can never fall back to the model
  // or break a tie.
  lexicon: LexiconTerm[],
  // Injected (same DI pattern as propose.ts's ProposeDeps clock/transport) —
  // never `crypto.randomUUID()` called directly in this file, so this
  // module's determinism (every existing assertion here is an exact value,
  // not a `typeof x === "string"` check) survives the new minting behavior.
  // Production wiring (Phase 3, not yet built) passes `() => crypto.
  // randomUUID()`; tests pass a counter and assert the exact minted keys.
  // Omitted entirely (existing call sites, pre this fix) means no line ever
  // gets a stable line_key — identical to this function's behavior before
  // stable keys existed.
  newLineKey?: () => string,
): DecideResult {
  const nextCart: TurnEngineCartLine[] = cart.map(l => ({ ...l }));
  const menuById = new Map(menu.map(m => [m.id, m]));
  const declines: Decline[] = [];
  let qualifyingAddMenuItemId: string | null = null;
  let disambiguationCandidateIds: string[] | null = null;
  let carriedDisambiguationCandidateIds: string[][] = [];

  // Resolve each add's item_span BEFORE anything reaches the cart (spec §4:
  // "item_span is an input to a deterministic, total function that runs
  // before anything reaches the cart"). A span that doesn't resolve to
  // exactly one item adds NO line -- ambiguous sets disambiguationCandidateIds
  // for ASK to pick up (the existing `disambiguation` open-question kind
  // already renders the actual question from these candidate ids); unresolved
  // surfaces a decline so the customer knows nothing was added. Never a
  // tiebreak, never a fallback to the model, never re-inspected afterward.
  const resolvedAdds: ResolvedAdd[] = [];
  // Every ambiguous span this turn, in the customer's own message order
  // (proposal.adds order) -- never sorted, never reordered by candidate
  // count or anything else. The FIRST one becomes this turn's ASK; the rest
  // are carried forward below so a later turn can ask about them instead of
  // the second (third, ...) span silently vanishing the moment more than one
  // add ties in the same message.
  const ambiguousSpans: string[][] = [];
  for (const add of proposal.adds ?? []) {
    const resolution = resolveItem(add.item_span, lexicon);
    if (resolution.kind === "resolved") {
      resolvedAdds.push({ menu_item_id: resolution.menu_item_id, quantity: add.quantity, choices: add.choices });
    } else if (resolution.kind === "ambiguous") {
      ambiguousSpans.push(resolution.candidates);
    } else {
      declines.push({ reason: "Sorry, I didn't catch what item that was — mind saying it again?" });
    }
  }
  if (ambiguousSpans.length > 0) {
    disambiguationCandidateIds = ambiguousSpans[0];
    carriedDisambiguationCandidateIds = ambiguousSpans.slice(1);
  }

  // Two adds in one proposal with identical identity collapse to ONE line at
  // MAX quantity, never a sum (§3b step 4) — grouped here, before any of
  // them ever reaches the mutation pipeline.
  const addGroups = new Map<string, ResolvedAdd>();
  for (const add of resolvedAdds) {
    const key = addIdentityKey(add);
    const existing = addGroups.get(key);
    if (!existing || add.quantity > existing.quantity) addGroups.set(key, add);
  }

  for (const add of addGroups.values()) {
    const menuItem = menuById.get(add.menu_item_id);
    if (!menuItem) { declines.push({ reason: "That item isn't on the menu." }); continue; }
    if (!menuItem.ask_plan) { declines.push({ reason: `${menuItem.name} isn't available to order this way yet.` }); continue; }
    const { texts, droppedCount } = resolveChoiceDisplays(menuItem.ask_plan, add.choices ?? []);
    if (droppedCount > 0) declines.push({ reason: `Some of what was asked for on ${menuItem.name} isn't a real option — skipped.` });
    const lengthBeforeAdd = nextCart.length;
    const result = applyCompiledAddItem(nextCart, toCompiledMenuItem(menuItem, menuItem.ask_plan), add.menu_item_id, add.quantity, "", undefined, undefined, texts);
    if (!result.ok) {
      const errMsg = (result.result as { error?: string } | undefined)?.error;
      declines.push({ reason: errMsg ?? `Couldn't add ${menuItem.name}.` });
      continue;
    }
    if (result.cartChanged) {
      qualifyingAddMenuItemId = add.menu_item_id;
      // A genuinely NEW line is the only case that pushes onto nextCart —
      // applyCompiledAddItem's continuation branch (filling a still-open
      // slot on an existing line) and its merge-into-identical-existing
      // branch (a repeat order growing quantity) both route through
      // writeCartLine's `continuationIndex` path, which mutates an existing
      // index in place and never changes the array's length (see
      // turn-reconciler.ts's writeCartLine: only the no-match branch
      // `cart.push(...)`s). Minting a stable key only when the length
      // actually grew by exactly one is what keeps a quantity bump from
      // ever getting its own new identity.
      if (newLineKey && nextCart.length === lengthBeforeAdd + 1) {
        nextCart[nextCart.length - 1].line_key = newLineKey();
      }
    }
  }

  for (const rm of proposal.removes ?? []) {
    const idx = findLineByKey(nextCart, rm.line_key);
    if (idx < 0) { declines.push({ reason: "That item wasn't in your order." }); continue; }
    removeCartLine(nextCart as unknown as ReconcilerCartLine[], idx);
  }

  for (const mod of proposal.modifies ?? []) {
    const idx = findLineByKey(nextCart, mod.line_key);
    if (idx < 0) { declines.push({ reason: "That item wasn't in your order." }); continue; }
    const line = nextCart[idx];
    const menuItem = menuById.get(line.menu_item_id);
    if (!menuItem?.ask_plan) { declines.push({ reason: "Couldn't update that item." }); continue; }
    // See this file's header note 4: applyCompiledModifyItem targets a line
    // by menu_item_id alone, so a line_key that isn't the ONLY line for this
    // menu_item_id is unsafe to route through it.
    const sameItemCount = nextCart.filter(l => isRealCartLine(l) && l.menu_item_id === line.menu_item_id).length;
    if (sameItemCount > 1) { declines.push({ reason: `You have more than one ${menuItem.name} — please say which one.` }); continue; }

    if (mod.remove_choices && mod.remove_choices.length > 0) {
      applyRemoveChoiceIds(line, menuItem.ask_plan, menuItem.option_groups ?? [], mod.remove_choices);
    }
    if (mod.quantity !== undefined || (mod.choices && mod.choices.length > 0)) {
      const { texts, droppedCount } = resolveChoiceDisplays(menuItem.ask_plan, mod.choices ?? []);
      if (droppedCount > 0) declines.push({ reason: `Some of what was asked for on ${menuItem.name} isn't a real option — skipped.` });
      applyCompiledModifyItem(nextCart, toCompiledMenuItem(menuItem, menuItem.ask_plan), line.menu_item_id, mod.quantity, "", texts);
    }
  }

  return { cart: nextCart, declines, qualifyingAddMenuItemId, disambiguationCandidateIds, carriedDisambiguationCandidateIds };
}

// ─── STEP 5: ASK ────────────────────────────────────────────────────────────
//
// (cart, state, turnEvents, shopContext, menu) => DialogueState. Computes
// the single next open question by fixed priority — never a prompt rule.
// See this file's header notes 1 and 2 for the two places this deviates from
// (or fills a gap in) the spec's own step-5 prose.

export interface AskShopContext {
  deliveryEnabled: boolean;
  upsellEnabled: boolean;
  // These four live on order_carts as their own columns today (§3a only
  // folds pending_disambiguation / delivery_offer_made_at /
  // checkout_intent_confirmed_at / per-line pending_options into
  // dialogue_state — order_type, delivery_address, driver_tip_cents and
  // pickup_name are NOT superseded, they stay their own columns), so ASK
  // needs them handed in rather than reading them off `state` or `cart`.
  orderTypeKnown: boolean;
  orderTypeIsDelivery: boolean;
  deliveryAddressKnown: boolean;
  driverTipKnown: boolean;
  pickupNameKnown: boolean;
}

export interface AskTurnEvents {
  qualifyingAddMenuItemId: string | null;
  disambiguationCandidateIds: string[] | null;
  // decide()'s own queue of OTHER ambiguous spans from this turn's proposal,
  // beyond the one named by disambiguationCandidateIds above -- see
  // DecideResult.carriedDisambiguationCandidateIds. Empty/omitted when at
  // most one add this turn was ambiguous.
  carriedDisambiguationCandidateIds?: string[][];
  // True when priorState.open was a `disambiguation` question AND this
  // turn's ANSWER settled it (resolved a candidate OR the customer declined
  // it) -- i.e. the caller's ANSWER call returned `resolved: true` while
  // that was the open question. No longer consumed by ask() itself (see its
  // `pendingAmbiguous` computation, which carries a span forward regardless
  // of this flag) — kept on the contract because callers (turn-engine-
  // runner.ts) already produce it and other consumers may still find it
  // useful for logging/observability.
  disambiguationSettledThisTurn: boolean;
  // True when this turn's ANSWER resolved to `checkout_intent`, or a
  // PROPOSE-produced Proposal carried `intent: "checkout"`. Once true (or
  // once `state.phase` has already moved past "ordering" — see
  // `committedToClose` below), ASK stops offering "anything else?" and
  // starts walking toward name/confirm/link.
  checkoutIntentThisTurn: boolean;
  confirmYes: boolean;
  confirmNo: boolean;
}

export function ask(
  cart: TurnEngineCartLine[],
  priorState: DialogueState,
  turnEvents: AskTurnEvents,
  shopContext: AskShopContext,
  menu: TurnEngineMenuItem[],
): DialogueState {
  const menuById = new Map(menu.map(m => [m.id, m]));

  // See DialogueState.pendingAmbiguous's doc for why this lives at the top
  // of ask(), computed unconditionally, rather than only being produced by
  // whichever priority branch happens to return `disambiguation` this turn:
  // this turn's own fresh ambiguous span(s) from decide() (the one that
  // WOULD be asked, plus any others that tied in the same proposal) are
  // appended after anything already queued from an earlier turn that lost
  // priority to something else — most commonly an open required slot, which
  // always outranks disambiguation below. Every `carry(...)` call defaults
  // to handing this exact queue straight back on the returned state, so a
  // span that doesn't win priority THIS turn is never silently dropped —
  // only priority 2 below (popping the front) ever shrinks it.
  const pendingAmbiguous: string[][] = [
    ...(priorState.pendingAmbiguous ?? []),
    ...(turnEvents.disambiguationCandidateIds && turnEvents.disambiguationCandidateIds.length > 0
      ? [turnEvents.disambiguationCandidateIds, ...(turnEvents.carriedDisambiguationCandidateIds ?? [])]
      : []),
  ];

  const carry = (
    open: DialogueState["open"],
    phase: DialogueState["phase"],
    upsellOffered = priorState.upsell_offered,
    pending: string[][] = pendingAmbiguous,
  ): DialogueState =>
    ({ phase, open, upsell_offered: upsellOffered, asked_message_id: null, pendingAmbiguous: pending });

  // 1. unresolved required slot on any line.
  for (const line of cart) {
    if (!isRealCartLine(line)) continue;
    const menuItem = menuById.get(line.menu_item_id);
    if (!menuItem?.ask_plan) continue;
    const resolvedGroupIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
    const openSlotStep = menuItem.ask_plan.steps.find(s => s.kind === "slot" && !resolvedGroupIds.has(s.group_id));
    if (openSlotStep) {
      return carry({ kind: "slot", line_key: effectiveLineKey(line), group_id: openSlotStep.group_id }, "ordering");
    }
  }

  // 2. disambiguation -- the oldest span still waiting, whether it's fresh
  // from THIS turn's decide() or carried over from an earlier turn that lost
  // priority to a required slot. One question per turn (§3b step 5): only
  // the front of the queue is ever asked; the rest ride along on `pending`
  // via `carry`'s default, to be asked on a later turn instead of dropped.
  if (pendingAmbiguous.length > 0) {
    const [next, ...rest] = pendingAmbiguous;
    return carry({ kind: "disambiguation", candidates: next }, "ordering", priorState.upsell_offered, rest);
  }

  // 3. order_type (only if delivery is enabled and unset).
  if (shopContext.deliveryEnabled && !shopContext.orderTypeKnown) {
    return carry({ kind: "order_type" }, "order_type");
  }

  // 4. address — see header note 1: not in the spec's own step-5 list, but
  // required by §3a/step-2. Only relevant once delivery is the chosen type.
  if (shopContext.orderTypeIsDelivery && !shopContext.deliveryAddressKnown) {
    return carry({ kind: "address" }, "address");
  }

  // 5. tip — see header note 1, same gap. Only relevant for delivery, and
  // only once the address is known (matches the standing prompt rule this
  // replaces: collect the address before anything else).
  if (shopContext.orderTypeIsDelivery && !shopContext.driverTipKnown) {
    return carry({ kind: "tip" }, "tip");
  }

  // 6. upsell (only if a qualifying add happened this turn and not yet offered).
  if (turnEvents.qualifyingAddMenuItemId && !priorState.upsell_offered && shopContext.upsellEnabled) {
    const addedItem = menuById.get(turnEvents.qualifyingAddMenuItemId);
    const upsellName = addedItem?.upsell ? firstParseableUpsellName(addedItem.upsell) : null;
    const upsellTarget = upsellName ? menu.find(m => m.name.toLowerCase() === upsellName.toLowerCase()) : undefined;
    if (upsellTarget) {
      return carry({ kind: "upsell", menu_item_id: upsellTarget.id }, "ordering", true);
    }
  }

  // Has this conversation already committed to closing? `phase` itself is
  // what carries that fact forward turn to turn (see header note on why this
  // isn't a separate DialogueState field) — once ASK has moved past
  // "ordering" toward name/confirm/link_sent, it never walks back to
  // "anything else?".
  const committedToClose =
    turnEvents.checkoutIntentThisTurn ||
    priorState.phase === "name" || priorState.phase === "confirm" || priorState.phase === "link_sent";

  if (!committedToClose) {
    // 00-AK: the cart is empty and nothing has committed this conversation
    // to closing — "Anything else?" (the `open: null` shape below) wrongly
    // presupposes a first item already exists. Ask the ordering question
    // instead, purely off cart emptiness (never inferred by the model).
    // `askCount` only increments when THIS exact question was already open
    // last turn (still empty, still nothing resolved) — see render()'s
    // "ordering" case for what that count drives.
    const cartHasRealLines = cart.some(isRealCartLine);
    if (!cartHasRealLines) {
      const askCount = priorState.open?.kind === "ordering" ? priorState.open.askCount + 1 : 1;
      return carry({ kind: "ordering", askCount }, "ordering");
    }
    return carry(null, "ordering");
  }

  // 7. name.
  if (!shopContext.pickupNameKnown) {
    return carry({ kind: "name" }, "name");
  }

  // 8. confirm / link.
  if (turnEvents.confirmYes) return carry(null, "link_sent");
  if (turnEvents.confirmNo) return carry(null, "ordering");
  return carry({ kind: "confirm" }, "confirm");
}

// ─── STEP 6: RENDER ─────────────────────────────────────────────────────────
//
// (cartBefore, cartAfter, state, declines, menu, context) => string. The
// ONLY function in this file that returns a reply string (see the Phase 1
// gate's static test). facts + question + money footer, all code — never a
// second reply-building function anywhere on this path.

export interface RenderContext {
  deliveryFeeCents?: number;
  driverTipCents?: number;
  priceIndexByMenuItemId?: Map<string, Map<string, number>>;
}

export function render(
  cartBefore: TurnEngineCartLine[],
  cartAfter: TurnEngineCartLine[],
  state: DialogueState,
  declines: Decline[],
  menu: TurnEngineMenuItem[],
  context: RenderContext = {},
): string {
  const menuById = new Map(menu.map(m => [m.id, m]));
  const parts: string[] = [];

  for (const d of declines) if (d.reason) parts.push(d.reason);

  const mutationEvent = detectCartMutation(cartBefore as unknown as MutationCartLine[], cartAfter as unknown as MutationCartLine[]);
  if (mutationEvent) {
    parts.push(renderActionConfirmation(mutationEvent, context.priceIndexByMenuItemId));
  } else if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter) && cartAfter.length > 0) {
    // The diff touched more than one nameable line (detectCartMutation
    // returned null for that reason, not because nothing changed) — fall
    // back to the full itemized recap rather than say nothing changed.
    parts.push(renderItemizedRecap(cartAfter as ItemizedCartLine[], context.deliveryFeeCents, context.driverTipCents, context.priceIndexByMenuItemId));
  }

  let question = "";
  if (state.open) {
    switch (state.open.kind) {
      case "slot": {
        for (const line of cartAfter) {
          if (!isRealCartLine(line)) continue;
          if (effectiveLineKey(line) !== state.open.line_key) continue;
          const menuItem = menuById.get(line.menu_item_id);
          const step = menuItem?.ask_plan?.steps.find(s => s.group_id === (state.open as { group_id: string }).group_id);
          if (menuItem?.ask_plan && step) question = renderStepQuestion(step, menuItem.ask_plan.display_name);
          break;
        }
        break;
      }
      case "disambiguation": {
        const candidates: PendingCandidate[] = state.open.candidates
          .map(id => menuById.get(id))
          .filter((m): m is TurnEngineMenuItem => !!m)
          .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
        if (candidates.length > 0) question = renderAmbiguousItemQuestion(candidates);
        break;
      }
      case "upsell": {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (menuItem) question = renderUpsellOfferSentence({ name: menuItem.name, priceCents: menuItem.price_cents });
        break;
      }
      case "order_type":
        question = "Pickup or delivery today?";
        break;
      case "address":
        question = "What's the delivery address?";
        break;
      case "tip":
        question = "Want to add a tip for the driver?";
        break;
      case "name":
        question = state.open.suggested ? `Putting this in for ${state.open.suggested}, right?` : "What's the name for the order?";
        break;
      case "confirm":
        question = "All good — confirm?";
        break;
      case "ordering": {
        // 00-AK: three distinct phrasings, cycled by askCount. Any three
        // consecutive turns cover all three exactly once (period-3 cycle),
        // so a real customer who protests instead of ordering never hears
        // the identical question three times running — the dead end that
        // made "Anything else?" unanswerable over an empty cart.
        const ORDERING_QUESTIONS = [
          "What would you like to order?",
          "No rush — what can I get started for you?",
          "Whenever you're ready, just let me know what you'd like.",
        ];
        question = ORDERING_QUESTIONS[(state.open.askCount - 1) % ORDERING_QUESTIONS.length];
        break;
      }
    }
  } else if (state.phase !== "link_sent") {
    question = "Anything else?";
  }
  if (question) parts.push(question);

  if (cartAfter.length > 0) {
    parts.push(renderLedgerFooter(cartAfter as ItemizedCartLine[], state.phase, context.deliveryFeeCents, context.driverTipCents));
  }

  // RENDER is unconditional (§3b step 6) — every turn that reaches it must
  // produce a reply. This is the hard backstop for the one theoretical case
  // where every part above is empty (link_sent, no cart, no declines).
  if (parts.length === 0) parts.push("Anything else?");

  return parts.filter(Boolean).join("\n\n").trim();
}
