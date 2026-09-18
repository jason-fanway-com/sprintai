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
import { buildConfirmReadback } from "./confirm-readback-20260918.ts";
import {
  impliesUpsellAcceptance,
  impliesUpsellDecline,
  looksLikeCustomerName,
  extractCustomerName,
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
  | { kind: "closure" }
  // 2026-09-18 PO dispatch (address loop, rule 2): "cancel"/"forget it"/
  // "never mind" while address is open must abandon the whole order, not be
  // treated as a failed address (which re-asks the exact same question the
  // customer just tried to escape). The cart is cleared in place by the
  // "address" case below, same mutate-in-place convention the slot/
  // disambiguation cases already use.
  | { kind: "cart_cancelled" };

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

export function impliesClosure(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return false;
  if (BARE_CLOSURE_RE.test(m)) return true;
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
  if (impliesClosure(trimmed) || impliesUpsellDecline(trimmed) || impliesUpsellAcceptance(trimmed)) {
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
    // 00-BK: this is the "Anything else?" state -- open === null -- and it had
    // its OWN closure check, still bare-only, so loosening the shared
    // closureOrAffirmationFallback never touched the single most common loop
    // in the product. The same one-call-site-of-two mistake this engine keeps
    // producing, committed here by the fix for it.
    if (impliesClosure(trimmed)) {
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
      {
        const tip = readTipReply(trimmed);   // 00-BH
        if (tip) return { resolved: true, outcome: { kind: "tip_resolved", tipCents: tip.kind === "amount" ? tip.cents : 0 }, cartChanged: false };
      }
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
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
      return closureOrAffirmationFallback(trimmed) ?? UNRESOLVED;
    }

    case "confirm": {
      if (isExplicitCheckoutIntent(trimmed, "Confirm?", false)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
      if (impliesConfirmDecline(trimmed)) return { resolved: true, outcome: { kind: "confirm_no" }, cartChanged: false };   // 00-BH
      // 00-BE: see isConfirmAffirmative. Decline above wins; negation inside
      // the helper blocks "not yet"/"don't"/"wrong"/"change".
      if (isConfirmAffirmative(trimmed)) return { resolved: true, outcome: { kind: "confirm_yes" }, cartChanged: false };
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

function itemSpanNamedInMessage(span: string, customerMessage: string | undefined): boolean {
  if (customerMessage === undefined) return true;
  const tokenize = (t: string): string[] =>
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).map(singularizeSpanToken);
  const spanTokens = tokenize(span);
  if (spanTokens.length === 0) return false;
  const messageTokenSet = new Set(tokenize(customerMessage));
  return spanTokens.every(t => messageTokenSet.has(t));
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
  for (const add of proposal.adds ?? []) {
    const guardPassed = itemSpanNamedInMessage(add.item_span, customerMessage);
    // Always resolve (even on guard failure) so the guard-drop path can check
    // whether the resolved item is already in cart without a second pass.
    const resolution = resolveItem(add.item_span, lexicon);
    if (!guardPassed) {
      // Guard-dropped: the span's tokens were not in the customer's message —
      // the model referenced an item the customer never named this turn.
      // 2026-09-18 PO dispatch (two-regressions item b): "didn't catch" is
      // for truly unresolved spans; a guard-dropped add must never say that.
      // If the item resolves AND is already in cart: silent (the model was
      // echoing an item it could see in state — a harmless restatement the
      // customer neither asked for nor would notice). Otherwise ask once
      // without guessing — "Did you want a X as well?" — the customer can
      // confirm or ignore; no item is ever added without explicit confirmation.
      const span = (add.item_span ?? "").trim();
      const inCart = resolution.kind === "resolved"
        && menuItemIdsAlreadyInCart.has(resolution.menu_item_id);
      if (!inCart && span) {
        declines.push({ reason: `Did you want a ${span} as well?` });
      }
    } else if (resolution.kind === "resolved") {
      resolvedAdds.push({ menu_item_id: resolution.menu_item_id, quantity: add.quantity, choices: add.choices, item_span: add.item_span });
    } else if (resolution.kind === "ambiguous") {
      ambiguousSpans.push(resolution.candidates);
    } else {
      // 00-AX: NAME the span. The customer's own words are right here in
      // add.item_span and were being thrown away. An anonymous "what item
      // that was" is why a customer who ordered two things restates BOTH --
      // which re-adds the one that DID resolve (the "- now 2" inflation) and
      // fails again on the one that didn't. Live: "2 bowls of the Soup of the
      // Day and an Italian sandwich on wheat" -- soup added, sandwich never,
      // and the customer was never told which half failed.
      const span = (add.item_span ?? "").trim();
      declines.push({
        reason: span
          ? `Sorry, I didn't catch "${span}" — mind saying it again?`
          : "Sorry, I didn't catch what item that was — mind saying it again?",
      });
      unresolvedSpans.push(span);
    }
  }
  if (ambiguousSpans.length > 0) {
    disambiguationCandidateIds = ambiguousSpans[0];
    carriedDisambiguationCandidateIds = ambiguousSpans.slice(1);
  }

  // See dropAddsSupersededByCorrection's own header: "add a side salad...
  // Just the house salad" resolves BOTH real items — this drops the one the
  // customer's own words retracted, before either ever reaches grouping.
  const survivingAdds = dropAddsSupersededByCorrection(resolvedAdds, customerMessage);

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

  return { cart: nextCart, declines, unresolvedSpans, qualifyingAddMenuItemId, disambiguationCandidateIds, carriedDisambiguationCandidateIds };
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
  // 2026-09-18 PO dispatch (address loop, rule 2): true when THIS turn's
  // ANSWER resolved to cart_cancelled ("cancel"/"forget it" while address
  // was open). Never persisted — a fresh turnEvents object every turn — so
  // it only suppresses priorities 4/5 (address/tip) for the one turn the
  // cancel itself happened on, never on any later turn. Optional so every
  // existing caller/test that predates this field is unaffected.
  cartCancelledThisTurn?: boolean;
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
}

// 00-AU: fixed lead-in for the enumerated-repeat case only — Jason's own
// wording (2026-09-17): "it should just say I'm gonna list the options for
// you and then list the options." Deterministic, code-authored, identical
// every run; never shown on a slot's first ask (renderStepQuestion's default
// `enumerate: false` stays untouched for that case).
const ENUMERATE_SLOT_CHOICES_LEAD_IN = "Let me list the options for you:";

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
            question = context.enumerateSlotChoices
              ? renderStepQuestion(step, menuItem.ask_plan.display_name, true, ENUMERATE_SLOT_CHOICES_LEAD_IN)
              : renderStepQuestion(step, menuItem.ask_plan.display_name);
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
        if (candidates.length > 0) question = renderAmbiguousItemQuestion(candidates);
        break;
      }
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
