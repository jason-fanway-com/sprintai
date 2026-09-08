// Item 8 (docs/specs/2026-09-07-conversation-ready-menu-design.md §7/§11
// item 8): the deterministic sequencer + resolver for items that have been
// compiled (non-null `ask_plan`, produced by
// supabase/functions/_shared/compile-menu.ts, item 4).
//
// Per §7's contract: "Sequencer: input = cart line + ask_plan; output = the
// single next step or complete." and "The model phrases; code decides."
// (P1). This module is pure — no I/O, no Supabase client, no LLM call — so
// it is unit-testable in isolation, matching the convention of
// pending-disambiguation.ts / phantom-add-guard.ts.
//
// SCOPE (revised 2026-09-07 when bug 4 — "buffalo chicken pizza with
// pepperoni" silently dropping the topping and its $3.00 price — was
// escalated as urgent, same session as bugs 1/2/5/7): SLOT groups
// (kind="slot") get the full sequencer treatment — ask/auto_single/
// apply_default, always applying the real price_delta_cents, always the
// single next question. MODIFIER groups (kind="modifier") are matched
// REACTIVELY: if the current message names a real, compiled choice, it's
// applied with its real price (spec Appendix B's worked example: "large
// pepperoni pizza" -> product + size + toppings Pepperoni pre-filled, no
// question asked). This reactive match requires the modifier's group to
// actually be a step in askPlan.steps — compile-menu.ts's stepEligible()
// used to exclude any modifier not pre-classified offer_once (i.e. every
// modifier with an unset/on_request ask_mode, which is most of them until
// item 3's archetype infer runs), which made the group invisible here too,
// not just unasked. Fixed 2026-09-07: stepEligible() now includes every
// group unconditionally, so an on_request modifier is still never asked
// proactively (this loop never sets it as `nextStep`) but IS reactively
// matchable, closing the exact gap bug 4 reported as "still broken."
// What's still NOT built here: the proactive offer_once question ("Any
// toppings on the X? Say which, or 'no' for plain.") for a modifier the
// customer never mentions, and unverified-request tracking for a mentioned
// modifier that doesn't match any real choice (the legacy path's
// `unverified_requests` has no compiled-path equivalent yet — GUARD 12 in
// index.ts covers the false-confirmation half of this from outside the
// engine, since it checks cart_json against the reply text regardless of
// which path added the item). Both are documented follow-ups, not silent
// gaps — a modifier never named this turn is simply not applied, same as
// today's legacy behavior for an unprompted extra.
//
// Reuses significantStems/stemWord from pending-disambiguation.ts rather
// than reimplementing a second matcher, per the standing rule from the
// named-item-removal fix earlier this session ("reuse the resolution
// primitives, don't hand-roll a new ad hoc regex matcher").

import { significantStems } from "./pending-disambiguation.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";

export interface EngineChoice {
  id: string;
  display: string;
  price_delta_cents: number;
}

export interface ResolvedSlot {
  group_id:  string;
  slot_key:  string | null;
  choice:    EngineChoice;
}

export interface EngineResult {
  // Every slot step that could be resolved this turn (auto_single applied
  // silently, apply_default applied from the caller-supplied default map,
  // ask/apply_default-fallback resolved from customer text when it matched).
  resolved: ResolvedSlot[];
  // The single next step the customer still needs to answer, or null if
  // every slot step is resolved. Never more than one at a time (§7, §2.2).
  nextStep: CompiledStep | null;
  // Sum of resolved slots' price_delta_cents. Caller adds this to
  // ask_plan.base_price_cents (+ any modifier deltas handled separately by
  // the legacy path) to get the cart line's price_cents.
  totalDeltaCents: number;
}

/**
 * Match free customer text against a step's real, compiled choice list.
 * Deterministic: normalizes both sides to significant stems (reusing the
 * same stemmer as cart-line/category resolution elsewhere in this
 * codebase) and requires the match to be unambiguous. Never guesses between
 * two plausible choices — returns null rather than pick one, matching the
 * "missing beats wrong" principle (spec P3).
 */
