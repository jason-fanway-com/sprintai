/**
 * menu-readiness — the readiness gate (docs/specs/2026-09-07-conversation-
 * ready-menu-design.md §8, §11 item 5).
 *
 * §8.1 (item state) and §8.2 (the 8 menu-level invariants) are NOT
 * reimplemented here — they already exist as pure, tested functions in
 * ./compile-menu.ts (item 4, commit 24d7275): `compileItem`/`compileMenu`
 * compute `bot_state` per item (§8.1), and `computeMenuInvariants` runs all
 * 8 §8.2 checks and returns pass/fail + the specific violating rows per
 * check. This module reuses both unchanged rather than duplicating them.
 *
 * What's new here is §8.3 — the generated menu walk. For every `orderable`
 * item it synthesizes and executes the walk() case from the spec against
 * the REAL production code, no LLM, no synthetic shortcuts:
 *   - phrase-split.ts's splitCustomerPhrases + resolveClaimedPhraseIndex
 *     (item "P0 pepperoni-bleed") are the actual functions
 *     chat-sms/index.ts calls to turn one customer message into phrase
 *     boundaries and to validate a per-item modifier scope claim.
 *   - ask-plan-engine.ts's applyCompiledAddItem (item 8) is the actual
 *     sequencer + cart-mutation code the live compiled-item ordering path
 *     calls — reused here unchanged to answer each ask_plan step and build
 *     a real, priced cart line.
 *   - pricing.ts's computeCartSubtotalCents cross-checks the line total.
 *   - itemizer.ts's renderItemizedRecap renders the real ticket text.
 *
 * REWIRED (2026-09-10): this walk used to resolve free text to an item id
 * and its named modifiers via chat-sms/resolver.ts. resolver.ts is dead
 * code — grep confirms zero call sites for resolveUtterance/resolvePhrase
 * anywhere in chat-sms/index.ts's live import tree, today or historically
 * (see docs/PO-BRIEF.md §8, "a module list is not an architecture, check
 * the import path"). Every gate report produced while this module called
 * resolver.ts was certifying a code path a real customer message can never
 * reach. There is no deterministic replacement for resolver.ts's job of
 * "which item id does this free text name" — in production that decision
 * is made by the LLM's own tool call (chat-sms/index.ts destructures
 * `menu_item_id` straight off the model's `add_item` tool input; there is
 * no text -> item-id function in the live path at all). This walk cannot
 * invoke an LLM (spec's own "no LLM" constraint), so it supplies the
 * already-known ground-truth item id per phrase directly — the same
 * simplification resolver.ts's stand-in made, just without a fake resolver
 * in between. What IS real and IS exercised now: the phrase-boundary
 * splitting and the modifier-scope-per-phrase logic (splitCustomerPhrases /
 * resolveClaimedPhraseIndex / the modifierScopeText derivation), copied
 * verbatim from chat-sms/index.ts's own add_item handler, and
 * ask-plan-engine.ts's modelAssertedChoiceTexts contract — the ONLY channel
 * production uses to resolve a modifier (free-text modifier scanning was
 * deliberately removed from resolveAskPlan, see that function's own "Rank-2
 * fix" comment). The walk simulates a model that correctly names its item
 * and correctly asserts the modifier it read, then checks whether the REAL
 * phrase-scoping code still keeps modifiers from bleeding across items —
 * that is the actual, current production defect class this walk exists to
 * catch, not resolver.ts's fuzzy word matching.
 *
 * cart.ts (item 2) is NOT used here: every function it exports is a
 * hallucination GUARD — it verifies an LLM's free-text reply against
 * already-known cart state (claimsItemInCart, findMissingCartItems,
 * replyAcknowledgesCart, isClosingReply, ...). The walk never produces an
 * LLM reply to check, so none of those functions have anything to operate
 * on. The module that actually turns ask_plan steps + customer text into a
 * cart line is ask-plan-engine.ts, which is what's used instead.
 */

import {
  type AskPlan,
  type CompileItem,
  type CompiledItem,
  type MenuInvariantResult,
} from "./compile-menu.ts";
import { splitCustomerPhrases, resolveClaimedPhraseIndex } from "../chat-sms/phrase-split.ts";
import {
  applyCompiledAddItem,
  allSlotsResolved,
  type CompiledCartLine,
  type CompiledMenuItem,
} from "../chat-sms/ask-plan-engine.ts";
import { computeCartSubtotalCents, type PricedCartLine } from "../chat-sms/pricing.ts";
import { renderItemizedRecap, type ItemizedCartLine } from "../chat-sms/itemizer.ts";
import { SERVICE_FEE_CENTS } from "./connect.ts";

// ── §8.1 state summary (thin wrapper over compile-menu.ts's own bot_state) ──

export interface ItemStateCounts {
  orderable: number;
  blocked: number;
  display_only: number;
  stale: number;
  total_active: number;
}

