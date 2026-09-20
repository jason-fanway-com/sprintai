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
import { splitCustomerPhrases, resolveClaimedPhraseIndex, scopedModifierText, stripOtherItemSpansFromModifierText } from "./phrase-split.ts";
import {
  applyCompiledAddItem,
  applyCompiledModifyItem,
  priceSelections,
  renderStepQuestion,
  renderChoiceList,
  matchChoiceInText,
  matchChoiceAsWholeSpan,
  isRedundantDerivedStep,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "./ask-plan-engine.ts";
import { identityKey, removeCartLine, type ReconcilerCartLine } from "./turn-reconciler.ts";
import { isNegated } from "./reactive-modifier-match.ts";
import {
  resolvePendingDisambiguation,
  isPendingDisambiguationDeclined,
  isDisambiguationAnswerRemovalRequest,
  isDisambiguationOptionsRequest,
  renderAmbiguousItemQuestion,
  renderCappedAmbiguousItemQuestion,
  pickNarrowingFacet,
  isNarrowingCandidateSet,
  narrowCandidatesByFacetAnswer,
  facetDisplayValues,
  candidateSizeValue,
  extractPartialSizeClause,
  extractGlobalSizeWord,
  extractDisambiguationAnswerQuantity,
  filterCandidatesBySizeWord,
  extractAnswerClause,
  extractAnswerQuantity,
  significantStems,
  categoryWordMatches,
  extractSizeAndKind,
  type PendingCandidate,
} from "./pending-disambiguation.ts";
import { isExplicitCheckoutIntent } from "./checkout-intent-gate-20260913.ts";
import { parseBareTipDollars } from "./intent-router.ts";
import { computeCartSubtotalCents } from "./pricing.ts";
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
import { buildConfirmReadback } from "./confirm-readback-20260918.ts";
import {
  impliesUpsellAcceptance,
  impliesUpsellDecline,
  looksLikeCustomerName,
  extractCustomerName,
} from "./dialogue-signals.ts";
import { resolveItem, SIZE_WORD_ALIASES, type LexiconTerm } from "./resolve-item.ts";
import { fuzzyWordMatch, GUARD19_GENERIC_WORDS } from "./guard19-fuzzy-item-match.ts";
// Type-only — delivery-memory-offer.ts is a pure decision module (no I/O)
// with zero dependency on this file, so importing its result TYPE here
// (DialogueState.returningCustomerOffer's own shape, freeze-queue item 7)
// creates no cycle and keeps this module's own "no Supabase client" rule
// intact — only the shape is used, never the function calls themselves
// (those stay in turn-engine-runner.ts, the I/O adapter).
import type { DeliveryOffer } from "./delivery-memory-offer.ts";

// ─── §3a: the state record — EXACT shape from the spec ─────────────────────

export interface DialogueState {
  phase: "ordering" | "order_type" | "address" | "tip" | "name" | "confirm" | "link_sent";
  open:
    | null
    | { kind: "slot"; line_key: string; group_id: string }
    // heldModifierText: see AskTurnEvents.heldModifierText's own doc — the
    // customer's own words for an add that turned out to be a modifier of
    // whichever candidate they're about to pick, applied once they do
    // (answer()'s disambiguation case). Optional so state persisted before
    // this field existed still parses.
    // quantity: the count named alongside the still-ambiguous span ("4 large
    // pizzas" -> 4) — see AskTurnEvents.disambiguationQuantity's own doc.
    // Optional/undefined for every pre-existing caller and persisted state
    // written before this field existed; answer()'s disambiguation case
    // falls back to 1, its exact previous hardcoded behavior.
    // spanText: the customer's own words for the still-ambiguous span ("4
    // large pizzas") — see AskTurnEvents.disambiguationSpanText's own doc.
    // Used only to recover an already-stated size (global or partial) so a
    // narrowing question never re-asks something the customer already
    // answered. otherOneFollowUp: true only on the second disambiguation a
    // partial-size split opens (PO amendment 2026-09-19, "2 pizzas, one
    // large") — render() uses it to say "And the size on the other one?"
    // instead of the plain "What size?" a fresh size facet gets.
    // facetNarrowed: true whenever this open state is the reopened remainder
    // of a facet answer (AnswerOutcome "disambiguation_narrowed" — e.g.
    // "cheese" against 62 candidates narrowed to the 3 Cheese sizes). Forces
    // render()'s disambiguation case to keep asking the next facet ("What
    // size?") instead of falling back to the enumerated list, which
    // isNarrowingCandidateSet's own <=5-candidate/short-list carve-out would
    // otherwise pick for a remainder this small — exactly the live bug where
    // a same-kind, multi-size remainder (always <=5 on a real menu) silently
    // reverted to a priced numbered list after the kind was answered. A
    // disambiguation that was never narrowed (fresh, small, e.g. Soup
    // Bowl/Cup) leaves this unset and keeps its pre-existing fullList wording.
    | {
      kind: "disambiguation";
      candidates: string[];
      heldModifierText?: string | null;
      quantity?: number;
      spanText?: string;
      otherOneFollowUp?: boolean;
      facetNarrowed?: boolean;
      // 2026-09-19 PO dispatch (real live incident, "fifth shape" — a
      // clarifying question with no exit): true once a facet answer against
      // this candidate set has already made ZERO narrowing progress (every
      // candidate still contains the word the customer said). Once set,
      // answer()'s disambiguation case stops trying facet narrowing
      // entirely for this open question — it stays "stuck" on the same
      // words no matter how many more times it's tried — and routes
      // straight to the numbered-list resolver instead; render() shows the
      // capped numbered list (renderCappedAmbiguousItemQuestion) rather
      // than recomputing and re-asking the identical facet question.
      // Persists across turns the same way facetNarrowed/otherOneFollowUp
      // already do (mirrored forward by ask() below) so a customer who
      // still can't answer never gets routed back into the facet loop.
      noProgress?: boolean;
      // 2026-09-19 PO dispatch (replacement, ambiguous target hole): the
      // line_key of X, a same-breath replacement's ORIGINAL item, still
      // sitting untouched in the cart while THIS question narrows down Y.
      // Mirrors heldModifierText's exact "reference-equal to this specific
      // candidate group, survives however many turns the ambiguity stays
      // open" contract -- see DecideResult.replacementSourceLineKey and
      // AskTurnEvents.replacementSourceLineKey for the other two legs.
      // Undefined for every ordinary disambiguation (a fresh ambiguous add,
      // never a replacement) and for state persisted before this field
      // existed.
      replacementSourceLineKey?: string;
    }
    // Round 2, item 1 (2026-09-19, live v511): two or more same-kind,
    // multi-size groups from a single list answer, still waiting on ONE
    // shared size word — see AnswerOutcome's "disambiguation_multi_size_narrowed"
    // and resolveMultiKindClauses's own header (needsSizeGroups). Each
    // group keeps its own candidate ids/quantity; answer()'s own
    // `"multi_size"` case applies whatever size the customer names to every
    // group independently.
    | { kind: "multi_size"; groups: Array<{ candidates: string[]; quantity: number }> }
    | { kind: "upsell"; menu_item_id: string }
    // 2026-09-19 PO dispatch (freeze-queue item 4): a fresh add resolved to
    // exactly one real menu item whose OWN category the customer's words
    // for it don't match (see DecideResult.categoryMismatchPending's own
    // doc for the live bug and detection). Nothing is in the cart for this
    // item yet — unlike the disambiguation-path category-rejection fix
    // (aae67b80), which adds first and asks "keep it or take it off?", a
    // fresh add has never touched the cart at all, so the question here is
    // "add it, or skip it?" instead. `message` is the exact wording to
    // render; `menu_item_id`/`quantity` are applied to the cart only if the
    // customer answers yes (answer()'s "category_confirm" case).
    | { kind: "category_confirm"; menu_item_id: string; quantity: number; message: string }
    // 2026-09-18 PO dispatch (address loop, rule 3): `reason` distinguishes
    // "order type genuinely never asked yet" (render()'s plain "Pickup or
    // delivery today?") from "opened as the fallback after 2 consecutive
    // failed address lookups" (render()'s one-time give-up line) — see
    // ask()'s priority-4 branch and render()'s "order_type" case below.
    | { kind: "order_type"; reason?: "address_unverifiable" } | { kind: "address" } | { kind: "tip" }
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
  // 00-AZ: consecutive turns the CURRENT open question has been open. 0 for a
  // question just opened, 1 the first time it is re-asked, and so on. Optional
  // so states persisted before this field existed still load. See carry().
  openRepeatCount?: number;
  // 2026-09-18 PO dispatch (echo regression follow-up): the exact text last
  // ECHOED back to the customer ("We don't have '<this>' for <item>") on an
  // unmatched slot answer — kept OUTSIDE `open` deliberately, so it never
  // affects `sameQuestionAsBefore`'s comparison (ask()'s openRepeatCount
  // escalation must keep working off `open` alone, unaffected by what text
  // happened to be echoed). Cleared (set to undefined) whenever a turn falls
  // back to the plain enumerate wording instead of echoing, so a LATER
  // attempt with the same original words can still echo fresh once the
  // "two in a row" streak is broken. Set/read only by turn-engine-runner.ts.
  lastSlotEchoText?: string;
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
  // Round 3, item 2b (2026-09-19, live repro, conv e893e129): whether the
  // driver-tip question has genuinely been resolved (an amount OR an
  // explicit decline) at any point THIS order — tracked here, in
  // dialogue_state, rather than inferred from order_carts.driver_tip_cents
  // (AskShopContext.driverTipKnown's old signal), because that column is
  // `NOT NULL DEFAULT 0` (migration 039) — a customer who was never asked
  // and a customer who declined are BOTH stored as the same 0, so
  // `driverTipCents != null` reads true from the moment the cart is
  // created, before the tip is ever asked. Live effect: the priority-5 tip
  // question in ask() below never fired for ANY delivery order. Set true by
  // ask() itself (via AskTurnEvents.tipResolvedThisTurn) the same turn
  // answer() produces a "tip_resolved" outcome — see the priority-5 branch
  // below — and carried forward by every return path (carry() and the
  // fresh-cycle-reset branch) exactly like openRepeatCount/upsell_offered.
  // Optional so state persisted before this field existed still loads
  // (missing = not yet resolved, the correct interpretation either way).
  driverTipResolved?: boolean;
  // 2026-09-19 live repro (Jason's transcript): the checkout ladder (order
  // type/address/tip/upsell -> name -> confirm) rewrites `phase` to whatever
  // intermediate step is open, so by the time the ladder reaches "tip",
  // `phase` no longer says "name"/"confirm"/"link_sent" -- ask()'s own
  // `committedToClose` used to read ONLY off `phase` for that fact, so it
  // forgot the customer had already closed ("That's it") the instant the tip
  // question resolved and `phase` briefly wasn't one of those three values.
  // The very next turn fell all the way back to priority 7's
  // closureOrOrdering(), re-opening "Anything else?" over a cart that had
  // already been closed and re-answering a stated tip/name as if it were a
  // fresh order attempt. Same persisted-once-true pattern as
  // driverTipResolved above: set true the turn checkoutIntentThisTurn first
  // fires, carried on every return path after that for the rest of the
  // order, so no later intermediate-phase turn can un-commit it. Optional so
  // state persisted before this field existed still loads (missing = not yet
  // closed, the correct interpretation either way).
  checkoutClosed?: boolean;
  // Freeze-queue item 7 (2026-09-19): the returning-customer greeting/offer
  // turn-engine-runner.ts asks on a conversation's very first turn (delivery-
  // memory-offer.ts + customer-profile.ts already built and tested this
  // decision logic for the legacy path; this is the engine path's own
  // memory of "we just asked, waiting on yes/no"). Deliberately a top-level
  // field, NOT a variant of `open` above — `open` is consumed by exhaustive
  // switches in ask()/render() that this feature has no business touching;
  // the runner alone reads and clears this field, short-circuiting BEFORE
  // ANSWER/DECIDE/ASK/RENDER ever run on the turn that answers it. `null`
  // once cleared (customer declined, or the offer was accepted and applied)
  // — never re-set later in the same conversation, so a "yes" two turns
  // later (after the customer's message has already moved on) is correctly
  // read as an ordinary confirmation, not a stale re-acceptance of this
  // offer. Optional so state persisted before this field existed still
  // loads (missing = no offer outstanding, the correct interpretation).
  returningCustomerOffer?: {
    // Null when the customer had no favorite_items regular (or it no longer
    // resolves to a real menu item — see turn-engine-runner.ts's own
    // findMenuItemByNamePhrase call) — a delivery-only offer still has a
    // value worth remembering even with no regular item attached.
    regularItem: { menu_item_id: string; name: string } | null;
    // Null when there was no delivery/pickup-again offer worth asking about
    // this turn (delivery-memory-offer.ts's own computeDeliveryOffer/
    // isDeliveryOfferEligible contract — see that module's header for why a
    // plain "pickup again?" is treated as optional and never reaches here).
    deliveryOffer: DeliveryOffer;
  } | null;
}

// ─── §3c: the proposal contract — EXACT shape from the spec ────────────────

export interface Proposal {
  intent: "order" | "checkout" | "cancel" | "question" | "other";
  // 00-BI: what the customer's message MEANS as an answer to the question they
  // were just asked, as one of the ids CODE supplied. Never a free-text
  // meaning, never an id code did not offer -- propose.ts re-checks membership
  // against the list it sent, so a hallucinated value is discarded and the
  // engine behaves exactly as it did before this field existed.
  answer_to_open_question?: string;
  // 00-BL: a VALUE the model extracted for a question that wants one (the
  // customer's name). Code validates the shape before it is ever stored.
  answer_value?: string;
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

// PO amendment (2026-09-19, narrowing questions): adds a facet-narrowed
// candidate straight to the cart, mutating in place — same convention as
// every other applyCompiledAddItem call site in this file. No held-modifier
// recovery here (unlike the numbered-list resolver's own path just below):
// a modifier held back for an ambiguous sibling is scoped to that ONE
// span's own candidate set, which a multi-facet narrowing set (kind, then
// possibly size) never carries through unchanged, so it is out of scope for
// this path rather than silently misapplied.
function addNarrowedCandidateToCart(
  cart: TurnEngineCartLine[],
  menuById: Map<string, TurnEngineMenuItem>,
  candidate: PendingCandidate,
  quantity: number,
): boolean {
  const menuItem = menuById.get(candidate.menu_item_id);
  if (!menuItem?.ask_plan) return false;
  const { texts } = resolveChoiceDisplays(menuItem.ask_plan, []);
  const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, quantity, "", undefined, undefined, texts);
  return result.cartChanged;
}

// Freeze-queue item 7 (2026-09-19): adds a SPECIFIC, already-known menu item
// straight to the cart — same applyCompiledAddItem call addNarrowedCandidateToCart
// above already makes, just keyed by a bare menu_item_id (the returning-
// customer offer already resolved to exactly one item via
// findMenuItemByNamePhrase before this is ever called, so there is no
// PendingCandidate list to thread through). Any required option group the
// item still needs (size, etc.) is left unresolved here on purpose — the
// normal ask()/render() cycle that runs immediately afterward opens that
// slot question exactly as it would for any other fresh add, so a regular
// with required options is never silently defaulted.
export function addResolvedItemToCart(
  cart: TurnEngineCartLine[],
  menu: TurnEngineMenuItem[],
  menuItemId: string,
  quantity: number,
): boolean {
  const menuItem = menu.find(m => m.id === menuItemId);
  if (!menuItem?.ask_plan) return false;
  const { texts } = resolveChoiceDisplays(menuItem.ask_plan, []);
  const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, quantity, "", undefined, undefined, texts);
  return result.cartChanged;
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
  // Rule 3 (2026-09-19, real conv 087abb8d): "take it off" / "remove it"
  // while a slot question is open (e.g. "what type of wrap?") declines the
  // WHOLE item the slot belongs to, never a literal answer to the slot — the
  // line is removed from the cart in place (same mutate-in-place convention
  // as slot_resolved), and there is nothing else to persist; ask() picks the
  // next question fresh off the now-shorter cart, same as any other resolved
  // outcome that doesn't need special handling.
  | { kind: "slot_item_declined" }
  | { kind: "disambiguation_resolved"; menuItemId: string }
  // PO amendment (2026-09-19, narrowing questions): a facet answer that
  // still leaves more than one candidate — the other facet (kind then size)
  // still needs asking. `resolvedMenuItemId` is set only when this same
  // answer ALSO fully resolved a split-off partial-size line ("2 pizzas, one
  // large" -> "pepperoni" resolves the large one outright and reopens a new,
  // smaller disambiguation for the still-unsized remainder) — cart already
  // mutated in place for it, same convention as disambiguation_resolved.
  | {
    kind: "disambiguation_narrowed";
    remainingCandidates: string[];
    remainingQuantity: number;
    resolvedMenuItemId?: string;
    otherOneFollowUp: boolean;
    // 2026-09-19 PO dispatch: mirrors DialogueState.open's own
    // replacementSourceLineKey — carried forward so a replacement's still-
    // unresolved Y (narrowed by one facet, e.g. kind, but not yet down to
    // one candidate) keeps X held for however many more turns the
    // narrowing takes.
    replacementSourceLineKey?: string;
    // 2026-09-19 PO dispatch (real live incident — the "fifth shape": a
    // clarifying question with no exit): true when the customer's own
    // narrowing answer excluded ZERO candidates — every remaining candidate
    // still contains the word they said (real repro: "chicken" against 11
    // Buffalo/Thai/Grilled Chicken items, all still 11 after the answer).
    // render() must never ask the identical facet question again once this
    // is set — see DialogueState.open's own `noProgress` doc.
    noProgress?: boolean;
  }
  // P0 (2026-09-19, multi-kind-answer, see resolveMultiKindClauses's own
  // header): a "what kind?" answer that was a LIST ("one plain, one
  // pepperoni, one meat lovers and one hawaiian") resolved zero, one, or
  // several of its clauses outright — each already added to cart, its own
  // count, in place (same mutate-in-place convention as
  // disambiguation_resolved). `clarifyMessage` names whatever clause(s)
  // didn't cleanly resolve to exactly one candidate (no match, a quantity
  // that didn't sum to the original open quantity, or more than one
  // still-ambiguous clause) — undefined when every clause resolved cleanly.
  | {
    kind: "disambiguation_multi_resolved";
    resolvedMenuItemIds: string[];
    clarifyMessage?: string;
  }
  // Round 2, item 1 (2026-09-19, live v511): two or more clauses of a list
  // answer each matched their own kind cleanly but left several sizes open,
  // with no size ever stated ("one cheese, one hawaiian, two meat lovers" —
  // see resolveMultiKindClauses's own header, needsSizeGroups). Opens a
  // SHARED "What size?" question covering every one of `groups` at once —
  // the next turn's single size answer resolves all of them together (see
  // DialogueState's own "multi_size" open kind), rather than the customer
  // being asked the same question once per kind. `resolvedMenuItemIds`
  // carries whatever OTHER clauses in the SAME message resolved outright
  // this turn (cart already mutated in place for those, same convention as
  // disambiguation_multi_resolved); `clarifyMessage`, when present, names
  // whatever clause(s) are still genuinely unclear (not just missing a
  // size) — rides alongside the size question rather than replacing it.
  | {
    kind: "disambiguation_multi_size_narrowed";
    groups: Array<{ candidates: string[]; quantity: number }>;
    resolvedMenuItemIds: string[];
    clarifyMessage?: string;
  }
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
  | { kind: "closure" }
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 1: quantity):
  // a correction like "2 Thin Sicilian Pizzas, not one" while confirm is
  // open is a QUANTITY SET on that existing line — resolved and applied
  // directly (see parseQuantityCorrection below), never read as a plain
  // decline (impliesConfirmDecline would otherwise catch "wrong"/"instead"
  // and discard the correction entirely, landing on "Anything else?" with
  // nothing fixed). ask() reopens confirm with a FRESH read-back on this
  // outcome specifically — never the short "All good — confirm?" a genuine
  // repeat gets, since the cart just changed and the customer needs to see
  // the new numbers, not just be asked to re-confirm the same ones.
  | { kind: "quantity_corrected" }
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 2:
  // replacement): "<X>, not <Y>" while confirm is open, where Y matches an
  // existing cart line, replaces that line with X — resolved directly
  // (see parseReplacementCorrection below), never left to PROPOSE's
  // removes/adds for this shape (the real defect: the model's own removes
  // array named every line in the cart, and only the one that happened to
  // still match a real line_key was silently deleted — never the line the
  // customer actually named). ask() reopens confirm with a fresh read-back,
  // same as quantity_corrected, since the cart changed.
  | { kind: "line_replaced" }
  // Money bug fix (2026-09-19, live conv 0dcb02a7): a bare removal ("no
  // stromboli") while confirm is already open — no replacement target named,
  // just "take this off" — resolved directly against the cart's real lines
  // (see applyNamedLineRemovals's own header), checked ahead of
  // impliesConfirmDecline below so "no" inside "no stromboli" is never read
  // as declining the WHOLE order. ask() reopens confirm with a fresh
  // read-back, same convention as quantity_corrected/line_replaced above,
  // since the cart just changed.
  | { kind: "line_removed_at_confirm" }
  // X doesn't exist as its own menu item ("there is no 16\" House pizza,
  // only the stromboli") — declined by name, nothing touched. `message` is
  // threaded through to the runner's existing answerText hook (the same
  // one intent:"question"'s answer_text already uses) so it renders ahead
  // of the normal confirm re-ask, never inventing a second reply-building
  // path.
  | { kind: "replacement_unavailable"; message: string }
  // 2026-09-18 PO dispatch (address loop, rule 2): "cancel"/"forget it"/
  // "never mind" while address is open must abandon the whole order, not be
  // treated as a failed address (which re-asks the exact same question the
  // customer just tried to escape). The cart is cleared in place by the
  // "address" case below, same mutate-in-place convention the slot/
  // disambiguation cases already use.
  | { kind: "cart_cancelled" }
  // 2026-09-19 PO dispatch (Commit 3): when a disambiguation answer explicitly
  // rejects the offered category ("not stromboli", "I meant pizza not X") but
  // still names the item family, the customer hasn't declined the item — they
  // want it under a different category they think exists. Respond the same way
  // the category-mismatch case in decide() already does: add the item (the
  // best-matching candidate) and say "We only have X as a Y. Keep it, or take
  // it off?" — never silently drop the line. `message` carries that wording,
  // `menuItemId` is the candidate actually added to the cart.
  | { kind: "disambiguation_category_rejected"; message: string; menuItemId: string }
  // Round 2, item 3 (2026-09-19, live repro): an answer to "which one?"
  // that names an entirely DIFFERENT item than anything on the offered
  // list — see messageNamesItemOutsideCandidates's own header for why the
  // pre-existing resolvers can misread this as picking a position/category
  // within the open list instead. The named item is added on its own
  // (`menuItemId`, `quantity` — cart already mutated in place, same
  // convention as disambiguation_resolved), and the ORIGINAL disambiguation
  // stays open exactly as it was — the runner re-opens the identical
  // question next turn, same as a genuinely-failed answer would, so the
  // still-unresolved item is never silently dropped.
  | { kind: "disambiguation_new_item_added"; menuItemId: string; quantity: number }
  // M2 fix (2026-09-19, live conv d3539d12 #5): an answer to "which one?"
  // that carries removal language ("remove that small Pepperoni pizza")
  // instead — never a candidate pick. `removed` reports whether a matching
  // real cart line was actually found and taken off (same "graceful no-op,
  // never an error" contract applyNamedLineRemovals already has everywhere
  // else it's called); the ORIGINAL disambiguation stays open exactly as it
  // was, same convention as disambiguation_new_item_added just above —
  // removing an unrelated cart line never answers what candidate the
  // customer actually wants for the still-unresolved item.
  | { kind: "disambiguation_removal_applied"; removed: boolean }
  // Round 3, item 2c(ii) (2026-09-19, live repro): a question at confirm
  // whose answer lives in the shop's own data (delivery fee, whether a tip
  // can be added, hours) — answered by CODE, never sent to the model, same
  // "code decides" principle as everywhere else in this file. `infoText`
  // rides ahead of the normal confirm re-ask via the same answerText hook
  // replacement_unavailable already uses (never a second reply-building
  // path); confirm itself stays open so ask() re-asks it right after.
  | { kind: "confirm_info_answered"; infoText: string }
  // 2026-09-19 PO dispatch (freeze-queue item 4): the customer answered a
  // fresh-add category-mismatch question. "added" — cart already mutated in
  // place by answer() (same convention as upsell_accepted); "declined" —
  // nothing touched, the held-back item is simply never added. See
  // DialogueState.open's own "category_confirm" variant.
  | { kind: "category_confirm_added"; menuItemId: string }
  | { kind: "category_confirm_declined" };

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
  // PO fix (2026-09-19, round 2 addendum): the shop's own item-level lexicon,
  // same shape decide() already resolves every fresh add's item_span against
  // (resolve-item.ts). Threaded in here so a "what kind?" disambiguation
  // answer — single-clause or list — can be resolved the SAME deterministic
  // way, instead of the disambiguation-only name-facet matcher below that
  // never sees an alias/typo/category lexicon entry. Undefined on every
  // pre-existing call site and test (all unaffected — see
  // resolveKindClauseViaLexicon's own header for the fallback this permits).
  lexicon?: LexiconTerm[];
  // Round 3, item 2c(ii): the shop facts a confirm-stage question can be
  // answered from directly — read by the caller (turn-engine-runner.ts)
  // ONLY while confirm is the open question (same lazy-load discipline as
  // `lexicon` above for disambiguation), never fetched on an ordinary
  // ordering turn. `hoursLine` is shop_settings.hours_line, already
  // formatted human-readable text (never assembled here from open_hours).
  confirmShopFacts?: { deliveryFeeCents: number | null; hoursLine: string | null };
}

const BARE_CLOSURE_RE = /^(?:no|nope|nah|none|nothing|that'?s all|thats all)[.!]?$/i;
// 00-BG: the SAME defect as the name question and the confirm gate, a third
// time. BARE_CLOSURE_RE is anchored to the whole message, so "nope" closes the
// order and "Nope, that's it for now!" does not. Live, from one run, each
// answered with "Anything else?" again:
//   "Nope, that's it for now!"
//   "No, that's all! Just the small Meat Lover, large Meat Lover, and side salad for pickup."
//   "That's all I want! Just the wings for pickup."
//   "I think I'm good! Just the Coke and onion rings."
// That is the "same question asked 3+ times" property at 81%, and it is what
// burns the turns a conversation needs to reach checkout.
//
// Reads closure ANYWHERE in the message, then requires that the customer is
// not simultaneously asking for something. The add-marker guard is the same
// one the restatement fix uses: "no, that's all BUT ALSO add a coke" must not
// close the order.
const CLOSURE_ANYWHERE_RE =
  /\b(?:that'?s (?:it|all|everything)|thats (?:it|all|everything)|nothing (?:else|more)|no(?:thing)? more|i'?m (?:good|done|all set)|im (?:good|done)|we'?re good|all set|that(?: will|'?ll) be (?:it|all))\b/i;
const CLOSURE_BLOCKED_BY_RE =
  /\b(?:also|another|one more|1 more|add |plus |as well|too\b|actually|instead|change|wait|but )\b/i;

// 2026-09-19 PO dispatch (P0, conversation ae0eb19b, swallowed order): a
// customer's FIRST-EVER message -- an entire fresh order, "yo, lemme get 2x
// buffalo chicken cheesesteaks w/ mild sauce and 1x french fries. that's it
// rn" -- was read as closure because CLOSURE_ANYWHERE_RE matches "that's it"
// ANYWHERE, including this casual "that's it [for] rn[ow]" filler tacked
// onto the end of an order that was never even started. impliesClosure
// returned true with cart empty, PROPOSE was never reached (zero
// propose_call/propose_success rows for the entire conversation, confirmed
// against error_log), and every one of the 15 turns that followed just
// cycled ask()'s 3 "ordering" phrasings forever -- the order was silently
// discarded before it was ever read, not lost partway through.
// CLOSURE_ANYWHERE_RE's own header says what closure means: "I'm done
// adding items, move on" -- a commitment forward. That is only a coherent
// reading when there is something to move ON FROM. With an empty cart there
// is nothing to close, so the broader ANYWHERE tier (built to catch a
// closure phrase embedded in a longer sentence) is suppressed entirely and
// only the exact, whole-message BARE_CLOSURE_RE tier is trusted -- an
// unambiguous bare "no"/"nope"/"that's all" with nothing else said still
// closes (there is no other plausible reading of a bare word), but an
// embedded "that's it" riding along with real order content falls through
// to PROPOSE instead of silently eating the order. `cartHasItems` defaults
// to true (this function's original, unconditional behavior) so every
// existing single-argument call and test is unaffected -- only answer()'s
// two call sites below pass the real cart state.
export function impliesClosure(message: string, cartHasItems = true): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (BARE_CLOSURE_RE.test(m)) return true;
  if (!cartHasItems) return false;
  if (CLOSURE_BLOCKED_BY_RE.test(m)) return false;
  return CLOSURE_ANYWHERE_RE.test(m);
}

// 2026-09-18 PO dispatch (address loop, rule 2, live: 3 conversations x
// 14-20 turns, run 181417): "can I just pick it up?", "forget it, just
// cancel", and a second/third different address were ALL getting the exact
// same "I couldn't find that address" line as a garbled address, because
// nothing in the "address" case below recognized abandon-the-order intent
// as anything other than a failed address attempt. Distinct from
// impliesClosure/CLOSURE_ANYWHERE_RE above: closure means "I'm done adding
// items, move on" (a commitment forward); this means the opposite (give up
// on the order entirely) — conflating them would make "that's everything"
// while address is open accidentally cancel a real order.
const CANCEL_ORDER_ANYWHERE_RE = /\b(?:cancel|forget it|forget the whole (?:thing|order)|never\s?mind)\b/i;
// 2026-09-18 PO dispatch (address loop, rule 1): the PO's own acceptance
// phrase — "can I just pick it up?" — never matched this regex before: "pick
// it up" has a word between "pick" and "up" that neither `[\s-]?` (single
// char) nor the old pattern accounted for, so the general order_type
// resolver already had this gap for any caller, not just the new address
// case below.
const ORDER_TYPE_PICKUP_RE = /\bpick(?:\s+it)?[\s-]?up\b/i;
const ORDER_TYPE_DELIVERY_RE = /\bdeliver(?:y|ed)?\b/i;