export function matchChoiceInText(choices: EngineChoice[], text: string): EngineChoice | null {
  if (!text || choices.length === 0) return null;
  const textStems = significantStems(text);
  if (textStems.size === 0) return null;

  const hits: EngineChoice[] = [];
  for (const choice of choices) {
    const choiceStems = significantStems(choice.display);
    if (choiceStems.size === 0) continue;
    // Every stem the choice display contributes must appear in the
    // customer's text (so "large" matches a choice displayed "Large" or
    // "Large 18 inch", but "large" alone never matches "Extra Large").
    const allPresent = [...choiceStems].every(s => textStems.has(s));
    if (allPresent) hits.push(choice);
  }

  if (hits.length === 1) return hits[0];
  // Ambiguous (0 or >1 hits) — the sequencer will ask, not guess.
  return null;
}

/** Appendix C: identical wording every run. The LLM never rewrites these. */
const TEMPLATE_QUESTIONS: Record<string, string> = {
  temp:      "How would you like the {display_name} cooked? {choices}.",
  bread:     "What bread for the {display_name}? {choices}.",
  dressing:  "Which dressing on the {display_name}? {choices}.",
  size:      "What size {display_name}? {choices_with_prices}.",
  flavor:    "Which flavor for the {display_name}? {choices}.",
  protein:   "{choices_or} for the {display_name}?",
  bagel:     "Which bagel? {choices}.",
};