export function summarizeItemStates(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
): ItemStateCounts {
  const active = items.filter(i => i.active);
  const counts: ItemStateCounts = { orderable: 0, blocked: 0, display_only: 0, stale: 0, total_active: active.length };
  for (const i of active) {
    const state = compiled.get(i.id)?.bot_state;
    if (state && state in counts) (counts as unknown as Record<string, number>)[state]++;
  }
  return counts;
}

// ── §8.3 the generated menu walk ────────────────────────────────────────────

export interface WalkFailure {
  step: string;
  detail: string;
}

export interface WalkResult {
  item_id: string;
  display_name: string;
  pass: boolean;
  failures: WalkFailure[];
  cart_line_price_cents: number | null;
  cart_total_with_fee_cents: number | null;
  ticket_text: string | null;
}

export interface MenuWalkReport {
  total_orderable: number;
  passed: number;
  failed: number;
  results: WalkResult[];
}

/**
 * Execute the §8.3 walk for exactly one orderable item against the real
 * resolver + compiled-item engine + pricing + itemizer code. Returns a
 * structured pass/fail with the specific step that broke, not just a
 * boolean — per the task's own requirement, mirroring how
 * computeMenuInvariants reports violating rows rather than a bare pass/fail.
 */
export function runItemWalk(
  item: CompileItem,
  compiledItem: CompiledItem,
): WalkResult {
  const failures: WalkFailure[] = [];
  const askPlan: AskPlan = compiledItem.ask_plan;
  const empty: WalkResult = {
    item_id: item.id,
    display_name: askPlan.display_name,
    pass: false,
    failures,
    cart_line_price_cents: null,
    cart_total_with_fee_cents: null,
    ticket_text: null,
  };

  // ── Build the real cart line via the compiled add-item engine (item 8) ──
  // Item id is known ground truth (this walk is testing exactly this item),
  // mirroring chat-sms/index.ts's own add_item handler, which likewise never
  // derives an item id from text — it reads `menu_item_id` straight off the
  // model's tool call. What's real here is the ask-plan-engine.ts sequencer
  // this call feeds into, unchanged from production.
  const cart: CompiledCartLine[] = [];
  const engineMenuItem: CompiledMenuItem = {
    ask_plan: askPlan,
    bot_state: compiledItem.bot_state,
    option_groups: item.groups.map(g => ({ id: g.id, name: g.name, default_choice_id: g.default_choice_id })),
  };

  const addResult = applyCompiledAddItem(cart, engineMenuItem, item.id, 1, askPlan.display_name, null);
  if (!addResult.ok || cart.length !== 1) {
    failures.push({ step: "add-item", detail: `applyCompiledAddItem failed or produced ${cart.length} cart lines: ${JSON.stringify(addResult.result)}` });
    return empty;
  }

  // ── apply_default / auto_single: must already be resolved with zero dialogue ──
  const firstCallResolvedIds = new Set(Object.keys(cart[0].ask_plan_selections ?? {}));
  for (const step of askPlan.steps) {
    if (step.kind !== "slot") continue;
    if (step.ask_mode === "auto_single" && !firstCallResolvedIds.has(step.group_id)) {
      failures.push({ step: `auto_single:${step.group_id}`, detail: "auto_single slot was not silently resolved on add" });
    }
    const groupHasDefault = item.groups.find(g => g.id === step.group_id)?.default_choice_id;
    if (step.ask_mode === "apply_default" && groupHasDefault && !firstCallResolvedIds.has(step.group_id)) {
      failures.push({ step: `apply_default:${step.group_id}`, detail: "apply_default slot with a configured default was not silently resolved on add" });
    }
  }

  // ── for step in ask_plan.steps: ask -> answer with choices[0].display ──
  const slotSteps = askPlan.steps.filter(s => s.kind === "slot");
  let guard = 0;
  for (;;) {
    const line = cart[0];
    const resolvedIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
    if (allSlotsResolved(askPlan, resolvedIds)) break;
    guard++;
    if (guard > slotSteps.length + 2) {
      failures.push({ step: "ask-loop", detail: `slot resolution did not converge after ${guard} turns; resolved=${[...resolvedIds]}` });
      break;
    }
    const nextStep = slotSteps.find(s => !resolvedIds.has(s.group_id));
    if (!nextStep || nextStep.choices.length === 0) {
      failures.push({ step: "ask-loop", detail: `no answerable next step found; resolved=${[...resolvedIds]}` });
      break;
    }
    const answerText = nextStep.choices[0].display;
    const beforeSize = resolvedIds.size;
    const stepResult = applyCompiledAddItem(cart, engineMenuItem, item.id, 1, answerText, null);
    const afterIds = new Set(Object.keys(cart[0].ask_plan_selections ?? {}));
    if (!stepResult.ok || !afterIds.has(nextStep.group_id) || afterIds.size <= beforeSize) {
      failures.push({
        step: `ask:${nextStep.slot_key ?? nextStep.group_id}`,
        detail: `answering "${answerText}" (choices[0].display) did not record a selection for group ${nextStep.group_id}`,
      });
      break; // don't loop forever on a step that can't be answered
    }
  }

  const line = cart[0];
  const resolvedGroupIds = new Set(Object.keys(line.ask_plan_selections ?? {}));

  // ── unfilled_required_groups() == [] ─────────────────────────────────────
  if (!allSlotsResolved(askPlan, resolvedGroupIds)) {
    const unfilled = slotSteps.filter(s => !resolvedGroupIds.has(s.group_id)).map(s => s.slot_key ?? s.group_id);
    failures.push({ step: "unfilled-required-groups", detail: `still-open required slots: ${unfilled.join(", ")}` });
  }

  // ── offer_once / modifier steps: never mentioned -> never applied ("no thanks") ──
  for (const step of askPlan.steps) {
    if (step.kind === "modifier" && resolvedGroupIds.has(step.group_id)) {
      failures.push({ step: `offer_once:${step.group_id}`, detail: "modifier was applied without ever being requested by the walk" });
    }
  }

  // ── total == base + Σ deltas (+ consumer fee) ────────────────────────────
  let expectedDelta = 0;
  const selectedDisplays: string[] = [];
  for (const step of askPlan.steps) {
    for (const choiceId of selectionIds(line.ask_plan_selections?.[step.group_id])) {
      const choice = step.choices.find(c => c.id === choiceId);
      if (!choice) {
        failures.push({ step: "pricing", detail: `selection ${choiceId} on group ${step.group_id} does not reference a real ask_plan choice` });
        continue;
      }
      expectedDelta += choice.price_delta_cents;
      selectedDisplays.push(choice.display);
    }
  }
  const expectedLineTotal = askPlan.base_price_cents + expectedDelta;
  if (line.price_cents !== expectedLineTotal) {
    failures.push({
      step: "pricing",
      detail: `cart line price_cents ${line.price_cents} !== base ${askPlan.base_price_cents} + Σdeltas ${expectedDelta} = ${expectedLineTotal}`,
    });
  }
  const subtotalCents = computeCartSubtotalCents(cart as unknown as PricedCartLine[]);
  if (subtotalCents !== line.price_cents) {
    failures.push({ step: "pricing-subtotal", detail: `computeCartSubtotalCents ${subtotalCents} !== single line's price_cents ${line.price_cents}` });
  }
  const totalWithFeeCents = subtotalCents + SERVICE_FEE_CENTS;

  // ── ticket text contains every selection's display_name, never the raw
  // internal name when it differs from display_name ──────────────────────
  const ticketText = renderItemizedRecap(cart as unknown as ItemizedCartLine[]);
  for (const d of selectedDisplays) {
    if (!ticketText.includes(d)) {
      failures.push({ step: "ticket-text", detail: `ticket text missing selection display_name "${d}"` });
    }
  }
  const displayDiffersFromRawName = item.name !== askPlan.display_name;
  const rawNameIsSubstringOfDisplay = askPlan.display_name.includes(item.name);
  if (displayDiffersFromRawName && !rawNameIsSubstringOfDisplay && ticketText.includes(item.name)) {
    failures.push({ step: "ticket-text-leak", detail: `ticket text contains raw internal name "${item.name}" though display_name is "${askPlan.display_name}"` });
  }

  return {
    item_id: item.id,
    display_name: askPlan.display_name,
    pass: failures.length === 0,
    failures,
    cart_line_price_cents: line.price_cents,
    cart_total_with_fee_cents: totalWithFeeCents,
    ticket_text: ticketText,
  };
}