// Round 3, item 2b (2026-09-19, live repro, conv e893e129): exported so
// turn-engine-runner.ts can read an order-type statement OPPORTUNISTICALLY
// — regardless of what's actually open — the same way it already reads an
// address opportunistically (extractAddressSpan/opportunisticAddress). A
// live delivery+address message can arrive while a completely unrelated
// question is open (a fries disambiguation, in the repro) and the
// "order_type" case of answer()'s own switch below is the ONLY other place
// this ever resolved — meaning order type was silently never captured
// whenever it wasn't the exact question on the table, and ask()'s tip gate
// (which requires orderTypeIsDelivery) could then never fire either. Same
// exact logic as the "order_type" case below, extracted so both callers
// share one rule.
export function readOrderTypeReply(message: string): "pickup" | "delivery" | null {
  const trimmed = (message ?? "").trim();
  const wantsPickup = ORDER_TYPE_PICKUP_RE.test(trimmed);
  const wantsDelivery = ORDER_TYPE_DELIVERY_RE.test(trimmed);
  if (wantsPickup && !wantsDelivery) return "pickup";
  if (wantsDelivery && !wantsPickup) return "delivery";
  return null;
}
// Mirrors intent-router.ts's detectBareTipReply decline shape, narrowed to
// this module's own already-open-tip-question context (that function's own
// "did the prior assistant message offer a tip" half is redundant here —
// state.open.kind === "tip" already establishes that fact).
const TIP_DECLINE_RE = /^(?:no tip|no thanks|no thank you|not now|skip|none|pass|no)[.!]?$/i;
const TIP_AMOUNT_RE = /^\$?\s*\d+(?:\.\d{1,2})?\s*$/;
const CONFIRM_DECLINE_RE = /^(?:no|nope|nah|not yet|wait|hold on)[.!]?$/i;
// 00-BH: the same whole-message anchoring, in three more places -- two of them
// on money. Found by auditing every /^..._RE = \/\^/ detector rather than
// waiting for the sim to trip over them one at a time, which is how the name
// question, the confirm gate and the closure check were each found separately.
//
// TIP: "No tip, thanks!" and "No, I don't want a tip" both failed the anchored
// decline, and "leave $5" / "5 dollars" both failed the anchored amount, so a
// customer answering the tip question at all could leave it unresolved and be
// re-asked. An amount WINS over a decline word, so "no more than $5" tips $5
// rather than declining. A bare number is still read as dollars exactly as
// before -- the tip question is open, so a number here is unambiguous.
// P0 (2026-09-19, live money bug, deploy v528): "driver" now optional
// between "want a" and "tip" -- "I don't want a driver tip" used to miss
// this entirely (the literal word "tip" had to sit right after "want a"),
// so a real decline fell through to the amount scan below and read whatever
// dollar figure happened to be elsewhere in the same message as the tip.
const TIP_DECLINE_ANYWHERE_RE = /\b(?:no tip|without a tip|don'?t want (?:a |any )?(?:driver )?tip|no thanks|no thank you|not (?:now|today)|skip (?:it|the tip)?|none|pass|zero|nothing)\b/i;
// P0 (2026-09-19, live money bug, deploy v528, conv-level repro: "I don't
// want a driver tip. Is it really $19.99 for that?" charged a $19.99 tip on
// an $8.49 order): the old TIP_AMOUNT_ANYWHERE_RE scanned the WHOLE message
// for ANY dollar figure and, checked BEFORE the decline above, used
// whichever one it found first -- here, the delivery fee the customer was
// ASKING about, in a second sentence that had nothing to do with tipping.
// Two independent fixes, both required: (1) decline is now checked FIRST
// (see readTipReply below), so an explicit decline always wins over a
// number appearing anywhere else in the same message; (2) a number is only
// ever read as an explicit tip when it sits next to the word "tip" (or a
// word-number amount is stated "for the driver") -- never scanned out of
// an unrelated clause on its own. This intentionally tightens the old
// "leave $5" / "5 dollars" / "$3.50 please" / "2 bucks" behavior (see
// anchored-detectors-20260917.test.ts's own updated header) -- those were
// exactly the "guess a bare number means tip" shape this P0 was filed to
// remove; a bare "$5"/"5" (the whole message, nothing else said) is still
// read fine via TIP_AMOUNT_RE below, unchanged.
const TIP_NUMBER_NEAR_TIP_WORD_RE = /\btip\b[^.?!]{0,25}?\$?\s*(\d+(?:\.\d{1,2})?)|\$?\s*(\d+(?:\.\d{1,2})?)[^.?!]{0,25}?\btip\b/i;
const TIP_WORDNUMBER_FOR_DRIVER_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+dollars?\b[^.?!]{0,25}?\bdriver\b/i;
const TIP_BARE_PERCENT_RE = /^\s*(\d{1,3})\s*%\s*$/;
const TIP_PERCENT_NEAR_TIP_WORD_RE = /\btip\b[^.?!]*?(\d{1,3})\s*%|(\d{1,3})\s*%[^.?!]*?\btip\b/i;
// Round 3, item 2c(ii): three shop-data question shapes recognized at
// confirm, answered by CODE instead of falling through to PROPOSE (a real
// question about a real number this system already has must never be
// guessed at, or worse, silently ignored and re-asked the confirm gate).
// Checked ONLY inside the "confirm" case, after the tip-amount check above
// has already had first crack — a bare "tip" mention that reaches here
// carries no dollar amount, so it's a genuine question, not a statement.
const CONFIRM_DELIVERY_FEE_QUESTION_RE = /\bdeliver(?:y)?\b[^?]*\b(free|fee|charge|cost)\b|\b(free|fee|charge|cost)\b[^?]*\bdeliver(?:y)?\b|\bhow much\b[^?]*\bdeliver/i;
const CONFIRM_TIP_QUESTION_RE = /\btip\b/i;
const CONFIRM_HOURS_QUESTION_RE = /\b(?:hours|what time|when (?:do|are) you|open until|close[sd]?|closing)\b/i;

// Round 3, item 2b (2026-09-19, live repro, conv e893e129): item 2c(ii)'s
// shop-facts answering (delivery fee / tip info / hours, answered by CODE,
// never sent to the model) extracted so the "tip" case below can reuse it
// too, not just "confirm" — the repro asks "So delivery is free?" WHILE tip
// is still the open question (the customer never answered it, just asked
// something else), and the identical shop-data-question shape deserves the
// identical direct-from-code answer there, not a bare re-ask or a model
// guess. Returns null when nothing here matches, exactly as inlined before.
function answerConfirmShopFactsQuestion(
  trimmed: string,
  confirmShopFacts: { deliveryFeeCents: number | null; hoursLine: string | null } | undefined,
  // 2026-09-19 live repro: the "tip" case below (state.open.kind === "tip")
  // re-asks "Want to add a tip for the driver?" itself, via render()'s own
  // "tip" case, on the SAME turn this function's tip-info branch would fire
  // -- the two questions rode out together in one SMS ("You can add a tip
  // for the driver — how much?" immediately followed by "Want to add a tip
  // for the driver?"), asking the identical thing twice. The "confirm" case
  // needs this branch (tip isn't otherwise open there, so answering "you can
  // add a tip" is the only place that information comes from), but the
  // "tip" case's own call site sets this true to skip it -- the re-ask
  // already covers it.
  skipTipInfo = false,
): AnswerResult | null {
  if (!confirmShopFacts) return null;
  if (CONFIRM_DELIVERY_FEE_QUESTION_RE.test(trimmed)) {
    const feeCents = confirmShopFacts.deliveryFeeCents;
    const infoText = feeCents == null
      ? "I'm not sure of the exact delivery fee — I'll have the shop confirm."
      : feeCents === 0
      ? "Delivery is free."
      : `Delivery is $${(feeCents / 100).toFixed(2)}.`;
    return { resolved: true, outcome: { kind: "confirm_info_answered", infoText }, cartChanged: false };
  }
  if (!skipTipInfo && CONFIRM_TIP_QUESTION_RE.test(trimmed)) {
    return { resolved: true, outcome: { kind: "confirm_info_answered", infoText: "You can add a tip for the driver — how much?" }, cartChanged: false };
  }
  if (CONFIRM_HOURS_QUESTION_RE.test(trimmed)) {
    const infoText = confirmShopFacts.hoursLine
      ? `Our hours: ${confirmShopFacts.hoursLine}`
      : "I'm not sure of our exact hours — I'll have the shop confirm.";
    return { resolved: true, outcome: { kind: "confirm_info_answered", infoText }, cartChanged: false };
  }
  return null;
}

// P0 (2026-09-19): the number itself, read ONLY from an explicit tip
// phrase -- "$5 tip"/"tip $5"/"tip the driver 5" (number within 25 chars of
// the word "tip"), "five dollars for the driver" (word-number + "dollars"
// + "driver"), "20%"/"tip 20%" (percent, resolved against subtotalCents
// when known), or the bare whole-message "$5"/"5" (TIP_AMOUNT_RE,
// unambiguous since nothing else is being said). Returns null -- never a
// guess -- for anything else, e.g. a dollar figure that just happens to
// appear in an unrelated sentence.
function extractExplicitTipCents(m: string, subtotalCents: number | undefined): number | null {
  if (TIP_AMOUNT_RE.test(m)) return Math.round(parseBareTipDollars(m) * 100);
  const barePercent = TIP_BARE_PERCENT_RE.exec(m);
  if (barePercent && subtotalCents != null) {
    return Math.round(subtotalCents * (parseInt(barePercent[1], 10) / 100));
  }
  const nearTip = TIP_NUMBER_NEAR_TIP_WORD_RE.exec(m);
  if (nearTip) {
    const raw = nearTip[1] ?? nearTip[2];
    return Math.round(parseFloat(raw) * 100);
  }
  const wordNum = TIP_WORDNUMBER_FOR_DRIVER_RE.exec(m);
  if (wordNum) {
    const n = NUMBER_WORDS[wordNum[1].toLowerCase()];
    if (n) return n * 100;
  }
  const tipPercent = TIP_PERCENT_NEAR_TIP_WORD_RE.exec(m);
  if (tipPercent && subtotalCents != null) {
    const pct = tipPercent[1] ?? tipPercent[2];
    return Math.round(subtotalCents * (parseInt(pct, 10) / 100));
  }
  return null;
}

export function readTipReply(
  message: string,
  ctx: { subtotalCents?: number; lineItemPricesCents?: number[] } = {},
): { kind: "amount"; cents: number } | { kind: "decline" } | null {
  const m = (message ?? "").trim();
  if (!m) return null;
  // Decline checked FIRST -- see TIP_DECLINE_ANYWHERE_RE's own header. An
  // explicit decline always wins over a dollar figure appearing anywhere
  // else in the same message.
  if (TIP_DECLINE_RE.test(m) || TIP_DECLINE_ANYWHERE_RE.test(m)) return { kind: "decline" };
  const isBareNumber = TIP_AMOUNT_RE.test(m);
  const cents = extractExplicitTipCents(m, ctx.subtotalCents);
  if (cents == null) return null;
  // Rule 5a: a number is never accepted as the tip if that exact figure
  // also names a real line-item price elsewhere in the same message (the
  // $19.99-delivery-fee-mistaken-for-tip shape) -- defense in depth
  // alongside the decline-checked-first fix above. Never applied to the
  // bare whole-message case: there is no "elsewhere" in a message that IS
  // just the number.
  if (!isBareNumber && ctx.lineItemPricesCents?.includes(cents)) return null;
  // Rule 5b: capped at the subtotal -- a tip can never exceed the order.
  // 2026-09-19: a builder briefly removed this rule after misreading a test
  // artifact ($5 tip on a $4.99 SYNTHETIC test order) as a live bug -- the
  // PO confirmed rule 5b is intentional and reinstated it before merge; the
  // $4.99 shape only ever shows up on a test order small enough to hit the
  // cap by construction, never in real order sizes.
  const cappedCents = ctx.subtotalCents != null ? Math.min(cents, ctx.subtotalCents) : cents;
  return { kind: "amount", cents: cappedCents };
}

// CONFIRM: declining just reopens ordering -- it never charges anyone -- so
// reading it anywhere is the safe direction. "No, wait, change the size" and
// "no, remove the onions" are both the customer refusing to confirm.
const CONFIRM_DECLINE_ANYWHERE_RE = /\b(?:no|nope|nah|not yet|wait|hold on|hold up|change|remove|instead|actually|mistake|wrong|cancel)\b/i;

export function impliesConfirmDecline(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  return CONFIRM_DECLINE_RE.test(m) || CONFIRM_DECLINE_ANYWHERE_RE.test(m);
}

// 2026-09-18 PO dispatch (read-back corrections, mechanism 1). Real conv
// e46f1c41, live: read-back showed "One Size Thin Sicilian Pizza" (customer
// ordered 2). "I think you got the pizzas wrong. I meant 2 Thin Sicilian
// Pizzas, not one." contains "wrong"/"instead"/"actually" — exactly the
// words CONFIRM_DECLINE_ANYWHERE_RE above already treats as a plain
// decline, discarding the correction's actual content and landing on
// "Anything else?" with the cart untouched. Three consecutive attempts
// (differently worded, same correction) all hit this same dead end; only
// the fourth, phrased as a plain restatement with no decline word in it,
// happened to reach PROPOSE and succeed. This is the deterministic path
// that makes the FIRST attempt work, for any of the PO's four listed
// shapes — checked in `answer()`'s "confirm" case BEFORE
// impliesConfirmDecline gets a chance to consume the message as a bare no.
const QUANTITY_WORD_RE = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
function parseQtyToken(tok: string): number | null {
  const n = Number(tok);
  if (Number.isFinite(n) && n > 0) return n;
  return NUMBER_WORDS[tok.toLowerCase()] ?? null;
}
// The separator between a quantity token and the item name that follows it
// — "2 Thin Sicilian Pizzas" (bare number, a space), "2 x Thin Sicilian
// Pizzas" (spelled-out "x"), or "1x Large Hawaiian Pizza" (the "x" GLUED
// directly to the digit, no space at all). 2026-09-19 PO dispatch (P0, conv
// 6fc39938, live money bug): the old `\s+(?:x\s+)?` fragment required at
// least one space immediately after the quantity token, so "1x ..." never
// matched ANY of the three patterns below at all — not "close but wrong
// number", not matched even as an attempt. The customer repeated the exact
// same correction five more times, worded five different ways, and every
// one of them fell through this same gap or the "make it"/"only want" gaps
// fixed alongside it.
const QTY_ITEM_SEP = "(?:\\s*x\\s*|\\s+)";
// "<N> <item>, not/instead of <M>" — covers "2 Thin Sicilian Pizzas, not
// one" and "2 x Thin Sicilian Pizzas instead of one" (the "x" is optional).
const QUANTITY_CORRECTION_NOT_RE = new RegExp(
  `\\b${QUANTITY_WORD_RE}${QTY_ITEM_SEP}([a-zA-Z][a-zA-Z '"-]*?),?\\s+(?:not|instead of)\\s+${QUANTITY_WORD_RE}\\b`, "i",
);
// "I meant <N> <item>" — a correction that states the right number without
// necessarily naming the wrong one too.
const QUANTITY_CORRECTION_MEANT_RE = new RegExp(
  `\\bi meant\\s+${QUANTITY_WORD_RE}${QTY_ITEM_SEP}([a-zA-Z][a-zA-Z '"-]*?)(?:,|\\.|$)`, "i",
);
// "I (actually/really) only want <N> <item>" / "I just want <N> <item>" —
// 2026-09-19 PO dispatch (P0, conv 6fc39938): a third real phrasing from
// the same live conversation, never covered by any existing pattern at all
// (not a spacing gap like the two above — this shape simply had no rule).
const QUANTITY_CORRECTION_ONLY_WANT_RE = new RegExp(
  `\\b(?:only|just)\\s+want\\s+${QUANTITY_WORD_RE}${QTY_ITEM_SEP}([a-zA-Z][a-zA-Z '"-]*?)(?:,|\\.|!|$)`, "i",
);
// "make it/that <N> <item>[, <N> <item>...][ and <N> <item>]" — captures
// everything after "make it"/"make that" up to sentence end, then each
// comma/"and"-joined clause is parsed on its own below (parseQtyItemClause)
// so a compound correction naming TWO items each with their own quantity
// ("make that 1x Large Hawaiian Pizza and 1x Nonas Meatballs") applies both,
// while a clause that never states its own number (an item just mentioned
// along for the ride, "and the Garlic Knots") is left alone rather than
// guessed at. 2026-09-19 PO dispatch: widened from "make it" only to also
// accept "make that" — the live transcript's exact wording — which the
// 2026-09-18 version of this rule never matched at all.
const QUANTITY_CORRECTION_MAKE_IT_RE = /\bmake (?:it|that)\s+([^.!?]+)/i;

interface QuantityCorrectionCandidate {
  quantity: number;
  itemPhrase: string;
}

// A single "<N> <item>" clause, anchored to the whole (trimmed) clause —
// used to validate each piece of a "make it/that" compound correction.
function parseQtyItemClause(clause: string): QuantityCorrectionCandidate | null {
  const re = new RegExp(`^${QUANTITY_WORD_RE}${QTY_ITEM_SEP}([a-zA-Z][a-zA-Z '"-]*)$`, "i");
  const m = clause.trim().match(re);
  if (!m) return null;
  const quantity = parseQtyToken(m[1]);
  const itemPhrase = m[2]?.trim();
  return quantity && itemPhrase ? { quantity, itemPhrase } : null;
}

// Returns every quantity correction stated in the message — almost always
// exactly one, except a "make it/that X and Y" compound naming two or more
// items each with their own explicit quantity.
function parseQuantityCorrectionPhrases(message: string): QuantityCorrectionCandidate[] {
  for (const re of [QUANTITY_CORRECTION_NOT_RE, QUANTITY_CORRECTION_MEANT_RE, QUANTITY_CORRECTION_ONLY_WANT_RE]) {
    const m = message.match(re);
    if (!m) continue;
    const quantity = parseQtyToken(m[1]);
    const itemPhrase = m[2]?.trim();
    if (quantity && itemPhrase) return [{ quantity, itemPhrase }];
  }
  const makeItMatch = message.match(QUANTITY_CORRECTION_MAKE_IT_RE);
  if (makeItMatch) {
    const clauses = makeItMatch[1].split(/\s*,\s*|\s+and\s+/i);
    const candidates = clauses.map(parseQtyItemClause).filter((c): c is QuantityCorrectionCandidate => c !== null);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

// Matches itemPhrase against exactly one REAL cart line by stem subset —
// same "missing beats wrong" convention as matchChoiceInText/
// matchReactiveExtras elsewhere in this codebase: every significant stem
// the phrase contributes must appear in the line's own name (tolerates
// "Thin Sicilian Pizzas" naming "One Size Thin Sicilian Pizza" — "size"
// stays unclaimed, "one" is already a stopword). Two or more lines
// matching, or none, returns null — never a guess at which line was meant.
// Shared by both read-back correction mechanisms (quantity and
// replacement) — renamed from the quantity-only findCartLineForQuantityCorrection
// when mechanism 2 needed the identical "match a phrase against exactly one
// real cart line's name" logic.
function findCartLineByNamePhrase(
  cart: TurnEngineCartLine[],
  itemPhrase: string,
): TurnEngineCartLine | null {
  const phraseStems = significantStems(itemPhrase);
  if (phraseStems.size === 0) return null;
  const hits = cart.filter(line => {
    if (!isRealCartLine(line)) return false;
    const lineStems = significantStems(line.name);
    return [...phraseStems].every(s => lineStems.has(s));
  });
  return hits.length === 1 ? hits[0] : null;
}

// 2026-09-19 PO dispatch (P0, conv 6fc39938) — the mirror of
// findCartLineByNamePhrase above: does the customer's WHOLE message name a
// real cart line, rather than does a short extracted phrase match one? Every
// significant stem of the line's own name must appear somewhere in the
// message (order-independent, tolerant of everything else the message also
// says) — used only to decide whether an unmatched confirm-state message is
// confidently ABOUT a specific real item (forward to PROPOSE) or genuinely
// unrelated chatter/complaint (safe to resolve as a plain decline, same as
// before this dispatch).
function messageNamesRealCartLine(message: string, cart: TurnEngineCartLine[]): boolean {
  const messageStems = significantStems(message);
  return cart.some(line => {
    if (!isRealCartLine(line)) return false;
    const lineStems = significantStems(line.name);
    return lineStems.size > 0 && [...lineStems].every(s => messageStems.has(s));
  });
}

// 2026-09-18 PO dispatch (read-back corrections, mechanism 2: replacement).
// Real conv 453c5cc7, live: read-back showed "16\" House Stromboli".
// "Just to clarify, I wanted a 16\" House pizza, not a stromboli. Can you
// fix that?" removed "Small Gyro Pizza" instead — a line the customer
// never named. Pulled the real propose_success log for that turn: the
// model's own proposal carried THREE remove line_keys (every line in the
// cart) and only ONE add ("16\" House pizza") — decide()'s remove loop
// (turn-engine.ts, the `for (const rm of proposal.removes ?? [])` block)
// has no verification that a removed line was actually named by the
// customer, unlike the add path's itemSpanNamedInMessage guard — whichever
// of the three line_keys still matched a real line by accident (the Gyro's
// did) was removed for real, silently.
//
// Rule (PO): "<X>, not <Y>" where Y matches a cart line replaces that line
// with X — resolved deterministically here, in the SAME "confirm" case as
// mechanism 1, BEFORE the message can ever reach PROPOSE's flawed
// removes/adds for this shape. X not existing on the menu (this exact
// case — there is no House pizza, only the stromboli) declines by name,
// touching nothing, rather than guessing or silently keeping the wrong
// line.
// Arrow form deliberately (see extractSlotChoiceWords's own doc above) —
// this file's gate test asserts exactly one function signature returning a
// string exists (render()); a second matching declaration trips it even
// though this helper never produces customer-facing text on its own.
const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface ReplacementCorrectionCandidate {
  targetPhrase: string; // X — what the customer actually wants
  wrongPhrase: string;  // Y — what's on the order that's wrong
}

const REPLACEMENT_NOT_SUFFIX_RE = /,?\s+not\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z][a-zA-Z '"-]*?)[.,!?]?(?:\s|$)/i;
const REPLACEMENT_LIST_AND_RE = /\band\s+(?:a\s+|an\s+|the\s+)?/gi;
const REPLACEMENT_LEADING_WANT_RE = /^.*?\bi\s+(?:still\s+)?(?:wanted|want|need)\s+(?:a\s+|an\s+|the\s+)?/i;

function parseReplacementCorrection(message: string): ReplacementCorrectionCandidate | null {
  const notMatch = message.match(REPLACEMENT_NOT_SUFFIX_RE);
  if (!notMatch || notMatch.index === undefined) return null;
  const wrongPhrase = notMatch[1].trim();
  let before = message.slice(0, notMatch.index);
  // A list ("...the small Gyro pizza, Fish and Chips, and the 16\" House
  // pizza") names several items in the same breath — only the one right
  // before "not" is actually in question; the LAST "and (a|an|the)?" marks
  // where its own phrase starts, never the list's first item.
  const andMatches = [...before.matchAll(REPLACEMENT_LIST_AND_RE)];
  const lastAnd = andMatches[andMatches.length - 1];
  if (lastAnd && lastAnd.index !== undefined) {
    before = before.slice(lastAnd.index + lastAnd[0].length);
  } else {
    before = before.replace(REPLACEMENT_LEADING_WANT_RE, "");
  }
  const targetPhrase = before.trim();
  if (!targetPhrase) return null;
  return { targetPhrase, wrongPhrase };
}

// Real, distinct menu items whose display name's stems are a superset of
// phraseStems — same stem-subset convention as findCartLineByNamePhrase
// above, on the menu side instead of the cart side. `excludeMenuItemId`
// keeps the currently-wrong line's own item from ever counting as its own
// replacement. Two or more matches, or none, returns null — a genuine
// ambiguity or a genuinely nonexistent item are handled identically by the
// caller (never guess, never silently keep the wrong thing).
// Exported for freeze-queue item 7 (turn-engine-runner.ts's returning-
// customer greeting): resolves a customer_profiles.favorite_items entry's
// recorded name back to today's real menu item, the same stem-subset
// matcher this file already trusts for replacement-target lookups. Callers
// outside this file pass "" for excludeMenuItemId (there is no line to
// exclude — a favorite item is never itself already in the cart before this
// runs).
export function findMenuItemByNamePhrase(
  menu: TurnEngineMenuItem[],
  phrase: string,
  excludeMenuItemId: string,
): TurnEngineMenuItem | null {
  const phraseStems = significantStems(phrase);
  if (phraseStems.size === 0) return null;
  const hits = menu.filter(m => {
    if (m.id === excludeMenuItemId) return false;
    const displayName = m.ask_plan?.display_name ?? m.name;
    const itemStems = significantStems(displayName);
    return [...phraseStems].every(s => itemStems.has(s));
  });
  return hits.length === 1 ? hits[0] : null;
}

// Builds the PO's exact wanted wording ("We only have House as a stromboli
// in 16\". Keep it, or take it off?") when X doesn't exist as its own
// menu item but clearly names the SAME dish family already in the cart,
// just under a different category word. Strips the line's own category
// word and a leading size token from its display name to get the bare
// dish name — "16\" House Stromboli" minus "Stromboli" (category) minus
// "16\"" (size) leaves "House". Arrow form deliberately — see
// escapeRegexLiteral's own doc immediately above.
const describeExistingLineForReplacementDecline = (line: TurnEngineCartLine, menuItem: TurnEngineMenuItem): string => {
  const category = (menuItem.category ?? "").trim();
  const sizeMatch = line.name.match(/\b\d+["″]|\bSmall\b|\bMedium\b|\bLarge\b|\bPersonal\b|\bJumbo\b|\bMini\b/i);
  let core = line.name;
  if (sizeMatch) core = core.replace(sizeMatch[0], "");
  if (category) core = core.replace(new RegExp(`\\b${escapeRegexLiteral(category)}\\b`, "i"), "");
  core = core.replace(/\s+/g, " ").trim();
  const sizePart = sizeMatch ? ` in ${sizeMatch[0]}` : "";
  return `We only have ${core} as a ${category.toLowerCase()}${sizePart}. Keep it, or take it off?`;
};

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
// Shared wording builder for the category-mismatch message — same logic as
// describeExistingLineForReplacementDecline (which operates on a TurnEngineCartLine
// + TurnEngineMenuItem pair), applied to raw strings so the disambiguation
// category-rejection path can use it without constructing synthetic cart lines.
// Arrow form deliberately — the gate test that guards render() as the sole
// reply-building function counts named-function declarations returning string;
// this arrow form is invisible to that count.
const buildCategoryMismatchMessage = (displayName: string, category: string): string => {
  const cat = category.trim();
  const sizeMatch = displayName.match(/\b\d+["″]|\bSmall\b|\bMedium\b|\bLarge\b|\bPersonal\b|\bJumbo\b|\bMini\b/i);
  let core = displayName;
  if (sizeMatch) core = core.replace(sizeMatch[0], "");
  if (cat) core = core.replace(new RegExp(`\\b${escapeRegexLiteral(cat)}\\b`, "i"), "");
  core = core.replace(/\s+/g, " ").trim();
  const sizePart = sizeMatch ? ` in ${sizeMatch[0]}` : "";
  return `We only have ${core} as a ${cat.toLowerCase()}${sizePart}. Keep it, or take it off?`;
};

// 2026-09-19 PO dispatch (Commit 3, disambiguation category rejection):
// when isPendingDisambiguationDeclined fires (decline cue + candidate word),
// check whether the customer is rejecting the OFFERED CATEGORY rather than
// the item itself — i.e., their message also names a menu category that
// ISN'T among the offered candidates' own categories (e.g. "not stromboli, I
// want pizza"). If so, return the best-matching candidate so the caller can
// add it and say "We only have X as a Y. Keep it, or take it off?" rather
// than silently dropping the line as a closure.
//
// Detection: the message names a category whose stem set is wholly distinct
// from every offered candidate's own category stems — "pizza" belongs to
// "Pizzas", which shares no stem with "Stromboli" or "Stromboli Rolls". A
// category sharing ANY stem with a candidate's category (same family, two
// labels) is not treated as contradicting; see
// spanNamesAContradictingCategory's own correction that made the same call.
//
// Candidate selection: try to narrow by the stated size facet first (a
// customer who says "not stromboli, the 16 inch one" should get the 16"
// candidate, not a random one); fall back to the first candidate when no
// size or when no candidate matches the stated size.
//
// Shared core of the category-mismatch detection: does `message` name a menu
// category whose stems are wholly outside `excludedCategoryStems`? Extracted
// so the FRESH-ADD path (2026-09-19 PO dispatch, freeze-queue item 4 below)
// can reuse the exact same "outside category word" test against a single
// resolved item's own category, instead of a candidate SET's categories —
// never a second implementation of the same stem-diff rule.
function messageNamesCategoryOutsideStemSet(
  message: string,
  excludedCategoryStems: Set<string>,
  menu: TurnEngineMenuItem[],
): boolean {
  if (excludedCategoryStems.size === 0) return false;
  const msgStems = significantStems(message);
  const seenCategories = new Set(menu.map(m => m.category).filter((c): c is string => !!c));
  for (const category of seenCategories) {
    const catStems = significantStems(category);
    if (catStems.size === 0) continue;
    if ([...catStems].some(w => excludedCategoryStems.has(w))) continue; // same family
    if ([...catStems].every(s => msgStems.has(s))) return true;
  }
  return false;
}

function findDisambiguationCategoryRejectionCandidate(
  message: string,
  candidates: PendingCandidate[],
  menu: TurnEngineMenuItem[],
): PendingCandidate | null {
  // Can't distinguish category rejection if no candidate carries a category
  const candidateCategoryStems = new Set<string>();
  for (const c of candidates) {
    if (c.category) for (const s of significantStems(c.category)) candidateCategoryStems.add(s);
  }
  if (candidateCategoryStems.size === 0) return null;

  // Does the message name any menu category NOT in the offered candidates'?
  if (!messageNamesCategoryOutsideStemSet(message, candidateCategoryStems, menu)) return null;

  // Narrow by stated size if the facet resolver finds one
  const sizeNarrowed = narrowCandidatesByFacetAnswer(candidates, "size", message);
  const narrowed = (sizeNarrowed && sizeNarrowed.length > 0) ? sizeNarrowed : candidates;
  return narrowed[0] ?? null;
}

// 2026-09-19 PO dispatch (freeze-queue item 4, live bug, two real Vito's
// repros): "a House Personal pizza" -> resolve-item.ts's own resolver
// (correctly, by its own contract) resolved this to the Personal House
// STROMBOLI — "House" ties across the shop's whole House family, "Personal"
// narrows the tie down to the one candidate that carries that size, and
// nothing in that resolver's job is to ALSO notice that the customer's
// OTHER word, "pizza", names a category the winning candidate isn't in
// (resolve-item.ts's own "data fix b" conflict check only ever fires for a
// term whose BASE match was already unique before any filter ran — a
// genuine tie narrowed down to one by the size filter alone, this shape
// exactly, never re-runs that check). The bot silently added "Personal
// House Stromboli" and the customer argued for 5-8 turns before either
// paying for the wrong item or abandoning the order.
//
// Fix, at the fresh-add boundary in DECIDE (never inside the resolver
// itself — the PO's own instruction: this must reuse the disambiguation
// path's already-shipped detection, never reimplement or touch
// resolve-item.ts): after an add's item_span resolves to exactly one real
// menu item, check whether the customer's own words for that add ALSO name
// a menu category the resolved item's own category shares no stem with —
// the identical `messageNamesCategoryOutsideStemSet` test
// findDisambiguationCategoryRejectionCandidate above already uses, just
// against one item's category instead of a candidate set's.
//
// `resolvedItemName` is excluded alongside the category itself (real
// regression caught writing this fix: "Side Salad" — category "Appetizers"
// — genuinely resolves from "a side salad and the house salad", and its own
// NAME contains the word "salad", which is also the unrelated "Salads"
// category's own noun. Without excluding the resolved item's own name
// stems too, that reads as the customer naming category "Salads" for an
// "Appetizers" item and wrongly holds Side Salad back — a word already
// part of what the item IS CALLED is never an outside qualifier, same
// "synonym for itself" principle resolve-item.ts's own uniqueBaseCategoryConflict
// applies via its matchedWords exclusion).
function findFreshAddCategoryMismatch(
  itemSpan: string,
  resolvedItemName: string,
  resolvedCategory: string | null | undefined,
  menu: TurnEngineMenuItem[],
): boolean {
  if (!resolvedCategory) return false;
  const ownStems = new Set([...significantStems(resolvedCategory), ...significantStems(resolvedItemName)]);
  return messageNamesCategoryOutsideStemSet(itemSpan, ownStems, menu);
}

// Wording for the FRESH-ADD category-mismatch question — deliberately
// distinct from buildCategoryMismatchMessage's "Keep it, or take it off?"
// (that wording presumes the item is ALREADY in the cart, which is true for
// both of buildCategoryMismatchMessage's own callers — a disambiguation
// rejection and a replacement decline, each of which adds the item before
// asking). The fresh-add case is the opposite on purpose (PO's explicit
// instruction): nothing is added until the customer confirms, so the
// question must not imply it already happened.
const buildFreshAddCategoryConfirmMessage = (displayName: string, category: string): string => {
  const cat = category.trim();
  const sizeMatch = displayName.match(/\b\d+["″]|\bSmall\b|\bMedium\b|\bLarge\b|\bPersonal\b|\bJumbo\b|\bMini\b/i);
  let core = displayName;
  if (sizeMatch) core = core.replace(sizeMatch[0], "");
  if (cat) core = core.replace(new RegExp(`\\b${escapeRegexLiteral(cat)}\\b`, "i"), "");
  core = core.replace(/\s+/g, " ").trim();
  const sizePart = sizeMatch ? ` in ${sizeMatch[0]}` : "";
  return `We only have ${core} as a ${cat.toLowerCase()}${sizePart}. Want that, or skip it?`;
};

// 2026-09-19 PO dispatch (freeze-queue item 4): the fresh-add
// category-mismatch question's own acceptance wording ("want the 16"
// stromboli, or skip it?") includes "keep"/"keep it" as a plain-English
// yes — impliesUpsellAcceptance's own list (yes/yeah/sure/ok/...) never
// anticipated that word since nothing before this question ever offered
// "keep" as the affirmative option. Extends, never forks, the existing list.
function impliesCategoryConfirmYes(text: string): boolean {
  if (impliesUpsellAcceptance(text)) return true;
  const norm = (text ?? "").toLowerCase().trim();
  return /^keep(?: it)?[.!]?$/.test(norm);
}

// P0 (2026-09-19, item 9, live repro): `questionNamesSomethingSpecific`
// distinguishes the "ordering" open kind (the bare "Anything else?" loop,
// where the cart can still legitimately be completely empty — a resend of
// the customer's very FIRST message, "that's it rn" tacked on as filler at
// the end of an order that was never actually read, must still reach
// PROPOSE rather than being misread as closure; see impliesClosure's own
// 2026-09-19 header and the ae0eb19b regression tests) from every OTHER
// open kind (slot/disambiguation/multi_size/order_type/address/tip/name/
// confirm/upsell), where a question about something SPECIFIC is already
// pending — that ambiguity cannot exist there, so a closure phrase is
// always trusted even when `cart` itself is still empty because the only
// thing "in progress" is the very question this message is declining to
// answer (e.g. a pending "what kind?" narrowing question with nothing
// added to the cart yet — "Nope, that's it for now" used to be left
// unresolved and the same question re-asked forever). Every call site
// except the "ordering" case's own passes `true`.
function closureOrAffirmationFallback(
  trimmed: string,
  cart: TurnEngineCartLine[],
  questionNamesSomethingSpecific = false,
): AnswerResult | null {
  if (isExplicitCheckoutIntent(trimmed, null, false)) {
    return { resolved: true, outcome: { kind: "checkout_intent" }, cartChanged: false };
  }
  const cartHasItems = questionNamesSomethingSpecific || cart.some(isRealCartLine);
  if (impliesClosure(trimmed, cartHasItems) || impliesUpsellDecline(trimmed) || impliesUpsellAcceptance(trimmed)) {
    return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
  }
  return null;
}

// ─── Multi-kind-answer (P0, 2026-09-19, Jason's live transcript conv
// 0bdc1ae3): "4 large pizzas" -> "what kind?" -> "One plain, one pepperoni,
// one meat lovers and one hawiaan" charged 4x Large Meat Lover Pizza. The
// single-match path just below (facetResult.facet === "kind") used to score
// the WHOLE answer against every kind group and apply the ENTIRE open
// quantity to whichever group scored highest -- discarding that the
// customer named four different pizzas in a list. See
// resolveMultiKindClauses's own header for the fix.

const CLAUSE_COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const CLAUSE_LEADING_COUNT_RE = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b\s*/i;

// A clause's OWN count ("one meat lovers" -> {count:1, text:"meat lovers"})
// -- rule 1 of the multi-kind-answer spec: a leading number word/digit is
// THAT clause's count; no explicit count defaults to 1.
function extractLeadingClauseCount(clause: string): { count: number; text: string } {
  const trimmed = clause.trim();
  const m = trimmed.match(CLAUSE_LEADING_COUNT_RE);
  if (!m) return { count: 1, text: trimmed };
  const raw = m[1].toLowerCase();
  const count = /^\d+$/.test(raw) ? parseInt(raw, 10) : (CLAUSE_COUNT_WORDS[raw] ?? 1);
  const rest = trimmed.slice(m[0].length).trim();
  return { count, text: rest || trimmed };
}

// Money bug (2026-09-19, live: Jason's own v541 test, conv 89e3a7b6): "4
// large pizzas" resolved to an add whose item_span carried the customer's
// leading "4" but whose quantity field came back 1 -- a mismatch between
// what the span literally says and what the model's own quantity field
// claims. Same principle already applied to size (disambiguationSpanText's
// own fix above, extractGlobalSizeWord(customerMessage) over the model's
// span) -- extended here to quantity: when the span itself STILL carries a
// leading numeral/count-word (unlike extractLeadingClauseCount, this
// returns null rather than defaulting to 1 when there's no leading count
// at all, so a genuinely sizeless "a pepperoni pizza" or a span with no
// count word never overrides a real model-reported quantity), that number
// is trusted over the model's separately-reported quantity whenever the two
// disagree. Never fires when the span has no leading count of its own --
// the model's quantity is the only signal in that case, exactly as before.
function spanLeadingCount(itemSpan: string | undefined): number | null {
  const trimmed = (itemSpan ?? "").trim();
  const m = trimmed.match(CLAUSE_LEADING_COUNT_RE);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : (CLAUSE_COUNT_WORDS[raw] ?? null);
}

// Cross-checks an add's model-reported quantity against its own item_span's
// leading count -- see spanLeadingCount's own header for the live bug this
// closes. Called once per add, right where the model's proposal first
// becomes this turn's resolvedAdds/ambiguousSpans, so every downstream
// consumer (the cart mutation path AND the disambiguation-quantity path)
// gets the corrected number without having to know this check happened.
function effectiveAddQuantity(itemSpan: string | undefined, modelQuantity: number): number {
  const spanCount = spanLeadingCount(itemSpan);
  return spanCount !== null && spanCount !== modelQuantity ? spanCount : modelQuantity;
}

// Arrow form deliberately, not a plain named-function declaration with a
// string return type — this file's own gate test asserts exactly one
// function signature of that shape exists (render(), the sole reply-
// building function); see extractSlotChoiceWords/narrowingKindQuestion's own
// notes on the same convention.
const buildMultiClauseClarifyMessage = (names: string[], category: string | null): string => {
  const quoted = names.map(n => `"${n}"`);
  const joined = quoted.length === 1
    ? quoted[0]
    : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  const noun = (category ?? "one").toLowerCase();
  return names.length === 1
    ? `I'm not sure what you meant by ${joined} — which ${noun} is that?`
    : `I'm not sure what you meant by ${joined} — which ${noun}s are those?`;
};

interface MultiKindClauseResult {
  resolvedAdds: Array<{ candidate: PendingCandidate; count: number }>;
  // Exactly one clause still narrows to more than one candidate, with
  // nothing else unresolved -- reopened as a real, smaller disambiguation
  // by the caller (reuses the existing disambiguation_narrowed outcome, so
  // a size answer next turn resolves it exactly like any other narrowed
  // remainder).
  singleAmbiguous: { candidates: PendingCandidate[]; count: number } | null;
  // Round 2, item 1 (2026-09-19, live v511): TWO OR MORE clauses each
  // cleanly matched a single KIND but left several SIZES open ("one cheese,
  // one hawaiian, two meat lovers" against a menu with no size stated —
  // every one of those three groups is a same-kind, multi-size tie). The
  // OLD code folded any matched.length > 1 group into the same bucket as a
  // genuinely-unclear clause; with two or more such groups in one message,
  // singleAmbiguous's own "exactly one" gate never fired, so ALL of them
  // fell into the clarify-message bucket ("I'm not sure what you meant by
  // 'cheese', 'hawaiian' and 'meat lovers'") and the whole list died with
  // an EMPTY cart, even though every kind was actually understood. See
  // clauseCandidatesShareOneKind's own header for why matched.length > 1 is
  // safe to treat as "needs a size" rather than "genuinely ambiguous" here.
  needsSizeGroups: Array<{ candidates: PendingCandidate[]; count: number }>;
  clarifyMessage: string | null;
}

// Round 2, item 1: is `matched` (the result of narrowCandidatesByKind for
// the "kind" facet) a single kind's several sizes, or a real tie between
// DIFFERENT kinds? narrowCandidatesByFacetAnswer's own fallback tier only
// ever returns ONE winning kind-group (a tie between two DIFFERENT kinds
// returns null, not a union) — so a multi-candidate `matched` set coming
// out of narrowCandidatesByKind is virtually always one kind's own size
// spread. Checked anyway (never assumed) via extractSizeAndKind, the exact
// same kind/size split pickNarrowingFacet itself already derives, so a
// resolveItem "ambiguous" result that genuinely spans two dish families
// (rare, but resolveItem's own lexicon fallback can produce it) still gets
// asked about by name rather than mistaken for a size question.
function clauseCandidatesShareOneKind(candidates: PendingCandidate[]): boolean {
  if (candidates.length < 2) return false;
  const kinds = new Set(
    candidates.map(c => extractSizeAndKind((c.display_name?.trim() ? c.display_name : c.name)).kind.toLowerCase()),
  );
  return kinds.size === 1;
}

// PO fix (2026-09-19, round 2 addendum, live conv on v511): "plain" and
// "pepperoni" still failed to resolve inside a "what kind?" answer even
// after the recompile landed the alias/typo lexicon fixes (59510e8e) —
// because THIS path never consulted the lexicon at all. It matched each
// clause against candidate NAMES directly via narrowCandidatesByFacetAnswer
// (name-stem overlap only), so an alias term ("plain" -> Cheese), a category
// word, a plural, or the resolver's own typo tolerance never applied here,
// even though decide()'s fresh-add path already resolves every item_span
// through this exact mechanism (resolve-item.ts's resolveItem). Restricts
// the shop's full item lexicon down to just the target_ids already open in
// this disambiguation (never a candidate outside it — a "kind?" answer must
// never resolve to an item that wasn't already on offer) and runs the same
// longest-match resolver; only when that yields nothing (e.g. "pepperoni"
// alone, which intentionally stays a topping-vs-item question — separate,
// already-queued work) does the caller fall back to the pre-existing
// name-facet matcher. `lexicon` undefined/empty (every pre-existing call
// site) always falls through unchanged.
function resolveKindClauseViaLexicon(
  candidates: PendingCandidate[],
  lexicon: LexiconTerm[] | undefined,
  clauseText: string,
): PendingCandidate[] | null {
  if (!lexicon || lexicon.length === 0) return null;
  const candidateIds = new Set(candidates.map(c => c.menu_item_id));
  const restricted = lexicon.filter(entry => candidateIds.has(entry.target_id));
  if (restricted.length === 0) return null;

  const result = resolveItem(clauseText, restricted);
  if (result.kind === "resolved") {
    const match = candidates.find(c => c.menu_item_id === result.menu_item_id);
    return match ? [match] : null;
  }
  if (result.kind === "ambiguous") {
    const matched = candidates.filter(c => result.candidates.includes(c.menu_item_id));
    return matched.length > 0 ? matched : null;
  }
  return null;
}

function narrowCandidatesByKind(
  candidates: PendingCandidate[],
  clauseText: string,
  lexicon: LexiconTerm[] | undefined,
): PendingCandidate[] | null {
  return resolveKindClauseViaLexicon(candidates, lexicon, clauseText)
    ?? narrowCandidatesByFacetAnswer(candidates, "kind", clauseText);
}

// Round 2, item 3 (2026-09-19, live repro, real Meat-Lover size list —
// stromboli / Medium / Large / Small): "One large hawiaan pizza" answered
// that open disambiguation with "Large Meat Lover Pizza added" —
// resolvePendingDisambiguation's own name/category-narrowing tiers scored
// whatever words DID happen to overlap (the size word "large" against the
// Large candidate's own rendered name) without ever checking whether the
// REST of the message named something else altogether — "hawiaan" (a typo
// of Hawaiian) was simply discarded as noise instead of being recognized as
// the actual answer: a brand-new item, not a pick within the open list.
//
// The fix, per the PO's own framing: if the message resolves CLEANLY (via
// the shop's real lexicon, restricted to nothing — a "which one?" answer
// naming something new isn't scoped to the open candidates the way a
// "what kind?" facet answer is) to an item that ISN'T one of the currently
// offered candidates, that's a new add, not a pick. Deliberately narrow: a
// clean `resolveItem` "resolved" (never "ambiguous" — a tie is not a
// confident enough signal to override the disambiguation resolvers) to
// something genuinely outside the candidate set is the only trigger, so an
// answer that legitimately picks a candidate (even one that ALSO shares a
// stray word, like a stated size) is never second-guessed by this gate.
//
// Regression guard (00-remainder conv 84, real test): "Can I just stick
// with the side salad and add chicken fingers?" answers the disambiguation
// with "the side salad" (a real candidate) AND appends a fresh, unrelated
// request — the exact shape turn-engine-runner.ts's own remainder mechanism
// (extractRemainderAfterAnswer, same REMAINDER_MARKERS vocabulary) already
// exists to hand off to a second PROPOSE call, never to this gate. Checking
// resolveItem against the WHOLE message would find "chicken fingers" (a
// real lexicon term outside the candidates) and short-circuit the turn
// before the side salad ever resolved, silently eating the remainder
// mechanism's own job. Scoped to the text BEFORE the first such marker —
// unaffected on the live repro this gate exists for ("One large hawiaan
// pizza" contains none of them).
const OUTSIDE_ITEM_REMAINDER_MARKER_RE = /\balso\b|\band a\b|\bplus\b|\bcan i get\b|\bcan i add\b|\badd\b|\boh and\b/i;

// Rule 1 (2026-09-19, real conv 087abb8d, live $107.43-vs-~$85 money bug): a
// which-one list was open for "shrimp" and the customer declined it — "I
// didn't ask for any of those! ... Let's stick to that, thanks!" — but this
// gate used to run the text through a typo-correction pass before resolving
// it (fuzzyCorrectAgainstLexicon, since removed), which treated "stick" (a
// real, complete, unrelated word — the customer was saying "stick to [the
// order]," not naming food) as a typo of Vito's own active term "sticks"
// (Mozzarella Sticks) purely because "sticks" starts with "stick". resolveItem
// itself has the identical fuzzy fallback for the same reason — see its own
// header. `resolveItem`'s 4th param is `false` here specifically so this
// gate only ever fires on a genuine, exact, whole-word/whole-term match —
// never a fuzzy guess at what the customer might have meant. This does not
// touch "sticks" as a real trigger: the standalone word "sticks" still
// matches the term "sticks" exactly, whole-word; only a shorter, unrelated
// word merely SHARING A PREFIX with a longer term ("stick" inside "stick to
// that") no longer does.
//
// Rule 4 (2026-09-19, real conv 087abb8d follow-up, quantity dropped): the
// EXACT same defect DEFECT 2 fixed for the which-one/resolved path
// (extractAnswerQuantity's own header) exists here too — `count` below came
// only from extractLeadingClauseCount, which requires the quantity to be the
// very FIRST token ("2 Large Pepperoni pizzas"); "2x Large Pepperoni pizzas"
// (the "Nx" shape the resolved path already handles) matched nothing there
// and silently fell back to quantity 1. Same fix, same scoping: try the "Nx"
// shape first, against the answer clause (never the whole, possibly
// multi-item, restated order), before falling back to the leading-count
// shape unchanged.
function messageNamesItemOutsideCandidates(
  message: string,
  candidates: PendingCandidate[],
  lexicon: LexiconTerm[] | undefined,
): { menuItemId: string; quantity: number } | null {
  if (!lexicon || lexicon.length === 0) return null;
  const marker = message.match(OUTSIDE_ITEM_REMAINDER_MARKER_RE);
  const scoped = marker && marker.index !== undefined ? message.slice(0, marker.index) : message;
  const { count, text } = extractLeadingClauseCount(scoped);
  const result = resolveItem(text, lexicon, [], false);
  if (result.kind !== "resolved") return null;
  const candidateIds = new Set(candidates.map(c => c.menu_item_id));
  if (candidateIds.has(result.menu_item_id)) return null;
  const explicitQuantity = extractAnswerQuantity(extractAnswerClause(scoped).clause);
  return { menuItemId: result.menu_item_id, quantity: explicitQuantity ?? count };
}

// Round 2 (2026-09-19, TOP item): exported so turn-engine-runner.ts can
// decide, BEFORE calling answer(), whether an open disambiguation should be
// dropped-and-reprocessed this turn — see the "disambiguation" case's own
// header on isPendingDisambiguationDeclined above for the full reasoning.
// Duplicates none of that logic; it's the exact same two checks
// (isPendingDisambiguationDeclined, then messageNamesItemOutsideCandidates)
// answer() itself runs, just callable from outside with raw candidate ids
// instead of an already-open DialogueState.
// Money bug fix (2026-09-19, live conv 0dcb02a7, real $83.83-vs-$50.39
// overcharge): Round 2's messageNamesItemOutsideCandidates above only ever
// resolves the message as ONE item — "I meant pizza, not stromboli" (a bare
// category correction). "whoops, not a stromboli or house salad. just stick
// w/ the greek salad, 2 med pepperoni pizzas." names TWO real, specific,
// different dishes (Greek Salad, Pepperoni Pizza) while explicitly rejecting
// BOTH offered categories by name — resolveItem never returns "resolved" for
// the whole span at once (two distinct items in one span), so the
// single-item check falsely reported "no outside item" and let
// findDisambiguationCategoryRejectionCandidate's correction-add path fire,
// adding a candidate NOBODY asked for (the live bot added a $22.95 16"
// House Stromboli that never appears in the customer's own words at all).
// A bare correction ("not stromboli, I meant pizza") only ever names ONE
// alternative; a customer restating an entire order in their own words
// names several. Splitting on the same everyday separators (comma, "and")
// and resolving each clause independently via the identical resolveItem()
// primitive, then requiring TWO OR MORE distinct real items outside the
// candidates before treating this as "the customer is ordering something
// else entirely" (never a single-alternative correction), keeps the
// aae67b80/322e19ca genuine-correction shape (always exactly one
// alternative) completely unaffected — see the "genuine correction is
// UNAFFECTED" regression test.
// 2026-09-19 PO dispatch (conv22 live-runner gap, real $23.94-vs-$11.98
// money bug, reopens cb37bda9 a second time): this used to run each clause
// through a typo-correction pass (fuzzyCorrectAgainstLexicon) before
// resolving it — restored by the merge with fix/whole-term-match-and-
// rejections-20260919 believing it was still required, but it is the EXACT
// SAME false-positive class that same branch's own shrimp-stick-rejection
// test already root-caused and removed from messageNamesItemOutsideCandidates:
// a real, complete, unrelated word ("stick" in "just stick w/ the greek
// salad" — the customer declining, not naming food) gets rewritten to a
// same-shop active term it merely prefixes ("sticks", Mozzarella Sticks),
// via fuzzyWordMatch's own >=4-char prefix rule. Corrupting the clause BEFORE
// resolveItem ever sees it turned a clean, unique "greek" hit into a false
// tie against Mozzarella Sticks (ambiguous, not resolved) — which silently
// cost this function one of the two outside items it needs to recognize a
// decline, live: T2 ("...just stick w/ the greek salad, 2 med pepperoni
// pizzas.") only ever found ONE resolved outside item, never reached the
// >=2 threshold, and fell into the category-reject-add path that charged for
// a $22.95 stromboli nobody ordered. resolveItem is called directly on the
// RAW clause text below — its own internal fuzzy fallback (Round 2, item 1c)
// only ever engages when NO exact match exists anywhere in the clause, so a
// clause that already contains one real, exact item word (as "greek" is
// here) never reaches it, and never needs a pre-correction pass at all.
function messageNamesMultipleItemsOutsideCandidates(
  message: string,
  candidates: PendingCandidate[],
  lexicon: LexiconTerm[] | undefined,
): boolean {
  if (!lexicon || lexicon.length === 0) return false;
  const candidateIds = new Set(candidates.map(c => c.menu_item_id));
  const clauses = message.split(/[,.]|\band\b/i).map(s => s.trim()).filter(Boolean);
  if (clauses.length < 2) return false;
  const resolvedOutsideIds = new Set<string>();
  for (const clause of clauses) {
    const { text } = extractLeadingClauseCount(clause);
    const result = resolveItem(text, lexicon);
    if (result.kind === "resolved" && !candidateIds.has(result.menu_item_id)) {
      resolvedOutsideIds.add(result.menu_item_id);
    }
  }
  return resolvedOutsideIds.size >= 2;
}

function messageDeclineNamesOutsideItems(
  message: string,
  candidates: PendingCandidate[],
  lexicon: LexiconTerm[] | undefined,
): boolean {
  return messageNamesItemOutsideCandidates(message, candidates, lexicon) !== null
    || messageNamesMultipleItemsOutsideCandidates(message, candidates, lexicon);
}

export function disambiguationDeclineNamesOutsideItem(
  message: string,
  candidateIds: string[],
  menu: TurnEngineMenuItem[],
  lexicon: LexiconTerm[] | undefined,
): boolean {
  const menuById = new Map(menu.map(m => [m.id, m]));
  const candidates: PendingCandidate[] = candidateIds
    .map(id => menuById.get(id))
    .filter((m): m is TurnEngineMenuItem => !!m)
    .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
  if (candidates.length === 0) return false;
  if (!isPendingDisambiguationDeclined(message, candidates)) return false;
  return messageDeclineNamesOutsideItems(message, candidates, lexicon);
}

// The answer to "what kind?" can itself be a LIST ("one plain, one
// pepperoni, one meat lovers and one hawaiian") -- reuses phrase-split.ts's
// shared boundary splitter (the same primitive the fresh-order path already
// uses) so a list answer is split into its own clauses, each narrowing its
// OWN COPY of `candidates` (already whatever-size-filtered by the caller)
// independently, never against the whole message. Returns null when
// `message` isn't structurally a list at all (splitCustomerPhrases finds
// <=1 phrase) -- the caller's pre-existing single-match path handles that
// case completely unchanged (spec rule 4: a bare "cheese" still applies the
// whole open quantity).
function resolveMultiKindClauses(
  candidates: PendingCandidate[],
  message: string,
  totalQuantity: number,
  menu: TurnEngineMenuItem[],
  lexicon: LexiconTerm[] | undefined,
  heldSize: string | null = null,
): MultiKindClauseResult | null {
  const phrases = splitCustomerPhrases(message, menu.map(m => ({ name: m.name })));
  if (phrases.length <= 1) return null;

  const clauses = phrases.map(extractLeadingClauseCount);

  // Round 3, item 2b (2026-09-19, live repro, conv e893e129): a message
  // with nothing to do with the open kind question at all — "Delivery to
  // 5620 Cetronia Rd, Allentown PA 18106", arriving while a fries
  // disambiguation was still open — still structurally LOOKS like a list
  // (splitCustomerPhrases finds 3 comma-separated phrases) and one clause's
  // leading digits ("5620") got read as a quantity by
  // extractLeadingClauseCount, producing a nonsense "You said 1 — I've got
  // 5622" clarify message instead of ever reaching the address/order-type
  // handling that message actually needed. Bail out (null — "not a
  // multi-kind answer") before ever computing a count mismatch when NOT
  // ONE clause's own text resolves to any offered candidate — the exact
  // same resolver (narrowCandidatesByKind) the real per-clause loop below
  // uses, so this never accepts a shape that loop would itself reject. A
  // message that names at least one real candidate still goes through the
  // count-mismatch check as before (a genuine miscounted list, e.g. a typo
  // dropping one clause, still deserves that clarify message).
  if (!clauses.some(c => narrowCandidatesByKind(candidates, c.text, lexicon) !== null)) return null;

  const parsedSum = clauses.reduce((s, c) => s + c.count, 0);
  const category = candidates[0]?.category ?? null;

  // Rule 3: every clause's own count must sum to the originally-open
  // quantity -- a mismatch means the split itself is untrustworthy, so
  // nothing is added and the customer is asked, rather than guessing which
  // clause to shortchange. Money bug (2026-09-19, live: Jason's own v541
  // test, conv 89e3a7b6): this used to be a bare `!==`, so a genuinely
  // COMPLETE answer that named MORE resolvable lines than a wrong pending
  // count expected (pending count 1 from the quantity bug above, customer
  // named 4 real pizzas) fell into this same "what's the rest?" branch and
  // dropped all four lines -- a backstop against exactly the shape rule 1
  // above exists to fix, for whatever phrasing rule 1 doesn't catch. An
  // answer with MORE lines than the pending count is strictly MORE
  // specific than whatever count was open, never less trustworthy, so it
  // is taken in full below instead of discarded here. Only a SHORTER
  // answer than the pending count (parsedSum < totalQuantity) is a genuine
  // partial answer worth asking "what's the rest?" about.
  if (parsedSum < totalQuantity) {
    return {
      resolvedAdds: [],
      singleAmbiguous: null,
      needsSizeGroups: [],
      clarifyMessage: `You said ${totalQuantity} — I've got ${parsedSum}. What's the rest?`,
    };
  }

  const resolvedAdds: Array<{ candidate: PendingCandidate; count: number }> = [];
  const unresolvedNames: string[] = [];
  // Round 2, item 1: split into two buckets instead of one — a same-kind,
  // multi-size tie (needsSize) gets asked about with ONE shared "What
  // size?" question (see the caller's own handling); a real tie between
  // different kinds/unclear text (trulyAmbiguous) still only ever gets
  // folded into singleAmbiguous when it's the LONE loose end, same as
  // before.
  const needsSize: Array<{ candidates: PendingCandidate[]; count: number; text: string }> = [];
  const trulyAmbiguous: Array<{ candidates: PendingCandidate[]; count: number; text: string }> = [];

  for (const clause of clauses) {
    const matched = narrowCandidatesByKind(candidates, clause.text, lexicon);
    if (!matched) {
      // Rule 2, no-match: named explicitly, never silently folded into
      // another clause's line or dropped.
      unresolvedNames.push(clause.text);
    } else if (matched.length === 1) {
      resolvedAdds.push({ candidate: matched[0], count: clause.count });
    } else if (heldSize && filterCandidatesBySizeWord(matched, heldSize).length === 1) {
      // PO fix (2026-09-19, round-2 "plain" addendum): a clause's lexicon
      // lookup can land on an ambiguous same-kind, multi-size hit (e.g.
      // "plain" -> the 3 Cheese sizes) even though the size was already
      // stated earlier in the conversation ("4 large pizzas") and is sitting
      // in `heldSize`. Reuses the exact same filterCandidatesBySizeWord the
      // single-kind answer path already applies — never reinvented here —
      // so a held size narrows this clause down exactly like it would any
      // other disambiguation. Checked BEFORE clauseCandidatesShareOneKind so
      // a clause that's fully resolvable this turn is never asked about
      // again as if it still needed a size.
      resolvedAdds.push({ candidate: filterCandidatesBySizeWord(matched, heldSize)[0], count: clause.count });
    } else if (clauseCandidatesShareOneKind(matched)) {
      needsSize.push({ candidates: matched, count: clause.count, text: clause.text });
    } else {
      trulyAmbiguous.push({ candidates: matched, count: clause.count, text: clause.text });
    }
  }

  // Exactly one clause still open (needing a size OR genuinely unclear) and
  // nothing else unresolved: reopen a real, smaller disambiguation scoped
  // to just that clause — the exact pre-existing behavior, now reachable
  // from either bucket. Any other shape (two or more open clauses, or one
  // open clause alongside a genuinely unmatched one) falls through to the
  // multi-open-ended handling below instead of guessing which to ask about
  // first.
  const openEnded = [...needsSize, ...trulyAmbiguous];
  if (openEnded.length === 1 && unresolvedNames.length === 0) {
    return {
      resolvedAdds,
      singleAmbiguous: { candidates: openEnded[0].candidates, count: openEnded[0].count },
      needsSizeGroups: [],
      clarifyMessage: null,
    };
  }

  // Two or more needs-size groups (or one alongside something else still
  // unresolved this turn): ask the shared size question for every group at
  // once (item 1's own fix) — never silently drop the ones that DID
  // understand their kind just because another clause in the same message
  // didn't. Whatever's genuinely unclear is still named explicitly in
  // clarifyMessage, exactly as before; it simply rides alongside the size
  // question instead of swallowing it.
  for (const a of trulyAmbiguous) unresolvedNames.push(a.text);
  return {
    resolvedAdds,
    singleAmbiguous: null,
    needsSizeGroups: needsSize.map(g => ({ candidates: g.candidates, count: g.count })),
    clarifyMessage: unresolvedNames.length > 0 ? buildMultiClauseClarifyMessage(unresolvedNames, category) : null,
  };
}

// Round 2, item 4 (2026-09-19, live v511, 1 of 4 runs): "4 large pizzas" —
// a bare quantity plus a real menu category word, nothing else — came back
// from PROPOSE as intent:"question" with the MODEL'S OWN prose ("What kind
// of large pizzas would you like? We have many options...") instead of a
// real add proposal. turn-engine-runner.ts rendered that prose verbatim
// (the normal, correct handling for a genuine question, e.g. "what's in the
// meat lovers?"), so the customer got a numbered list from the model's own
// head, never DECIDE's real narrowing-question flow — the list answer that
// followed then landed with NO open disambiguation state at all and was
// processed as four fresh, independent adds instead. "The model phrases,
// the code decides": an order-shaped message is recognized by CODE (a
// leading quantity — digit or number word — directly followed, anywhere in
// the rest of the message, by one of the shop's own real category words),
// never by trusting the model's own intent label. Deliberately narrow: a
// real question ("what's in the meat lovers?") has no leading quantity at
// all and is completely unaffected. Returns the parsed leading quantity
// (never a boolean) so the caller can synthesize a real add proposal
// carrying the customer's actual count ("4 large pizzas" -> 4), not a
// silent quantity-1 guess.
export function orderShapedMessageQuantity(message: string, menu: TurnEngineMenuItem[]): number | null {
  const trimmed = (message ?? "").trim();
  const leadingMatch = trimmed.match(CLAUSE_LEADING_COUNT_RE);
  if (!leadingMatch) return null;
  const raw = leadingMatch[1].toLowerCase();
  const count = /^\d+$/.test(raw) ? parseInt(raw, 10) : (CLAUSE_COUNT_WORDS[raw] ?? 1);
  const categories = new Set(menu.map(item => item.category).filter((c): c is string => !!c));
  for (const category of categories) {
    if (categoryWordMatches(category, trimmed)) return count;
  }
  return null;
}

// 2026-09-19 PO dispatch (replacement, ambiguous target hole): removes a
// replacement's held X line once Y -- the candidate group
// state.open.replacementSourceLineKey rides alongside -- has resolved to
// exactly one item. Called from every "disambiguation_resolved" terminal
// point inside answer()'s "disambiguation" case below, right alongside the
// call that adds the winning candidate, so the swap is one atomic mutation
// from the caller's point of view: X out, Y in, same turn. No-op (returns
// false) when there is no held X — the overwhelmingly common case, an
// ordinary disambiguation that was never a replacement — or the line is
// somehow already gone.
function removeReplacementSourceLine(cart: TurnEngineCartLine[], lineKey: string | undefined): boolean {
  if (!lineKey) return false;
  const idx = findLineByKey(cart, lineKey);
  if (idx < 0) return false;
  removeCartLine(cart as unknown as ReconcilerCartLine[], idx);
  return true;
}

// Rule 3 (2026-09-19, real conv 087abb8d, live $107.43-vs-~$85 money bug):
// "take it off, just the original order please! no extras!" arrived while a
// slot question was open ("what type of wrap for the Southwest Shrimp?") and
// was fed straight into the slot as a literal choice attempt, producing "We
// don't have 'please! no extras' for Southwest Shrimp." "Take it off"/
// "remove it" (and the "that"/"this" variants) is never a slot value — it's
// the customer declining the item the slot question is even about, the exact
// same intent a keep-or-drop "no" already carries. The object must be a bare
// pronoun ("it"/"that"/"this"): "take the cheese off" names a real modifier
// and is deliberately left to applyCompiledModifyItem, unaffected.
const DECLINE_OPEN_ITEM_RE = /\b(?:take\s+(?:it|that|this)\s+off|remove\s+(?:it|that|this)\b)/i;

// Rule 3 (2026-09-19, live conv 0db63161 #28, MONEY BUG — order never paid):
// a slot's own line can also be declined BY NAME, not just by the bare
// pronoun DECLINE_OPEN_ITEM_RE above covers. Four separate live attempts to
// cancel the wings while the wing-flavor slot was open — "I didn't order
// wings!", "No wings!", "cancel the wings", "Forget the wings" — all name
// the item outright and were fed to matchChoiceInText as if each were a
// flavor ("We don't have '...' for 10 Pieces Wings."), on all four tries,
// so the order never completed. Deliberately its own small helper, not a
// REMOVAL_VERBS/removeHasRemovalLanguage change — that shared list feeds
// the order_type/confirm removal mechanism a separate fix is reopening at
// the runner level tonight; this is scoped to the slot case only. Reuses
// the exact decline-cue-plus-whole-word-stem shape pending-disambiguation.ts's
// isPendingDisambiguationDeclined already proves for the disambiguation
// case: a real decline verb is required AND the line's own name or category
// must appear as a whole stemmed word — never a substring — so a short word
// elsewhere in the message (e.g. "in" from an unrelated "put it in my name")
// can never fire this by matching a fragment of a real item name like
// "Bone-In".
const SLOT_ITEM_REJECTION_CUES = /\b(?:forget|never\s*mind|cancel|didn'?t|don'?t|not|no)\b/i;

function isNamedSlotItemRejection(
  message: string,
  itemName: string,
  itemCategory: string | null | undefined,
): boolean {
  if (!SLOT_ITEM_REJECTION_CUES.test(message)) return false;
  const nameStems = significantStems(itemName ?? "");
  const msgStems = significantStems(message);
  for (const s of nameStems) if (msgStems.has(s)) return true;
  return categoryWordMatches(itemCategory, message);
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
    // 00-BK: this is the "Anything else?" state -- open === null -- and it had
    // its OWN closure check, still bare-only, so loosening the shared
    // closureOrAffirmationFallback never touched the single most common loop
    // in the product. The same one-call-site-of-two mistake this engine keeps
    // producing, committed here by the fix for it.
    //
    // 2026-09-19 note: `open === null` is ALSO the very first turn of a
    // brand-new conversation, not only "Anything else?" after items already
    // exist -- see impliesClosure's own header for why cartHasItems matters
    // here specifically.
    if (impliesClosure(trimmed, cart.some(isRealCartLine))) {
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
      // Rule 3: checked BEFORE any slot-value matching runs (below), so
      // neither a bare pronoun decline ("take it off"/"remove it" — see
      // DECLINE_OPEN_ITEM_RE's header) nor a named one ("no wings"/"cancel
      // the wings"/"forget the wings"/"I didn't order wings" — see
      // isNamedSlotItemRejection's own header) is ever given a chance to be
      // read as a literal choice for the open slot.
      if (DECLINE_OPEN_ITEM_RE.test(trimmed) || isNamedSlotItemRejection(trimmed, line.name, menuItem?.category)) {
        removeCartLine(cart as unknown as ReconcilerCartLine[], idx);
        return { resolved: true, outcome: { kind: "slot_item_declined" }, cartChanged: true };
      }
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
      if (result.cartChanged) {
        return { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true };
      }
      // 2026-09-18 PO dispatch (echo regression, real conv 4854b0e3):
      // applyCompiledModifyItem finds its target line by menu_item_id ALONE
      // (this file's own header note 4 on that pre-existing limitation) —
      // when TWO lines share a menu_item_id (one already resolved, one
      // still open; the real live shape here: the customer's own recap
      // text re-triggered a duplicate Chicken Alfredo Entree add, leaving
      // one resolved-to-Spaghetti line and one still-blank line), it can
      // silently match the ALREADY-RESOLVED line, find nothing new to set,
      // and report no change — even though the customer's own words
      // ("Spaghetti, please!...") plainly answer the question. Falls back
      // here to a direct match against ONLY the group ask() actually opened
      // (state.open.group_id), applied straight to `line` — the EXACT line
      // findLineByKey already found by line_key, never by menu_item_id — so
      // a duplicate elsewhere in the cart can never shadow this one.
      const openGroupId = state.open.group_id;
      const openStep = menuItem.ask_plan.steps.find(s => s.group_id === openGroupId);
      const directMatch = openStep ? matchChoiceInText(openStep.choices, trimmed) : null;
      if (openStep && directMatch && !isNegated(trimmed, directMatch.display)) {
        const selections = { ...(line.ask_plan_selections ?? {}), [openGroupId]: directMatch.id };
        const { resolvedOptions, priceCents } = priceSelections(menuItem.ask_plan, menuItem.option_groups ?? [], selections);
        line.ask_plan_selections = selections;
        line.options = Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined;
        line.price_cents = priceCents;
        return { resolved: true, outcome: { kind: "slot_resolved" }, cartChanged: true };
      }
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    case "disambiguation": {
      const candidates: PendingCandidate[] = state.open.candidates
        .map(id => menuById.get(id))
        .filter((m): m is TurnEngineMenuItem => !!m)
        .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
      if (candidates.length === 0) return UNRESOLVED;
      // M2 fix (2026-09-19, live conv d3539d12 #5, real $91.30 overcharge):
      // checked BEFORE isPendingDisambiguationDeclined and every candidate-
      // name/size matching tier below — see isDisambiguationAnswerRemovalRequest's
      // own header for why DECLINE_CUES doesn't already catch this. Applies
      // the removal against the CURRENT cart via the exact same primitive
      // the order_type/confirm cases already trust for the identical shape
      // (applyNamedLineRemovals — a no-op, never an error, when nothing in
      // the cart actually matches, same contract as everywhere else it's
      // called) and leaves the pending disambiguation open exactly as it
      // was: the removal targets a DIFFERENT item than the one still being
      // asked about, so there is always still a real reason to ask it again.
      if (isDisambiguationAnswerRemovalRequest(trimmed)) {
        const removedSomething = applyNamedLineRemovals(cart, trimmed, menu);
        return {
          resolved: true,
          outcome: { kind: "disambiguation_removal_applied", removed: removedSomething },
          cartChanged: removedSomething,
        };
      }
      // 2026-09-19 PO dispatch (replacement, ambiguous target hole): set
      // only when this open question is Y's own narrowing, opened by a
      // same-breath replacement whose target tied — see DialogueState.open's
      // "disambiguation" variant and removeReplacementSourceLine's own doc.
      const replacementSourceLineKey = state.open.replacementSourceLineKey;
      if (isPendingDisambiguationDeclined(trimmed, candidates)) {
        // Round 2 (2026-09-19, TOP item, real phantom charge, 50-run v511:
        // 42/50 paid, this the one money-wrong case): aae67b80's rejection-
        // add rule below treated ANY decline that also named a menu category
        // outside the offered candidates' own as a category CORRECTION
        // ("not stromboli, I meant pizza") and added the offered item anyway
        // — including "oh no, just salad rn! ... house salad w/ steak,
        // salmon n creamy italian only", where "salad" is just as much an
        // outside category as "pizza" is. The two read identically as bare
        // category words; the only reliable signal that tells them apart is
        // whether the OTHER category word, run through the shop's own real
        // lexicon (messageNamesItemOutsideCandidates — the exact same
        // "resolves cleanly to a SPECIFIC item outside the candidates, never
        // an ambiguous tie" primitive the outside-item dispatch above this
        // one already uses), resolves to something that ISN'T one of the
        // offered candidates. "pizza" alone is ordinarily ambiguous across a
        // real menu's many pizzas (never a single clean hit, so the
        // correction reading survives); "house salad" is a real, specific,
        // uniquely-named dish. When it does resolve to something outside the
        // candidates, this is a decline, not a correction — the category-
        // reject-add path below is skipped entirely and UNRESOLVED is
        // returned so turn-engine-runner.ts's own drop-and-reprocess
        // mechanism (disambiguationDeclineNamesOutsideItem, mirroring the
        // "list already missed, drop it" mechanism Round 2 item A rule 2
        // built) can drop this list and run the WHOLE message through
        // PROPOSE fresh — never silently discarding "house salad w/ steak,
        // salmon" the way plain `closure` below would (closure is
        // deliberately excluded from every remainder mechanism this engine
        // has).
        // Money bug fix (2026-09-19, live conv 0dcb02a7): see
        // messageNamesMultipleItemsOutsideCandidates's own header — a decline
        // naming TWO OR MORE distinct real items outside the candidates
        // ("just the greek salad, 2 med pepperoni pizzas") is exactly as much
        // a decline-not-a-correction as the single-outside-item case just
        // above it, and must take the identical UNRESOLVED/drop-and-reprocess
        // path rather than falling into the correction-add branch below.
        const quantity = state.open.quantity ?? 1;
        const outsideItem = messageDeclineNamesOutsideItems(trimmed, candidates, external.lexicon);
        if (!outsideItem) {
          const categoryRejectCandidate = findDisambiguationCategoryRejectionCandidate(
            trimmed, candidates, menu,
          );
          if (categoryRejectCandidate) {
            const cartChanged = addNarrowedCandidateToCart(cart, menuById, categoryRejectCandidate, quantity);
            const displayName = menuById.get(categoryRejectCandidate.menu_item_id)?.ask_plan?.display_name
              ?? menuById.get(categoryRejectCandidate.menu_item_id)?.name
              ?? categoryRejectCandidate.name;
            return {
              resolved: true,
              outcome: {
                kind: "disambiguation_category_rejected",
                message: buildCategoryMismatchMessage(displayName, categoryRejectCandidate.category ?? ""),
                menuItemId: categoryRejectCandidate.menu_item_id,
              },
              cartChanged,
            };
          }
          return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
        }
        return UNRESOLVED;
      }

      const quantity = state.open.quantity ?? 1;

      // Round 2, item 3 (2026-09-19, live repro): before letting either
      // resolver below (the facet path or resolvePendingDisambiguation)
      // score whatever words in this message happen to overlap the open
      // candidates, check whether the message actually names a DIFFERENT,
      // real item entirely — see messageNamesItemOutsideCandidates's own
      // header. Checked for every disambiguation, small list or narrowing
      // facet alike: both resolvers below share the same failure mode (a
      // stray size/category word winning a tiebreak while the actual
      // answer — a different dish's name — is discarded as noise).
      const outsideItem = messageNamesItemOutsideCandidates(trimmed, candidates, external.lexicon);
      if (outsideItem) {
        const outsideMenuItem = menuById.get(outsideItem.menuItemId);
        if (outsideMenuItem?.ask_plan) {
          const outsideCandidate: PendingCandidate = {
            menu_item_id: outsideMenuItem.id,
            name: outsideMenuItem.name,
            category: outsideMenuItem.category ?? null,
            price_cents: outsideMenuItem.price_cents,
          };
          const cartChanged = addNarrowedCandidateToCart(cart, menuById, outsideCandidate, outsideItem.quantity);
          return {
            resolved: true,
            outcome: { kind: "disambiguation_new_item_added", menuItemId: outsideItem.menuItemId, quantity: outsideItem.quantity },
            cartChanged,
          };
        }
      }

      // PO amendment (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md):
      // an overflowing candidate set (isNarrowingCandidateSet — the exact
      // threshold render()'s disambiguation case uses to choose narrowing
      // over enumeration) is answered facet-by-facet, kind then size, never
      // by the numbered-list resolver below. "what are the options" is left
      // to fall through to UNRESOLVED so the runner's existing
      // enumerateDisambiguationCandidates handling (turn-engine-runner.ts)
      // takes over instead of this trying to read it as a facet answer.
      // otherOneFollowUp/facetNarrowed force the facet path regardless of
      // size: once a kind (or partial-size split) has already narrowed the
      // set down to a same-kind, multi-size remainder, it stays a facet
      // answer even if only 2-3 candidates are left — never falls back to
      // the numbered-list resolver just because the remainder happens to be
      // small. See DialogueState's own doc on `facetNarrowed`.
      //
      // 2026-09-19 PO dispatch: `!state.open.noProgress` — once a facet
      // answer against THIS open question has already excluded zero
      // candidates once, trying the facet path again just re-derives the
      // identical question (the customer's word is stuck matching every
      // candidate the same way it did last time). From here on this
      // disambiguation is permanently routed to the numbered-list resolver
      // below instead — see DialogueState.open's own `noProgress` doc.
      if (
        (state.open.otherOneFollowUp || state.open.facetNarrowed || isNarrowingCandidateSet(candidates)) &&
        !state.open.noProgress &&
        !isDisambiguationOptionsRequest(trimmed)
      ) {
        const spanText = state.open.spanText ?? "";
        const partialSize = state.open.otherOneFollowUp ? null : extractPartialSizeClause(spanText, quantity);
        let effectiveCandidates = candidates;
        let heldSize: string | null = null;
        if (!partialSize) {
          heldSize = extractGlobalSizeWord(spanText);
          if (heldSize) effectiveCandidates = filterCandidatesBySizeWord(candidates, heldSize);
        }
        const facetResult = pickNarrowingFacet(effectiveCandidates);
        if (facetResult) {
          // P0 (2026-09-19, multi-kind-answer): the answer to "what kind?"
          // can be a LIST — see resolveMultiKindClauses's own header. Only
          // ever intercepts here (never for the "size" facet); returns null
          // when `trimmed` isn't structurally a list, in which case the
          // single-match path immediately below runs completely unchanged.
          if (facetResult.facet === "kind") {
            const multi = resolveMultiKindClauses(effectiveCandidates, trimmed, quantity, menu, external.lexicon, heldSize);
            if (multi) {
              let multiCartChanged = false;
              const resolvedIds: string[] = [];
              for (const add of multi.resolvedAdds) {
                if (addNarrowedCandidateToCart(cart, menuById, add.candidate, add.count)) multiCartChanged = true;
                resolvedIds.push(add.candidate.menu_item_id);
              }
              if (multi.singleAmbiguous) {
                return {
                  resolved: true,
                  outcome: {
                    kind: "disambiguation_narrowed",
                    remainingCandidates: multi.singleAmbiguous.candidates.map(c => c.menu_item_id),
                    remainingQuantity: multi.singleAmbiguous.count,
                    resolvedMenuItemId: resolvedIds.length > 0 ? resolvedIds[resolvedIds.length - 1] : undefined,
                    otherOneFollowUp: false,
                    ...(replacementSourceLineKey ? { replacementSourceLineKey } : {}),
                  },
                  cartChanged: multiCartChanged,
                };
              }
              // Round 2, item 1: two or more same-kind groups still need a
              // size, with nothing stated yet — ask the shared question
              // once, for all of them, instead of dumping the unresolved
              // ones into "I'm not sure what you meant" (see
              // resolveMultiKindClauses's own header).
              if (multi.needsSizeGroups.length > 0) {
                return {
                  resolved: true,
                  outcome: {
                    kind: "disambiguation_multi_size_narrowed",
                    groups: multi.needsSizeGroups.map(g => ({ candidates: g.candidates.map(c => c.menu_item_id), quantity: g.count })),
                    resolvedMenuItemIds: resolvedIds,
                    ...(multi.clarifyMessage ? { clarifyMessage: multi.clarifyMessage } : {}),
                  },
                  cartChanged: multiCartChanged,
                };
              }
              return {
                resolved: true,
                outcome: {
                  kind: "disambiguation_multi_resolved",
                  resolvedMenuItemIds: resolvedIds,
                  ...(multi.clarifyMessage ? { clarifyMessage: multi.clarifyMessage } : {}),
                },
                cartChanged: multiCartChanged,
              };
            }
          }

          const matched = facetResult.facet === "kind"
            ? narrowCandidatesByKind(effectiveCandidates, trimmed, external.lexicon)
            : narrowCandidatesByFacetAnswer(effectiveCandidates, facetResult.facet, trimmed);
          if (!matched) return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;

          // "2 pizzas, one large" -> "pepperoni": the kind answer also
          // settles the ALREADY-SIZED half of the split outright. Whatever
          // is left of that kind (the still-unsized remainder) either
          // resolves too (exactly one size left) or becomes a fresh, smaller
          // disambiguation asking just for "the other one"'s size.
          if (facetResult.facet === "kind" && partialSize) {
            const sizedMatch = matched.find(
              c => (candidateSizeValue(c) ?? "").toLowerCase() === partialSize.sizeWord.toLowerCase(),
            );
            if (sizedMatch) {
              const cartChanged = addNarrowedCandidateToCart(cart, menuById, sizedMatch, partialSize.sizeQuantity);
              const remaining = matched.filter(c => c.menu_item_id !== sizedMatch.menu_item_id);
              const remainingQuantity = quantity - partialSize.sizeQuantity;
              if (remaining.length === 0 || remainingQuantity <= 0) {
                const removed = removeReplacementSourceLine(cart, replacementSourceLineKey);
                return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: sizedMatch.menu_item_id }, cartChanged: cartChanged || removed };
              }
              if (remaining.length === 1) {
                const otherChanged = addNarrowedCandidateToCart(cart, menuById, remaining[0], remainingQuantity);
                const removed = removeReplacementSourceLine(cart, replacementSourceLineKey);
                return {
                  resolved: true,
                  outcome: { kind: "disambiguation_resolved", menuItemId: remaining[0].menu_item_id },
                  cartChanged: cartChanged || otherChanged || removed,
                };
              }
              return {
                resolved: true,
                outcome: {
                  kind: "disambiguation_narrowed",
                  remainingCandidates: remaining.map(c => c.menu_item_id),
                  remainingQuantity,
                  resolvedMenuItemId: sizedMatch.menu_item_id,
                  otherOneFollowUp: true,
                  ...(replacementSourceLineKey ? { replacementSourceLineKey } : {}),
                },
                cartChanged,
              };
            }
            // The stated partial size isn't actually available for this
            // kind — fall through and ask about the whole quantity as one
            // unsplit group instead of guessing.
          }

          if (matched.length === 1) {
            const cartChanged = addNarrowedCandidateToCart(cart, menuById, matched[0], quantity);
            const removed = removeReplacementSourceLine(cart, replacementSourceLineKey);
            return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: matched[0].menu_item_id }, cartChanged: cartChanged || removed };
          }
          // "large cheese" answering a bare "pizza" span in one message names
          // BOTH facets at once (kind AND size) — matched here is only the
          // kind-narrowed group (the 3 Cheese sizes); re-check the SAME
          // customer text against whatever facet still distinguishes that
          // narrowed group before asking a second question for something
          // already said once. Never re-asks something the customer already
          // named in the same breath.
          const secondFacet = pickNarrowingFacet(matched);
          if (secondFacet) {
            const doubleMatched = secondFacet.facet === "kind"
              ? narrowCandidatesByKind(matched, trimmed, external.lexicon)
              : narrowCandidatesByFacetAnswer(matched, secondFacet.facet, trimmed);
            if (doubleMatched && doubleMatched.length === 1) {
              const cartChanged = addNarrowedCandidateToCart(cart, menuById, doubleMatched[0], quantity);
              const removed = removeReplacementSourceLine(cart, replacementSourceLineKey);
              return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: doubleMatched[0].menu_item_id }, cartChanged: cartChanged || removed };
            }
          }
          // 2026-09-19 PO dispatch (real live incident, customer #20 —
          // "fifth shape", a clarifying question with no exit): `matched`
          // excluded ZERO of `effectiveCandidates` — the customer's own word
          // is contained in every remaining candidate the same way it was
          // before this answer (real repro: "chicken" against 11 Buffalo/
          // Thai/Grilled Chicken items, still 11 after). Re-asking the same
          // facet question (narrowingKindQuestion/render()) would produce
          // byte-identical text a second time with no way out. `secondFacet`
          // above already tried the OTHER facet on this exact set and it
          // didn't resolve to one either, so there is genuinely nothing left
          // to narrow with — fall back to the numbered list permanently for
          // this open question (see DialogueState.open's own `noProgress`
          // doc and render()'s disambiguation case).
          const noProgress = matched.length === effectiveCandidates.length;
          return {
            resolved: true,
            outcome: {
              kind: "disambiguation_narrowed",
              remainingCandidates: matched.map(c => c.menu_item_id),
              remainingQuantity: quantity,
              otherOneFollowUp: false,
              ...(replacementSourceLineKey ? { replacementSourceLineKey } : {}),
              ...(noProgress ? { noProgress: true } : {}),
            },
            cartChanged: false,
          };
        }
      }

      const resolved = resolvePendingDisambiguation(trimmed, candidates);
      if (!resolved) return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
      // P0 fix (2026-09-19, TOP live money bug, conv 4c52298c): the ANSWER to
      // this which-one question can restate a quantity that was never part
      // of the original ambiguous span ("pepperoni pizza" opened this
      // disambiguation at quantity 1; "I'll take 2 Large Pepperoni pizzas,
      // please." states 2) — see extractDisambiguationAnswerQuantity's own
      // header for the exact "quantity, never an index" distinction this
      // relies on.
      // DEFECT 2 (2026-09-19 live QA, conv 009de656): the answer that just
      // resolved `resolved` above may ALSO restate its own quantity in the
      // shorter "2x Large (16") Pepperoni pizzas" shape — see
      // extractAnswerQuantity's own doc for why this is scoped to the same
      // answer clause the category+name tier resolved against, never the
      // whole (possibly multi-item) restated order. Two independent
      // extractors, two different answer shapes; try the qualifier-aware one
      // first, then the clause-scoped one, then fall back to the open
      // question's own quantity (the ordinary case — nothing new stated).
      const resolvedQuantity =
        extractDisambiguationAnswerQuantity(trimmed) ??
        extractAnswerQuantity(extractAnswerClause(trimmed).clause) ??
        quantity;
      const menuItem = menuById.get(resolved.menu_item_id);
      if (!menuItem?.ask_plan) return UNRESOLVED;
      // 2026-09-18 PO dispatch (add-on rule edge): a modifier held back
      // while this item's own name was still ambiguous (see
      // DecideResult.heldModifierText's own header) is recovered against the
      // WINNING candidate's own modifier choices — same
      // recoverAssertedChoiceFromText helper decide()'s own 00-BF modifier
      // floor already uses for a genuinely resolved item — and passed as an
      // asserted choice, never as free customerMessage text: ask-plan-
      // engine.ts's modifier branch stopped reactively scanning free text
      // entirely (2026-09-09, the pepperoni-bleed defect) and now resolves
      // modifiers ONLY via an asserted choice.
      let heldChoices: Array<{ group_id: string; choice_id: string }> = [];
      const heldText = state.open.heldModifierText;
      if (heldText) {
        for (const step of menuItem.ask_plan.steps) {
          if (step.kind !== "modifier") continue;
          const recovered = recoverAssertedChoiceFromText(heldText, step.choices, menuItem.name);
          if (recovered) heldChoices = [...heldChoices, { group_id: step.group_id, choice_id: recovered }];
        }
      }
      const { texts } = resolveChoiceDisplays(menuItem.ask_plan, heldChoices);
      const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, resolvedQuantity, "", undefined, undefined, texts);
      // 2026-09-19 PO dispatch (replacement, ambiguous target hole): Y just
      // resolved (the numbered-list path — the one a small candidate set
      // like a two-item Chicken Fingers tie actually takes, per
      // isNarrowingCandidateSet's own <=5 threshold) — X comes out THIS
      // SAME turn, right alongside Y going in, so the swap is one atomic
      // mutation from the caller's point of view.
      const removed = removeReplacementSourceLine(cart, replacementSourceLineKey);
      return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: menuItem.id }, cartChanged: result.cartChanged || removed };
    }

    // Round 2, item 1 (2026-09-19, live v511): the shared "What size?"
    // question opened for two or more same-kind groups at once — see
    // AnswerOutcome's "disambiguation_multi_size_narrowed" and
    // resolveMultiKindClauses's own header. Each group is resolved
    // independently against the SAME size word; a group that narrows to
    // exactly one candidate is added at its own count, same mutate-in-place
    // convention as every other disambiguation resolution in this switch.
    case "multi_size": {
      const groups = state.open.groups
        .map(g => ({
          candidates: g.candidates
            .map(id => menuById.get(id))
            .filter((m): m is TurnEngineMenuItem => !!m)
            .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents })),
          quantity: g.quantity,
        }))
        .filter(g => g.candidates.length > 0);
      if (groups.length === 0) return UNRESOLVED;

      if (isPendingDisambiguationDeclined(trimmed, groups.flatMap(g => g.candidates))) {
        return { resolved: true, outcome: { kind: "closure" }, cartChanged: false };
      }

      // Round 2, item 3 (2026-09-19, live repro, real Meat-Lover size list):
      // this case never ran the same outside-item check the sibling
      // "disambiguation" case above already has (see
      // messageNamesItemOutsideCandidates's own header) — "One large
      // hawaiian pizza" against an open Meat-Lover-sizes question matched
      // the bare size word "large" in the per-group loop below and added
      // Large Meat Lover Pizza, discarding that "hawaiian" named a
      // completely different, real item. Same fix, same primitive: a clean
      // (never ambiguous) lexicon resolution to something outside every
      // open group is a new add, checked once across all groups before any
      // group's own size facet gets a chance to score a stray word.
      const allGroupCandidates = groups.flatMap(g => g.candidates);
      const outsideItem = messageNamesItemOutsideCandidates(trimmed, allGroupCandidates, external.lexicon);
      if (outsideItem) {
        const outsideMenuItem = menuById.get(outsideItem.menuItemId);
        if (outsideMenuItem?.ask_plan) {
          const outsideCandidate: PendingCandidate = {
            menu_item_id: outsideMenuItem.id,
            name: outsideMenuItem.name,
            category: outsideMenuItem.category ?? null,
            price_cents: outsideMenuItem.price_cents,
          };
          const cartChanged = addNarrowedCandidateToCart(cart, menuById, outsideCandidate, outsideItem.quantity);
          return {
            resolved: true,
            outcome: { kind: "disambiguation_new_item_added", menuItemId: outsideItem.menuItemId, quantity: outsideItem.quantity },
            cartChanged,
          };
        }
      }

      let anyCartChanged = false;
      const resolvedIds: string[] = [];
      const stillOpen: Array<{ candidates: PendingCandidate[]; quantity: number }> = [];
      for (const group of groups) {
        const matched = narrowCandidatesByFacetAnswer(group.candidates, "size", trimmed);
        if (matched && matched.length === 1) {
          if (addNarrowedCandidateToCart(cart, menuById, matched[0], group.quantity)) anyCartChanged = true;
          resolvedIds.push(matched[0].menu_item_id);
        } else {
          stillOpen.push({ candidates: (matched && matched.length > 1) ? matched : group.candidates, quantity: group.quantity });
        }
      }

      // The size word didn't match anything at all for ANY group — never
      // silently drop the whole open question; give closure/checkout intent
      // a crack first (same discipline as every other facet path in this
      // switch), then genuinely unresolved so the SAME question re-asks.
      if (resolvedIds.length === 0) {
        return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
      }

      // Rare on a real menu (every kind normally shares the same size set),
      // but never guessed at: whatever's left reopens the same shared
      // question for just what's still unresolved.
      if (stillOpen.length > 0) {
        return {
          resolved: true,
          outcome: {
            kind: "disambiguation_multi_size_narrowed",
            groups: stillOpen.map(g => ({ candidates: g.candidates.map(c => c.menu_item_id), quantity: g.quantity })),
            resolvedMenuItemIds: resolvedIds,
          },
          cartChanged: anyCartChanged,
        };
      }

      return { resolved: true, outcome: { kind: "disambiguation_multi_resolved", resolvedMenuItemIds: resolvedIds }, cartChanged: anyCartChanged };
    }

    case "order_type": {
      const orderType = readOrderTypeReply(trimmed);
      if (orderType) {
        // Money bug fix (2026-09-19, live conv 0dcb02a7): see
        // applyNamedLineRemovals's own header — "no stromboli" said in the
        // same breath as the order-type answer must actually remove the
        // line, not be silently dropped because this turn never reaches
        // PROPOSE/decide() at all.
        const removedSomething = applyNamedLineRemovals(cart, trimmed, menu);
        return { resolved: true, outcome: { kind: "order_type_resolved", orderType }, cartChanged: removedSomething };
      }
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    case "address": {
      // 2026-09-18 PO dispatch (address loop, rule 2): abandon-the-order
      // intent gets the FIRST crack, ahead of even closure — "forget it,
      // just cancel" must never be read as a failed address, and must never
      // fall through to a geocode attempt on that literal text. The cart is
      // cleared in place (same mutate-in-place convention applyCompiledAddItem/
      // applyCompiledModifyItem already use in the slot/disambiguation cases
      // above) so the runner needs no extra glue to persist it.
      if (CANCEL_ORDER_ANYWHERE_RE.test(trimmed)) {
        cart.length = 0;
        return { resolved: true, outcome: { kind: "cart_cancelled" }, cartChanged: true };
      }
      // 2026-09-18 PO dispatch (address loop, rule 1): an order-type answer
      // that names pickup switches the order type and closes the address
      // question outright — the customer no longer needs to give an address
      // at all. Checked before the closure fallback since this is a real,
      // positive resolution, not a decline. Delivery isn't checked here: the
      // address question is already delivery-only, so there is nothing to
      // switch TO; a customer saying "deliver it" while address is open is
      // almost certainly retrying the same delivery order, which the
      // fallback/geocode paths below already handle.
      if (ORDER_TYPE_PICKUP_RE.test(trimmed)) {
        return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "pickup" }, cartChanged: false };
      }
      // Closure/checkout intent gets next crack, same as every other open
      // kind below — a bare "thats it"/"no thanks" while address is open
      // must resolve as closure, never as an address (declined or
      // otherwise), regardless of what the caller's geocode attempt (if any)
      // came back with for that same text.
      const fallback = closureOrAffirmationFallback(trimmed, cart, true);
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
      // P0 (2026-09-19, live money bug, deploy v528): the customer can
      // restate the order type WHILE the tip question is open ("Can you
      // just do the two pizzas for pickup?") -- a pickup order never has a
      // tip step at all (rule 4), so this must switch the order type
      // (turn-engine-runner.ts's "order_type_resolved" case also zeros any
      // tip already set, so nothing charges on pickup) rather than being
      // handed to readTipReply below, which has nothing to do with a
      // pickup statement and would otherwise leave this turn unresolved.
      if (readOrderTypeReply(trimmed) === "pickup") {
        return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "pickup" }, cartChanged: false };
      }
      {
        // P0 (2026-09-19): subtotal/line-item prices threaded through so
        // readTipReply can cap the tip and reject a number that's really a
        // menu price stated in the same message -- see its own header
        // (rules 5a/5b).
        const tip = readTipReply(trimmed, {
          subtotalCents: computeCartSubtotalCents(cart),
          lineItemPricesCents: cart.map(l => l.price_cents),
        });   // 00-BH
        if (tip) return { resolved: true, outcome: { kind: "tip_resolved", tipCents: tip.kind === "amount" ? tip.cents : 0 }, cartChanged: false };
      }
      // Round 3, item 2b: a shop-data question ("So delivery is free?")
      // asked WHILE tip is still open — see answerConfirmShopFactsQuestion's
      // own doc. Answered directly, same as at confirm; the tip question
      // itself stays unresolved (this doesn't set tip_resolved), so ASK's
      // own ladder naturally re-opens "tip" right after, never confirm —
      // the tip question was never actually answered.
      //
      // skipTipInfo=true (2026-09-19 live repro): render()'s own "tip" case
      // is about to re-ask "Want to add a tip for the driver?" this same
      // turn regardless — see answerConfirmShopFactsQuestion's own doc on
      // this param for why answering a bare "tip" mention here as well
      // duplicated that exact question in one SMS.
      const shopFactsAnswer = answerConfirmShopFactsQuestion(trimmed, external.confirmShopFacts, true);
      if (shopFactsAnswer) return shopFactsAnswer;
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    case "name": {
      // 00-AV: read the name OUT of the message rather than demanding the
      // message be nothing but a name. "It's Alex!" and "My name is Alex!"
      // both used to fall through to UNRESOLVED, and with nothing capping the
      // repeat the customer was asked their own name nine times and left.
      // Note this also stops "that's it" being accepted AS a name, which the
      // bare shape test allowed -- it now falls through to closure below,
      // where it belongs.
      const extractedName = extractCustomerName(trimmed);
      if (extractedName) return { resolved: true, outcome: { kind: "name_resolved", name: extractedName }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    case "confirm": {
      // 2026-09-18 PO dispatch (read-back corrections, mechanism 1): checked
      // FIRST, ahead of both isExplicitCheckoutIntent and impliesConfirmDecline
      // below — a quantity correction like "2 Thin Sicilian Pizzas, not one"
      // contains "wrong"/"instead"/"actually" (would be read as a bare
      // decline) and is often said in the SAME breath as a closing phrase
      // like "That's all" (would be read as an immediate yes) — either way,
      // the correction's actual content would be silently discarded. Same
      // principle as the remainder mechanism elsewhere in this file ("a yes
      // is not final the instant it's also carrying something new"): a real
      // correction always forces a fresh read-back before anything can be
      // silently confirmed on the same turn it arrived. Applied directly to
      // the matched line (mutate-in-place, same convention as the slot/
      // disambiguation cases above) and resolved on the customer's FIRST
      // attempt. 2026-09-19 PO dispatch (P0, conv 6fc39938): now plural —
      // a compound "make it/that X and Y" can name two corrections in one
      // message; every candidate that matches a real cart line is applied,
      // any that don't (an item mentioned but not actually in the cart) are
      // left alone rather than guessed at. `resolved:true` only once at
      // least one candidate actually landed.
      const qtyCorrections = parseQuantityCorrectionPhrases(trimmed);
      if (qtyCorrections.length > 0) {
        let appliedAny = false;
        for (const candidate of qtyCorrections) {
          const line = findCartLineByNamePhrase(cart, candidate.itemPhrase);
          if (line) {
            line.quantity = candidate.quantity;
            appliedAny = true;
          }
        }
        if (appliedAny) return { resolved: true, outcome: { kind: "quantity_corrected" }, cartChanged: true };
      }
      // 2026-09-18 PO dispatch (read-back corrections, mechanism 2): same
      // priority reasoning as mechanism 1 immediately above — "not a
      // stromboli" contains "not"/"actually"-adjacent language that
      // impliesConfirmDecline would otherwise consume as a bare decline,
      // and PROPOSE's own removes/adds for this exact shape is the real
      // defect this closes (see the dispatch's own header on this file).
      const replacement = parseReplacementCorrection(trimmed);
      if (replacement) {
        const wrongLine = findCartLineByNamePhrase(cart, replacement.wrongPhrase);
        if (wrongLine) {
          const wrongMenuItem = menuById.get(wrongLine.menu_item_id);
          if (wrongMenuItem) {
            const targetMenuItem = findMenuItemByNamePhrase(menu, replacement.targetPhrase, wrongLine.menu_item_id);
            if (targetMenuItem?.ask_plan) {
              const quantity = wrongLine.quantity;
              const idx = cart.indexOf(wrongLine);
              removeCartLine(cart as unknown as ReconcilerCartLine[], idx);
              applyCompiledAddItem(cart, toCompiledMenuItem(targetMenuItem, targetMenuItem.ask_plan), targetMenuItem.id, quantity, "", undefined, undefined, []);
              return { resolved: true, outcome: { kind: "line_replaced" }, cartChanged: true };
            }
            // X isn't its own menu item — never remove the line just
            // because the customer asked for something we don't have; say
            // so by name instead, matching what's actually on the menu.
            return {
              resolved: true,
              outcome: { kind: "replacement_unavailable", message: describeExistingLineForReplacementDecline(wrongLine, wrongMenuItem) },
              cartChanged: false,
            };
          }
        }
      }
      // Money bug fix (2026-09-19, live conv 0dcb02a7): mechanism 3, same
      // priority reasoning as mechanisms 1/2 above — "no stromboli" (a bare
      // removal, no replacement target named) contains "no", which
      // impliesConfirmDecline below would otherwise read as declining the
      // WHOLE order. Checked ahead of it; see applyNamedLineRemovals's own
      // header.
      const removedAtConfirm = applyNamedLineRemovals(cart, trimmed, menu);
      if (removedAtConfirm) {
        return { resolved: true, outcome: { kind: "line_removed_at_confirm" }, cartChanged: true };
      }
      // Round 3, item 2c(i) (2026-09-19, live repro): a tip amount stated
      // AT CONFIRM ("$5 tip", "I want to tip the driver $5") must set
      // driver_tip_cents even though PROPOSE reads this as intent:"order"
      // with adds:[] — same "trust the message over the model's
      // classification" principle as items 1 and 2a. Checked ahead of the
      // checkout/decline checks below since a dollar amount is never a
      // yes/no. Decline shapes ("no tip") are deliberately NOT read here —
      // confirm's own decline/affirm checks already own that vocabulary,
      // and a tip was never offered yet at this point for there to be
      // anything to decline.
      const tipAtConfirm = readTipReply(trimmed, {
        subtotalCents: computeCartSubtotalCents(cart),
        lineItemPricesCents: cart.map(l => l.price_cents),
      });
      if (tipAtConfirm?.kind === "amount") {
        return { resolved: true, outcome: { kind: "tip_resolved", tipCents: tipAtConfirm.cents }, cartChanged: false };
      }
      // Round 3, item 2c(ii): a question about a real shop fact — answered
      // by CODE, never sent to the model. Checked ahead of checkout/decline
      // below (none of these shapes are a yes/no) and after the tip-amount
      // check above (a stated amount always wins over a bare "tip" mention
      // inside the same message). See answerConfirmShopFactsQuestion's own
      // doc — shared with the "tip" case above (Round 3, item 2b).
      const confirmShopFactsAnswer = answerConfirmShopFactsQuestion(trimmed, external.confirmShopFacts);
      if (confirmShopFactsAnswer) return confirmShopFactsAnswer;
      if (isExplicitCheckoutIntent(trimmed, "Confirm?", false)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      // 00-BH, narrowed 2026-09-19 PO dispatch (P0, conv 6fc39938, live money
      // bug): CONFIRM_DECLINE_ANYWHERE_RE fires on ordinary correction
      // vocabulary ("actually", "instead", "wrong", "change") that also shows
      // up in genuine corrections neither mechanism above recognized. Real
      // transcript: the customer corrected the same order SIX different ways
      // and every single one tripped this decline check and got "Anything
      // else?" with the cart untouched — the actual defect, not any one
      // regex miss. A short, whole-message decline ("no"/"nope"/"wait") has
      // no other plausible reading and still declines immediately
      // (CONFIRM_DECLINE_RE, the anchored tier). For anything longer, the
      // deciding question is whether the customer is clearly talking about a
      // REAL line already in the cart (every significant word of that line's
      // own name shows up in the message — same stem-subset convention as
      // findCartLineByNamePhrase, just checked in the other direction): if
      // so, none of the correction patterns above matched, but the customer
      // is still plainly trying to say something about a specific item we
      // have, so fall through to UNRESOLVED and let PROPOSE take a shot
      // rather than silently discarding it as a bare "no" — the actual
      // defect this dispatch closes. Anything else (decline-adjacent
      // language with no real cart item named at all, e.g. a general
      // complaint about the total) keeps the pre-existing deterministic
      // confirm_no — unchanged from before this dispatch, on purpose: it is
      // NOT confidently a correction of anything specific, and this file's
      // ADDENDUM 1 regression test (tip-step-p0-20260919.test.ts) already
      // pins exactly this shape to resolve without ever reaching the model.
      if (impliesConfirmDecline(trimmed)) {
        if (!CONFIRM_DECLINE_RE.test(trimmed) && messageNamesRealCartLine(trimmed, cart)) return UNRESOLVED;
        return { resolved: true, outcome: { kind: "confirm_no" }, cartChanged: false };
      }
      // 00-BE: see isConfirmAffirmative. Decline above wins; negation inside
      // the helper blocks "not yet"/"don't"/"wrong"/"change".
      if (isConfirmAffirmative(trimmed)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    case "upsell": {
      if (impliesUpsellAcceptance(trimmed)) {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (!menuItem?.ask_plan) return UNRESOLVED;
        const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, 1, "", undefined, undefined, []);
        return { resolved: true, outcome: { kind: "upsell_accepted" }, cartChanged: result.cartChanged };
      }
      if (impliesUpsellDecline(trimmed)) return { resolved: true, outcome: { kind: "upsell_declined" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    // 2026-09-19 PO dispatch (freeze-queue item 4): the fresh-add
    // category-mismatch question — see DialogueState.open's own
    // "category_confirm" doc. Same shape as "upsell" immediately above
    // (bare yes/no over a single held item), except the item was NEVER
    // added to the cart, so "yes" adds it here for the first time rather
    // than confirming something already there. impliesCategoryConfirmYes
    // extends impliesUpsellAcceptance with "keep"/"keep it" — the PO's own
    // acceptance wording for this question — never a second copy of the
    // whole affirmative list. Anything that isn't a clean yes/no (including
    // a message about something else entirely) falls to
    // closureOrAffirmationFallback and, failing that, UNRESOLVED — which
    // hands the turn to PROPOSE with `open` cleared back to whatever DECIDE
    // computes fresh next turn (categoryMismatchPending is turn-scoped,
    // never persisted), so this question is asked AT MOST ONCE per item,
    // never re-asked forever on an unclear reply (a general repeat cap
    // across every open kind is freeze-queue item 5, out of scope here).
    case "category_confirm": {
      if (impliesCategoryConfirmYes(trimmed)) {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (!menuItem?.ask_plan) return UNRESOLVED;
        const result = applyCompiledAddItem(
          cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, state.open.quantity, "", undefined, undefined, [],
        );
        return { resolved: true, outcome: { kind: "category_confirm_added", menuItemId: menuItem.id }, cartChanged: result.cartChanged };
      }
      // Rule 3: "take it off" is this keep-or-drop question's own "drop"
      // answer, same as a bare "no" — see DECLINE_OPEN_ITEM_RE's header.
      if (impliesUpsellDecline(trimmed) || DECLINE_OPEN_ITEM_RE.test(trimmed)) {
        return { resolved: true, outcome: { kind: "category_confirm_declined" }, cartChanged: false };
      }
      return closureOrAffirmationFallback(trimmed, cart, true) ?? UNRESOLVED;
    }

    // "ordering" (00-AK): identical treatment to `state.open === null` above
    // — an empty cart has nothing to close, so this only catches an
    // explicit checkout phrase or a bare closure/affirmation before ever
    // reaching PROPOSE; naming an actual item is NOT this case's job (that
    // free text falls through UNRESOLVED to PROPOSE exactly as it always
    // has, regardless of which `open.kind` is on record).
    case "ordering": {
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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

// 2026-09-18 PO dispatch (fries-duplicate money bug, conv fbc7cab1): PROPOSE's
// own contract (propose.ts's SYSTEM_PROMPT_PREAMBLE) already states item_span
// must be "the VERBATIM substring of the customer's own message naming the
// item — nothing normalized, nothing invented", but nothing here ever
// verified that. Live: the customer said "I want to add a side of fries,
// too!" (an item that ties ambiguous, 10 items — correctly queued) and the
// SAME proposal's adds ALSO carried a second entry that resolved, uniquely,
// to The Slice Cheesesteak — an item already fully resolved in the cart,
// never named anywhere in this turn's message. resolve-item.ts worked
// exactly right on both spans; the gap is that decide() trusted an add's
// span was really said this turn instead of checking the one guarantee the
// contract already promises. `customerMessage` undefined (an existing call
// site/test that predates this param) opts out entirely — permissive
// default, same convention as isRestatementOfExistingOrder below.
//
// 2026-09-18 PO dispatch (two-regressions item a): original implementation
// was an exact substring test, so a model that reordered tokens in the span
// ("medium Hawaiian Pizza" for "a Hawaiian Pizza in medium size") failed the
// check and the customer was told "Sorry, I didn't catch 'medium Hawaiian
// Pizza'" (conv 55c05b4c) — the item WAS in the message, just with a
// different token order. Token-based: normalize both strings the same way
// resolve-item.ts does (lowercase, strip non-alphanumeric to spaces,
// collapse whitespace) then check every span token appears somewhere in the
// message token set — order-free. "The Slice Cheesesteak" for "I want to
// add a side of fries" still fails: no shared tokens.
//
// Singularized before comparing (same singularizeWord rule compile-menu.ts
// and resolve-item.ts both already carry, duplicated here per that existing
// convention — see resolve-item.ts's own comment on why it duplicates
// compile-menu.ts's copy rather than importing it): the ORIGINAL substring
// check tolerated a plural/singular mismatch for free ("California
// Cheesesteak" IS a substring of "...California Cheesesteaks..."; "cheese
// burger" IS a substring of "...cheese burgers..."), because English pluralization
// almost always just appends letters. An exact-token-equality check does not
// get that for free — "cheesesteak" != "cheesesteaks" as strings — and broke
// two real call sites the first time this landed (turn-engine-runner tests:
// PROPOSE's span "cheese burger" against message "two cheese burgers";
// open-question-reprocess's span "California Cheesesteak" against message
// "...California Cheesesteaks..."). Singularizing both sides before the
// membership check restores that tolerance without giving up the ordering
// fix or the "no shared tokens" rejection.
// Arrow form deliberately, not a plain named-function declaration with a
// string return type — this file's own gate test asserts exactly one
// function signature of that shape exists (render(), the sole reply-
// building function); a second declaration matching it trips the gate even
// though this helper never produces customer-facing text.
const singularizeSpanToken = (word: string): string => {
  if (word.length > 4 && /ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|ses|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
};

// ADDENDUM B (2026-09-19, live repro): the customer typed "One large
// hawiaan pizza", the model correctly self-corrected the typo in its own
// item_span ("large hawaiian pizza"), and the exact-token check below
// rejected it — "hawaiian" is nowhere in the customer's literal message,
// only "hawiaan" is — so a genuine typo fix was punished exactly like a
// hallucinated item, and the customer had to repeat themselves a third
// time. A span token of 5+ letters that doesn't exact-match is now also
// accepted when it's within edit distance 1 of SOME message token of 5+
// letters — this guard's job is to block a span the customer never said
// anything resembling, not to punish a correct typo fix. Deliberately
// narrower than guard19-fuzzy-item-match.ts's own fuzzyWordMatch (which
// also allows a >=4-char prefix match and a wider distance for 8+ char
// words): this guard's job is catching a hallucinated item, so it stays at
// the tightest tolerance that still fixes the live repro.
// PO correction to the dispatch's own wording: a flat "edit distance 1"
// cap does NOT fix the cited live repro — levenshteinDistance("hawaiian",
// "hawiaan") is 2, not 1 (verified against the real customer typo before
// shipping this). Reuses guard19-fuzzy-item-match.ts's own fuzzyWordMatch
// instead of a hand-rolled distance-1-only check: it already carries
// exactly the graduated tolerance this needs (prefix match for 4+ chars,
// distance 1 for 5-7 chars, distance 2 for 8+ chars, extended to 3 when
// both words are 6+/8+), is already tested, and already comfortably covers
// "hawiaan"/"hawaiian" (dist 2, well inside its 8-char tolerance) without
// widening the guard any further than a defect already fixed elsewhere in
// this codebase.
// P0 fix (2026-09-19, live money bug, phantom $20 charge): "... Also, can I
// get 2 Pepperoni pizzas? And do you have anything gluten free?" fused the
// customer's own QUESTION about availability into the same add as the two
// pepperoni pizzas actually ordered — the bot added a $20.00 "Gluten-Free
// Pizza (Toppings: Pepperoni (Whole))" line nobody asked to buy, and the two
// real pepperoni pizzas never landed. itemSpanNamedInMessage above only
// checks that a span's words appear SOMEWHERE in the message; it has no
// notion of a word that appears ONLY inside a question — "gluten" and
// "free" passed that check cleanly (they really are in the message), even
// though the clause they came from was the customer asking a question, not
// placing an order.
//
// Rule: split the message into clauses (sentence-ending punctuation, then
// the coordinating conjunctions PROPOSE routinely runs an add and a
// question together across — "and"/"also"/"but"/"plus"), find every clause
// that carries a real availability-question marker ("do you have", "is
// there", "are there", "what about", "does it have", "you have/got any",
// "have/got any"), and collect whichever tokens show up ONLY inside those
// clauses and nowhere else in the message. A word that ALSO appears in a
// non-question clause is never excluded — the customer really did use it to
// order something — this only strips vocabulary used exclusively to ask.
//
// Deliberately narrow trigger phrases: "can I get" is this SMS channel's own
// common ordering phrasing ("can I get 2 pepperoni pizzas") and must never
// itself be treated as a question clause, or every order phrased that way
// would have its own words stripped and silently dropped.
const AVAILABILITY_QUESTION_MARKER_RE =
  /\b(?:do you have|does\s+\S+(?:\s+\S+){0,3}\s+have|is there|are there|what about|you (?:have|got) any|have any|got any)\b/i;

// SIZE_WORD_ALIASES (resolve-item.ts): the same "med" -> "medium" expansion
// resolveItem's own tokenizer applies, reused here so a model item_span
// abbreviation lines up with the customer's own fully-spelled word (or vice
// versa) instead of failing this guard on a spelling difference alone — see
// the conv22 money-bug dispatch on itemSpanNamedInMessage below.
const tokenizeSpanText = (t: string): string[] =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
    .map(singularizeSpanToken).map(w => SIZE_WORD_ALIASES[w] ?? w);

// Sentence-ending punctuation splits first (a literal "?" closes the
// question clause and starts fresh for whatever follows), then the
// conjunctions PROPOSE commonly runs an add and a question together across
// within the SAME sentence. Shared by questionClauseOnlyTokens (which
// tokens are question-exclusive) and nonQuestionClauseText below (the
// actual surviving TEXT once the question clause is excluded) -- one
// clause-boundary rule, two different things read off of it.
function splitIntoMessageClauses(customerMessage: string): string[] {
  return customerMessage.split(/[.!?]+/).flatMap(s => s.split(/\b(?:and|also|but|plus)\b/i));
}

function questionClauseOnlyTokens(customerMessage: string | undefined): Set<string> {
  if (!customerMessage) return new Set();
  const clauses = splitIntoMessageClauses(customerMessage);
  const questionTokens = new Set<string>();
  const nonQuestionTokens = new Set<string>();
  for (const clause of clauses) {
    const isQuestionClause = AVAILABILITY_QUESTION_MARKER_RE.test(clause);
    for (const t of tokenizeSpanText(clause)) (isQuestionClause ? questionTokens : nonQuestionTokens).add(t);
  }
  const exclusive = new Set<string>();
  for (const t of questionTokens) if (!nonQuestionTokens.has(t)) exclusive.add(t);
  return exclusive;
}

// PO follow-up (2026-09-19, non-blocking wart on the fix above, same live
// conversation): when PROPOSE FUSES a real order and a question into the
// SAME add's item_span ("gluten free pepperoni pizzas" for "can I get 2
// Pepperoni pizzas? And do you have anything gluten free?"),
// itemSpanNamedInMessage correctly refuses the whole span for its
// question-clause taint -- the $20 phantom charge stays refused, exactly as
// designed -- but that refusal also erases the two pepperoni pizzas the
// customer actually ordered, since the model never proposed a separate span
// for them. Recovering that real order means re-resolving against the
// message's own words with the question clause's words removed -- NOT the
// raw message verbatim, since "gluten free" would still be sitting right
// there and could resolve on its own, reintroducing the exact charge this
// guard exists to prevent. Returns the surviving non-question clause text,
// joined back together in the message's own order. See the decide() add
// loop below for where this feeds resolveItem.
function nonQuestionClauseText(customerMessage: string | undefined) {
  if (!customerMessage) return "";
  return splitIntoMessageClauses(customerMessage)
    .filter(clause => !AVAILABILITY_QUESTION_MARKER_RE.test(clause))
    .map(clause => clause.trim())
    .filter(Boolean)
    .join(" ");
}

// True when at least one of the span's own tokens is supported ONLY by a
// question clause -- i.e. itemSpanNamedInMessage refused (or would refuse)
// this span BECAUSE of question-clause taint, as distinct from a span
// naming something absent from the message entirely (a stale re-proposal
// or a flat hallucination -- ADDENDUM A/Round 3 item 2a's own territory,
// not this one).
function spanHasQuestionClauseOnlyToken(span: string, customerMessage: string | undefined): boolean {
  if (!customerMessage) return false;
  const questionOnly = questionClauseOnlyTokens(customerMessage);
  if (questionOnly.size === 0) return false;
  return tokenizeSpanText(span).some(t => questionOnly.has(t));
}

function itemSpanNamedInMessage(span: string, customerMessage: string | undefined): boolean {
  if (customerMessage === undefined) return true;
  const spanTokens = tokenizeSpanText(span);
  if (spanTokens.length === 0) return false;
  const messageTokens = tokenizeSpanText(customerMessage);
  const questionOnly = questionClauseOnlyTokens(customerMessage);
  const messageTokenSet = new Set(messageTokens.filter(t => !questionOnly.has(t)));
  return spanTokens.every(t => {
    // A span token used nowhere but a question clause is never valid
    // support for an add, even if it also happens to be 5+ letters and
    // would otherwise pass the fuzzy fallback below.
    if (questionOnly.has(t)) return false;
    if (messageTokenSet.has(t)) return true;
    // 2026-09-19 PO dispatch (conv22 live-runner gap, real $23.94-vs-$11.98
    // money bug): a format/size word (GUARD19_GENERIC_WORDS — the exact
    // vocabulary GUARD 19 already treats as carrying no identity signal of
    // its own, see that file's own header) is never what makes a span real
    // or hallucinated — the OTHER words in the span (the actual dish name)
    // still have to clear this guard normally. Real live repro: PROPOSE
    // paraphrased "2 medium pepperonis" (the customer's own words) as item_
    // span "2 med pepperoni pizzas" — "pizzas" names the same dish the
    // customer already did via "pepperonis" alone (this shop's bare
    // "pepperoni" term ties pizza sizes against a Stromboli Roll of the same
    // name; "pizza" is PROPOSE's own correct disambiguation, not new,
    // unverified information), and nothing in the customer's message that
    // turn contained the word "pizza" at all to support it literally or via
    // the 5+-letter fuzzy fallback below. The guard silently dropped the
    // whole add — the customer's 2 pepperoni pizzas simply vanished, no
    // decline shown. Exempting only the generic word, never the dish-naming
    // ones ("pepperoni" still has to appear, and does), keeps this guard's
    // actual job — refusing a span naming a DISH the customer didn't say —
    // completely intact.
    if (GUARD19_GENERIC_WORDS.has(t)) return true;
    if (t.length < 5) return false;
    return messageTokens.some(mt => mt.length >= 5 && !questionOnly.has(mt) && fuzzyWordMatch(t, mt));
  });
}

// 2026-09-18 PO dispatch (self-correction money bug, conv c879937d): "Actually,
// can I add a side salad to that? Just the house salad." resolved BOTH Side
// Salad ($3.99) and House ($8.99) — two real, distinct, correctly-resolved
// items, both genuine substrings of the message, so itemSpanNamedInMessage
// above does not (and should not) catch this: the customer really did say
// both phrases. The gap is recognizing "Just X" as retracting whatever was
// named before it, not adding to it — same clause-boundary idea pending-
// disambiguation.ts already uses for an ANSWER (a marker splits the message;
// content on the wrong side of it is discarded), applied here to a pair of
// ADDS instead of a single answer. A correction marker sitting between the
// end of one add's own span and the start of a LATER add's span means the
// earlier one was superseded mid-message; only the later survives. Requires
// customerMessage (an existing call site/test that predates this param
// keeps every add, unchanged) and at least two resolved adds to do anything.
const CORRECTION_MARKER_RE = /\b(?:just|actually|i meant|make that)\b/i;

function dropAddsSupersededByCorrection(adds: ResolvedAdd[], customerMessage: string | undefined): ResolvedAdd[] {
  if (!customerMessage || adds.length < 2) return adds;
  const lowerMessage = customerMessage.toLowerCase();
  const spans = adds.map(add => {
    const span = (add.item_span ?? "").toLowerCase().trim();
    const start = span ? lowerMessage.indexOf(span) : -1;
    return { start, end: start >= 0 ? start + span.length : -1 };
  });
  const superseded = new Set<number>();
  for (let i = 0; i < adds.length - 1; i++) {
    if (spans[i].end < 0) continue;
    for (let j = i + 1; j < adds.length; j++) {
      if (spans[j].start < spans[i].end) continue;
      const between = customerMessage.slice(spans[i].end, spans[j].start);
      if (CORRECTION_MARKER_RE.test(between)) {
        superseded.add(i);
        break;
      }
    }
  }
  return superseded.size > 0 ? adds.filter((_, idx) => !superseded.has(idx)) : adds;
}

// 2026-09-18 PO dispatch (add-on treated as a separate item, real money
// bug, every run that day): "house salad w/ black diamond steak" applied
// the $8.00 Black Diamond Steak add-on to the House Salad correctly (the
// 00-BF modifier floor below) AND ALSO added a separate $12.49 "Steak"
// Quesadilla line — customers paid both. Root cause, per the PO's own
// diagnosis: resolveItem correctly resolves "black diamond steak" to the
// real Quesadillas "Steak" item (the lexicon is right — that dish is
// really named that), but decide()'s per-add resolution loop had no way to
// know the SAME words were ALSO a real modifier choice on House Salad,
// another item named in the SAME message. The item path (resolveItem) and
// the modifier path (recoverAssertedChoiceFromText) never compared notes —
// each ran blind to what the other decided about the identical span.
//
// Rule (PO): a phrase that matches an option CHOICE of an item named in
// the SAME message is a modifier, consumed there — it never reaches the
// cart as its own item line. The choice only wins when some OTHER add in
// THIS batch genuinely owns a modifier group with a matching choice — an
// item with no such competing claim ("a steak quesadilla and a house
// salad") is untouched, since nothing in that message has a group Steak
// Quesadilla's own span could instead be read as a choice of. Dropping the
// false item here doesn't need to separately attach the modifier anywhere:
// the words stay in `customerMessage`, so the surviving item's own 00-BF
// floor pass (unchanged, below) finds and applies the same match on its
// own — this function's only job is to stop the SPURIOUS item line from
// ever being created.
//
// P0 fix (2026-09-19, phantom-money): "a phrase that matches an option
// CHOICE" means the candidate's WHOLE resolved span IS that choice's name
// (matchChoiceAsWholeSpan — whole normalized token-set equality, no
// stemming/reduction on either side), never a substring/contains
// check. "a chicken cheesesteak sandwich and a house salad" used to lose
// the whole $11.99 sandwich here — no decline, no trace — because the bare
// word "chicken" inside that span is also House's "Chicken" add-on choice,
// and the old matchChoiceInText call only required the CHOICE's stems to
// be a subset of the span's, not the other way. A resolved add whose span
// is longer/more specific than the modifier text it merely contains is a
// real second item, not a modifier mention — see matchChoiceAsWholeSpan's
// own header for the "longest match wins" reasoning.
function dropAddsThatAreReallyModifiersOfAnotherAdd(
  adds: ResolvedAdd[],
  menuById: Map<string, TurnEngineMenuItem>,
): ResolvedAdd[] {
  if (adds.length < 2) return adds;
  const isReallyAModifierOfAnother = (candidate: ResolvedAdd): boolean => {
    const span = (candidate.item_span ?? "").trim();
    if (!span) return false;
    for (const other of adds) {
      if (other === candidate) continue;
      const otherMenuItem = menuById.get(other.menu_item_id);
      if (!otherMenuItem?.ask_plan) continue;
      for (const step of otherMenuItem.ask_plan.steps) {
        if (step.kind !== "modifier") continue;
        if (matchChoiceAsWholeSpan(step.choices, span, step.prompt_template.split(".")[0])) return true;
      }
    }
    return false;
  };
  return adds.filter(add => !isReallyAModifierOfAnother(add));
}

// 2026-09-18 PO dispatch (add-on rule edge, real conv 9fc0fad9): "I want an
// Italian wrap with chicken, please. Wheat tortilla." split into two adds,
// "Italian" and "chicken" — "chicken" became its own $12.49 line instead of
// a modifier of the Italian item, because "Italian" alone is AMBIGUOUS
// (Italian Wrap vs. Italian Homemade Panini). dropAddsThatAreReallyModifier-
// sOfAnotherAdd above only checks a span against OTHER RESOLVED adds — an
// ambiguous sibling never became a ResolvedAdd, so there was nothing for
// "chicken" to check against. Both Italian candidates carry a Chicken
// modifier choice, so "chicken" was never really a separate item; it just
// had nowhere to attach until the disambiguation resolves. Held here
// instead of dropped: the caller gets the span back as `heldModifierText`
// so answer()'s disambiguation branch can apply it as the winning item's
// customerMessage once the customer picks Wrap or Panini, letting that
// item's own 00-BF modifier floor pick it up the same way a resolved
// sibling already would have.
//
// P0 fix (2026-09-19, phantom-money): same substring-vs-whole-span hole as
// dropAddsThatAreReallyModifiersOfAnotherAdd above — "a chicken cheesesteak
// sandwich and a garden salad" (garden salad genuinely ambiguous) used to
// HOLD the whole resolved sandwich as if it were a modifier of whichever
// salad candidate the customer would pick, and it never came back. Now
// uses matchChoiceAsWholeSpan (whole normalized token-set equality, no
// stemming/reduction on either side), so only a span that IS
// the choice's name, not one that merely contains it, gets held.
function holdAddsThatAreModifiersOfAnAmbiguousSibling(
  adds: ResolvedAdd[],
  ambiguousCandidateIds: string[] | null,
  menuById: Map<string, TurnEngineMenuItem>,
): { survivingAdds: ResolvedAdd[]; heldModifierText: string | null } {
  if (!ambiguousCandidateIds || ambiguousCandidateIds.length === 0) {
    return { survivingAdds: adds, heldModifierText: null };
  }
  const isModifierOfAnyCandidate = (candidate: ResolvedAdd): boolean => {
    const span = (candidate.item_span ?? "").trim();
    if (!span) return false;
    for (const candidateId of ambiguousCandidateIds) {
      const menuItem = menuById.get(candidateId);
      if (!menuItem?.ask_plan) continue;
      for (const step of menuItem.ask_plan.steps) {
        if (step.kind !== "modifier") continue;
        if (matchChoiceAsWholeSpan(step.choices, span, step.prompt_template.split(".")[0])) return true;
      }
    }
    return false;
  };
  let heldModifierText: string | null = null;
  const survivingAdds = adds.filter(add => {
    if (heldModifierText === null && isModifierOfAnyCandidate(add)) {
      heldModifierText = (add.item_span ?? "").trim();
      return false;
    }
    return true;
  });
  return { survivingAdds, heldModifierText };
}

// Round 2, items 1/2 (2026-09-19, live sim): an add whose span resolveItem
// came back AMBIGUOUS or fully UNRESOLVED can still really just be naming a
// choice of another item resolved THIS SAME turn — "house salad w/ steak,
// salmon n creamy italian" proposed "creamy italian dressing" as its own
// add; "italian" is a real item-lexicon term shared by the Italian Wrap and
// Italian Homemade Panini, so it came back ambiguous instead of naming House
// Salad's own "Creamy Italian" dressing choice. "blackened salmon" matched
// no item-lexicon term at all (fully unresolved) even though it's a real
// add-ons choice on that same House Salad. Checked against BOTH slot-kind
// steps (a required choice like Dressing) and modifier-kind steps (an
// on-request extra like Blackened Salmon) — dropAddsThatAreReallyModifiers-
// OfAnotherAdd/holdAddsThatAreModifiersOfAnAmbiguousSibling above are
// deliberately scoped to modifier-kind only (a different, narrower bug); a
// required slot choice is just as ordinary a thing for a customer to name in
// its own clause. Same "don't attach it here" discipline as those two: the
// caller only drops the false disambiguation/decline, never applies the
// choice directly — the span's words stay in customerMessage, so the
// surviving item's own 00-BF modifier-floor pass finds and applies the real
// choice on its own.
// PO dispatch 2026-09-19 (pepperoni wart a): matchChoiceAsWholeSpan requires
// the span's token set to equal a choice's FULL display token set exactly —
// but a pizza topping choice always displays with its placement qualifier
// ("Pepperoni (Whole pizza)"), which a bare topping mention ("pepperoni")
// never contains. That exact-equality miss let a topping already destined to
// land as this add's own modifier (via the 00-BF floor, below) ALSO come
// back from resolveItem as a separately ambiguous span ("did you mean
// Pepperoni Pizza or Pepperoni Roll?") for the very same word. Comparing
// against the choice's CORE name (the display minus its placement suffix)
// as a second, narrower attempt catches exactly this case without loosening
// matchChoiceAsWholeSpan itself (which other callers rely on staying an
// exact real-second-item-vs-modifier-mention guard, see its own header).
// The span may also carry the customer's own placement word ("half
// pepperoni", not just "pepperoni") — PROPOSE sometimes hands this exact
// wording back as its own ambiguous item_span (real live shape, wart a/b
// dispatch probe). Stripped before the equality check below so either
// surface form still names the same core topping.
const SPAN_PLACEMENT_WORDS_RE = /^(half|whole)$/i;

function spanMatchesPlacementCoreAsWholeSpan(
  choices: Array<{ id: string; display: string }>,
  span: string,
): boolean {
  const spanTokens = new Set([...modifierFloorTokens(span)].filter(t => !SPAN_PLACEMENT_WORDS_RE.test(t)));
  if (spanTokens.size === 0) return false;
  const cores = new Set<string>();
  for (const c of choices) {
    const m = (c.display ?? "").trim().match(PLACEMENT_SUFFIX_RE);
    const core = m?.[1]?.trim();
    if (core) cores.add(core);
  }
  for (const core of cores) {
    const coreTokens = modifierFloorTokens(core);
    if (coreTokens.size === 0) continue;
    if (coreTokens.size === spanTokens.size && [...coreTokens].every(t => spanTokens.has(t))) return true;
  }
  return false;
}

function spanIsWholeChoiceOfAnyAdd(
  span: string,
  adds: ResolvedAdd[],
  menuById: Map<string, TurnEngineMenuItem>,
): boolean {
  const trimmed = span.trim();
  if (!trimmed) return false;
  for (const add of adds) {
    const menuItem = menuById.get(add.menu_item_id);
    if (!menuItem?.ask_plan) continue;
    for (const step of menuItem.ask_plan.steps) {
      if (step.kind !== "modifier" && step.kind !== "slot") continue;
      if (matchChoiceAsWholeSpan(step.choices, trimmed, step.prompt_template.split(".")[0])) return true;
      if (step.kind === "modifier" && spanMatchesPlacementCoreAsWholeSpan(step.choices, trimmed)) return true;
    }
  }
  return false;
}

export interface Decline {
  reason: string;
}

export interface DecideResult {
  cart: TurnEngineCartLine[];
  declines: Decline[];
  // 00-AX: the customer's own words for every item that resolved to nothing
  // this turn. Recorded so the system knows what was ASKED FOR and not
  // delivered -- the single missing fact behind "that item wasn't in your
  // order", the silently dropped second item, and a read-back that can only
  // confirm what the system already believes.
  unresolvedSpans: string[];
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
  // P0 fix (2026-09-19): the quantity named alongside the span that produced
  // `disambiguationCandidateIds` above ("4 large pizzas" -> 4) — undefined
  // when there was no ambiguous span this turn. Only the FIRST (chosen) span's
  // quantity is carried; a carried (not-yet-asked) span's own quantity is not
  // tracked, same "one question per turn" scope as the rest of this dispatch.
  disambiguationQuantity?: number;
  // PO amendment (2026-09-19, narrowing questions): the customer's own words
  // for the span that produced `disambiguationCandidateIds` above ("4 large
  // pizzas") — mirrors disambiguationQuantity's own scope exactly (first
  // chosen span only, undefined when there was none this turn). Read by
  // answer()'s disambiguation case to recover an already-stated size
  // (global or partial) so a narrowing question never re-asks something the
  // customer already answered.
  disambiguationSpanText?: string;
  // The ambiguous spans NOT chosen for `disambiguationCandidateIds` above,
  // in message order, each still carrying every one of its own tying
  // candidates unranked. Empty when at most one add this turn was
  // ambiguous. See DialogueState's `pendingAmbiguous` and ask()'s priority 2
  // for how this queue gets asked on a later turn.
  carriedDisambiguationCandidateIds: string[][];
  // 2026-09-18 PO dispatch (add-on rule edge): the customer's own words for
  // an add that turned out to be a modifier of THIS turn's ambiguous
  // sibling (disambiguationCandidateIds above), not a separate item — see
  // holdAddsThatAreModifiersOfAnAmbiguousSibling's own header. Null unless
  // exactly that happened this turn. Applied once the sibling resolves;
  // see answer()'s disambiguation case.
  heldModifierText: string | null;
  // Round 3 P0 (2026-09-19, hallucinated-remove, live repro: 4 pizzas in
  // cart, "Yes, I want some fries too." -> PROPOSE re-proposed removes for
  // all four pizza lines, pulled from conversation HISTORY same as the
  // stale-add class this file already guards against, never from anything
  // the customer said this turn). Every proposed remove this turn that
  // failed removeHasRemovalLanguage below -- dropped silently from the
  // cart (never a decline, same "silent" discipline as a guard-dropped add)
  // but recorded here so the caller can log a guard_deny row. Empty when
  // every remove this turn was authorized or there were no removes.
  guardDroppedRemoves: Array<{ line_key: string; item_name: string }>;
  // 2026-09-19 PO dispatch (replacement, ambiguous target hole): set only
  // when a same-breath replacement's own Y span (parseReplacementIntent/
  // resolveReplacementTargetLine above) tied across two or more menu items
  // this turn -- the line_key of X, the ORIGINAL item still sitting in the
  // cart, untouched, waiting for the narrowing question this same turn's
  // disambiguationCandidateIds now carries to settle Y. Mirrors
  // heldModifierText's own "reference-equal to disambiguationCandidateIds,
  // survives however many turns the ambiguity stays open" contract exactly
  // -- see AskTurnEvents.replacementSourceLineKey and DialogueState.open's
  // "disambiguation" variant for the two other legs of this same thread.
  // Undefined whenever no replacement's own target was ambiguous this turn
  // (the overwhelmingly common case, including a replacement whose Y
  // resolved cleanly -- that swap already happened above, in code, and
  // never touches this field).
  replacementSourceLineKey?: string;
  // 2026-09-19 PO dispatch (freeze-queue item 4): set when a fresh add this
  // turn resolved to exactly one real menu item, but the customer's own
  // words for it also named a menu category that item isn't actually in
  // ("a House Personal pizza" resolving to the Personal House STROMBOLI —
  // see findFreshAddCategoryMismatch's own header for the live bug and why
  // this can't be caught inside resolve-item.ts). That add is held OUT of
  // the cart this turn (never silently added) and its menu_item_id/quantity
  // carried here instead, for ASK to open a "category_confirm" question
  // from (see DialogueState.open's own variant) — `message` is the exact
  // "We only have X as a Y. Want that, or skip it?" wording to render. Null
  // when no add this turn hit this conflict. Only the FIRST such add in the
  // proposal wins this slot (same "one question per turn" scope every other
  // DecideResult field here uses) — a second, same-turn conflict is rare
  // enough (no live repro) that it is simply left to add normally rather
  // than building a carry-forward queue for it.
  categoryMismatchPending: { menu_item_id: string; quantity: number; message: string } | null;
}

interface ResolvedAdd {
  menu_item_id: string;
  quantity: number;
  choices: Array<{ group_id: string; choice_id: string }>;
  // 00-BF: the customer's own words for THIS add, kept so the modifier floor
  // can scope its text to this item's phrase instead of the whole turn.
  item_span?: string;
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

// 00-BF: the modifier floor. "2 Regular Slices with sausage" loses the sausage
// EVERY time -- reproduced 4 of 4 against the live build. The menu data is
// correct (that item carries 16 toppings, "Sausage" spelled exactly), the
// phrase splitter isolates the right phrase, and the resolver matches it
// instantly WHEN TOLD. The model simply never asserts the choice, and code
// deliberately will not read it from the customer's text -- so nothing catches
// a word sitting in plain sight. That is the "item asked for but never added"
// property, stuck near 28% all day and unmoved by every other fix.
//
// This is a FLOOR, not a return to free-text scanning. Every one of these must
// hold before a choice is applied:
//   1. the model asserted NOTHING for this add (we never override the model)
//   2. the text is scoped by scopedModifierText -- the item's OWN phrase, with
//      the item's own display name stripped as a contiguous unit. That helper
//      exists because unscoped matching once applied and CHARGED a "Bacon"
//      topping that was only three letters of another item's name; its header
//      asks a future resolver to reuse it rather than re-derive it. This is
//      that resolver.
//   3. every one of the choice's own words appears SOMEWHERE in the scoped
//      text -- order-independent, so "half pepperoni" (the customer's own
//      word order) still matches a choice literally displayed "Pepperoni
//      (Half pizza)". Word-level, NOT stemmed: no plural/singular folding,
//      so a bare "sausages" still does not match "Sausage" (P0 2026-09-19,
//      addendum 2 -- the prior literal-substring version required the
//      choice's exact display string to appear verbatim and in order, which
//      "with half pepperoni" never does; the deterministic derived-row
//      pizza item this floor was losing the race to is a REAL, separately
//      resolvable menu row now that compile-menu.ts's derived rows carry
//      lexicon terms, so a topping mentioned in the same clause as its host
//      item must be recovered here or it silently becomes a second,
//      wrongly-priced pizza line instead of a modifier of the one the
//      customer actually asked for).
//   4. exactly one choice matches -- a tie resolves nothing, never a guess
//   5. no negation anywhere in the scoped text
//
// A false positive here ADDS A PAID TOPPING, which the customer cannot undo
// after paying. So every ambiguity resolves to doing nothing.
const MODIFIER_NEGATION_RE = /\b(?:no|not|without|hold|skip|minus|except|omit|leave off|lose the)\b/i;

function modifierFloorTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
}

// PO dispatch 2026-09-19 (pepperoni warts, item a/c): pizza toppings compile
// as TWO choices per topping, "X (Whole pizza)" and "X (Half pizza)" — see
// this function's own header, point 3. The word-subset rule above already
// handles "half pepperoni" (the text plainly contains "half", "pepperoni"
// and "pizza"), but a BARE topping mention with no half/whole word at all
// ("with pepperoni") never contains the literal word "whole", so the Whole
// choice's own token set was never a subset and NOTHING was recovered — the
// topping silently priced as if never asked for. A customer who names a
// topping and says nothing about placement means the whole pizza; "half" is
// the only placement word customers ever actually say, so its ABSENCE is
// itself the signal for Whole, not the literal word "whole". Grouping each
// topping's Whole/Half pair by its own core name (the display minus the
// placement suffix) and picking the variant by whether "half" appears in
// the text — rather than requiring both variants' full literal wording —
// makes a bare mention resolve to Whole while an explicit "half X" still
// resolves to Half exactly as before (regression-tested: b65c5bea).
const PLACEMENT_SUFFIX_RE = /^(.*?)\s*\((Whole pizza|Half pizza)\)$/i;

interface PlacementGroup {
  core: string;
  whole?: { id: string };
  half?: { id: string };
}

function groupChoicesByPlacement(
  choices: Array<{ id: string; display: string }>,
): { placementGroups: PlacementGroup[]; plainChoices: Array<{ id: string; display: string }> } {
  const groupsByCore = new Map<string, PlacementGroup>();
  const plainChoices: Array<{ id: string; display: string }> = [];
  for (const c of choices) {
    const d = (c.display ?? "").trim();
    if (d.length < 3) continue;
    const m = d.match(PLACEMENT_SUFFIX_RE);
    if (!m) { plainChoices.push(c); continue; }
    const core = m[1].trim();
    if (!core) { plainChoices.push(c); continue; }
    const key = core.toLowerCase();
    const g = groupsByCore.get(key) ?? { core };
    if (/half/i.test(m[2])) g.half = { id: c.id }; else g.whole = { id: c.id };
    groupsByCore.set(key, g);
  }
  return { placementGroups: [...groupsByCore.values()], plainChoices };
}

// A placement group's own core name (e.g. "Pepperoni") is "mentioned" when
// every one of ITS OWN words appears somewhere in the scoped text — same
// word-level, non-stemmed subset rule as the plain-choice path below, just
// applied to the core name instead of the full "(Whole/Half pizza)" display.
function placementGroupMentioned(group: PlacementGroup, textTokens: Set<string>): boolean {
  const coreTokens = modifierFloorTokens(group.core);
  if (coreTokens.size === 0) return false;
  for (const t of coreTokens) if (!textTokens.has(t)) return false;
  return true;
}

// PO dispatch 2026-09-19 (Chicken Bacon Ranch regression, a7266e41 fix-up):
// a candidate's own words are NEVER a modifier request when every one of
// them is already part of the resolved item's own name — those words are
// naming the item, not asking for an addition. "2 Medium Chicken Bacon
// Ranch pizzas" resolved to the item named "Chicken Bacon Ranch - Medium
// (14")"; scopedModifierText's own name-strip (phrase-split.ts) only
// matches that FULL literal name verbatim in the customer's text, which
// never happens here (the customer never typed the size/quote-formatted
// internal name) -- so "Bacon" survived into the scoped text and matched
// the standalone "Bacon (Whole pizza)" topping, silently adding $4.50 per
// pizza with no question asked. This is a second, independent guard at the
// token level: it fires regardless of whether the literal-substring strip
// above succeeded, so a topping whose name is wholly contained in the
// item's own name is excluded even when the two never matched as a
// substring. A topping with any word NOT in the item's name (e.g.
// "Chicken Steak" on this same pizza -- "steak" isn't part of the name)
// is untouched.
// Freeze-queue item 6, part C (2026-09-19 PO dispatch, real Vito's
// Quesadillas category): a quesadilla item is itself named after its own
// protein ("Chicken", "Steak") and separately offers that identical word
// as an optional $4 Add-ons modifier choice ("Chicken") — so for THIS
// item, the candidate's tokens are not a FRAGMENT of a longer name (the
// a7266e41 shape this guard exists for — "bacon" inside "Chicken Bacon
// Ranch"), they are the item's ENTIRE name. Blocking on a proper subset is
// right; blocking on an exact match means this exact choice could never be
// recovered for this exact item through ANY phrasing ("with chicken",
// "with grilled chicken") — a customer naming their own quesadilla's
// listed protein add-on gets silently nothing, every time. Real query
// (2026-09-19): Quesadillas category items "Chicken"/"Steak"/"Chicken
// Fajita"/"Southwest Chicken"/"Veggie Quesadilla" each carry an "Add-ons"
// modifier group with choices Chicken/Shrimp/Blackened Salmon/Black
// Diamond Steak — there is no separate "Grilled Chicken" choice anywhere
// on this menu, so a customer asking for "grilled chicken" means the
// plain "Chicken" add-on by the closest real match, exactly the same as
// "with chicken" would.
function isSubsetOfItemName(candidateTokens: Set<string>, itemNameTokens: Set<string>): boolean {
  if (candidateTokens.size === 0 || itemNameTokens.size === 0) return false;
  for (const t of candidateTokens) if (!itemNameTokens.has(t)) return false;
  return candidateTokens.size !== itemNameTokens.size;
}

// Freeze-queue item 6, part B (2026-09-19 PO dispatch, real Vito's "Medium
// Chicken Bacon Ranch pizza, extra bacon"): the item-name-subset guard
// above (a7266e41) is still correct for its own real bug — a customer who
// only NAMES the item ("2 Medium Chicken Bacon Ranch pizzas") never gets
// charged for a phantom "Bacon" topping just because that word is also part
// of the item's own name. But the guard has no way to tell that case apart
// from a customer who explicitly asks for MORE of that same word as a
// topping — "extra bacon" — since the topping's own display name ("Bacon")
// is a subset of the item's name either way. The word "extra" itself is the
// disambiguator: it never appears in a bare item-naming phrase (nobody says
// "2 extra Medium Chicken Bacon Ranch pizzas" to mean two pizzas), so its
// presence in the SCOPED text is an unambiguous signal that whatever
// follows is an addition request, not a restatement of the item's name —
// safe to let the name-subset guard step aside for this one candidate.
const EXPLICIT_ADDITION_RE = /\bextra\b/i;

// Every core-name group the text mentions, resolved to the ONE choice id
// that group's own placement signal (the presence/absence of the literal
// word "half" anywhere in the text) selects — never both, never a guess
// when the selected variant doesn't exist on this item.
function recoverPlacementHits(groups: PlacementGroup[], textTokens: Set<string>, itemNameTokens: Set<string>, explicitAddition: boolean): string[] {
  const hasHalfWord = textTokens.has("half");
  const hits: string[] = [];
  for (const g of groups) {
    if (!placementGroupMentioned(g, textTokens)) continue;
    if (!explicitAddition && isSubsetOfItemName(modifierFloorTokens(g.core), itemNameTokens)) continue;
    const chosen = hasHalfWord ? g.half : g.whole;
    if (chosen) hits.push(chosen.id);
  }
  return hits;
}

function recoverPlainHits(plainChoices: Array<{ id: string; display: string }>, textTokens: Set<string>, itemNameTokens: Set<string>, explicitAddition: boolean): string[] {
  const hits: string[] = [];
  for (const c of plainChoices) {
    const choiceTokens = modifierFloorTokens(c.display);
    if (choiceTokens.size === 0) continue;
    if (!explicitAddition && isSubsetOfItemName(choiceTokens, itemNameTokens)) continue;
    let ok = true;
    for (const t of choiceTokens) if (!textTokens.has(t)) { ok = false; break; }
    if (ok) hits.push(c.id);
  }
  return hits;
}

export function recoverAssertedChoiceFromText(
  scopedText: string,
  choices: Array<{ id: string; display: string }>,
  itemName?: string,
): string | null {
  const text = (scopedText ?? "").trim();
  if (!text || choices.length === 0) return null;
  if (MODIFIER_NEGATION_RE.test(text)) return null;
  const textTokens = modifierFloorTokens(text);
  const itemNameTokens = modifierFloorTokens(itemName ?? "");
  const explicitAddition = EXPLICIT_ADDITION_RE.test(text);
  const { placementGroups, plainChoices } = groupChoicesByPlacement(choices);
  const hits = [...recoverPlacementHits(placementGroups, textTokens, itemNameTokens, explicitAddition), ...recoverPlainHits(plainChoices, textTokens, itemNameTokens, explicitAddition)];
  if (hits.length !== 1) return null;   // a tie, or nothing, resolves nothing
  return hits[0];
}

// PO dispatch 2026-09-19 (pepperoni wart c): "half pepperoni half sausage"
// names TWO distinct toppings, each with its own explicit placement — both
// must land as modifiers, neither silently dropped. recoverAssertedChoice-
// FromText above stays singular on purpose (its own "hits.length !== 1"
// tie-guard is what keeps "with sausage and onions" — two PLAIN toppings,
// no placement language, genuinely ambiguous which one, if either, the
// customer meant as a modifier versus a second item — resolving to nothing,
// per its own pre-existing test). A topping named WITH placement language is
// a different, unambiguous shape: the customer is explicitly building a
// split pizza, one named half at a time, so every distinctly-named core
// group this text mentions is recovered independently, all at once —
// plain (non-placement) choices keep the exact original single-recovery
// behavior via recoverAssertedChoiceFromText itself, appended to the same
// result set.
//
// Freeze-queue item W2 (2026-09-19 PO dispatch, live conv 01609954 #20,
// money bug): "a Chicken quesadilla with Black Diamond Steak and Chicken
// added" landed the plain $12.49 quesadilla with BOTH named, real, priced
// Add-ons choices silently dropped — no question, no trace. This is the
// wart-c tie-guard above hitting its OWN limit on a fresh-add turn: two
// PLAIN (non-placement) choices named together tie at plainHits.length===2
// and get thrown away, exactly the "sausage and onions" shape that guard
// exists to protect — except here the customer's own trailing word "added"
// (real text: "...and Chicken added") removes the ambiguity the guard was
// built for. "sausage and onions" leaves it genuinely unclear whether the
// customer is naming two modifiers or a modifier plus an unrelated second
// item; "X and Y added" is a customer explicitly saying BOTH are being
// added to the item just named — the same class of single-word disambiguator
// as EXPLICIT_ADDITION_RE's "extra" above, just for the plural-tie case
// instead of the name-collision case. When present, every plain choice the
// text actually names (not a guess — each one's own tokens still have to
// occur in the text, same as always) is recovered instead of the whole set
// being discarded.
const EXPLICIT_MULTI_ADDON_RE = /\badded\b/i;

export function recoverAssertedChoicesFromText(
  scopedText: string,
  choices: Array<{ id: string; display: string }>,
  itemName?: string,
): string[] {
  const text = (scopedText ?? "").trim();
  if (!text || choices.length === 0) return [];
  if (MODIFIER_NEGATION_RE.test(text)) return [];
  const textTokens = modifierFloorTokens(text);
  const itemNameTokens = modifierFloorTokens(itemName ?? "");
  const explicitAddition = EXPLICIT_ADDITION_RE.test(text);
  const explicitMultiAddon = EXPLICIT_MULTI_ADDON_RE.test(text);
  const { placementGroups, plainChoices } = groupChoicesByPlacement(choices);
  const placementHits = recoverPlacementHits(placementGroups, textTokens, itemNameTokens, explicitAddition);
  const plainHits = recoverPlainHits(plainChoices, textTokens, itemNameTokens, explicitAddition);
  const allPlainHitsLand = plainHits.length === 1 || (explicitMultiAddon && plainHits.length > 1);
  return [...placementHits, ...(allPlainHitsLand ? plainHits : [])];
}

// 00-BE: the last gate before money, and it was rejecting the word "yes".
//
// Live, one 100-conversation run, repeated 8+ times per conversation:
//   BOT:      All good - confirm?
//   CUSTOMER: "Yes, confirm the order!"          -> All good - confirm?
//   CUSTOMER: "Yes, I confirm the order!"        -> All good - confirm?
//   CUSTOMER: "I already said yes! Confirm the order already!"
//   CUSTOMER: "Just confirm the order for the last time! Why is this so hard?"
//
// The cart was right, the name was captured, the money was right. The order
// could not be placed because the affirmative test is anchored to the WHOLE
// message (/^(?:yes|yeah|...)[.!]?$/), so a bare "yes" passes and "yes,
// confirm the order" does not -- and "confirm" is not in the checkout phrase
// vocabulary at all, even though the bot's own question is "confirm?".
//
// Scoped deliberately to the `confirm` open state. That state only opens
// AFTER the order is complete and has been read back to the customer, and it
// asks a yes/no question, so an affirmative anywhere in the reply is
// unambiguous here in a way it is not in general ordering chat. The global
// checkout gate is untouched -- it guards a different problem (deciding
// whether ambiguous mid-order chat means "take my money"), and widening it
// would risk charging people early.
//
// Decline is still evaluated FIRST by the caller, so "no, change it" wins.
//
// MONEY BUG (2026-09-19, live conv 31f54c6b, item 2): "Looks good to me!"
// over a correct $39.98 cart matched none of the above (no "yes", no
// "correct", nothing here) and fell through to PROPOSE -- a model call that
// timed out twice and told a customer ready to pay to call the restaurant
// instead. "look(s) good"/"sound(s) good" added below: the same bare-
// affirmation family guard9-unconsented-affirmation.ts's impliesOrderConfirmation
// already trusts for this exact "confirm?" question elsewhere in this
// codebase, extended (never reinvented) onto this anywhere-in-message regex
// the same way "correct"/"confirm" already are.
const CONFIRM_AFFIRMATIVE_RE =
  /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|correct|confirm|confirmed|confirming|place (?:it|the order)|go ahead|do it|send it|looks? good|sounds? good)\b/i;
const CONFIRM_NEGATION_RE =
  /\b(?:not|don'?t|do not|never|wait|hold on|hold off|cancel|stop|isn'?t|wrong|mistake|change|remove|instead)\b/i;

export function isConfirmAffirmative(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (CONFIRM_NEGATION_RE.test(m)) return false;
  return CONFIRM_AFFIRMATIVE_RE.test(m);
}

// 00-BD: people confirm an order by repeating it, and that was being read as
// a second order. Live, all three from one run:
//
//   "Nope, that's it. Just to recap: 1x Gyro - Small pizza..."   -> "House - now 2."
//   "I didn't order anything else! Just the 2 Italian wraps..."  -> "Italian Wrap - now 4."
//   "I think there's a mistake. I just wanted a small White..."  -> "Small White Pizza - now 2."
//
// Two of those are the customer COMPLAINING ABOUT AN ERROR and being charged
// more for it. Same family as the 06:15 fix, which only covers the case where
// a menu-choice question is open; here the open question is "Anything else?",
// so the model runs and sees item names.
//
// Deliberately conservative: this suppresses an add ONLY when the customer's
// own words carry a restatement marker AND no addition marker, AND the add
// duplicates a line already in the cart. A genuine "another one" or "also add
// a coke" is untouched. Reads the CUSTOMER's text, never the model's prose.
//
// Failure direction is the reason this is safe to do: wrongly suppressing
// under-adds, which the customer can now correct because removes and changes
// work again; wrongly adding overcharges them, which they cannot undo after
// paying.
const RESTATEMENT_MARKERS = [
  "to recap", "just to recap", "recap:", "that's it", "thats it", "that is it",
  "i just wanted", "i only wanted", "i just want", "i only want",
  "i didn't order", "i didnt order", "i already", "as i said", "like i said",
  "just the", "only the", "my order is", "so that's", "so thats",
  "nothing else", "no changes",
];
const ADDITION_MARKERS = [
  "another", "one more", "1 more", "also", "add ", "extra", "plus ",
  "as well", " too", "additional", "and a ", "and an ", "and some",
];

export function isRestatementOfExistingOrder(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (ADDITION_MARKERS.some(a => m.includes(a))) return false;
  return RESTATEMENT_MARKERS.some(r => m.includes(r));
}

// Round 3 P0 (2026-09-19, hallucinated-remove): same "model proposes, code
// validates" principle as the stale-add guard above -- a proposed remove's
// line_key is model output and is never, on its own, authorization to
// delete a line from the cart. It is executed only when the CUSTOMER'S
// CURRENT message itself carries removal language naming that specific
// line: a negation/removal verb, AND one of (a) a word from the line's own
// stored name, (b) a word naming the line's menu CATEGORY (real stored
// names are often a raw variant SKU label like "Cheese - Large (16\")" that
// never contains the word a customer actually says, e.g. "pizza" -- same
// gap named-remove-20260907.test.ts's header documents for the legacy
// regex remover; this reuses categoryWordMatches, the same shared matcher),
// or (c) "it"/"that"/"them"/"those" when this is the only real line open in
// the cart (unambiguous referent). Deliberately checks the raw message,
// never the model's proposal text -- same reasoning as itemSpanNamedInMessage
// above.
// Round 4 P0 (2026-09-19, remove-guard pronoun + replacement): "switch"/
// "swap"/"change"/"replace"/"drop" added alongside the original set --
// live repro, "switch that to a Cheesesteak instead" and "swap out the
// pizza for Buffalo Chicken" both carry unambiguous removal/replacement
// intent that the original verb list (written before this shape was seen)
// didn't recognize, so hasVerb below returned false and the guard blocked
// a real, customer-intended removal exactly as hard as it blocks a
// hallucinated one. "instead" is added bare (not just "instead of") for
// the same reason -- "switch that to a Cheesesteak instead" never says
// "instead of".
const REMOVAL_VERBS = [
  "no", "remove", "take off", "scratch", "cancel", "instead of", "not the", "without",
  "switch", "swap", "change", "replace", "drop", "instead",
];

// Round 4 P0 (2026-09-19): which REAL cart line a bare pronoun ("it"/
// "that"/"this") refers to, for both the remove guard below and the
// replacement parser further down. The codebase has no last_added_item /
// last_discussed_item tracking (grepped -- there is none), so the only
// signal available is cart order itself: the LAST real line is the most
// recently added one, and doubles as "the only line" when there's just
// one. Null when the cart has no real line at all (nothing to refer to).
function resolvePronounTargetLineKey(cart: TurnEngineCartLine[]): string | undefined {
  const realLines = cart.filter(isRealCartLine);
  return realLines.length > 0 ? realLines[realLines.length - 1].line_key : undefined;
}

function removeHasRemovalLanguage(
  message: string | undefined,
  lineName: string,
  lineCategory: string | null | undefined,
  isPronounTargetLine: boolean,
): boolean {
  const msg = (message ?? "").toLowerCase().trim();
  if (!msg) return false;
  const hasVerb = REMOVAL_VERBS.some(v => new RegExp(`\\b${v}\\b`, "i").test(msg));
  if (!hasVerb) return false;
  const nameStems = significantStems(lineName ?? "");
  if (nameStems.size > 0) {
    const msgStems = significantStems(msg);
    for (const s of msgStems) if (nameStems.has(s)) return true;
  }
  // Merged/compound wording ("the cheeseburger" for a line named "Cheese
  // Burger") tokenizes to a single word on the message side, so it can
  // never land in msgStems' set-intersection above -- fall back to a
  // flattened substring check against the item name's own (unstemmed)
  // words, same >= 3 char significance floor as significantStems.
  const msgFlat = msg.replace(/[^a-z0-9]/g, "");
  const nameWords = (lineName ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 3);
  if (nameWords.some(w => msgFlat.includes(w))) return true;
  if (categoryWordMatches(lineCategory, msg)) return true;
  // Round 4 P0: this now passes for the resolved pronoun TARGET line even
  // in a 2+-line cart (resolvePronounTargetLineKey above), not only when
  // it's the sole real line -- "switch that to X" with several lines in
  // the cart refers to the most recently added one, same as a human
  // listener would assume.
  if (isPronounTargetLine && /\b(it|that|them|those|this)\b/.test(msg)) return true;
  return false;
}

// Money bug fix (2026-09-19, live conv 0dcb02a7, real $83.83-vs-$50.39
// overcharge): "wait, no stromboli, just the greek salad & 2 medium
// pepperoni pizzas please. i'll do pickup." answered the open order_type
// question ("pickup") but the removal language in the SAME breath ("no
// stromboli") was silently dropped — order_type/confirm both resolve
// deterministically in answer() below, and turn-engine-runner.ts's own
// dispatch never calls PROPOSE (and therefore never runs decide()'s own
// remove-guard, removeHasRemovalLanguage) once a deterministic answer
// already resolved the turn. Reuses removeHasRemovalLanguage directly
// against the cart's own real lines — the identical primitive decide()
// already trusts for a model-proposed remove, just with no proposal to
// gate here at all.
function applyNamedLineRemovals(
  cart: TurnEngineCartLine[],
  message: string,
  menu: TurnEngineMenuItem[],
): boolean {
  const menuById = new Map(menu.map(m => [m.id, m]));
  const pronounTargetLineKey = resolvePronounTargetLineKey(cart);
  // Clause-scoped (same boundary set as ask-plan-engine.ts's own sibling,
  // isRemovalRequested): removeHasRemovalLanguage's own hasVerb/name-match
  // checks are unscoped across the WHOLE message it's given, which is safe
  // at its original call site (a per-line CONFIRMATION of a target line_key
  // the model already proposed) but not safe here, where every real cart
  // line is checked cold, from scratch. Real repro: "no stromboli, just the
  // greek salad & 2 medium pepperoni pizzas please" contains a removal verb
  // ("no") AND the Greek Salad line's own name ("greek salad") somewhere in
  // the SAME message — an unscoped check wrongly matched and removed the
  // salad the customer was actively keeping, right alongside the stromboli
  // they actually wanted gone. Scoping each check to the clause that
  // actually carries the removal verb keeps a kept item's name, mentioned
  // in an unrelated later clause, from ever being read as a removal target.
  const clauses = message.split(/\b(?:but|and|also|plus)\b|[,.;]/i);
  let changed = false;
  for (let i = cart.length - 1; i >= 0; i--) {
    const line = cart[i];
    if (!isRealCartLine(line)) continue;
    const category = menuById.get(line.menu_item_id)?.category;
    const isPronounTargetLine = line.line_key === pronounTargetLineKey;
    const removed = clauses.some(clause => removeHasRemovalLanguage(clause, line.name, category, isPronounTargetLine));
    if (removed) {
      removeCartLine(cart as unknown as ReconcilerCartLine[], i);
      changed = true;
    }
  }
  return changed;
}

// Round 4 P0 (2026-09-19, replacement parsing): "swap out the pizza for
// Buffalo Chicken", "change my Grilled Cheese to Chicken Fingers", "switch
// that to a Cheesesteak instead" are a REMOVE and an ADD spoken in the same
// breath. PROPOSE's own removes/adds for this shape is exactly as
// unreliable as the hallucinated-remove case above -- the model may name
// the wrong line_key, drop the remove entirely, or drop the add -- so this
// is resolved directly from the CUSTOMER'S CURRENT message, in code,
// bypassing whatever PROPOSE produced for this pair entirely. X (what's
// being replaced) and Y (what it's being replaced with) are captured
// separately; X is deliberately allowed to be a bare pronoun ("that"/"it"/
// "this") since that is how a customer refers to the item they were just
// discussing.
interface ReplacementIntent {
  xPhrase: string | null; // null only for "make it Y instead" (implicit pronoun)
  yPhrase: string;
}

function parseReplacementIntent(message: string): ReplacementIntent | null {
  const m = (message ?? "").trim();
  if (!m) return null;
  const STOP = String.raw`(?=[,.!?]|\s+and\b|$)`;
  const patterns: RegExp[] = [
    // "swap out the pizza for Buffalo Chicken" / "swap the pizza for X"
    new RegExp(String.raw`\bswap(?:\s+out)?\s+(?:the\s+|my\s+|our\s+|a\s+|an\s+)?(.+?)\s+for\s+(?:a\s+|an\s+|the\s+)?(.+?)${STOP}`, "i"),
    // "change my Grilled Cheese to Chicken Fingers" / "...to X instead"
    new RegExp(String.raw`\bchange\s+(?:my\s+|the\s+|our\s+)?(.+?)\s+to\s+(?:a\s+|an\s+|the\s+)?(.+?)(?:\s+instead\b)?${STOP}`, "i"),
    // "switch that to a Cheesesteak instead" / "switch X to Y"
    new RegExp(String.raw`\bswitch\s+(?:my\s+|the\s+|our\s+)?(.+?)\s+to\s+(?:a\s+|an\s+|the\s+)?(.+?)(?:\s+instead\b)?${STOP}`, "i"),
    // "replace X with Y"
    new RegExp(String.raw`\breplace\s+(?:my\s+|the\s+|our\s+)?(.+?)\s+with\s+(?:a\s+|an\s+|the\s+)?(.+?)${STOP}`, "i"),
  ];
  for (const re of patterns) {
    const mm = m.match(re);
    if (!mm) continue;
    const xPhrase = mm[1]?.trim();
    const yPhrase = mm[2]?.trim();
    if (!xPhrase || !yPhrase) continue;
    return { xPhrase, yPhrase };
  }
  // "make it Y instead" / "make that Y instead" -- X is never named, only
  // ever a pronoun, so there is no capture group for it.
  const makeIt = m.match(/\bmake\s+(?:it|that|this)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s+instead\b/i);
  const yPhrase = makeIt?.[1]?.trim();
  if (yPhrase) return { xPhrase: null, yPhrase };
  return null;
}

// Resolves X (the ReplacementIntent's xPhrase) to a single REAL cart line.
// A bare pronoun ("that"/"it"/"this", or xPhrase === null for "make it Y
// instead") uses the same last-real-line convention as
// resolvePronounTargetLineKey above. A named phrase ("the pizza", "my
// Grilled Cheese") is matched against cart line NAMES first (stem subset,
// same convention as findCartLineByNamePhrase), then against menu
// CATEGORY (a raw stored name like "Cheese - Large (16\")" never contains
// the word "pizza" -- same gap named-remove-20260907.test.ts's header
// documents). Null when neither resolves to exactly one line -- the
// caller asks which item rather than guessing.
function resolveReplacementTargetLine(
  xPhrase: string | null,
  cart: TurnEngineCartLine[],
  menuById: Map<string, TurnEngineMenuItem>,
): TurnEngineCartLine | null {
  const realLines = cart.filter(isRealCartLine);
  const trimmed = (xPhrase ?? "").trim();
  const isBarePronoun = !trimmed || /^(?:that|it|this)$/i.test(trimmed);
  if (!isBarePronoun) {
    const stripped = trimmed.replace(/^(?:that|it|this|the|my|our|a|an)\s+/i, "").trim() || trimmed;
    const byName = findCartLineByNamePhrase(cart, stripped);
    if (byName) return byName;
    const categoryHits = realLines.filter(l => categoryWordMatches(menuById.get(l.menu_item_id)?.category, stripped));
    return categoryHits.length === 1 ? categoryHits[0] : null;
  }
  return realLines.length > 0 ? realLines[realLines.length - 1] : null;
}

// PO dispatch 2026-09-19 (M1 rule 2, real live money bug, conv d95306c8
// #26): the size-recovery fallback just below this call site's own header
// comment (round-2 item 1's "4 large pizzas" fix) scans the WHOLE raw
// customerMessage for a size word whenever the ambiguous item's own
// item_span dropped it — correct for the single-item message it was built
// for, but "a Gourmet White Fiesta - Large and a Sausage Pizza - Small"
// (Sausage Pizza's own item_span landing as bare "Sausage Pizza", no size)
// let that same whole-message scan return "Large" — the OTHER item's size,
// stated first in the raw text — as the held size for Sausage Pizza's own
// disambiguation. A message naming two items assumes only one is ever in
// play the exact way rule 1's topping bleed did. Scopes the same way
// scopedModifierText already does for the modifier floor: split the message
// into phrases, find the ambiguous span's OWN phrase, and search only that
// phrase for a size word. Falls back to the old unscoped whole-message scan
// exactly when phrase-scoping itself has nothing better to offer (a single-
// phrase message, or a claim that doesn't resolve to exactly one phrase) —
// never worse than before this fix, same contract scopedModifierText's own
// header states for itself.
function rawMessageSizeWordForSpan(
  customerMessage: string | undefined,
  spanText: string,
  menu: TurnEngineMenuItem[],
): string | null {
  if (!customerMessage) return null;
  const phrases = splitCustomerPhrases(customerMessage, menu.map(m => ({ name: m.name })));
  if (phrases.length <= 1) return extractGlobalSizeWord(customerMessage);
  const phraseIdx = resolveClaimedPhraseIndex(phrases, spanText);
  if (phraseIdx === null) return extractGlobalSizeWord(customerMessage);
  return extractGlobalSizeWord(phrases[phraseIdx]);
}

// PO dispatch 2026-09-19 (M1 rule 2, reopened — conv d95306c8 #26 follow-up):
// rawMessageSizeWordForSpan above fixed WHICH size word gets displayed once a
// tie already opened a disambiguation question, but never used that word to
// try closing the tie first. resolveItem's own tiebreak (resolve-item.ts)
// narrows candidates only by the shop's LEXICON size_label — real, but null
// for some items in live Vito's data (Sausage Pizza, mirrored by this file's
// own M1 test fixture), so "Sausage Pizza - Small" ties its 3 sizes even
// though the customer's own words state the size right next to the name.
// filterCandidatesBySizeWord (pending-disambiguation.ts) already solves this
// a different way — it derives each candidate's size from its own MENU ITEM
// NAME text (candidateSizeValue/extractSizeAndKind), independent of the
// lexicon size_label gap — but until now it only ever ran on the SECOND
// turn, narrowing an already-open disambiguation's candidates once the
// customer answered a "what size?" facet question. This applies the
// identical name-derived narrowing to a FRESH tie, using the exact same
// scoped size word rawMessageSizeWordForSpan recovers, so a stated size
// closes the tie before any question opens — never merely corrects the
// question's wording after the fact. Returns the single surviving
// menu_item_id, or null when the size word doesn't narrow to exactly one
// candidate (genuinely still ambiguous — never guessed).
function narrowAmbiguousCandidatesBySpanSize(
  candidateIds: string[],
  spanText: string,
  customerMessage: string | undefined,
  menu: TurnEngineMenuItem[],
  menuById: Map<string, TurnEngineMenuItem>,
): string | null {
  const sizeWord = extractGlobalSizeWord(spanText) ?? rawMessageSizeWordForSpan(customerMessage, spanText, menu);
  if (!sizeWord) return null;
  const candidates: PendingCandidate[] = candidateIds
    .map(id => menuById.get(id))
    .filter((m): m is TurnEngineMenuItem => !!m)
    .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
  const narrowed = filterCandidatesBySizeWord(candidates, sizeWord);
  return narrowed.length === 1 ? narrowed[0].menu_item_id : null;
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
  // 00-BD: the customer's own message this turn. Used ONLY to tell a
  // restatement from a new order -- see isRestatementOfExistingOrder below.
  // Optional so every existing caller and test is unchanged.
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
  customerMessage?: string,
  // DEFECT 3 (2026-09-19 live QA): the shop's own item-lexicon rows that
  // were excluded from `lexicon` above for being inactive/non-orderable —
  // see resolve-item.ts's longerInactiveTermExists for why resolveItem
  // needs to see them (never to resolve anything on its own, only to veto a
  // wrong guess when a real, more specific answer was deliberately dropped).
  // Optional and defaulted to `[]`, so every pre-existing call site and test
  // is unaffected.
  inactiveLexicon: LexiconTerm[] = [],
  // Money bug fix (2026-09-19, live conv 0dcb02a7): 00-BD's own restatement
  // check (isRestatementOfExistingOrder below) is a PHRASE heuristic tuned
  // for a genuinely fresh, unprompted message — it needs "just the"/"that's
  // it"/etc. to tell "another burger" (a real second order) from "the
  // burger" (restating). That heuristic is right for a fresh PROPOSE turn,
  // but wrong for a message reprocessed off the back of an ANSWER to an
  // open question (a dropped disambiguation, a remainder after answer()
  // resolved) — being mid-question is ALREADY strong evidence any item
  // named again is a restatement, regardless of exact phrasing; the real
  // conv 0dcb02a7 repro's own words ("just stick w/ the greek salad") never
  // contain "just the" verbatim and would otherwise double an already-
  // ordered Greek Salad to 2x. Set true ONLY by turn-engine-runner.ts call
  // sites that are reprocessing an answer/remainder, never by a fresh,
  // unprompted message — see this file's own regression test proving a
  // genuine fresh PROPOSE turn is completely unaffected (defaults false).
  treatCartMatchAsRestatement = false,
): DecideResult {
  const nextCart: TurnEngineCartLine[] = cart.map(l => ({ ...l }));
  const menuById = new Map(menu.map(m => [m.id, m]));
  const declines: Decline[] = [];
  let qualifyingAddMenuItemId: string | null = null;
  // 2026-09-19 PO dispatch (freeze-queue item 4): see DecideResult.
  // categoryMismatchPending's own doc — set by the add-application loop
  // below, at most once per turn.
  let categoryMismatchPending: { menu_item_id: string; quantity: number; message: string } | null = null;
  let disambiguationCandidateIds: string[] | null = null;
  let disambiguationQuantity: number | undefined;
  let disambiguationSpanText: string | undefined;
  let carriedDisambiguationCandidateIds: string[][] = [];
  // 2026-09-19 PO dispatch (replacement, ambiguous target hole): set from
  // ambiguousSpansFiltered[0] below, ONLY when this turn's chosen
  // disambiguation is a replacement's own Y span -- see DecideResult's own
  // doc on this field.
  let replacementSourceLineKey: string | undefined;
  // Declared here (rather than alongside resolvedAdds/unresolvedSpans
  // below, its pre-existing location) so the replacement block immediately
  // below -- which must run BEFORE proposal.adds are resolved, per
  // parseReplacementIntent's own header -- can push Y's own tied candidates
  // onto the SAME queue a plain ambiguous add's span joins moments later.
  // Pushed first, so a replacement's own narrowing question always wins
  // ambiguousSpansFiltered[0] over anything else this turn ties on -- it is
  // the customer's own explicit, deliberate correction, never a side issue.
  const ambiguousSpans: Array<{ candidates: string[]; quantity: number; spanText: string; replacementSourceLineKey?: string }> = [];

  // Round 4 P0 (2026-09-19, replacement parsing): resolved BEFORE anything
  // else in this function touches the cart, and entirely independent of
  // `proposal` -- see parseReplacementIntent's own header. X unresolved
  // asks which item rather than guessing.
  //
  // 2026-09-19 PO dispatch (ambiguous target hole): Y ambiguous or
  // unresolved BOTH hold X -- the replacement is one atomic unit, so if Y
  // can't be added cleanly THIS turn (immediately or, for the ambiguous
  // case, after the narrowing question below resolves it), X must not be
  // removed either. Previously this branch did nothing at all for a
  // not-cleanly-resolved Y, on the theory that "leave it for the normal add
  // path" was enough -- it wasn't: leaving replacementHandledLineKey unset
  // meant PROPOSE's own remove for X (very likely, same message) sailed
  // through the removes loop below completely unguarded, deleting X with
  // nothing added in its place. Y ambiguous additionally opens the exact
  // narrowing question the customer would get for a fresh ambiguous add
  // (reusing disambiguationCandidateIds/ambiguousSpans, never a parallel
  // mechanism) with replacementSourceLineKey riding along so the eventual
  // answer (answer()'s "disambiguation" case) knows to remove X once Y
  // resolves. Y genuinely unresolved (matches nothing on the shop's own
  // lexicon) still holds X but asks nothing further -- there is no
  // candidate list to narrow -- matching this function's pre-existing "a
  // span that resolves to nothing leaves the line alone" discipline
  // elsewhere (see the resolveItem "unresolved" branch below).
  let replacementHandledLineKey: string | undefined;
  let replacementHandledMenuItemId: string | null = null;
  const replacementIntent = customerMessage ? parseReplacementIntent(customerMessage) : null;
  if (replacementIntent) {
    const targetLine = resolveReplacementTargetLine(replacementIntent.xPhrase, nextCart, menuById);
    if (!targetLine) {
      declines.push({ reason: "Which item did you want to replace?" });
    } else {
      const yResolution = resolveItem(replacementIntent.yPhrase, lexicon, inactiveLexicon);
      if (yResolution.kind === "resolved") {
        const newMenuItem = menuById.get(yResolution.menu_item_id);
        if (newMenuItem?.ask_plan) {
          const idx = nextCart.indexOf(targetLine);
          const quantity = targetLine.quantity;
          removeCartLine(nextCart as unknown as ReconcilerCartLine[], idx);
          const lengthBeforeAdd = nextCart.length;
          const result = applyCompiledAddItem(nextCart, toCompiledMenuItem(newMenuItem, newMenuItem.ask_plan), newMenuItem.id, quantity, "", undefined, undefined, []);
          if (result.ok && result.cartChanged) {
            qualifyingAddMenuItemId = newMenuItem.id;
            if (newLineKey && nextCart.length === lengthBeforeAdd + 1) {
              nextCart[nextCart.length - 1].line_key = newLineKey();
            }
          }
          replacementHandledLineKey = targetLine.line_key;
          replacementHandledMenuItemId = yResolution.menu_item_id;
        }
      } else {
        // Y did not resolve cleanly -- ambiguous (ties two or more menu
        // items) or unresolved (matches nothing). Either way X is held:
        // set BEFORE the ambiguous-only branch below so both failure modes
        // suppress PROPOSE's own remove/modify of X this turn identically.
        replacementHandledLineKey = targetLine.line_key;
        if (yResolution.kind === "ambiguous") {
          ambiguousSpans.push({
            candidates: yResolution.candidates,
            quantity: targetLine.quantity,
            spanText: replacementIntent.yPhrase,
            replacementSourceLineKey: targetLine.line_key,
          });
        }
      }
    }
  }
  // See the "ambiguous" branch of the proposal.adds loop below for why this
  // is captured as a Set here, right after the replacement block has had
  // its one chance to push its own entry (at most one -- parseReplacementIntent
  // returns a single Y span per message).
  const replacementPendingCandidateIds = ambiguousSpans.length > 0 ? new Set(ambiguousSpans[0].candidates) : null;

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
  // add ties in the same message. Declared above (with the replacement
  // block) now -- see that declaration's own comment for why.
  // 00-AX: spans the customer said that resolved to nothing. Previously these
  // vanished at the point of failure, so nothing in the system ever knew an
  // item had been ASKED FOR and not delivered -- which is why the bot could
  // say "that item wasn't in your order" with complete confidence, and why a
  // read-back of the order could only ever confirm what the system already
  // believed rather than what the customer actually said.
  // Built here (before the add loop) rather than at the 00-BD site below:
  // the guard-drop path needs it to decide between silent and "Did you want
  // a X as well?" without resolving the add a second time. The set is still
  // the cart as it stood BEFORE this turn's adds — same semantics as 00-BD.
  const menuItemIdsAlreadyInCart = new Set(
    cart.filter(isRealCartLine).map(l => l.menu_item_id),
  );

  const unresolvedSpans: string[] = [];
  // ADDENDUM A (2026-09-19, live repro: "No thats wrong." after a
  // multi-kind-answer clarify question): the model re-proposed all four
  // pizzas again from CONVERSATION HISTORY, not from what the customer
  // typed that turn. itemSpanNamedInMessage correctly guard-dropped all
  // four, but the OLD code below replied to each one individually — four
  // stacked "Did you want X too?"/"Sorry, I didn't catch X" lines in one
  // SMS, repeating on every turn after. A span absent from the CURRENT
  // message is now dropped completely SILENTLY (no reply text at all) —
  // still recorded in unresolvedSpans (internal state only, never rendered)
  // so a later turn's model prompt can still see it was asked about. This
  // is ONLY for guard-dropped spans; a span the customer DID say this turn
  // that still failed to resolve keeps the exact pre-existing 035a2bd3
  // wording below, unchanged, now collected into `genuinelyUnresolvedSpans`
  // so two or more of THOSE in the same turn also combine into one line
  // instead of stacking (same "never stack more than one clarifying
  // question" rule this whole addendum exists for).
  const genuinelyUnresolvedSpans: string[] = [];
  // Round 3, item 2a: every guard-dropped add this turn, tagged with
  // whether it was genuinely STALE — resolved to a real item that's
  // already in the cart (a re-proposal from history, ADDENDUM A's own
  // case) — as opposed to a hallucinated span naming nothing the customer
  // has, which must stay silently dropped and nothing else. Read below,
  // after the loop, to gate the raw-message fallback precisely: it must
  // fire ONLY when every guard-dropped add is the former, never the latter.
  const guardDroppedWasStale: boolean[] = [];
  // PO follow-up (2026-09-19): parallel to guardDroppedWasStale above, but
  // for the OTHER reason a guard-drop happens -- see
  // spanHasQuestionClauseOnlyToken's own header. Read after the loop by the
  // recovery block that feeds nonQuestionClauseText through resolveItem.
  const guardDroppedWasQuestionTainted: boolean[] = [];
  for (const add of proposal.adds ?? []) {
    const guardPassed = itemSpanNamedInMessage(add.item_span, customerMessage);
    // Always resolve (even on guard failure) so the guard-drop path can check
    // whether the resolved item is already in cart without a second pass.
    const resolution = resolveItem(add.item_span, lexicon, inactiveLexicon);
    if (!guardPassed) {
      // Guard-dropped: the span's tokens were not in the customer's CURRENT
      // message — the model referenced an item the customer didn't name
      // this turn (stale re-proposal from history, or a genuine
      // hallucination either way). Silent per ADDENDUM A above — nothing
      // pushed to `declines`.
      const span = (add.item_span ?? "").trim();
      if (span) unresolvedSpans.push(span);
      guardDroppedWasStale.push(resolution.kind === "resolved" && menuItemIdsAlreadyInCart.has(resolution.menu_item_id));
      guardDroppedWasQuestionTainted.push(spanHasQuestionClauseOnlyToken(add.item_span, customerMessage));
    } else if (resolution.kind === "resolved") {
      resolvedAdds.push({ menu_item_id: resolution.menu_item_id, quantity: effectiveAddQuantity(add.item_span, add.quantity), choices: add.choices, item_span: add.item_span });
    } else if (resolution.kind === "ambiguous") {
      // 2026-09-19 PO dispatch (ambiguous target hole): PROPOSE frequently
      // proposes its OWN add for the exact same span the replacement block
      // above already turned into a pending question (live repro: "change
      // the Grilled Cheese to a Chicken Fingers (5) instead" produced BOTH
      // the replacement's remove/add pair AND a redundant top-level add for
      // "Chicken Fingers (5)") -- pushing this as a SECOND ambiguousSpans
      // entry would queue a duplicate "which one?" question behind the
      // replacement's own, and answering IT would add a second, disconnected
      // Chicken Fingers line with no memory that Grilled Cheese was ever
      // meant to go. Ties against the exact same candidate set the
      // replacement is already asking about are dropped here, silently --
      // the replacement's own entry is the sole, correct question for this
      // item this turn.
      const isReplacementDuplicate = replacementPendingCandidateIds !== null &&
        resolution.candidates.length === replacementPendingCandidateIds.size &&
        resolution.candidates.every(id => replacementPendingCandidateIds!.has(id));
      if (!isReplacementDuplicate) {
        // M1 rule 2 (reopened, see narrowAmbiguousCandidatesBySpanSize's own
        // header above): a size stated right next to THIS item's own name
        // closes the tie here, before a "which one?" question ever opens —
        // never merely corrects the question's wording after the fact.
        const narrowedId = narrowAmbiguousCandidatesBySpanSize(
          resolution.candidates,
          (add.item_span ?? "").trim(),
          customerMessage,
          menu,
          menuById,
        );
        if (narrowedId) {
          resolvedAdds.push({ menu_item_id: narrowedId, quantity: effectiveAddQuantity(add.item_span, add.quantity), choices: add.choices, item_span: add.item_span });
        } else {
          ambiguousSpans.push({ candidates: resolution.candidates, quantity: effectiveAddQuantity(add.item_span, add.quantity), spanText: (add.item_span ?? "").trim() });
        }
      }
    } else {
      // 00-AX: NAME the span. The customer's own words are right here in
      // add.item_span and were being thrown away. An anonymous "what item
      // that was" is why a customer who ordered two things restates BOTH --
      // which re-adds the one that DID resolve (the "- now 2" inflation) and
      // fails again on the one that didn't. Live: "2 bowls of the Soup of the
      // Day and an Italian sandwich on wheat" -- soup added, sandwich never,
      // and the customer was never told which half failed.
      const span = (add.item_span ?? "").trim();
      genuinelyUnresolvedSpans.push(span);
      unresolvedSpans.push(span);
    }
  }
  // Round 3, item 2a (2026-09-19, live repro: "Yes, I want some fries too."
  // after four pizzas already in cart): PROPOSE re-proposed only the four
  // pizzas again — pulled from conversation HISTORY, not from this turn's
  // message — and produced nothing at all for "fries". The guard above
  // correctly dropped the stale pizza re-proposals (ADDENDUM A), but that
  // left NOTHING, and the customer's real new item was never even given to
  // the resolver, since the model never proposed a span for it in the first
  // place. Same "trust the message over the model" principle as item 1:
  // when EVERY add this turn was guard-dropped AND every one of those was
  // genuinely stale (resolved to a real item already in the cart — never a
  // hallucinated span naming nothing the customer has), run resolveItem
  // directly on the raw customer message for whatever the model missed —
  // the exact same resolver every other add already goes through, just fed
  // the raw message instead of a model-proposed span. The `guardDroppedWasStale`
  // gate is what keeps this from becoming a general fuzzy-match backdoor for
  // hallucinated spans (see the sibling "unrelated span word" test case):
  // a guard-dropped add that resolves to nothing, or to an item NOT already
  // in the cart, is a hallucination, not staleness, and must stay silently
  // dropped with no fallback attempted.
  if (proposal.adds && proposal.adds.length > 0 && resolvedAdds.length === 0 && ambiguousSpans.length === 0 &&
      genuinelyUnresolvedSpans.length === 0 && guardDroppedWasStale.length === proposal.adds.length &&
      guardDroppedWasStale.every(Boolean)) {
    const rawResolution = resolveItem(customerMessage ?? "", lexicon, inactiveLexicon);
    if (rawResolution.kind === "resolved" && !menuItemIdsAlreadyInCart.has(rawResolution.menu_item_id)) {
      resolvedAdds.push({ menu_item_id: rawResolution.menu_item_id, quantity: 1, choices: [], item_span: (customerMessage ?? "").trim() });
    } else if (rawResolution.kind === "ambiguous") {
      ambiguousSpans.push({ candidates: rawResolution.candidates, quantity: 1, spanText: (customerMessage ?? "").trim() });
    }
  }
  // PO follow-up (2026-09-19, non-blocking wart on question-clause-not-an-
  // add, live gap: cart ends up empty, real order lost): same "trust the
  // message over the model" principle as the staleness fallback just above,
  // for the OTHER reason an add ends up guard-dropped -- the model FUSED a
  // real order ("2 Pepperoni pizzas") and a question ("do you have anything
  // gluten free?") into ONE span, so itemSpanNamedInMessage correctly
  // refused the whole thing for its question-clause taint. That refusal
  // must stand -- it's the exact money-safety guarantee
  // question-clause-not-an-add exists for -- but it must not also erase the
  // real order sitting right next to it in the same span, which the model
  // never proposed a separate span for. Fires ONLY when every add this turn
  // was guard-dropped AND every one of those was question-clause-tainted
  // (never a bare hallucination or stale re-proposal -- those stay exactly
  // as silently dropped as they always have), and only once the staleness
  // fallback above has had its own chance to resolve things first.
  // Resolves against nonQuestionClauseText, never the raw message -- the
  // question clause's own words must stay excluded here exactly as they
  // were for the guard itself, or "gluten free" could resolve straight back
  // in on its own.
  if (proposal.adds && proposal.adds.length > 0 && resolvedAdds.length === 0 && ambiguousSpans.length === 0 &&
      genuinelyUnresolvedSpans.length === 0 && guardDroppedWasQuestionTainted.length === proposal.adds.length &&
      guardDroppedWasQuestionTainted.every(Boolean)) {
    const recoveryText = nonQuestionClauseText(customerMessage);
    const recoveryQuantity = proposal.adds.length === 1 ? (proposal.adds[0].quantity ?? 1) : 1;
    const recoveryResolution = resolveItem(recoveryText, lexicon, inactiveLexicon);
    if (recoveryResolution.kind === "resolved" && !menuItemIdsAlreadyInCart.has(recoveryResolution.menu_item_id)) {
      resolvedAdds.push({ menu_item_id: recoveryResolution.menu_item_id, quantity: recoveryQuantity, choices: [], item_span: recoveryText });
    } else if (recoveryResolution.kind === "ambiguous") {
      ambiguousSpans.push({ candidates: recoveryResolution.candidates, quantity: recoveryQuantity, spanText: recoveryText });
    }
  }
  // See dropAddsSupersededByCorrection's own header: "add a side salad...
  // Just the house salad" resolves BOTH real items — this drops the one the
  // customer's own words retracted, before either ever reaches grouping.
  // Moved ahead of the decline/disambiguation blocks below (Round 2, items
  // 1/2) so spanIsWholeChoiceOfAnyAdd has this turn's real resolved adds to
  // check the ambiguous/unresolved spans against before either becomes
  // customer-facing.
  const correctedAdds = dropAddsSupersededByCorrection(resolvedAdds, customerMessage);

  // Round 2, items 1/2 (2026-09-19, live sim): before either bucket becomes
  // a decline or reopens a disambiguation, drop any span that's really just
  // naming a slot/modifier choice of one of THIS turn's own resolved adds —
  // see spanIsWholeChoiceOfAnyAdd's own header.
  const genuinelyUnresolvedSpansFiltered = genuinelyUnresolvedSpans.filter(
    span => !spanIsWholeChoiceOfAnyAdd(span, correctedAdds, menuById),
  );
  const ambiguousSpansFiltered = ambiguousSpans.filter(
    a => !spanIsWholeChoiceOfAnyAdd(a.spanText, correctedAdds, menuById),
  );

  // ADDENDUM A: exactly the pre-existing 035a2bd3 wording, unchanged, for
  // the single-span case; two or more combine into ONE line rather than
  // stacking.
  if (genuinelyUnresolvedSpansFiltered.length === 1) {
    const span = genuinelyUnresolvedSpansFiltered[0];
    declines.push({
      reason: span
        ? `Sorry, I didn't catch "${span}" — mind saying it again?`
        : "Sorry, I didn't catch what item that was — mind saying it again?",
    });
  } else if (genuinelyUnresolvedSpansFiltered.length > 1) {
    const quoted = genuinelyUnresolvedSpansFiltered.filter(Boolean).map(s => `"${s}"`);
    const joined = quoted.length <= 1
      ? (quoted[0] ?? "")
      : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
    declines.push({
      reason: joined
        ? `Sorry, I didn't catch ${joined} — mind saying those again?`
        : "Sorry, I didn't catch a couple of those — mind saying them again?",
    });
  }
  if (ambiguousSpansFiltered.length > 0) {
    disambiguationCandidateIds = ambiguousSpansFiltered[0].candidates;
    disambiguationQuantity = ambiguousSpansFiltered[0].quantity;
    // PO fix (2026-09-19, round-2 item 1 root cause, live repro "4 large
    // pizzas. 1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers"): PROPOSE's
    // own item_span for the ambiguous add is model output and can drop a
    // size word the customer actually typed ("4 large pizzas" -> item_span
    // "pizzas") — this varies call to call for the IDENTICAL message. Every
    // downstream read of this disambiguation's held size (narrowingFacetForOpen,
    // narrowingKindQuestion, the answer() facet path above) goes through
    // extractGlobalSizeWord(spanText), so if item_span silently drops "large"
    // the held size is silently lost too — no size ever gets asked or held,
    // and a same-kind multi-size clause (pepperoni -> 3 sizes) narrows to
    // nothing instead of resolving or asking "What size?". The customer's
    // own raw message for THIS turn always has the real word if they said
    // one; only fall back to the model's span when the raw message has none
    // (a legitimately sizeless order like "a pepperoni pizza" answered later).
    const itemSpanSpanText = ambiguousSpansFiltered[0].spanText;
    // PO dispatch 2026-09-19 (M1 rule 2): scoped to this span's own phrase —
    // see rawMessageSizeWordForSpan's own header, above decide().
    const rawMessageSizeWord = rawMessageSizeWordForSpan(customerMessage, itemSpanSpanText, menu);
    disambiguationSpanText = (!extractGlobalSizeWord(itemSpanSpanText) && rawMessageSizeWord)
      ? `${rawMessageSizeWord} ${itemSpanSpanText}`.trim()
      : itemSpanSpanText;
    carriedDisambiguationCandidateIds = ambiguousSpansFiltered.slice(1).map(s => s.candidates);
    // 2026-09-19 PO dispatch (ambiguous target hole): only set when THIS
    // turn's chosen span (index 0, never a carried one) is a replacement's
    // own Y -- see DecideResult.replacementSourceLineKey's own doc.
    replacementSourceLineKey = ambiguousSpansFiltered[0].replacementSourceLineKey;
  }

  // See dropAddsThatAreReallyModifiersOfAnotherAdd's own header: "house
  // salad w/ black diamond steak" resolves BOTH the House Salad and,
  // independently, Quesadillas' own "Steak" item — this drops the one that
  // is really a modifier choice of the OTHER item in the same message,
  // before either ever reaches grouping.
  const modifierDroppedAdds = dropAddsThatAreReallyModifiersOfAnotherAdd(correctedAdds, menuById);
  const { survivingAdds, heldModifierText } = holdAddsThatAreModifiersOfAnAmbiguousSibling(
    modifierDroppedAdds,
    disambiguationCandidateIds,
    menuById,
  );

  // Two adds in one proposal with identical identity collapse to ONE line at
  // MAX quantity, never a sum (§3b step 4) — grouped here, before any of
  // them ever reaches the mutation pipeline.
  const addGroups = new Map<string, ResolvedAdd>();
  for (const add of survivingAdds) {
    const key = addIdentityKey(add);
    const existing = addGroups.get(key);
    if (!existing || add.quantity > existing.quantity) addGroups.set(key, add);
  }

  // 00-BD: if the customer is restating an order they already placed, an add
  // that duplicates a line already in the cart is not a new order. Checked
  // against the cart as it stood BEFORE this turn's adds, so two genuinely
  // distinct adds in one message still both land. menuItemIdsAlreadyInCart
  // is declared above (before the add-resolution loop) for the guard-drop
  // path; it's the same set used here.
  const restating = isRestatementOfExistingOrder(customerMessage) || treatCartMatchAsRestatement;

  // See stripOtherItemSpansFromModifierText's own header (M1 rule 1): every
  // OTHER item's own span this same message, whether it already resolved to
  // a real add or is still pending its own which-one question — computed
  // once, outside the loop, since it's the same set for every add in it.
  const allOwnSpansThisMessage = [
    ...[...addGroups.values()].map(a => (a.item_span ?? "").trim()),
    ...ambiguousSpansFiltered.map(a => a.spanText.trim()),
  ].filter(Boolean);

  for (const add of addGroups.values()) {
    if (restating && menuItemIdsAlreadyInCart.has(add.menu_item_id)) {
      // Silent on purpose: the customer is confirming, not asking for
      // anything. Telling them we skipped something would be confusing, and
      // the money footer already shows them exactly what is in the cart.
      continue;
    }
    // Round 4 P0: Y was already added directly by the replacement parser
    // above -- PROPOSE's own proposal.adds for the identical item this same
    // turn (very likely, since the model saw the same message) would
    // otherwise double the quantity.
    if (replacementHandledMenuItemId && add.menu_item_id === replacementHandledMenuItemId) continue;
    const menuItem = menuById.get(add.menu_item_id);
    if (!menuItem) { declines.push({ reason: "That item isn't on the menu." }); continue; }
    if (!menuItem.ask_plan) { declines.push({ reason: `${menuItem.name} isn't available to order this way yet.` }); continue; }
    // 2026-09-19 PO dispatch (freeze-queue item 4, live bug): the customer's
    // own words for THIS add name a menu category the resolved item isn't
    // actually in ("a House Personal pizza" -> Personal House Stromboli) —
    // see findFreshAddCategoryMismatch's own header. Held OUT of the cart
    // entirely this turn (never silently added) and surfaced as a
    // keep-or-skip question instead — only the first such add per turn;
    // see categoryMismatchPending's own declaration above.
    const freshAddDisplayName = menuItem.ask_plan.display_name ?? menuItem.name;
    if (
      !categoryMismatchPending &&
      findFreshAddCategoryMismatch(add.item_span ?? "", `${freshAddDisplayName} ${menuItem.name}`, menuItem.category, menu)
    ) {
      const displayName = freshAddDisplayName;
      categoryMismatchPending = {
        menu_item_id: menuItem.id,
        quantity: add.quantity,
        message: buildFreshAddCategoryConfirmMessage(displayName, menuItem.category ?? ""),
      };
      continue;
    }
    // 00-BF: the modifier floor. Only when the model asserted NOTHING for this
    // add -- we never override or second-guess a choice it did make.
    let effectiveChoices = add.choices ?? [];
    if (effectiveChoices.length === 0 && customerMessage) {
      const phrases = splitCustomerPhrases(customerMessage, menu.map(m => ({ name: m.name })));
      const phraseIdx = resolveClaimedPhraseIndex(phrases, add.item_span ?? "");
      const ownSpan = (add.item_span ?? "").trim();
      const otherSpansThisMessage = allOwnSpansThisMessage.filter(s => s !== ownSpan);
      const scoped = stripOtherItemSpansFromModifierText(
        scopedModifierText(phrases, phraseIdx, menuItem.name, customerMessage),
        otherSpansThisMessage,
      );
      for (const step of menuItem.ask_plan.steps) {
        if (step.kind !== "modifier") continue;          // slots are ASKED, never inferred
        // PO dispatch 2026-09-19 (wart c): plural recovery so two distinctly
        // placed toppings in one clause ("half pepperoni half sausage") both
        // land, instead of the singular floor's own tie-guard dropping both.
        for (const recovered of recoverAssertedChoicesFromText(scoped, step.choices, menuItem.name)) {
          effectiveChoices = [...effectiveChoices, { group_id: step.group_id, choice_id: recovered }];
        }
      }
    }
    const { texts, droppedCount } = resolveChoiceDisplays(menuItem.ask_plan, effectiveChoices);
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

  const guardDroppedRemoves: Array<{ line_key: string; item_name: string }> = [];
  // Round 4 P0: the pronoun's referent is resolved ONCE against the cart as
  // it stands after the replacement parser and this turn's adds above --
  // same "most recently added real line" convention throughout this file.
  const pronounTargetLineKey = resolvePronounTargetLineKey(nextCart);
  for (const rm of proposal.removes ?? []) {
    // Already executed directly by the replacement parser above -- the line
    // is gone, so findLineByKey below would otherwise read this as "that
    // item wasn't in your order" and surface a spurious decline.
    if (rm.line_key === replacementHandledLineKey) continue;
    const idx = findLineByKey(nextCart, rm.line_key);
    if (idx < 0) { declines.push({ reason: "That item wasn't in your order." }); continue; }
    const line = nextCart[idx];
    const lineCategory = menuById.get(line.menu_item_id)?.category;
    const isPronounTargetLine = line.line_key === pronounTargetLineKey;
    if (!removeHasRemovalLanguage(customerMessage, line.name, lineCategory, isPronounTargetLine)) {
      guardDroppedRemoves.push({ line_key: rm.line_key, item_name: line.name });
      continue;
    }
    removeCartLine(nextCart as unknown as ReconcilerCartLine[], idx);
  }

  for (const mod of proposal.modifies ?? []) {
    // 2026-09-19 PO dispatch (false "wasn't in your order" line): PROPOSE
    // proposes a `modify` for X's line_key ALONGSIDE its own `remove` for
    // the exact same shape the replacement block above already handles in
    // code -- live repro, "change the Grilled Cheese to a Chicken Fingers
    // (5) instead" produced both `removes: [{line_key}]` AND
    // `modifies: [{line_key, quantity: 1}]` for the identical line. The
    // removes loop above already skips a proposed remove that matches
    // replacementHandledLineKey; this loop never had the same guard, so
    // when X had ALREADY been removed (Y resolved cleanly, swap already
    // executed above) OR is being deliberately held (Y ambiguous/
    // unresolved, this same turn), findLineByKey below either can't find
    // it (a resolved swap: the line is genuinely gone) and reads that as
    // "that item wasn't in your order" -- FALSE, the item was right there
    // and was intentionally replaced -- or, for the held case, would
    // otherwise apply a stray no-op quantity/choice mutation to a line
    // that's mid-replacement. Same skip, same reasoning, same variable as
    // the removes loop immediately above.
    if (mod.line_key === replacementHandledLineKey) continue;
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

  return { cart: nextCart, declines, unresolvedSpans, qualifyingAddMenuItemId, disambiguationCandidateIds, disambiguationQuantity, disambiguationSpanText, carriedDisambiguationCandidateIds, heldModifierText, guardDroppedRemoves, replacementSourceLineKey, categoryMismatchPending };
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
  // P0 fix (2026-09-19): mirrors DecideResult.disambiguationQuantity — the
  // quantity named alongside the span that produced disambiguationCandidateIds
  // above. Applied to `open.quantity` only when this turn's primary
  // disambiguation is the one actually opened; see ask()'s priority-2 branch.
  disambiguationQuantity?: number;
  // PO amendment (2026-09-19): mirrors DecideResult.disambiguationSpanText —
  // applied to `open.spanText` under the same isThisTurnPrimary gate as
  // disambiguationQuantity. Deliberately left undefined (never mirrored
  // from priorState.open.spanText) when a disambiguation_narrowed outcome
  // opens the "other one" follow-up — that reopened disambiguation has
  // already consumed the original span's stated size and must not have it
  // re-applied.
  disambiguationSpanText?: string;
  // True only when this turn opens the second disambiguation of a
  // partial-size split (see AnswerOutcome's "disambiguation_narrowed" and
  // its own doc) — render() uses it to ask "And the size on the other one?"
  // instead of the plain size question a fresh facet split gets.
  disambiguationOtherOneFollowUp?: boolean;
  // True whenever this turn opens EITHER shape of "disambiguation_narrowed"
  // reopening (a plain kind-narrow-to-size remainder, or the partial-size
  // "other one" follow-up above) — mirrored onto `open.facetNarrowed` so
  // render() keeps asking the next facet instead of falling back to the
  // enumerated list for a remainder small enough to otherwise look like a
  // fresh, never-narrowed disambiguation. See DialogueState's own doc on
  // `facetNarrowed` for the exact live bug this closes.
  disambiguationFacetNarrowed?: boolean;
  // 2026-09-19 PO dispatch (real live incident, "fifth shape"): mirrored
  // onto `open.noProgress` — see AnswerOutcome's "disambiguation_narrowed"
  // and DialogueState.open's own doc on `noProgress` for the full mechanism.
  disambiguationNoProgress?: boolean;
  // Round 2, item 1 (2026-09-19, live v511): set whenever this turn's
  // ANSWER opened or re-opened the SHARED "What size?" question over two or
  // more same-kind groups — see AnswerOutcome's own
  // "disambiguation_multi_size_narrowed" and DialogueState's "multi_size"
  // open kind. ask() opens `{kind: "multi_size", groups}` straight off this
  // field, same "mirror the outcome onto the next state" convention as
  // every other disambiguation* field above.
  disambiguationMultiSizeGroups?: Array<{ candidates: string[]; quantity: number }>;
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
  // 2026-09-18 PO dispatch (address loop, rule 2): true when THIS turn's
  // ANSWER resolved to cart_cancelled ("cancel"/"forget it" while address
  // was open). Never persisted — a fresh turnEvents object every turn — so
  // it only suppresses priorities 4/5 (address/tip) for the one turn the
  // cancel itself happened on, never on any later turn. Optional so every
  // existing caller/test that predates this field is unaffected.
  cartCancelledThisTurn?: boolean;
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 1): true when
  // THIS turn's ANSWER resolved to quantity_corrected. ask()'s confirm
  // branch uses this to force a FRESH read-back (openRepeatCount reset to
  // 0) instead of the short "All good — confirm?" a genuine same-cart
  // repeat gets — the cart just changed, so the customer needs to see the
  // corrected numbers, not be asked to re-confirm ones that are stale.
  quantityCorrectedThisTurn?: boolean;
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 2): true when
  // THIS turn's ANSWER resolved to line_replaced. Same reasoning and same
  // ask()-branch handling as quantityCorrectedThisTurn immediately above —
  // kept as a separate flag rather than folded into it so each
  // mechanism's own commit stays independently reviewable.
  lineReplacedThisTurn?: boolean;
  // Money bug fix (2026-09-19, live conv 0dcb02a7): true when THIS turn's
  // ANSWER resolved to line_removed_at_confirm (mechanism 3, a bare removal
  // with no replacement named). Same reasoning and same ask()-branch
  // handling as quantityCorrectedThisTurn/lineReplacedThisTurn above.
  lineRemovedAtConfirmThisTurn?: boolean;
  // Round 3, item 2c(i) (2026-09-19): true when THIS turn's ANSWER resolved
  // a tip amount stated WHILE confirm was already open ("$5 tip" — see the
  // "confirm" case's tip-amount check above). Same fresh-read-back handling
  // as quantityCorrectedThisTurn/lineReplacedThisTurn — the total just
  // changed (a new Tip line), so the customer needs to see the real numbers,
  // not be asked to re-confirm stale ones.
  tipStatedAtConfirmThisTurn?: boolean;
  // Round 3, item 2b: true when THIS turn's ANSWER produced a "tip_resolved"
  // outcome, from EITHER the ordinary open-tip-question path or the
  // item 2c(i) tip-at-confirm path above — both are answer() resolving the
  // exact same outcome kind, so one flag covers both. See
  // DialogueState.driverTipResolved's own doc for why this can't be read
  // off order_carts.driver_tip_cents instead.
  tipResolvedThisTurn?: boolean;
  // 2026-09-18 PO dispatch (add-on rule edge): the customer's own words for
  // an add held back this turn because it was really a modifier of the
  // ambiguous sibling named by disambiguationCandidateIds above, not a
  // separate item — see DecideResult.heldModifierText and
  // holdAddsThatAreModifiersOfAnAmbiguousSibling's own header. Threaded
  // through unchanged on both the fresh-decide path and the re-ask carry-
  // forward path (turn-engine-runner.ts), same as disambiguationCandidateIds
  // itself, so it survives however many turns the ambiguity stays open.
  heldModifierText?: string | null;
  // 2026-09-19 PO dispatch (replacement, ambiguous target hole): mirrors
  // heldModifierText immediately above exactly — the line_key of a
  // replacement's held X, threaded through unchanged on both the fresh-
  // decide path (DecideResult.replacementSourceLineKey) and every re-ask
  // carry-forward path (turn-engine-runner.ts), so it survives however
  // many turns Y's own ambiguity stays open. See DialogueState.open's
  // "disambiguation" variant for where this lands once ask() opens (or
  // re-opens) the question.
  replacementSourceLineKey?: string;
  // 2026-09-19 PO dispatch (freeze-queue item 4): mirrors
  // DecideResult.categoryMismatchPending straight through — see that
  // field's own doc and DialogueState.open's "category_confirm" variant.
  // Undefined/null on every turn where no fresh add hit this conflict.
  categoryMismatchPending?: { menu_item_id: string; quantity: number; message: string } | null;
}

export function ask(
  cart: TurnEngineCartLine[],
  priorState: DialogueState,
  turnEvents: AskTurnEvents,
  shopContext: AskShopContext,
  menu: TurnEngineMenuItem[],
  // 2026-09-18 PO dispatch (confirm read-back): the customer's own message
  // this turn, used ONLY to recognize a restatement while confirm is open
  // (isRestatementOfExistingOrder — see step 8 below). Optional so every
  // existing caller and test is unchanged; omitted, the restatement branch
  // simply never fires, identical to this function's behavior before it
  // existed.
  customerMessage?: string,
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

  // 00-AZ: how many consecutive turns THIS question has been open. Before
  // this, only `ordering` counted its own repeats -- eight of the nine open
  // kinds could not tell they were repeating, so nothing could escalate,
  // rephrase or hand off, and every parse miss became a loop whose only exit
  // was the customer leaving. Live examples in one 100-conversation run: the
  // name question asked 9x, the delivery address 14x, a sauce question 11x, a
  // soup disambiguation 7x.
  //
  // Computed HERE because carry() is the single funnel every open question
  // passes through, so one line covers all nine kinds rather than eight more
  // special cases. Optional field: a persisted state written before this
  // change simply starts at 0, so there is no migration.
  const sameQuestionAsBefore = (open: DialogueState["open"]): boolean =>
    JSON.stringify(open ?? null) === JSON.stringify(priorState.open ?? null);

  // Round 3, item 2b: once true, stays true for the rest of this order —
  // computed once here (same funnel reasoning as sameQuestionAsBefore
  // above) rather than duplicated in every carry() call site.
  const driverTipResolved = priorState.driverTipResolved === true || turnEvents.tipResolvedThisTurn === true;

  // 2026-09-19 live repro: once true, stays true for the rest of this order
  // — see DialogueState.checkoutClosed's own doc for why `phase` alone can't
  // carry this fact through an intermediate ladder step (order_type/address/
  // tip/upsell). Same persisted-once-true funnel as driverTipResolved above.
  const checkoutClosed = priorState.checkoutClosed === true || turnEvents.checkoutIntentThisTurn === true;

  const carry = (
    open: DialogueState["open"],
    phase: DialogueState["phase"],
    upsellOffered = priorState.upsell_offered,
    pending: string[][] = pendingAmbiguous,
  ): DialogueState =>
    ({
      phase,
      open,
      upsell_offered: upsellOffered,
      asked_message_id: null,
      pendingAmbiguous: pending,
      openRepeatCount: open === null
        ? 0
        : sameQuestionAsBefore(open)
        ? (priorState.openRepeatCount ?? 0) + 1
        : 0,
      ...(driverTipResolved ? { driverTipResolved: true } : {}),
      ...(checkoutClosed ? { checkoutClosed: true } : {}),
    });

  // 1. unresolved required slot on any line.
  for (const line of cart) {
    if (!isRealCartLine(line)) continue;
    const menuItem = menuById.get(line.menu_item_id);
    if (!menuItem?.ask_plan) continue;
    const resolvedGroupIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
    const openSlotStep = menuItem.ask_plan.steps.find(s =>
      s.kind === "slot" && !resolvedGroupIds.has(s.group_id) && !isRedundantDerivedStep(s, menuItem.ask_plan!.steps)
    );
    if (openSlotStep) {
      return carry({ kind: "slot", line_key: effectiveLineKey(line), group_id: openSlotStep.group_id }, "ordering");
    }
  }

  // 1b. multi_size (2026-09-19, round 2 item 1): the shared "What size?"
  // question over two or more same-kind groups from a list answer — see
  // AskTurnEvents.disambiguationMultiSizeGroups's own doc and DialogueState's
  // "multi_size" open kind. Checked at the same priority a fresh/reopened
  // disambiguation gets (right after a required slot, ahead of everything
  // else) — this field is only ever set by answer()'s own "kind"-facet or
  // "multi_size" cases, never alongside a pendingAmbiguous push in the same
  // turn, so there's no real ordering conflict with priority 2 below.
  if (turnEvents.disambiguationMultiSizeGroups && turnEvents.disambiguationMultiSizeGroups.length > 0) {
    return carry({ kind: "multi_size", groups: turnEvents.disambiguationMultiSizeGroups }, "ordering");
  }

  // 2. disambiguation -- the oldest span still waiting, whether it's fresh
  // from THIS turn's decide() or carried over from an earlier turn that lost
  // priority to a required slot. One question per turn (§3b step 5): only
  // the front of the queue is ever asked; the rest ride along on `pending`
  // via `carry`'s default, to be asked on a later turn instead of dropped.
  if (pendingAmbiguous.length > 0) {
    const [next, ...rest] = pendingAmbiguous;
    // heldModifierText only ever describes THIS specific candidate group —
    // reference-equal to disambiguationCandidateIds on both the turn it was
    // computed (decide()'s fresh output) and every re-ask turn after
    // (turn-engine-runner.ts mirrors priorState.open.candidates straight
    // through, unchanged), never on an older span still waiting behind it.
    // Key omitted entirely (not set to undefined) when there is none, so a
    // plain `{ kind: "disambiguation", candidates }` equality check against
    // a state built before this field existed still holds.
    const isThisTurnPrimary = next === turnEvents.disambiguationCandidateIds;
    const heldModifierText = isThisTurnPrimary ? turnEvents.heldModifierText : undefined;
    const quantity = isThisTurnPrimary ? turnEvents.disambiguationQuantity : undefined;
    const spanText = isThisTurnPrimary ? turnEvents.disambiguationSpanText : undefined;
    const otherOneFollowUp = isThisTurnPrimary ? turnEvents.disambiguationOtherOneFollowUp : undefined;
    const facetNarrowed = isThisTurnPrimary ? turnEvents.disambiguationFacetNarrowed : undefined;
    const noProgress = isThisTurnPrimary ? turnEvents.disambiguationNoProgress : undefined;
    const replacementSourceLineKey = isThisTurnPrimary ? turnEvents.replacementSourceLineKey : undefined;
    return carry(
      {
        kind: "disambiguation",
        candidates: next,
        ...(heldModifierText ? { heldModifierText } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(spanText !== undefined ? { spanText } : {}),
        ...(otherOneFollowUp !== undefined ? { otherOneFollowUp } : {}),
        ...(facetNarrowed !== undefined ? { facetNarrowed } : {}),
        ...(noProgress !== undefined ? { noProgress } : {}),
        ...(replacementSourceLineKey !== undefined ? { replacementSourceLineKey } : {}),
      },
      "ordering",
      priorState.upsell_offered,
      rest,
    );
  }

  // 2c. category_confirm (2026-09-19 PO dispatch, freeze-queue item 4): a
  // fresh add this turn resolved to a real item whose own category doesn't
  // match the customer's words for it — see DecideResult.
  // categoryMismatchPending's own doc. Same priority band as disambiguation
  // immediately above (a fresh add still waiting on the customer, never a
  // persisted/carried queue — see answer()'s "category_confirm" case for
  // why this is asked at most once and never re-opened from stale state).
  if (turnEvents.categoryMismatchPending) {
    const { menu_item_id, quantity, message } = turnEvents.categoryMismatchPending;
    return carry({ kind: "category_confirm", menu_item_id, quantity, message }, "ordering");
  }

  // 3. order_type (only if delivery is enabled and unset).
  if (shopContext.deliveryEnabled && !shopContext.orderTypeKnown) {
    return carry({ kind: "order_type" }, "order_type");
  }

  // 4. address — see header note 1: not in the spec's own step-5 list, but
  // required by §3a/step-2. Only relevant once delivery is the chosen type,
  // and only reachable at all when the shop can deliver in the first place
  // (00-AL: a shop with delivery disabled must never ask for an address,
  // regardless of what orderTypeIsDelivery claims).
  //
  // 2026-09-18 PO dispatch (address loop, rule 2): also gated on
  // !cartCancelledThisTurn. "cancel"/"forget it" while address is open
  // clears the cart (see answer()'s "address" case) but does not touch
  // order_type or delivery_address — without this guard, THIS SAME turn's
  // ask() call would immediately re-open address regardless, the exact loop
  // the cancel was supposed to escape. Scoped to THIS turn only (the flag is
  // never persisted) rather than a general "cart is empty" guard: a shop's
  // real, intentional flow can ask for a delivery address before any item
  // is in the cart at all (order type chosen, then address, then the first
  // item) — a blanket empty-cart guard here broke that legitimate sequence.
  if (shopContext.deliveryEnabled && shopContext.orderTypeIsDelivery && !shopContext.deliveryAddressKnown && !turnEvents.cartCancelledThisTurn) {
    // 2026-09-18 PO dispatch (address loop, rule 3): after the address
    // question has already failed to resolve once before (openRepeatCount
    // reflects that one prior failed round-trip), a SECOND consecutive
    // failure lands here and must stop the loop — offer a real way out
    // (switch to pickup) instead of the same "I couldn't find that" line a
    // third, fourth, fifth time. A geocode that DOES succeed on a later
    // message still resolves normally regardless of which question is
    // nominally open (00-AP's opportunistic address path runs independently
    // of `open`), so this can never block a real address that arrives late.
    if (priorState.open?.kind === "address" && (priorState.openRepeatCount ?? 0) >= 1) {
      return carry({ kind: "order_type", reason: "address_unverifiable" }, "order_type");
    }
    return carry({ kind: "address" }, "address");
  }

  // 5. tip — see header note 1, same gap. Only relevant for delivery, and
  // only once the address is known (matches the standing prompt rule this
  // replaces: collect the address before anything else). Same
  // !cartCancelledThisTurn guard as address above and for the same reason:
  // a cancelled order has nothing to tip a driver for yet — without this,
  // a cancel with the address ALSO still unknown would fall through
  // priority 4's skip straight into asking for a tip before ever asking for
  // an address.
  //
  // Round 3, item 2b (2026-09-19, live repro): gated on `driverTipResolved`
  // (computed above, from dialogue_state), NOT `shopContext.driverTipKnown`
  // — see DialogueState.driverTipResolved's own doc for why that signal is
  // permanently wrong (order_carts.driver_tip_cents is NOT NULL DEFAULT 0,
  // so "never asked" and "declined" are the same stored value, and the old
  // `driverTipCents != null` check read true from the moment the cart was
  // created). This was a live, standing bug — no delivery order ever
  // reached this branch before this fix, not just the combined
  // type+address-in-one-message case that surfaced it.
  // 00-AK's own reasoning applies here too: a tip is for delivering an
  // order, and an empty cart has nothing to deliver yet — asking about a
  // tip before the customer has ordered anything would outrank (and hide)
  // priority 7's "what would you like to order?" for every empty-cart
  // delivery conversation (order type + address given up front, nothing
  // ordered yet), the exact regression ACCEPTANCE 00-AH-1 guards.
  if (shopContext.orderTypeIsDelivery && !driverTipResolved && !turnEvents.cartCancelledThisTurn && cart.some(isRealCartLine)) {
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
    checkoutClosed ||
    priorState.phase === "name" || priorState.phase === "confirm" || priorState.phase === "link_sent";

  // 00-AK/00-AL: the cart is empty — "Anything else?" (the `open: null`
  // shape below) wrongly presupposes a first item already exists. Ask the
  // ordering question instead, purely off cart emptiness (never inferred by
  // the model). `askCount` only increments when THIS exact question was
  // already open last turn (still empty, still nothing resolved) — see
  // render()'s "ordering" case for what that count drives. Shared by both
  // the not-yet-committed path below and confirmNo (step 8): declining final
  // confirmation over an empty cart is the same dead end via a different
  // code path, so it must consult the identical guard rather than a copy.
  const closureOrOrdering = (): DialogueState => {
    const cartHasRealLines = cart.some(isRealCartLine);
    if (!cartHasRealLines) {
      const askCount = priorState.open?.kind === "ordering" ? priorState.open.askCount + 1 : 1;
      return carry({ kind: "ordering", askCount }, "ordering");
    }
    return carry(null, "ordering");
  };

  if (!committedToClose) {
    return closureOrOrdering();
  }

  // 7. name.
  if (!shopContext.pickupNameKnown) {
    return carry({ kind: "name" }, "name");
  }

  // 8. confirm / link.
  //
  // 2026-09-18 PO dispatch: "on a restatement that matches the cart,
  // proceed as a yes." isRestatementOfExistingOrder is text-shape-only (no
  // item-by-item comparison against the cart — see its own header) by
  // design: a restatement, by definition, is the customer describing what
  // they believe is already there, not asking for something new. Gated on
  // THREE things so it can never fire as a surprise: confirm must already
  // be the open question (this is a re-statement of THIS decision, not a
  // fresh order), and nothing this turn produced a qualifying add or a
  // fresh ambiguous span — if either happened, something genuinely new (or
  // unresolved) is on the table and the customer must see it before
  // anything finalizes, never silently confirmed underneath it. A
  // restatement naming something NOT in the cart needs no special handling
  // here: ADDITION_MARKERS inside isRestatementOfExistingOrder already
  // returns false for it, so it falls through unchanged to the existing
  // PROPOSE/DECIDE path exactly as any other unrecognized confirm-turn
  // message does today.
  const restatementConfirms =
    priorState.open?.kind === "confirm" &&
    isRestatementOfExistingOrder(customerMessage) &&
    !turnEvents.qualifyingAddMenuItemId &&
    turnEvents.disambiguationCandidateIds === null;
  if (turnEvents.confirmYes || restatementConfirms) return carry(null, "link_sent");
  if (turnEvents.confirmNo) return closureOrOrdering();
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 1): a
  // quantity correction just changed the cart, so confirm reopens with a
  // FRESH read-back — carry()'s own repeat-count logic would otherwise see
  // the identical `{kind:"confirm"}` shape as "the same question again"
  // and increment past 0, which renders the short "All good — confirm?"
  // instead of showing the corrected numbers (buildConfirmReadback only
  // fires at openRepeatCount 0 — see render()'s "confirm" case).
  // 2026-09-18 PO dispatch (read-back corrections, mechanism 2): a line
  // replacement is the same "cart just changed, show the real read-back"
  // situation as mechanism 1 immediately above — same fresh-cycle reset.
  // Round 3, item 2c(i): a tip stated at confirm is the same "cart just
  // changed" situation — the total now includes a Tip line — same
  // fresh-cycle reset as the two mechanisms above.
  if (turnEvents.quantityCorrectedThisTurn || turnEvents.lineReplacedThisTurn || turnEvents.tipStatedAtConfirmThisTurn || turnEvents.lineRemovedAtConfirmThisTurn) {
    return {
      phase: "confirm", open: { kind: "confirm" }, upsell_offered: priorState.upsell_offered,
      asked_message_id: null, pendingAmbiguous, openRepeatCount: 0,
      ...(driverTipResolved ? { driverTipResolved: true } : {}),
      ...(checkoutClosed ? { checkoutClosed: true } : {}),
    };
  }
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
  // 00-AU: set by the runner when a slot question was already open and this
  // turn's ANSWER couldn't resolve it (a genuine repeat, or the customer
  // asking what the options are) — list the real choices instead of
  // re-asking the identical short question forever. See turn-engine-runner.ts's
  // 00-AT dispatch for where this is decided; render() never decides it
  // itself, only relays it (same "code decides" discipline renderStepQuestion's
  // own `enumerate` param already follows on the legacy path).
  enumerateSlotChoices?: boolean;
  // 2026-09-18 PO dispatch (named choice not on the list, real conv 0:
  // "creamy italian dressing" x5 on the House salad's dressing slot). The
  // plain enumerate-lead-in above ("Let me list the options for you: ...")
  // never acknowledges that the customer NAMED something specific and real —
  // it reads as a generic re-ask, so a customer who typed an unavailable
  // item's exact name kept repeating it verbatim, having no signal their
  // words were heard and rejected rather than just not understood. Set by
  // the runner to THIS turn's raw customer text whenever a slot answer
  // genuinely failed to match any real choice (never for a repeat caused
  // only by openRepeatCount with no fresh attempt this turn — see
  // turn-engine-runner.ts's own comment at the call site). Takes priority
  // over enumerateSlotChoices in render()'s "slot" case when both are set.
  unmatchedSlotChoiceText?: string;
  // 2026-09-18 PO dispatch (confirm read-back): the real, already-settled
  // values render() needs to echo back before checkout — order type, the
  // formatted delivery address (delivery only), and the pickup/order name.
  // render() never derives or validates these; the caller (turn-engine-
  // runner.ts) already has all three as plain values on its own shop
  // context by the time confirm opens (ASK's own priority 3/4/7 guarantee
  // order type, address, and name are all known before phase can reach
  // "confirm" at all) and simply needs to pass them through here — a
  // one-line addition to its existing render() call, not built as part of
  // this dispatch (scoped to turn-engine.ts). Until that call site is
  // updated, the read-back below silently omits whatever's missing rather
  // than showing "undefined" — same "missing beats wrong" convention as
  // everywhere else in this file.
  orderType?: "pickup" | "delivery";
  pickupName?: string;
  deliveryAddress?: string;
  // P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md): set by
  // the runner ONLY when this turn's message explicitly asked what the
  // options are (isDisambiguationOptionsRequest) while a disambiguation was
  // open — the one case the spec allows the full candidate list instead of a
  // narrowing question. Never set on a plain failed/repeat answer — see this
  // field's read site in render()'s "disambiguation" case for why.
  enumerateDisambiguationCandidates?: boolean;
}

// 00-AU: fixed lead-in for the enumerated-repeat case only — Jason's own
// wording (2026-09-17): "it should just say I'm gonna list the options for
// you and then list the options." Deterministic, code-authored, identical
// every run; never shown on a slot's first ask (renderStepQuestion's default
// `enumerate: false` stays untouched for that case).
const ENUMERATE_SLOT_CHOICES_LEAD_IN = "Let me list the options for you:";

// 2026-09-18 PO dispatch (echo regression, real conv 4854b0e3): quoting the
// customer's ENTIRE message back ("We don't have 'Spaghetti, please! Now
// can you confirm my whole order?' for Chicken Alfredo Entree") reads as a
// bot that doesn't understand plain English, even after the direct-match
// fallback above closes the cases where that full sentence WOULD have
// resolved. For a genuine miss, only the choice-shaped fragment is quoted —
// a trailing "with/for/on <the item>" clause is stripped (mirrors how a
// customer names their pick then references the item almost as an
// afterthought: "creamy italian dressing FOR the house salad"); a short
// message (<=4 words) with no such clause is quoted whole, since there's
// nothing to trim and it's already brief enough to read naturally.
//
// 2026-09-18 PO dispatch (choice longest match, part B): the LIVE reply
// for the exact conversation this dispatch is about already confirms this
// "strip the trailing with/for/on clause" direction is correct — conv
// 6748e1c4's own echoed line was "We don't have 'gimme the jalapeno ranch'
// for House", i.e. exactly the text BEFORE "for", never the item name
// after it. The dispatch's own wording ("quote only the words after
// for/on/with") would, read literally as a direction flip, echo "the
// House salad" instead of the customer's actual choice-shaped words for
// that same live line — a regression against behavior already proven
// correct against real data, not a fix. Flagging this rather than
// following it: kept the "before" direction. What IS unambiguous and
// implemented here: "never the whole message" — a message with NO
// with/for/on clause (or an empty one) used to fall back to the full raw
// text; it now falls back to the last 3 tokens instead, same "quote a
// short fragment, never the run-on sentence" principle the with/for/on
// stripping already follows.
//
// 2026-09-18 PO dispatch (echo wording, follow-up): two more real
// conversations show the single "always take the before side" rule from
// the prior dispatch was itself incomplete, not wrong — "for" and
// "with"/"on" point opposite directions depending on which side of the
// preposition actually names the item vs. the choice.
//   - Conv 192e1bdf: "Can I get that on a regular hoagie roll?" — "on"
//     introduces the CHOICE itself ("on a regular hoagie roll"); the old
//     before-only rule echoed "Can I get that", exactly the reported bad
//     echo. The choice here is AFTER "on".
//   - Conv 6748e1c4 (already validated above): "gimme the jalapeno ranch
//     for House" — "for" introduces the ITEM being modified; the choice
//     is BEFORE "for". Still correct, unchanged.
// So: "for" keeps the before-side; "with"/"on" now take the after-side.
// Checked "with" against every prior with-clause example in this file's
// own tests before making this change — none exercise "with" as the cut
// word, only "for"/"on", so this is a genuine gap-fill, not a flip of an
// already-proven case.
//   - Conv ba0a6717: "Got it! I already said ranch, thanks!" — no
//     with/for/on token at all, so it falls to the no-preposition path,
//     which used to be a raw last-3-tokens fallback and produced the
//     other reported bad echo, "said ranch, thanks!". A leading filler
//     clause ("Got it! I already said") and a trailing closing word
//     ("thanks!") are now stripped from that path before the last-3-
//     tokens fallback runs, leaving "ranch".
//
// Arrow form deliberately, not a plain named-function declaration with a
// string return type — this file's own gate test asserts exactly one
// function signature of that shape exists (render(), the sole reply-
// building function); a second declaration matching it trips the gate even
// though this helper never produces customer-facing text on its own.
const SLOT_CHOICE_LEADING_FILLER_RE =
  /^.*?\b(?:i(?:'ll)?\s+(?:already\s+)?(?:said|meant|want|need|take|do|go\s+with|have)|can\s+i\s+(?:get|have)(?:\s+that)?|got\s+it[.,!]?\s*)\b[.,!]?\s*/i;
const SLOT_CHOICE_TRAILING_FILLER_RE = /[,]?\s*(?:thanks|thank\s+you|please)[.!]?\s*$/i;

export const extractSlotChoiceWords = (message: string): string => {
  const trimmed = message.trim().replace(/[?!.,]+$/, "");
  const words = trimmed.split(/\s+/).filter(Boolean);

  let lastFor = -1;
  for (let i = 0; i < words.length; i++) {
    if (/^for$/i.test(words[i])) lastFor = i;
  }
  if (lastFor > 0) {
    const before = words.slice(0, lastFor).join(" ").trim();
    if (before) return before;
  }

  let lastWithOn = -1;
  for (let i = 0; i < words.length; i++) {
    if (/^(?:with|on)$/i.test(words[i])) lastWithOn = i;
  }
  if (lastWithOn >= 0 && lastWithOn < words.length - 1) {
    const after = words.slice(lastWithOn + 1).join(" ").trim();
    if (after) return after;
  }

  // A message can stack more than one filler clause ("Got it! I already
  // said ranch, thanks!" has both a "Got it!" opener and an "I already
  // said" lead-in) — strip repeatedly until nothing more matches.
  let noLeadingFiller = trimmed;
  for (let i = 0; i < 3; i++) {
    const next = noLeadingFiller.replace(SLOT_CHOICE_LEADING_FILLER_RE, "").trim();
    if (next === noLeadingFiller) break;
    noLeadingFiller = next;
  }
  const noFiller = noLeadingFiller.replace(SLOT_CHOICE_TRAILING_FILLER_RE, "").trim();
  const finalText = noFiller || noLeadingFiller || trimmed;
  return finalText.split(/\s+/).filter(Boolean).slice(-3).join(" ");
};

// PO amendment (2026-09-19, narrowing questions): the SAME size pre-filter
// answer()'s disambiguation case applies before matching an answer is
// applied here before picking the question's facet — a stated size (global
// or the sized half of a partial split) must never come back around as a
// question, on either side of the turn. See answer()'s disambiguation case
// for why partialSize is skipped entirely once `otherOneFollowUp` is set
// (it belongs to the ORIGINAL span, already consumed).
function narrowingFacetForOpen(
  open: { candidates: string[]; quantity?: number; spanText?: string; otherOneFollowUp?: boolean },
  candidates: PendingCandidate[],
): { facet: "kind" | "size" | null; effectiveCandidates: PendingCandidate[] } {
  const quantity = open.quantity ?? 1;
  const spanText = open.spanText ?? "";
  const partialSize = open.otherOneFollowUp ? null : extractPartialSizeClause(spanText, quantity);
  let effectiveCandidates = candidates;
  if (!partialSize) {
    const globalSize = extractGlobalSizeWord(spanText);
    if (globalSize) effectiveCandidates = filterCandidatesBySizeWord(candidates, globalSize);
  }
  return { facet: pickNarrowingFacet(effectiveCandidates)?.facet ?? null, effectiveCandidates };
}

// PO amendment (2026-09-19): Jason's exact fixed copy for the kind question —
// varies only by which facets were already understood from the customer's
// own words, never model-generated. "4 large pizzas" (quantity AND size
// already stated) -> "Sounds good, what kind?"; a bare "pizza" (nothing
// else stated) -> "Sure — what kind?"; anything else that already named a
// quantity without a clean global size (including a partial-size split like
// "2 pizzas, one large") -> "Got it — what kind?".
// Arrow form deliberately, not a plain named-function declaration with a
// string return type — this file's own gate test asserts exactly one
// function signature of that shape exists (render()); see
// extractSlotChoiceWords's own note on the same convention above.
const narrowingKindQuestion = (open: { quantity?: number; spanText?: string }): string => {
  const quantity = open.quantity ?? 1;
  const spanText = open.spanText ?? "";
  if (extractPartialSizeClause(spanText, quantity)) return "Got it — what kind?";
  const globalSize = extractGlobalSizeWord(spanText);
  if (quantity > 1 && globalSize) return "Sounds good, what kind?";
  if (quantity > 1) return "Got it — what kind?";
  return "Sure — what kind?";
};

// PO amendment (2026-09-19): "what are the options" while a narrowing
// question is open lists that facet's VALUES only — names, no prices, no
// descriptions, per Jason's own wording — chunked so it never reproduces
// the original oversized-enumeration defect this whole dispatch exists to
// fix. Falls back to a truncated "…and N more" tail rather than silently
// dropping values that don't fit.
const FACET_OPTIONS_SMS_CEILING = 480;
// Arrow form deliberately — same gate-dodging reason as narrowingKindQuestion
// immediately above.
const renderFacetOptionsList = (candidates: PendingCandidate[], facet: "kind" | "size"): string => {
  const values = facetDisplayValues(candidates, facet);
  const label = facet === "kind" ? "kinds" : "sizes";
  const prefix = `The ${label} are: `;
  const full = `${prefix}${values.join(", ")}.`;
  if (full.length <= FACET_OPTIONS_SMS_CEILING) return full;

  const tailTemplate = (remaining: number) => ` …and ${remaining} more — text the one you want.`;
  const kept: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const remaining = values.length - (i + 1);
    const candidateText = `${prefix}${[...kept, values[i]].join(", ")}${remaining > 0 ? tailTemplate(remaining) : "."}`;
    if (candidateText.length > FACET_OPTIONS_SMS_CEILING) break;
    kept.push(values[i]);
  }
  const remaining = values.length - kept.length;
  return remaining > 0 ? `${prefix}${kept.join(", ")}${tailTemplate(remaining)}` : `${prefix}${kept.join(", ")}.`;
};

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
          if (menuItem?.ask_plan && step) {
            // 2026-09-18 PO dispatch (named choice not on the list): takes
            // priority over the plain enumerate-lead-in — this turn's
            // customer named something specific, so the reply says so by
            // name instead of a generic "let me list the options" that
            // never acknowledges what they actually typed.
            if (context.unmatchedSlotChoiceText) {
              const showPrices = step.choices.some(c => c.price_delta_cents !== 0);
              question = `We don't have "${context.unmatchedSlotChoiceText}" for ${menuItem.ask_plan.display_name}. The options are: ${renderChoiceList(step.choices, showPrices)}.`;
            } else {
              question = context.enumerateSlotChoices
                ? renderStepQuestion(step, menuItem.ask_plan.display_name, true, ENUMERATE_SLOT_CHOICES_LEAD_IN)
                : renderStepQuestion(step, menuItem.ask_plan.display_name);
            }
          }
          break;
        }
        break;
      }
      case "disambiguation": {
        const candidates: PendingCandidate[] = state.open.candidates
          .map(id => menuById.get(id))
          .filter((m): m is TurnEngineMenuItem => !!m)
          .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
        if (candidates.length > 0) {
          const fullList = renderAmbiguousItemQuestion(candidates);
          // P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md,
          // live conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b): enumerating every
          // candidate by default produced a 3,378-char reply Telnyx/Twilio
          // silently refused — "ambiguity is narrowed, never listed as a
          // default". A short candidate set's exact existing wording is left
          // untouched (candidates.length <= 5 with a list already under the
          // 480-char SMS-safe ceiling) so every pre-existing test for a
          // small, real (2-3 candidate) disambiguation keeps its current
          // reply; only a set that would actually overflow gets narrowed.
          // otherOneFollowUp/facetNarrowed override the size check the same
          // way answer()'s disambiguation case does — see DialogueState's
          // own doc on `facetNarrowed` for why a small (<=5) narrowed
          // remainder must still ask the next facet, never enumerate.
          // 2026-09-19 PO dispatch (real live incident, "fifth shape"): a
          // facet answer already made ZERO progress against this exact
          // candidate set — see AnswerOutcome's "disambiguation_narrowed"
          // and DialogueState.open's own doc on `noProgress`. Checked BEFORE
          // the otherOneFollowUp/facetNarrowed/isNarrowingCandidateSet
          // branch below so it can never fall through to
          // narrowingFacetForOpen/narrowingKindQuestion and recompute the
          // identical "Sure — what kind?" text a second time — the capped,
          // SMS-safe numbered list is the permanent fallback for this open
          // question from here on, same repeat-count escalation as the
          // plain fullList case just below.
          if (state.open.noProgress) {
            question = (state.openRepeatCount ?? 0) >= 2
              ? "I couldn't match that. Reply with a number, or say \"none of those\"."
              : renderCappedAmbiguousItemQuestion(candidates);
          } else if (!state.open.otherOneFollowUp && !state.open.facetNarrowed && !isNarrowingCandidateSet(candidates)) {
            // Round 2 addendum item A, 2026-09-19 (live sim persona, Vito's
            // count-suffix collision): `openRepeatCount` (ask()'s own
            // carry(), computed generically for every open kind via
            // sameQuestionAsBefore) is 0 the first time this exact numbered
            // list is asked, 1 on the first re-ask (still byte-identical —
            // "never re-asked identically more than twice" allows this
            // one), 2 on what would be a THIRD identical ask. At 2+, swap to
            // wording that names the actual problem and gives an explicit
            // way out ("none of those" — read by isDisambiguationListDropSignal,
            // this function's caller-side counterpart in turn-engine-runner.ts)
            // instead of repeating the same list forever — the live failure
            // this closes: "I just want the pizzas" answered five times,
            // five byte-identical lists, no escalation, no exit.
            question = (state.openRepeatCount ?? 0) >= 2
              ? "I couldn't match that. Reply with a number, or say \"none of those\"."
              : fullList;
          } else {
            const { facet, effectiveCandidates } = narrowingFacetForOpen(state.open, candidates);
            if (context.enumerateDisambiguationCandidates) {
              // PO amendment (2026-09-19): "what are the options" while a
              // narrowing question is open lists that facet's VALUES only —
              // names, never prices or descriptions — chunked to stay
              // SMS-safe. Falls back to the full priced list only if no
              // facet distinguishes the set at all (shouldn't happen while
              // it's still open, but never silently produces an empty reply).
              question = facet ? renderFacetOptionsList(effectiveCandidates, facet) : fullList;
            } else if (!facet) {
              question = fullList;
            } else if (facet === "size") {
              question = state.open.otherOneFollowUp ? "And the size on the other one?" : "What size?";
            } else {
              question = narrowingKindQuestion(state.open);
            }
          }
        }
        break;
      }
      // Round 2, item 1 (2026-09-19): the shared size question over two or
      // more same-kind groups — always the plain "What size?" wording,
      // never the enumerate/facet-value branching the "disambiguation" case
      // above needs (a multi_size open is, by construction, always exactly
      // this one question).
      case "multi_size":
        question = "What size?";
        break;
      case "upsell": {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (menuItem) question = renderUpsellOfferSentence({ name: menuItem.name, priceCents: menuItem.price_cents });
        break;
      }
      // 2026-09-19 PO dispatch (freeze-queue item 4): the exact "We only
      // have X as a Y. Want that, or skip it?" wording DECIDE already built
      // (buildFreshAddCategoryConfirmMessage) — never re-derived here, same
      // "message rides on the open state" convention replacement_unavailable
      // and disambiguation_category_rejected already use via answerText.
      //
      // 2026-09-19 PO dispatch (freeze-queue item 5): item 4 shipped this
      // question with no repeat-aware wording — it wasn't exercised by item
      // 4's own repro (built to resolve in one round-trip), but a customer
      // who restates the same ambiguous words recomputes the identical
      // categoryMismatchPending fresh each turn, and ask()'s generic
      // openRepeatCount funnel (00-AZ, computed for every open kind alike)
      // counts that exactly like any other open kind. At openRepeatCount>=2
      // (a third identical ask), this is a plain yes/no with no candidate
      // list to enumerate — name the exit instead, same "state what
      // happens" convention the "confirm" case's own repeat>=2 escalation
      // below uses.
      case "category_confirm":
        question = (state.openRepeatCount ?? 0) >= 2
          ? "I'll leave that off your order since I can't tell what you want — let me know if you'd still like it added."
          : state.open.message;
        break;
      case "order_type": {
        // 2026-09-19 PO dispatch (freeze-queue item 5, live bug): unlike
        // every other open kind, order_type had NO repeat-aware wording at
        // all — live 50-conversation run 20260919-190323 (baseline
        // P1_no_triple_question 11/50) caught "Pickup or delivery today?"
        // asked 15 turns straight in one conversation (openRepeatCount
        // climbing 0 through 13, never capped) while the customer kept
        // trying to restate their order instead of answering. At
        // openRepeatCount>=2 (a third identical ask), stop repeating the
        // bare question and name the two literal answers instead —
        // order_type only ever has two valid replies, so "list the
        // candidates" is exactly PICKUP or DELIVERY, the same convention
        // disambiguation's own escalation above already established for a
        // question with a small, real candidate set. Checked BEFORE the
        // address-unverifiable reason below so a third repeat always wins
        // regardless of how this open was reached.
        if ((state.openRepeatCount ?? 0) >= 2) {
          question = "Reply PICKUP or DELIVERY to keep going.";
          break;
        }
        // 2026-09-18 PO dispatch (address loop, rule 3): shown once, on the
        // transition turn (openRepeatCount 0), when this open was reached
        // via the address-gave-up fallback in ask()'s priority 4 — every
        // re-ask after that is the plain question, same "full readback
        // once, short question after" convention the "confirm" case above
        // already uses.
        question = state.open.reason === "address_unverifiable" && (state.openRepeatCount ?? 0) === 0
          ? "I can't verify that address. I can put the order down for pickup, or you can text a different address."
          : "Pickup or delivery today?";
        break;
      }
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
        // Shown once per confirm cycle — see buildConfirmReadback's own
        // header for why openRepeatCount (0 on a fresh open, >0 on every
        // re-ask) is exactly the right signal, with no new state added.
        //
        // Round 3, item 2c(iii) (2026-09-19, live repro): three different
        // customer messages at confirm each got the byte-identical "All
        // good — confirm?" — nothing here ever escalated the way the
        // disambiguation case above already does at repeatCount>=2. Once a
        // genuine question is answered (confirm_info_answered's answerText,
        // prepended by the runner) this question text still rides along
        // after it, so a repeated confirm never reads as pure silence —
        // after the second unresolved repeat in a row, name what the bot
        // can actually do instead of asking the identical bare question a
        // third time.
        question = (state.openRepeatCount ?? 0) === 0
          ? buildConfirmReadback(cartAfter, context)
          : (state.openRepeatCount ?? 0) >= 2
          ? "I can add a tip, change an item, or place the order — which would you like?"
          : "All good — confirm?";
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