/** `{choices}` renders <=6 as "a, b, or c"; more truncates to 5 + "or something else". */
export function renderChoiceList(choices: EngineChoice[], withPrices: boolean): string {
  const names = choices.map(c =>
    withPrices && c.price_delta_cents !== 0
      ? `${c.display} ${formatDelta(c.price_delta_cents)}`
      : withPrices
      ? `${c.display} (no extra charge)`
      : c.display,
  );
  if (names.length > 6) return `${names.slice(0, 5).join(", ")}, or something else`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function formatDelta(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toFixed(2);
  return cents >= 0 ? `+$${dollars}` : `-$${dollars}`;
}

/**
 * Render the exact, deterministic question for a still-open slot step. The
 * LLM's job is to relay this text verbatim (plus, on the first turn only,
 * one warm sentence before it) — never to invent its own wording or option
 * names (spec P5, Appendix C).
 *
 * AUTHORITATIVE FIELD (2026-09-08, item 8 follow-up): reads `prompt_template`,
 * not `slot_key`. Before this fix the two could disagree — slot_key is a raw
 * DB passthrough (compile-menu/index.ts) that stayed null on 494/494 of
 * Zio's option_groups, while prompt_template is always compiler-derived
 * (compile-menu.ts's promptTemplateFor) with a name-based fallback baked in
 * when slot_key is null, so it could read e.g. "size.ask" even while
 * slot_key itself was still null underneath. Looking up slot_key here meant
 * the fallback that already existed one function away was never reached.
 * Deriving the lookup key from prompt_template instead means this function
 * has exactly one source for "what question is this," computed in exactly
 * one place (promptTemplateFor) — the two fields can no longer disagree
 * because only one of them is ever read downstream. slot_key remains the
 * canonical semantic tag for canonical step ordering (SLOT_RANK) and entity
 * keys; it is deliberately not consulted here anymore.
 */
export function renderStepQuestion(step: CompiledStep, displayName: string): string {
  const key = step.prompt_template.split(".")[0] || "";
  const template = TEMPLATE_QUESTIONS[key];
  if (template) {
    return template
      .replace("{display_name}", displayName)
      .replace("{choices_with_prices}", renderChoiceList(step.choices, true))
      .replace("{choices_or}", renderChoiceList(step.choices, false))
      .replace("{choices}", renderChoiceList(step.choices, false));
  }
  // Generic fallback for a slot_key not in the fixed Appendix C list —
  // still fully deterministic, still built only from compiled choices.
  const label = key ? key.replace(/_/g, " ") : "option";
  return `What ${label} would you like for the ${displayName}? ${renderChoiceList(step.choices, true)}.`;
}

/**
 * ITEM 2 (2026-09-08, PO live verification — "turkey sub" x4 produced 4
 * different renderings of the same compiled question: different wording,
 * "(+$8)" vs "(+$8.00)", "-" vs ":" separator, straight vs curly quotes).
 * `renderStepQuestion`'s output reaches the customer today only via a tool-
 * result `instruction` telling the LLM to relay it "verbatim" — a prompt
 * instruction, not a guarantee, and the model reworded it every run. This
 * is a CODE-level guarantee instead, same mechanical shape as index.ts's
 * GUARD 8 (programmatically appending a clause the model's own text is
 * missing): if the model's reply already contains `nextQuestion` byte-for-
 * byte, it's left alone (a warm lead-in before it is fine — spec Appendix
 * C, "may add one warm sentence... first turn only"). Otherwise, any
 * sentence in the model's reply that already named one of the step's real
 * choices is dropped (that's the model's own paraphrase attempt — keeping
 * it alongside the canonical line would show the customer two different,
 * possibly contradictory, renderings of the same question) and the
 * canonical question is appended after whatever warmth is left. Reuses
 * `significantStems` (same primitive `matchChoiceInText` above already
 * uses for choice matching) rather than a new ad hoc quote/format regex —
 * it strips punctuation, so "12"" vs "12''" no longer causes a false miss.
 */
export function enforceVerbatimStepQuestion(
  modelReply: string,
  nextQuestion: string,
  choiceDisplays: string[],
): string {
  if (modelReply.includes(nextQuestion)) return modelReply;

  const choiceStems = new Set(choiceDisplays.flatMap(d => [...significantStems(d)]));
  if (choiceStems.size === 0) return `${modelReply} ${nextQuestion}`.trim();

  const sentences = modelReply.split(/(?<=[.!?])\s+/).filter(Boolean);
  const keptSentences = sentences.filter(s => {
    const sentenceStems = significantStems(s);
    return ![...choiceStems].some(cs => sentenceStems.has(cs));
  });
  const leadIn = keptSentences.join(" ").trim();
  return leadIn ? `${leadIn} ${nextQuestion}` : nextQuestion;
}

/**
 * The sequencer + resolver core. Walks `ask_plan.steps` in canonical order
 * (already sorted by the compiler). For each SLOT step not yet in
 * `alreadyResolvedGroupIds`:
 *   - auto_single  -> apply its one choice silently (it's a fact, not a
 *     question, spec §2.2).
 *   - apply_default -> apply the group's default choice if the caller
 *     supplied one via `defaultChoiceIdByGroup` (chat-sms/index.ts looks
 *     this up from option_groups.default_choice_id, since CompiledStep does
 *     not itself carry which choice is default). If no default is known,
 *     falls back to `ask` rather than silently picking a choice — missing
 *     beats wrong (spec P3).
 *   - ask          -> try resolving from `customerText`; if it doesn't
 *     match unambiguously, this step becomes `nextStep`.
 * Modifier steps (offer_once/on_request) are skipped entirely — see the
 * module-level scope note above.
 */
export function resolveAskPlan(
  askPlan: AskPlan,
  customerText: string,
  alreadyResolvedGroupIds: Set<string>,
  defaultChoiceIdByGroup: Map<string, string>,
  // D1 fix (2026-09-08 P0, PO re-diagnosis — Zio's "1 pepperoni, 1 plain,
  // 1 hawaiian, 1 meat lovers" merge): `customerText` is the WHOLE turn's
  // message (or the whole turn plus one prior turn — see
  // stated-attribute-carryforward.ts), reused unchanged for every add_item
  // call this turn — correct for slots (an attribute stated once should
  // apply to every item named after it, e.g. "large" for a whole pizza
  // list), but WRONG for modifiers: a topping named ONCE for ONE item in an
  // enumerated list would otherwise reactively re-attach itself to every
  // OTHER add_item call for the same base item this turn, since
  // matchChoiceInText has no way to know which segment of the list it's
  // being asked about. Confirmed empirically: two same-item add_item calls
  // ("1 pepperoni" then "1 plain") both resolved identical selections
  // (Size + Add Toppings: Pepperoni) and silently merged into ONE line via
  // the existing identicalExisting quantity-stack below — the customer's
  // "plain" pizza vanished. A modifier choice already granted to an earlier
  // NEW cart line THIS TURN (tracked by the caller in
  // `consumedModifierChoiceIds`, mutated in place across every add_item
  // call in the turn) is not eligible to be reactively re-matched — this
  // call's resolution for that step is left unresolved instead (missing
  // beats wrong, same principle as apply_default falling back to `ask`
  // above), which naturally makes the two calls' selections diverge and
  // produces two real, separate cart lines instead of a false merge.
  consumedModifierChoiceIds?: Set<string>,
): EngineResult {
  const resolved: ResolvedSlot[] = [];
  let nextStep: CompiledStep | null = null;
  let totalDeltaCents = 0;

  for (const step of askPlan.steps) {
    if (alreadyResolvedGroupIds.has(step.group_id)) continue;

    // Modifiers (bug 4, 2026-09-07: "buffalo chicken pizza with pepperoni"
    // silently dropped the topping and its $3.00 price): apply reactively,
    // with the real compiled price, when the SAME message names a real
    // modifier choice — spec Appendix B's worked example ("large pepperoni
    // pizza": product + size + toppings Pepperoni pre-filled, no question
    // asked). Never gates `nextStep` — modifiers never block checkout or
    // get asked proactively here (the full offer_once "ask once" proactive
    // question is a separate, documented follow-up; this is strictly
    // narrower: match-if-mentioned-this-turn, same as a slot, minus the
    // asking).
    if (step.kind === "modifier") {
      const matched = matchChoiceInText(step.choices, customerText);
      if (matched && !consumedModifierChoiceIds?.has(matched.id)) {
        resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: matched });
        totalDeltaCents += matched.price_delta_cents;
      }
      continue;
    }

    if (step.ask_mode === "auto_single" && step.choices.length === 1) {
      const choice = step.choices[0];
      resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice });
      totalDeltaCents += choice.price_delta_cents;
      continue;
    }

    if (step.ask_mode === "apply_default") {
      const defaultId = defaultChoiceIdByGroup.get(step.group_id);
      const defaultChoice = defaultId ? step.choices.find(c => c.id === defaultId) : undefined;
      if (defaultChoice) {
        resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: defaultChoice });
        totalDeltaCents += defaultChoice.price_delta_cents;
        continue;
      }
      // No default resolvable from the data we have — fall through to
      // matching customer text / asking, same as a plain "ask" step.
    }

    const matched = matchChoiceInText(step.choices, customerText);
    if (matched) {
      resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: matched });
      totalDeltaCents += matched.price_delta_cents;
      continue;
    }

    if (!nextStep) nextStep = step;
  }

  return { resolved, nextStep, totalDeltaCents };
}