/** Run the §8.3 walk for every orderable item in the compiled menu. */
export function runMenuWalk(items: CompileItem[], compiled: Map<string, CompiledItem>): MenuWalkReport {
  const orderable = items.filter(i => compiled.get(i.id)?.bot_state === "orderable");
  const results = orderable.map(i => runItemWalk(i, compiled.get(i.id)!));
  return {
    total_orderable: orderable.length,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results,
  };
}

// ── §8.4 the generated MULTI-ITEM menu walk ─────────────────────────────────
//
// runItemWalk/runMenuWalk above prove every orderable item is individually
// orderable — one item, one cart line. They have never once built a cart
// with more than one line, which is exactly the shape of the real P0 defect
// (a topping named for one pizza bleeding onto another pizza in the same
// multi-item order) that kept recurring while this gate reported "passes."
// This section closes that gap: for each shop's own compiled menu, it
// generates real multi-item, multi-phrasing utterances and runs them through
// the SAME functions chat-sms/index.ts's live add_item handler calls —
// chat-sms/phrase-split.ts's splitCustomerPhrases + resolveClaimedPhraseIndex
// compute this turn's phrase boundaries and validate each per-item modifier-
// scope claim, and ask-plan-engine.ts's applyCompiledAddItem (item 8) turns
// each planned item into a real, priced cart line via that same scoping,
// pricing.ts cross-checks the subtotal, itemizer.ts renders the real ticket
// text. No LLM, no live HTTP call to chat-sms — same reasoning as
// runItemWalk's own header comment.
//
// HONESTY NOTE (read before trusting a "pass" here as proof the live bot is
// fixed): there is no deterministic function anywhere in chat-sms/index.ts's
// live import tree that turns free text into a menu item id or a modifier
// selection — the LLM's own tool call supplies `menu_item_id` and the
// asserted `modifiers`/`options` directly; index.ts only ever validates
// those claims (resolveClaimedPhraseIndex, matchAssertedChoice), it never
// derives them. This walk cannot invoke an LLM (the gate's own no-LLM
// constraint), so it supplies each planned item's real id and its intended
// modifier's real display name directly — simulating a model that read the
// phrase correctly — and then runs that simulated call through the REAL
// scoping/validation code path. A "pass" here proves the deterministic
// phrase-boundary + modifier-scope + cart-mutation code is correct GIVEN a
// model that identifies items and names modifiers correctly; it does not,
// by itself, prove the model always does — that is a live-LLM-quality
// question this gate is not built to answer.

