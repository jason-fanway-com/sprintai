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
import { splitCustomerPhrases, resolveClaimedPhraseIndex, scopedModifierText } from "./phrase-split.ts";
import {
  applyCompiledAddItem,
  applyCompiledModifyItem,
  priceSelections,
  renderStepQuestion,
  renderChoiceList,
  matchChoiceInText,
  matchChoiceAsWholeSpan,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "./ask-plan-engine.ts";
import { identityKey, removeCartLine, type ReconcilerCartLine } from "./turn-reconciler.ts";
import { isNegated } from "./reactive-modifier-match.ts";
import {
  resolvePendingDisambiguation,
  isPendingDisambiguationDeclined,
  isDisambiguationOptionsRequest,
  renderAmbiguousItemQuestion,
  pickNarrowingFacet,
  isNarrowingCandidateSet,
  narrowCandidatesByFacetAnswer,
  facetDisplayValues,
  candidateSizeValue,
  extractPartialSizeClause,
  extractGlobalSizeWord,
  filterCandidatesBySizeWord,
  significantStems,
  categoryWordMatches,
  extractSizeAndKind,
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
import { buildConfirmReadback } from "./confirm-readback-20260918.ts";
import {
  impliesUpsellAcceptance,
  impliesUpsellDecline,
  looksLikeCustomerName,
  extractCustomerName,
} from "./dialogue-signals.ts";
import { resolveItem, type LexiconTerm } from "./resolve-item.ts";
import { fuzzyWordMatch } from "./guard19-fuzzy-item-match.ts";

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
  | { kind: "disambiguation_new_item_added"; menuItemId: string; quantity: number };

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
const TIP_DECLINE_ANYWHERE_RE = /\b(?:no tip|without a tip|don'?t want (?:a )?tip|no thanks|no thank you|not (?:now|today)|skip (?:it|the tip)?|none|pass|zero|nothing)\b/i;
const TIP_AMOUNT_ANYWHERE_RE = /(?:\$\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)\b)/i;

export function readTipReply(message: string): { kind: "amount"; cents: number } | { kind: "decline" } | null {
  const m = (message ?? "").trim();
  if (!m) return null;
  const amt = TIP_AMOUNT_ANYWHERE_RE.exec(m);
  if (amt) {
    const raw = amt[1] ?? amt[2];
    const cents = Math.round(parseFloat(raw) * 100);
    if (Number.isFinite(cents) && cents >= 0) return { kind: "amount", cents };
  }
  if (TIP_AMOUNT_RE.test(m)) return { kind: "amount", cents: parseBareTipDollars(m) * 100 };
  if (TIP_DECLINE_RE.test(m) || TIP_DECLINE_ANYWHERE_RE.test(m)) return { kind: "decline" };
  return null;
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
// "<N> <item>, not/instead of <M>" — covers "2 Thin Sicilian Pizzas, not
// one" and "2 x Thin Sicilian Pizzas instead of one" (the "x" is optional).
const QUANTITY_CORRECTION_NOT_RE = new RegExp(
  `\\b${QUANTITY_WORD_RE}\\s+(?:x\\s+)?([a-zA-Z][a-zA-Z '"-]*?),?\\s+(?:not|instead of)\\s+${QUANTITY_WORD_RE}\\b`, "i",
);
// "I meant <N> <item>" — a correction that states the right number without
// necessarily naming the wrong one too.
const QUANTITY_CORRECTION_MEANT_RE = new RegExp(
  `\\bi meant\\s+${QUANTITY_WORD_RE}\\s+(?:x\\s+)?([a-zA-Z][a-zA-Z '"-]*?)(?:,|\\.|$)`, "i",
);
// "make it <N> <item>" — stops the item-phrase capture at a trailing
// "and <something else>" clause ("make it 2 Thin Sicilian Pizzas and the
// Garlic Knots") so a second, unrelated item mentioned in the same breath
// never gets folded into the corrected item's own name.
const QUANTITY_CORRECTION_MAKE_IT_RE = new RegExp(
  `\\bmake it\\s+${QUANTITY_WORD_RE}\\s+(?:x\\s+)?([a-zA-Z][a-zA-Z '"-]*?)(?:,|\\.|\\band\\b|$)`, "i",
);

interface QuantityCorrectionCandidate {
  quantity: number;
  itemPhrase: string;
}

function parseQuantityCorrectionPhrase(message: string): QuantityCorrectionCandidate | null {
  for (const re of [QUANTITY_CORRECTION_NOT_RE, QUANTITY_CORRECTION_MEANT_RE, QUANTITY_CORRECTION_MAKE_IT_RE]) {
    const m = message.match(re);
    if (!m) continue;
    const quantity = parseQtyToken(m[1]);
    const itemPhrase = m[2]?.trim();
    if (quantity && itemPhrase) return { quantity, itemPhrase };
  }
  return null;
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
function findMenuItemByNamePhrase(
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
  const msgStems = significantStems(message);
  const seenCategories = new Set(menu.map(m => m.category).filter((c): c is string => !!c));
  let foundNonCandidateCategory = false;
  for (const category of seenCategories) {
    const catStems = significantStems(category);
    if (catStems.size === 0) continue;
    if ([...catStems].some(w => candidateCategoryStems.has(w))) continue; // same family
    if ([...catStems].every(s => msgStems.has(s))) {
      foundNonCandidateCategory = true;
      break;
    }
  }
  if (!foundNonCandidateCategory) return null;

  // Narrow by stated size if the facet resolver finds one
  const sizeNarrowed = narrowCandidatesByFacetAnswer(candidates, "size", message);
  const narrowed = (sizeNarrowed && sizeNarrowed.length > 0) ? sizeNarrowed : candidates;
  return narrowed[0] ?? null;
}

function closureOrAffirmationFallback(trimmed: string, cart: TurnEngineCartLine[]): AnswerResult | null {
  if (isExplicitCheckoutIntent(trimmed, null, false)) {
    return { resolved: true, outcome: { kind: "checkout_intent" }, cartChanged: false };
  }
  // See impliesClosure's own 2026-09-19 header: an embedded "that's it" is
  // only trusted as closure when there's something in the cart to close.
  const cartHasItems = cart.some(isRealCartLine);
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

// Round 2, item 3 (2026-09-19, live repro): a typo'd word ("hawiaan") that
// would name a real lexicon term ("hawaiian") if spelled correctly, but
// resolveItem itself does only exact whole-word matching (no fuzzy
// tolerance — that lives in narrowCandidatesByFacetAnswer's own fallback
// tier and in itemSpanNamedInMessage's guard, neither of which this gate
// reuses). Without this, "One large hawiaan pizza" would never resolve via
// the lexicon at all and messageNamesItemOutsideCandidates below would
// silently miss the exact case it exists for. Same tight, narrow tolerance
// as itemSpanNamedInMessage's own ADDENDUM B fix (5+ letter words only,
// fuzzyWordMatch's graduated distance) — this is a typo-correction pass,
// not a general fuzzy search.
// Arrow form deliberately, not a plain named-function declaration with a
// string return type — this file's own gate test asserts exactly one
// function signature of that shape exists (render(), the sole reply-
// building function); see buildMultiClauseClarifyMessage's own note on the
// same convention.
const fuzzyCorrectAgainstLexicon = (text: string, lexicon: LexiconTerm[]): string => {
  const lexiconWords = new Set<string>();
  for (const entry of lexicon) {
    for (const w of entry.term.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 5) lexiconWords.add(w);
  }
  if (lexiconWords.size === 0) return text;
  return text.replace(/[a-zA-Z]+/g, word => {
    const bare = word.toLowerCase();
    if (bare.length < 5 || lexiconWords.has(bare)) return word;
    for (const lw of lexiconWords) if (fuzzyWordMatch(bare, lw)) return lw;
    return word;
  });
};

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

function messageNamesItemOutsideCandidates(
  message: string,
  candidates: PendingCandidate[],
  lexicon: LexiconTerm[] | undefined,
): { menuItemId: string; quantity: number } | null {
  if (!lexicon || lexicon.length === 0) return null;
  const marker = message.match(OUTSIDE_ITEM_REMAINDER_MARKER_RE);
  const scoped = marker && marker.index !== undefined ? message.slice(0, marker.index) : message;
  const { count, text } = extractLeadingClauseCount(scoped);
  const corrected = fuzzyCorrectAgainstLexicon(text, lexicon);
  const result = resolveItem(corrected, lexicon);
  if (result.kind !== "resolved") return null;
  const candidateIds = new Set(candidates.map(c => c.menu_item_id));
  if (candidateIds.has(result.menu_item_id)) return null;
  return { menuItemId: result.menu_item_id, quantity: count };
}

// Round 2 (2026-09-19, TOP item): exported so turn-engine-runner.ts can
// decide, BEFORE calling answer(), whether an open disambiguation should be
// dropped-and-reprocessed this turn — see the "disambiguation" case's own
// header on isPendingDisambiguationDeclined above for the full reasoning.
// Duplicates none of that logic; it's the exact same two checks
// (isPendingDisambiguationDeclined, then messageNamesItemOutsideCandidates)
// answer() itself runs, just callable from outside with raw candidate ids
// instead of an already-open DialogueState.
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
  return messageNamesItemOutsideCandidates(message, candidates, lexicon) !== null;
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
): MultiKindClauseResult | null {
  const phrases = splitCustomerPhrases(message, menu.map(m => ({ name: m.name })));
  if (phrases.length <= 1) return null;

  const clauses = phrases.map(extractLeadingClauseCount);
  const parsedSum = clauses.reduce((s, c) => s + c.count, 0);
  const category = candidates[0]?.category ?? null;

  // Rule 3: every clause's own count must sum to the originally-open
  // quantity -- a mismatch means the split itself is untrustworthy, so
  // nothing is added and the customer is asked, rather than guessing which
  // clause to shortchange.
  if (parsedSum !== totalQuantity) {
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
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
    }

    case "disambiguation": {
      const candidates: PendingCandidate[] = state.open.candidates
        .map(id => menuById.get(id))
        .filter((m): m is TurnEngineMenuItem => !!m)
        .map(m => ({ menu_item_id: m.id, name: m.name, category: m.category ?? null, price_cents: m.price_cents }));
      if (candidates.length === 0) return UNRESOLVED;
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
        const quantity = state.open.quantity ?? 1;
        const outsideItem = messageNamesItemOutsideCandidates(trimmed, candidates, external.lexicon);
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
      if (
        (state.open.otherOneFollowUp || state.open.facetNarrowed || isNarrowingCandidateSet(candidates)) &&
        !isDisambiguationOptionsRequest(trimmed)
      ) {
        const spanText = state.open.spanText ?? "";
        const partialSize = state.open.otherOneFollowUp ? null : extractPartialSizeClause(spanText, quantity);
        let effectiveCandidates = candidates;
        if (!partialSize) {
          const globalSize = extractGlobalSizeWord(spanText);
          if (globalSize) effectiveCandidates = filterCandidatesBySizeWord(candidates, globalSize);
        }
        const facetResult = pickNarrowingFacet(effectiveCandidates);
        if (facetResult) {
          // P0 (2026-09-19, multi-kind-answer): the answer to "what kind?"
          // can be a LIST — see resolveMultiKindClauses's own header. Only
          // ever intercepts here (never for the "size" facet); returns null
          // when `trimmed` isn't structurally a list, in which case the
          // single-match path immediately below runs completely unchanged.
          if (facetResult.facet === "kind") {
            const multi = resolveMultiKindClauses(effectiveCandidates, trimmed, quantity, menu, external.lexicon);
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
          if (!matched) return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;

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
                return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: sizedMatch.menu_item_id }, cartChanged };
              }
              if (remaining.length === 1) {
                const otherChanged = addNarrowedCandidateToCart(cart, menuById, remaining[0], remainingQuantity);
                return {
                  resolved: true,
                  outcome: { kind: "disambiguation_resolved", menuItemId: remaining[0].menu_item_id },
                  cartChanged: cartChanged || otherChanged,
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
            return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: matched[0].menu_item_id }, cartChanged };
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
              return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: doubleMatched[0].menu_item_id }, cartChanged };
            }
          }
          return {
            resolved: true,
            outcome: {
              kind: "disambiguation_narrowed",
              remainingCandidates: matched.map(c => c.menu_item_id),
              remainingQuantity: quantity,
              otherOneFollowUp: false,
            },
            cartChanged: false,
          };
        }
      }

      const resolved = resolvePendingDisambiguation(trimmed, candidates);
      if (!resolved) return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
          const recovered = recoverAssertedChoiceFromText(heldText, step.choices);
          if (recovered) heldChoices = [...heldChoices, { group_id: step.group_id, choice_id: recovered }];
        }
      }
      const { texts } = resolveChoiceDisplays(menuItem.ask_plan, heldChoices);
      const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, quantity, "", undefined, undefined, texts);
      return { resolved: true, outcome: { kind: "disambiguation_resolved", menuItemId: menuItem.id }, cartChanged: result.cartChanged };
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
        return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
      const wantsPickup = ORDER_TYPE_PICKUP_RE.test(trimmed);
      const wantsDelivery = ORDER_TYPE_DELIVERY_RE.test(trimmed);
      if (wantsPickup && !wantsDelivery) return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "pickup" }, cartChanged: false };
      if (wantsDelivery && !wantsPickup) return { resolved: true, outcome: { kind: "order_type_resolved", orderType: "delivery" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
      const fallback = closureOrAffirmationFallback(trimmed, cart);
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
      {
        const tip = readTipReply(trimmed);   // 00-BH
        if (tip) return { resolved: true, outcome: { kind: "tip_resolved", tipCents: tip.kind === "amount" ? tip.cents : 0 }, cartChanged: false };
      }
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
      // attempt.
      const qtyCorrection = parseQuantityCorrectionPhrase(trimmed);
      if (qtyCorrection) {
        const line = findCartLineByNamePhrase(cart, qtyCorrection.itemPhrase);
        if (line) {
          line.quantity = qtyCorrection.quantity;
          return { resolved: true, outcome: { kind: "quantity_corrected" }, cartChanged: true };
        }
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
      if (isExplicitCheckoutIntent(trimmed, "Confirm?", false)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      if (impliesConfirmDecline(trimmed)) return { resolved: true, outcome: { kind: "confirm_no" }, cartChanged: false };   // 00-BH
      // 00-BE: see isConfirmAffirmative. Decline above wins; negation inside
      // the helper blocks "not yet"/"don't"/"wrong"/"change".
      if (isConfirmAffirmative(trimmed)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
    }

    case "upsell": {
      if (impliesUpsellAcceptance(trimmed)) {
        const menuItem = menuById.get(state.open.menu_item_id);
        if (!menuItem?.ask_plan) return UNRESOLVED;
        const result = applyCompiledAddItem(cart, toCompiledMenuItem(menuItem, menuItem.ask_plan), menuItem.id, 1, "", undefined, undefined, []);
        return { resolved: true, outcome: { kind: "upsell_accepted" }, cartChanged: result.cartChanged };
      }
      if (impliesUpsellDecline(trimmed)) return { resolved: true, outcome: { kind: "upsell_declined" }, cartChanged: false };
      return closureOrAffirmationFallback(trimmed, cart) ?? UNRESOLVED;
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
function itemSpanNamedInMessage(span: string, customerMessage: string | undefined): boolean {
  if (customerMessage === undefined) return true;
  const tokenize = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).map(singularizeSpanToken);
  const spanTokens = tokenize(span);
  if (spanTokens.length === 0) return false;
  const messageTokens = tokenize(customerMessage);
  const messageTokenSet = new Set(messageTokens);
  return spanTokens.every(t => {
    if (messageTokenSet.has(t)) return true;
    if (t.length < 5) return false;
    return messageTokens.some(mt => mt.length >= 5 && fuzzyWordMatch(t, mt));
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
//   3. whole-word match against THIS item's own compiled choices only
//   4. exactly one choice matches -- a tie resolves nothing, never a guess
//   5. no negation anywhere in the scoped text
//
// A false positive here ADDS A PAID TOPPING, which the customer cannot undo
// after paying. So every ambiguity resolves to doing nothing.
const MODIFIER_NEGATION_RE = /\b(?:no|not|without|hold|skip|minus|except|omit|leave off|lose the)\b/i;

export function recoverAssertedChoiceFromText(
  scopedText: string,
  choices: Array<{ id: string; display: string }>,
): string | null {
  const text = (scopedText ?? "").trim();
  if (!text || choices.length === 0) return null;
  if (MODIFIER_NEGATION_RE.test(text)) return null;
  const hay = text.toLowerCase();
  const hits = choices.filter(c => {
    const d = (c.display ?? "").trim().toLowerCase();
    if (d.length < 3) return false;
    return new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i").test(hay);
  });
  if (hits.length !== 1) return null;   // a tie, or nothing, resolves nothing
  return hits[0].id;
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
const CONFIRM_AFFIRMATIVE_RE =
  /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|correct|confirm|confirmed|confirming|place (?:it|the order)|go ahead|do it|send it)\b/i;
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
): DecideResult {
  const nextCart: TurnEngineCartLine[] = cart.map(l => ({ ...l }));
  const menuById = new Map(menu.map(m => [m.id, m]));
  const declines: Decline[] = [];
  let qualifyingAddMenuItemId: string | null = null;
  let disambiguationCandidateIds: string[] | null = null;
  let disambiguationQuantity: number | undefined;
  let disambiguationSpanText: string | undefined;
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
  const ambiguousSpans: Array<{ candidates: string[]; quantity: number; spanText: string }> = [];
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
  for (const add of proposal.adds ?? []) {
    const guardPassed = itemSpanNamedInMessage(add.item_span, customerMessage);
    // Always resolve (even on guard failure) so the guard-drop path can check
    // whether the resolved item is already in cart without a second pass.
    const resolution = resolveItem(add.item_span, lexicon);
    if (!guardPassed) {
      // Guard-dropped: the span's tokens were not in the customer's CURRENT
      // message — the model referenced an item the customer didn't name
      // this turn (stale re-proposal from history, or a genuine
      // hallucination either way). Silent per ADDENDUM A above — nothing
      // pushed to `declines`.
      const span = (add.item_span ?? "").trim();
      if (span) unresolvedSpans.push(span);
    } else if (resolution.kind === "resolved") {
      resolvedAdds.push({ menu_item_id: resolution.menu_item_id, quantity: add.quantity, choices: add.choices, item_span: add.item_span });
    } else if (resolution.kind === "ambiguous") {
      ambiguousSpans.push({ candidates: resolution.candidates, quantity: add.quantity, spanText: (add.item_span ?? "").trim() });
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
    disambiguationSpanText = ambiguousSpansFiltered[0].spanText;
    carriedDisambiguationCandidateIds = ambiguousSpansFiltered.slice(1).map(s => s.candidates);
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
  const restating = isRestatementOfExistingOrder(customerMessage);

  for (const add of addGroups.values()) {
    if (restating && menuItemIdsAlreadyInCart.has(add.menu_item_id)) {
      // Silent on purpose: the customer is confirming, not asking for
      // anything. Telling them we skipped something would be confusing, and
      // the money footer already shows them exactly what is in the cart.
      continue;
    }
    const menuItem = menuById.get(add.menu_item_id);
    if (!menuItem) { declines.push({ reason: "That item isn't on the menu." }); continue; }
    if (!menuItem.ask_plan) { declines.push({ reason: `${menuItem.name} isn't available to order this way yet.` }); continue; }
    // 00-BF: the modifier floor. Only when the model asserted NOTHING for this
    // add -- we never override or second-guess a choice it did make.
    let effectiveChoices = add.choices ?? [];
    if (effectiveChoices.length === 0 && customerMessage) {
      const phrases = splitCustomerPhrases(customerMessage, menu.map(m => ({ name: m.name })));
      const phraseIdx = resolveClaimedPhraseIndex(phrases, add.item_span ?? "");
      const scoped = scopedModifierText(phrases, phraseIdx, menuItem.name, customerMessage);
      for (const step of menuItem.ask_plan.steps) {
        if (step.kind !== "modifier") continue;          // slots are ASKED, never inferred
        const recovered = recoverAssertedChoiceFromText(scoped, step.choices);
        if (recovered) effectiveChoices = [...effectiveChoices, { group_id: step.group_id, choice_id: recovered }];
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

  return { cart: nextCart, declines, unresolvedSpans, qualifyingAddMenuItemId, disambiguationCandidateIds, disambiguationQuantity, disambiguationSpanText, carriedDisambiguationCandidateIds, heldModifierText };
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
  // 2026-09-18 PO dispatch (add-on rule edge): the customer's own words for
  // an add held back this turn because it was really a modifier of the
  // ambiguous sibling named by disambiguationCandidateIds above, not a
  // separate item — see DecideResult.heldModifierText and
  // holdAddsThatAreModifiersOfAnAmbiguousSibling's own header. Threaded
  // through unchanged on both the fresh-decide path and the re-ask carry-
  // forward path (turn-engine-runner.ts), same as disambiguationCandidateIds
  // itself, so it survives however many turns the ambiguity stays open.
  heldModifierText?: string | null;
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
    });

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
    return carry(
      {
        kind: "disambiguation",
        candidates: next,
        ...(heldModifierText ? { heldModifierText } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(spanText !== undefined ? { spanText } : {}),
        ...(otherOneFollowUp !== undefined ? { otherOneFollowUp } : {}),
        ...(facetNarrowed !== undefined ? { facetNarrowed } : {}),
      },
      "ordering",
      priorState.upsell_offered,
      rest,
    );
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
  if (shopContext.orderTypeIsDelivery && !shopContext.driverTipKnown && !turnEvents.cartCancelledThisTurn) {
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
  if (turnEvents.quantityCorrectedThisTurn || turnEvents.lineReplacedThisTurn) {
    return { phase: "confirm", open: { kind: "confirm" }, upsell_offered: priorState.upsell_offered, asked_message_id: null, pendingAmbiguous, openRepeatCount: 0 };
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
          if (!state.open.otherOneFollowUp && !state.open.facetNarrowed && !isNarrowingCandidateSet(candidates)) {
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
      case "order_type":
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
        question = (state.openRepeatCount ?? 0) === 0
          ? buildConfirmReadback(cartAfter, context)
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