/** True iff every SLOT step in the plan has a resolution (ignores modifiers). */
export function allSlotsResolved(askPlan: AskPlan, resolvedGroupIds: Set<string>): boolean {
  return askPlan.steps.every(step => step.kind !== "slot" || resolvedGroupIds.has(step.group_id));
}

// ── Structural types for the add_item integration (deliberately minimal —
// index.ts's real CartItem/EffectiveMenuItem satisfy these by structure,
// no explicit cast needed at the call site). ──────────────────────────────

export interface CompiledCartLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  modifiers: string[];
  options?: Record<string, string[]>;
  pending_options?: string[];
  ask_plan_selections?: Record<string, string>;
}

export interface CompiledMenuItem {
  ask_plan: AskPlan;
  bot_state?: string | null;
  option_groups?: Array<{ id: string; name: string; default_choice_id?: string | null }>;
}

export interface CompiledAddItemResult {
  ok: boolean;
  result: unknown;
  cartChanged: boolean;
}

/**
 * The full add_item integration for a compiled item (spec §7/§11 item 8).
 * Extracted as a pure function (cart is mutated in place, matching this
 * codebase's existing executeTool convention, but there is no I/O here —
 * the caller is responsible for `saveCart` when `cartChanged` is true) so
 * it is directly importable and testable, rather than requiring a
 * hand-copied mirror of inline switch-case logic.
 *
 * Scope: SLOT groups only. See this file's header comment for why
 * modifier/offer_once handling is deliberately out of scope here.
 */