export interface MultiItemCaseResult {
  case_id: string;
  case_type: string;
  phrasing: string;
  utterance: string;
  pass: boolean;
  failures: WalkFailure[];
  expected_line_count: number;
  actual_line_count: number;
  subtotal_cents: number | null;
  ticket_text: string | null;
}

export interface MultiItemWalkReport {
  total_cases: number;
  passed: number;
  failed: number;
  skipped_case_types: string[];
  results: MultiItemCaseResult[];
}

interface ComposedPick {
  item: CompileItem;
  askPlan: AskPlan;
  modStep: AskPlan["steps"][number];
}

interface PlannedItem {
  item: CompileItem;
  askPlan: AskPlan;
  phraseText: string;
  intendedModifierChoiceIds: Set<string>;
}

// Items whose own display name contains "with" are excluded from case
// generation entirely. LEGACY REASON (2026-09-10 rewire): this guarded
// against chat-sms/resolver.ts's dead-code "with X" clause-splitting, which
// this module no longer calls — the real pipeline (splitCustomerPhrases +
// modelAssertedChoiceTexts) has no equivalent "with"-parsing step to break.
// Left in place rather than removed in this pass to keep the rewire scoped
// to the resolution mechanism, not case-generation coverage; revisit
// separately if broader "with"-named-item coverage is wanted.
function hasWithInName(displayName: string): boolean {
  return /\bwith\b/i.test(displayName);
}

function findComposedItems(orderable: CompileItem[], compiled: Map<string, CompiledItem>): ComposedPick[] {
  const out: ComposedPick[] = [];
  for (const it of orderable) {
    const c = compiled.get(it.id);
    if (!c) continue;
    if (hasWithInName(c.ask_plan.display_name)) continue;
    const modStep = c.ask_plan.steps.find(s => s.kind === "modifier" && s.choices.length > 0);
    if (modStep) out.push({ item: it, askPlan: c.ask_plan, modStep });
  }
  return out;
}

function findPlainItems(orderable: CompileItem[], compiled: Map<string, CompiledItem>): CompileItem[] {
  return orderable.filter(it => {
    const c = compiled.get(it.id);
    if (!c) return false;
    if (hasWithInName(c.ask_plan.display_name)) return false;
    return !c.ask_plan.steps.some(s => s.kind === "modifier");
  });
}

function toPlanned(
  it: CompileItem,
  compiled: Map<string, CompiledItem>,
  modifier?: { choice: { id: string; display: string } },
): PlannedItem | null {
  const c = compiled.get(it.id);
  if (!c) return null;
  const askPlan = c.ask_plan;
  const phraseText = modifier ? `${askPlan.display_name} with ${modifier.choice.display}` : askPlan.display_name;
  const intendedModifierChoiceIds = new Set<string>(modifier ? [modifier.choice.id] : []);
  return { item: it, askPlan, phraseText, intendedModifierChoiceIds };
}

function buildTwoDifferentCategories(
  orderable: CompileItem[],
  compiled: Map<string, CompiledItem>,
  composed: ComposedPick[],
): PlannedItem[] | null {
  const a = composed[0];
  if (!a) {
    for (const x of orderable) {
      const y = orderable.find(cand => cand.id !== x.id && (cand.category ?? "") !== (x.category ?? "") && !hasWithInName(compiled.get(cand.id)?.ask_plan.display_name ?? ""));
      if (y) {
        const p1 = toPlanned(x, compiled);
        const p2 = toPlanned(y, compiled);
        if (p1 && p2) return [p1, p2];
      }
    }
    return null;
  }
  const b = orderable.find(cand =>
    cand.id !== a.item.id &&
    (cand.category ?? "") !== (a.item.category ?? "") &&
    !hasWithInName(compiled.get(cand.id)?.ask_plan.display_name ?? ""),
  );
  if (!b) return null;
  const p1 = toPlanned(a.item, compiled, { choice: a.modStep.choices[0] });
  const p2 = toPlanned(b, compiled);
  if (!p1 || !p2) return null;
  return [p1, p2];
}

function buildFourItemsWithModifier(
  orderable: CompileItem[],
  compiled: Map<string, CompiledItem>,
  composed: ComposedPick[],
): PlannedItem[] | null {
  const a = composed[0];
  if (!a) return null;
  const others = orderable.filter(it => it.id !== a.item.id && !hasWithInName(compiled.get(it.id)?.ask_plan.display_name ?? "")).slice(0, 3);
  if (others.length < 3) return null;
  const planned: (PlannedItem | null)[] = [toPlanned(a.item, compiled, { choice: a.modStep.choices[0] })];
  for (const o of others) planned.push(toPlanned(o, compiled));
  if (planned.some(p => p === null)) return null;
  return planned as PlannedItem[];
}

function buildTwoSameItemDifferentModifiers(
  compiled: Map<string, CompiledItem>,
  composed: ComposedPick[],
): PlannedItem[] | null {
  const candidate = composed.find(c => c.modStep.choices.length >= 2);
  if (!candidate) return null;
  const p1 = toPlanned(candidate.item, compiled, { choice: candidate.modStep.choices[0] });
  const p2 = toPlanned(candidate.item, compiled, { choice: candidate.modStep.choices[1] });
  if (!p1 || !p2) return null;
  return [p1, p2];
}

function buildItemPlusPlain(
  compiled: Map<string, CompiledItem>,
  composed: ComposedPick[],
  plain: CompileItem[],
): PlannedItem[] | null {
  const a = composed[0];
  if (!a) return null;
  const b = plain.find(it => it.id !== a.item.id);
  if (!b) return null;
  const p1 = toPlanned(a.item, compiled, { choice: a.modStep.choices[0] });
  const p2 = toPlanned(b, compiled);
  if (!p1 || !p2) return null;
  return [p1, p2];
}

interface PhrasingStyle {
  key: string;
  build: (parts: string[]) => string;
}

// The 5 required phrasing forms (item 5 follow-up spec). Each takes the raw
// per-item phrase text (e.g. "Cheese Pizza with Pepperoni") and wraps it in
// a distinct quantity/connector style — chat-sms/phrase-split.ts's
// splitCustomerPhrases must isolate each item correctly under every one of
// these (the real function the live add_item handler calls).
const PHRASING_STYLES: PhrasingStyle[] = [
  { key: "comma-digit-qty", build: parts => parts.map(p => `1 ${p}`).join(", ") },
  { key: "comma-word-qty", build: parts => parts.map(p => `one ${p}`).join(", ") },
  { key: "and-separated", build: parts => parts.map(p => `one ${p}`).join(" and ") },
  { key: "bare-list", build: parts => parts.join(", ") },
  {
    key: "conversational",
    build: parts => {
      if (parts.length === 1) return `gimme a ${parts[0]}`;
      const lead = parts.slice(0, -1).map(p => `a ${p}`).join(", ");
      return `gimme ${lead}, and a ${parts[parts.length - 1]}`;
    },
  },
];

/**
 * A resolved ask_plan_selections entry is a bare string for the common
 * single-choice case, or a string[] when a modifier group resolved more than
 * one choice (P0 fix 2026-09-10, ask-plan-engine.ts's matchAllAssertedChoices)
 * — normalize to an array so every consumer below handles both uniformly.
 */
function selectionIds(sel: string | string[] | undefined): string[] {
  if (!sel) return [];
  return Array.isArray(sel) ? sel : [sel];
}

/** All of an ask_plan's real modifier-choice displays whose id is in `ids`, in step order. */
function modifierDisplaysForIds(askPlan: AskPlan, ids: Set<string>): string[] {
  if (ids.size === 0) return [];
  const out: string[] = [];
  for (const step of askPlan.steps) {
    if (step.kind !== "modifier") continue;
    for (const choice of step.choices) {
      if (ids.has(choice.id)) out.push(choice.display);
    }
  }
  return out;
}

/**
 * Execute one multi-item, one-phrasing case against the REAL live pipeline:
 * chat-sms/phrase-split.ts's splitCustomerPhrases splits the utterance into
 * phrase boundaries exactly as chat-sms/index.ts does before validating a
 * per-call source_phrase claim; resolveClaimedPhraseIndex is that same
 * validation, run here against each planned item's own phrase text; and
 * ask-plan-engine.ts's applyCompiledAddItem builds each resulting cart line,
 * fed the modifierScopeText/modelAssertedChoiceTexts a correctly-behaving
 * model would produce (see this module's header comment for why item-id and
 * modifier-assertion can't themselves be produced by a deterministic
 * resolver — there isn't one in production; the LLM decides both). Then
 * assert:
 *   - correct line count (no silent merge, no dropped phrase)
 *   - each line's MODIFIER selections are exactly the ones its own phrase
 *     named — nothing missing, nothing leaked in from another phrase or from
 *     the item's own name colliding with a modifier choice
 *   - no single modifier choice id ever resolves onto more than one cart line
 *   - subtotal (pricing.ts's computeCartSubtotalCents) equals the sum of the
 *     individual lines, and each line's own price equals its own base +
 *     resolved deltas (same discipline as runItemWalk's pricing check)
 */