export function applyCompiledAddItem(
  cart: CompiledCartLine[],
  menuItem: CompiledMenuItem,
  menuItemId: string,
  quantity: number,
  customerMessage: string,
  shopPhone: string | null | undefined,
  // D1 fix (2026-09-08 P0, see resolveAskPlan's header comment above for the
  // full explanation): shared across every add_item call in ONE turn — the
  // caller (index.ts's runOrderingLoop) creates this once per turn and
  // passes the SAME Set to every call, so a modifier choice already granted
  // to an earlier NEW line this turn can't be reactively re-claimed by a
  // later, otherwise-identical-looking add_item call for the same base
  // item. Optional/undefined at the other call site (index.ts's separate-
  // turn pending-answer resolution) — that path only ever touches one
  // pending line per invocation, never multiple add_item calls sharing one
  // turn's text, so it isn't exposed to this defect and doesn't need it.
  consumedModifierChoiceIds?: Set<string>,
): CompiledAddItemResult {
  const askPlan = menuItem.ask_plan;
  const itemGroups = menuItem.option_groups ?? [];

  if (menuItem.bot_state === "blocked" || menuItem.bot_state === "display_only") {
    const phoneSuffix = shopPhone ? ` — you can call the shop at ${shopPhone}` : "";
    return {
      ok: false,
      cartChanged: false,
      result: { declined: true, error: `The ${askPlan.display_name} isn't available to order by text yet${phoneSuffix}.` },
    };
  }

  const defaultChoiceIdByGroup = new Map<string, string>();
  for (const g of itemGroups) {
    if (g.default_choice_id) defaultChoiceIdByGroup.set(g.id, g.default_choice_id);
  }

  // A cart line for this item is a CONTINUATION (same order, still
  // resolving) iff it exists and doesn't yet have every slot filled.
  // Mirrors the legacy PHANTOM-ADD GUARD's reasoning for the new selections
  // shape: filling a pending slot updates the waiting line; it never spawns
  // a duplicate (spec: "filling a pending group is a resolution of the SAME
  // order, not a repeat order").
  const continuationIdx = cart.findIndex(ci => {
    if (ci.menu_item_id !== menuItemId || !ci.ask_plan_selections) return false;
    return !allSlotsResolved(askPlan, new Set(Object.keys(ci.ask_plan_selections)));
  });

  const priorSelections = continuationIdx >= 0 ? { ...cart[continuationIdx].ask_plan_selections } : {};
  const alreadyResolvedGroupIds = new Set(Object.keys(priorSelections));

  const engineResult = resolveAskPlan(askPlan, customerMessage, alreadyResolvedGroupIds, defaultChoiceIdByGroup, consumedModifierChoiceIds);

  const newSelections: Record<string, string> = { ...priorSelections };
  for (const r of engineResult.resolved) newSelections[r.group_id] = r.choice.id;

  // Record every modifier choice this call resolved as consumed for the
  // rest of this turn (see param doc above) — BEFORE the merge/dedup logic
  // below runs, so it applies regardless of whether this call ends up
  // pushing a new line, filling a continuation, or (now correctly avoided
  // for the reported defect) still finding an identical existing line for
  // some other legitimate reason.
  if (consumedModifierChoiceIds) {
    for (const r of engineResult.resolved) {
      const step = askPlan.steps.find(s => s.group_id === r.group_id);
      if (step?.kind === "modifier") consumedModifierChoiceIds.add(r.choice.id);
    }
  }

  const resolvedOptions: Record<string, string[]> = {};
  let priceCents = askPlan.base_price_cents;
  for (const step of askPlan.steps) {
    const choiceId = newSelections[step.group_id];
    if (!choiceId) continue;
    const choice = step.choices.find(c => c.id === choiceId);
    if (!choice) continue;
    priceCents += choice.price_delta_cents;
    const group = itemGroups.find(g => g.id === step.group_id);
    if (group) resolvedOptions[group.name] = [choice.display];
  }

  const nextQuestion = engineResult.nextStep ? renderStepQuestion(engineResult.nextStep, askPlan.display_name) : null;
  const pendingGroupNames = engineResult.nextStep
    ? [itemGroups.find(g => g.id === engineResult.nextStep!.group_id)?.name ?? engineResult.nextStep.slot_key ?? "option"]
    : undefined;

  // Bug-3-class guard (2026-09-07 quantity-doubling incident): a redundant
  // add_item call for an item ALREADY fully resolved, carrying text that
  // resolves nothing new (e.g. the LLM re-calling add_item after the
  // customer just answered an unrelated pickup/delivery question), must be
  // a no-op — never a phantom duplicate line, never a quantity bump. This
  // is the compiled path's answer to the exact incident described in
  // BLOCKED.txt's "Bug 3 ROOT CAUSE FOUND" entry: the legacy path's
  // vulnerability was matching on `options` equality, which a no-new-info
  // call satisfies trivially; here the gate is "did the engine actually
  // learn anything new this turn," which a no-op call never does.
  const fullyResolvedExistingIdx = continuationIdx < 0 && engineResult.resolved.length === 0
    ? cart.findIndex(ci =>
        ci.menu_item_id === menuItemId && !!ci.ask_plan_selections &&
        allSlotsResolved(askPlan, new Set(Object.keys(ci.ask_plan_selections))))
    : -1;
  if (fullyResolvedExistingIdx >= 0) {
    const existingLine = cart[fullyResolvedExistingIdx];
    const total = cart.reduce((s, i) => s + i.price_cents * i.quantity, 0);
    return {
      ok: true,
      cartChanged: false,
      result: {
        added: askPlan.display_name,
        price_cents: existingLine.price_cents,
        cart_total_cents: total,
        next_question: null,
        instruction: `${askPlan.display_name} is already in the cart with every required option resolved — this call added nothing. Do not ask about options for this item again.`,
      },
    };
  }

  if (continuationIdx >= 0) {
    const line = cart[continuationIdx];
    line.ask_plan_selections = newSelections;
    line.options = Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined;
    line.price_cents = priceCents;
    line.pending_options = pendingGroupNames;
  } else {
    // A genuine new add: merge into an existing FULLY-resolved line with
    // identical selections (real "another one, same way"), else push a
    // new line.
    const fullyResolved = allSlotsResolved(askPlan, new Set(Object.keys(newSelections)));
    const identicalExisting = fullyResolved ? cart.findIndex(ci =>
      ci.menu_item_id === menuItemId && !!ci.ask_plan_selections &&
      JSON.stringify(Object.entries(ci.ask_plan_selections).sort()) === JSON.stringify(Object.entries(newSelections).sort())
    ) : -1;
    if (identicalExisting >= 0) {
      cart[identicalExisting].quantity += quantity;
    } else {
      cart.push({
        menu_item_id: menuItemId, name: askPlan.display_name, quantity, price_cents: priceCents,
        modifiers: [], options: Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined,
        pending_options: pendingGroupNames, ask_plan_selections: newSelections,
      });
    }
  }

  const total = cart.reduce((s, i) => s + i.price_cents * i.quantity, 0);
  return {
    ok: true,
    cartChanged: true,
    result: {
      added: askPlan.display_name,
      price_cents: priceCents,
      cart_total_cents: total,
      next_question: nextQuestion,
      // ITEM 2: the group name + real choice display names for the open
      // step, so the caller (index.ts) can enforce `nextQuestion` reaches
      // the customer byte-for-byte via enforceVerbatimStepQuestion, and so
      // GUARD 8's "Choices for X" clause can tell it already said these
      // choices without re-deriving the engine state. Undefined (not a
      // stale/wrong value) when every slot is resolved.
      next_question_group: engineResult.nextStep ? pendingGroupNames![0] : undefined,
      next_question_choices: engineResult.nextStep ? engineResult.nextStep.choices.map(c => c.display) : undefined,
      instruction: nextQuestion
        ? `A required option is still open. Ask the customer EXACTLY this, verbatim — do not invent your own wording or option names: "${nextQuestion}"`
        : "All required options are resolved. Do not ask about options for this item again.",
    },
  };
}