function runMultiItemCase(
  caseType: string,
  phrasingKey: string,
  utterance: string,
  planned: PlannedItem[],
): MultiItemCaseResult {
  const failures: WalkFailure[] = [];
  const caseId = `${caseType}:${phrasingKey}`;

  // ── Real phrase-boundary splitting — the exact function chat-sms/index.ts
  // calls to compute this turn's phrase boundaries before it ever validates
  // a per-call source_phrase claim. ────────────────────────────────────────
  const turnPhrases = splitCustomerPhrases(utterance);
  if (turnPhrases.length !== planned.length) {
    failures.push({
      step: "phrase-split",
      detail: `expected ${planned.length} phrase(s) for "${utterance}", splitCustomerPhrases produced ${turnPhrases.length}: ${JSON.stringify(turnPhrases)}`,
    });
  }

  const cart: CompiledCartLine[] = [];
  const opToLineIndex: (number | null)[] = [];
  // Shared across every add_item call in this simulated turn — mirrors
  // chat-sms/index.ts's consumedModifierChoiceIdsForTurn, created once per
  // turn and threaded through every add_item call that turn makes.
  const consumedModifierChoiceIds = new Set<string>();

  for (let idx = 0; idx < planned.length; idx++) {
    const p = planned[idx];
    const askPlan = p.askPlan;
    // Every planned item comes from the caller's `orderable` list — bot_state
    // is always "orderable" by construction, no lookup needed.
    const engineMenuItem: CompiledMenuItem = {
      ask_plan: askPlan,
      bot_state: "orderable",
      option_groups: p.item.groups.map(g => ({ id: g.id, name: g.name, default_choice_id: g.default_choice_id })),
    };

    // A model that correctly read this phrase supplies this item's real id
    // directly (chat-sms/index.ts destructures `menu_item_id` straight off
    // the tool call — there is no text-to-item-id resolver in the live path
    // to test here) and claims, via `source_phrase`, the words of its own
    // message that name this item. The walk's claim is its own phraseText
    // (not the literal split phrase), so resolveClaimedPhraseIndex's real
    // substring-validation logic is actually exercised here, not trivially
    // short-circuited by an exact match.
    const phraseIndex = resolveClaimedPhraseIndex(turnPhrases, p.phraseText);
    if (phraseIndex !== null && phraseIndex !== idx) {
      failures.push({
        step: `phrase-index-mismatch:${idx}`,
        detail: `resolveClaimedPhraseIndex matched phrase claim "${p.phraseText}" to turn-phrase index ${phraseIndex}, expected ${idx} (turnPhrases: ${JSON.stringify(turnPhrases)})`,
      });
    }
    if (phraseIndex === null && turnPhrases.length > 1) {
      failures.push({
        step: `phrase-index-unresolved:${idx}`,
        detail: `resolveClaimedPhraseIndex could not uniquely match phrase claim "${p.phraseText}" against turn-phrases ${JSON.stringify(turnPhrases)} — modifierScopeText will be empty this call, same as production`,
      });
    }
    // Copied verbatim from chat-sms/index.ts's own add_item handler.
    const modifierScopeText = turnPhrases.length <= 1
      ? undefined
      : (phraseIndex !== null ? turnPhrases[phraseIndex] : "");

    // A correctly-behaving model asserts the modifier(s) it read for this
    // item by exact display name — resolveAskPlan's ONLY channel for
    // resolving a modifier (free-text modifier scanning was deliberately
    // removed, see ask-plan-engine.ts's "Rank-2 fix" comment).
    const modelAssertedChoiceTexts = modifierDisplaysForIds(askPlan, p.intendedModifierChoiceIds);

    const sizeBefore = cart.length;
    const addResult = applyCompiledAddItem(
      cart, engineMenuItem, p.item.id, 1, utterance, null,
      consumedModifierChoiceIds, modelAssertedChoiceTexts, modifierScopeText,
      phraseIndex ?? undefined,
    );
    if (!addResult.ok) {
      failures.push({ step: `multi-add:${idx}`, detail: `applyCompiledAddItem failed for phrase "${p.phraseText}": ${JSON.stringify(addResult.result)}` });
      opToLineIndex.push(null);
      continue;
    }
    if (cart.length !== sizeBefore + 1) {
      failures.push({ step: `multi-add:${idx}`, detail: `expected a new cart line for phrase "${p.phraseText}" (item ${p.item.id}); cart length went ${sizeBefore} -> ${cart.length} (likely merged into an existing line)` });
      opToLineIndex.push(cart.length > 0 ? cart.length - 1 : null);
      continue;
    }
    const lineIndex = cart.length - 1;
    opToLineIndex.push(lineIndex);

    // Ask-loop: resolve any still-open required slots with choices[0].display,
    // exactly like runItemWalk's single-item walk.
    const slotSteps = askPlan.steps.filter(s => s.kind === "slot");
    let guard = 0;
    for (;;) {
      const line = cart[lineIndex];
      const resolvedIds = new Set(Object.keys(line.ask_plan_selections ?? {}));
      if (allSlotsResolved(askPlan, resolvedIds)) break;
      guard++;
      if (guard > slotSteps.length + 2) {
        failures.push({ step: `multi-ask-loop:${idx}`, detail: `slot resolution for ${p.item.id} (phrase "${p.phraseText}") did not converge after ${guard} turns` });
        break;
      }
      const nextStep = slotSteps.find(s => !resolvedIds.has(s.group_id));
      if (!nextStep || nextStep.choices.length === 0) {
        failures.push({ step: `multi-ask-loop:${idx}`, detail: `no answerable next step for ${p.item.id}` });
        break;
      }
      const answerText = nextStep.choices[0].display;
      const beforeSize = resolvedIds.size;
      const stepResult = applyCompiledAddItem(cart, engineMenuItem, p.item.id, 1, answerText, null, consumedModifierChoiceIds);
      const afterIds = new Set(Object.keys(cart[lineIndex].ask_plan_selections ?? {}));
      if (!stepResult.ok || !afterIds.has(nextStep.group_id) || afterIds.size <= beforeSize) {
        failures.push({ step: `multi-ask:${idx}:${nextStep.slot_key ?? nextStep.group_id}`, detail: `answering "${answerText}" for ${p.item.id} did not record a selection` });
        break;
      }
    }
  }

  // ── Assertion: correct line count ──────────────────────────────────────
  if (cart.length !== planned.length) {
    failures.push({ step: "line-count", detail: `expected ${planned.length} cart lines for "${utterance}", got ${cart.length}` });
  }

  // ── Assertion: modifier isolation — each line carries EXACTLY the
  // modifier(s) its own phrase named, nothing missing, nothing leaked ─────
  for (let idx = 0; idx < planned.length; idx++) {
    const lineIndex = opToLineIndex[idx];
    if (lineIndex === null || !cart[lineIndex]) continue; // already reported above
    const line = cart[lineIndex];
    const askPlan = planned[idx].askPlan;
    const modifierChoiceIds = new Set<string>();
    for (const step of askPlan.steps) {
      if (step.kind !== "modifier") continue;
      for (const choiceId of selectionIds(line.ask_plan_selections?.[step.group_id])) modifierChoiceIds.add(choiceId);
    }
    const intended = planned[idx].intendedModifierChoiceIds;
    const missing = [...intended].filter(id => !modifierChoiceIds.has(id));
    const extra = [...modifierChoiceIds].filter(id => !intended.has(id));
    if (missing.length > 0) {
      failures.push({ step: `modifier-missing:${idx}`, detail: `phrase "${planned[idx].phraseText}" (item ${planned[idx].item.id}) is missing intended modifier choice id(s): ${missing.join(", ")}` });
    }
    if (extra.length > 0) {
      failures.push({ step: `modifier-leakage:${idx}`, detail: `phrase "${planned[idx].phraseText}" (item ${planned[idx].item.id}) picked up unintended modifier choice id(s): ${extra.join(", ")} — cross-line/self-name leakage` });
    }
  }

  // ── Assertion: no MODIFIER choice id resolves on more than one line ──────
  // (SLOT choices legitimately repeat across lines — two independent pizzas
  // can both be "Large" — so only modifier-kind selections are checked here;
  // the missing/extra check above already covers per-line correctness.)
  const modifierChoiceIdToLines = new Map<string, number[]>();
  for (let idx = 0; idx < planned.length; idx++) {
    const lineIndex = opToLineIndex[idx];
    if (lineIndex === null || !cart[lineIndex]) continue;
    const line = cart[lineIndex];
    const askPlan = planned[idx].askPlan;
    for (const step of askPlan.steps) {
      if (step.kind !== "modifier") continue;
      for (const choiceId of selectionIds(line.ask_plan_selections?.[step.group_id])) {
        const arr = modifierChoiceIdToLines.get(choiceId) ?? [];
        arr.push(lineIndex);
        modifierChoiceIdToLines.set(choiceId, arr);
      }
    }
  }
  for (const [choiceId, lines] of modifierChoiceIdToLines) {
    if (lines.length > 1) {
      failures.push({ step: "cross-line-duplicate-selection", detail: `modifier choice id ${choiceId} was resolved on ${lines.length} different cart lines (indices ${lines.join(",")}) for "${utterance}"` });
    }
  }

  // ── Assertion: subtotal == sum of the lines; each line's own price ==
  // its own base + resolved deltas ─────────────────────────────────────────
  let subtotalCents: number | null = null;
  try {
    subtotalCents = computeCartSubtotalCents(cart as unknown as PricedCartLine[]);
    const sumOfLines = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
    if (subtotalCents !== sumOfLines) {
      failures.push({ step: "subtotal", detail: `computeCartSubtotalCents ${subtotalCents} !== sum of line totals ${sumOfLines} for "${utterance}"` });
    }
    for (let idx = 0; idx < planned.length; idx++) {
      const lineIndex = opToLineIndex[idx];
      if (lineIndex === null || !cart[lineIndex]) continue;
      const line = cart[lineIndex];
      const askPlan = planned[idx].askPlan;
      let expectedDelta = 0;
      for (const step of askPlan.steps) {
        for (const choiceId of selectionIds(line.ask_plan_selections?.[step.group_id])) {
          const choice = step.choices.find(c => c.id === choiceId);
          if (choice) expectedDelta += choice.price_delta_cents;
        }
      }
      const expectedLineTotal = askPlan.base_price_cents + expectedDelta;
      if (line.price_cents !== expectedLineTotal) {
        failures.push({ step: `pricing:${idx}`, detail: `line ${idx} (${askPlan.display_name}) price_cents ${line.price_cents} !== base ${askPlan.base_price_cents} + deltas ${expectedDelta}` });
      }
    }
  } catch (e) {
    failures.push({ step: "subtotal", detail: `computeCartSubtotalCents threw: ${String(e)}` });
  }

  let ticketText: string | null = null;
  try {
    ticketText = renderItemizedRecap(cart as unknown as ItemizedCartLine[]);
  } catch (e) {
    failures.push({ step: "ticket-text", detail: `renderItemizedRecap threw: ${String(e)}` });
  }

  return {
    case_id: caseId,
    case_type: caseType,
    phrasing: phrasingKey,
    utterance,
    pass: failures.length === 0,
    failures,
    expected_line_count: planned.length,
    actual_line_count: cart.length,
    subtotal_cents: subtotalCents,
    ticket_text: ticketText,
  };
}

/**
 * §8.4: run the extended multi-item, multi-phrasing walk for a compiled
 * menu. Cases are DERIVED from the shop's own orderable items (never
 * hardcoded item names) — see the 4 buildXxx() functions above. A case type
 * is skipped (not silently counted as a pass) when the shop's menu has no
 * items shaped to support it (e.g. no item with >=2 modifier choices for the
 * "two of the same item, different modifiers" case) — `skipped_case_types`
 * reports exactly which, so a 0-case shop never reads as a clean pass.
 */
export function runMultiItemMenuWalk(items: CompileItem[], compiled: Map<string, CompiledItem>): MultiItemWalkReport {
  const orderable = items.filter(i => compiled.get(i.id)?.bot_state === "orderable");
  const composed = findComposedItems(orderable, compiled);
  const plain = findPlainItems(orderable, compiled);

  const caseBuilders: Array<{ type: string; build: () => PlannedItem[] | null }> = [
    { type: "two-different-categories", build: () => buildTwoDifferentCategories(orderable, compiled, composed) },
    { type: "four-items-with-modifier", build: () => buildFourItemsWithModifier(orderable, compiled, composed) },
    { type: "two-same-item-different-modifiers", build: () => buildTwoSameItemDifferentModifiers(compiled, composed) },
    { type: "item-plus-non-composed", build: () => buildItemPlusPlain(compiled, composed, plain) },
  ];

  const results: MultiItemCaseResult[] = [];
  const skippedCaseTypes: string[] = [];

  for (const { type, build } of caseBuilders) {
    const planned = build();
    if (!planned) {
      skippedCaseTypes.push(type);
      continue;
    }
    for (const style of PHRASING_STYLES) {
      const utterance = style.build(planned.map(p => p.phraseText));
      results.push(runMultiItemCase(type, style.key, utterance, planned));
    }
  }

  return {
    total_cases: results.length,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    skipped_case_types: skippedCaseTypes,
    results,
  };
}

// ── Top-line readiness report combining §8.1 states + §8.2 invariants + §8.3 walk + §8.4 multi-item walk ──

export interface MenuReadinessReport {
  states: ItemStateCounts;
  invariants: MenuInvariantResult[];
  walk: MenuWalkReport;
  multi_item_walk: MultiItemWalkReport;
  orderable_ratio: number;
}

export function computeReadinessReport(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
  invariants: MenuInvariantResult[],
): MenuReadinessReport {
  const states = summarizeItemStates(items, compiled);
  const walk = runMenuWalk(items, compiled);
  const multiItemWalk = runMultiItemMenuWalk(items, compiled);
  return {
    states,
    invariants,
    walk,
    multi_item_walk: multiItemWalk,
    orderable_ratio: states.total_active === 0 ? 1 : states.orderable / states.total_active,
  };
}
