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
import { isNegated } from "./reactive-modifier-match.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";

// P0 fix (2026-09-09, live money — cart-mutation gap): a customer removing a
// priced modifier/topping already resolved on a compiled cart line ("remove
// the extra cheese") got a reply that CLAIMED the removal happened while the
// cart itself never changed — nothing in resolveAskPlan/
// resolveAndPriceSelections below could ever strip an already-resolved
// modifier-kind selection, only add one. GUARD 1f (index.ts,
// guard1f-correction-claim-20260909.ts, shipped as chat-sms v316) stopped the
// bot from lying about it but explicitly left the actual mutation as
// unassigned follow-up work (BLOCKED.txt, 2026-09-09 15:36 UTC entry). This
// is that follow-up: a deterministic, clause-scoped detector (same technique
// as isNegated above, reused rather than reimplemented) that reads the
// customer's own words and tells applyCompiledModifyItem which already-
// selected modifier choice they're asking to take off — independent of
// whatever `options`/`modifiers` shape the model's own tool-call happens to
// pass, so a bare `modify_item(menu_item_id)` call with no other args is
// enough for the removal to actually take effect. Kept local to this module
// (not a separate file) — it is only ever consumed by
// applyCompiledModifyItem below.
const REMOVAL_VERBS = [
  "remove", "take off", "take away", "get rid of", "drop", "lose",
  "scratch", "cancel", "delete", "no more",
];

/**
 * True iff `text` contains a clause that both (a) uses a removal verb and
 * (b) names every significant stem of `choiceDisplay` — e.g. "remove the
 * extra cheese" against "Extra Cheese". Clause-scoped (split on
 * but/and/also/plus/punctuation) so "remove the pepperoni but keep the extra
 * cheese" doesn't also flag Extra Cheese, same discipline as isNegated's own
 * clause splitting. Falls back to isNegated (a bare "no extra cheese" spoken
 * about an item already in the cart reads as a removal request too).
 */
export function isRemovalRequested(text: string, choiceDisplay: string): boolean {
  if (!text) return false;
  const nameStems = significantStems(choiceDisplay);
  if (nameStems.size === 0) return false;

  const clauses = text.toLowerCase().split(/\b(?:but|and|also|plus)\b|[,.;]/);
  for (const clause of clauses) {
    const hasRemovalVerb = REMOVAL_VERBS.some(verb =>
      new RegExp(`\\b${verb.replace(/ /g, "\\s+")}\\b`, "i").test(clause),
    );
    if (!hasRemovalVerb) continue;
    const clauseStems = significantStems(clause);
    if ([...nameStems].every(s => clauseStems.has(s))) return true;
  }

  return isNegated(text, choiceDisplay);
}

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

/** Case/whitespace-fold for exact-string comparison — not a stem, no plural handling. */
function normalizeForExactMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Match free customer text against a step's real, compiled choice list.
 * Deterministic: normalizes both sides to significant stems (reusing the
 * same stemmer as cart-line/category resolution elsewhere in this
 * codebase) and requires the match to be unambiguous. Never guesses between
 * two plausible choices — returns null rather than pick one, matching the
 * "missing beats wrong" principle (spec P3).
 *
 * Fix (2026-09-09, ask-plan-engine modifier/choice matching gaps, round 3):
 * an exact (case/whitespace-normalized) full-string match against one
 * choice's own display wins outright, before the fuzzy stem-subset check
 * below ever runs. Spec §8.3's walk() answers every `ask` step with
 * literally `choices[0].display` and asserts the selection is recorded —
 * that is the customer stating the single, unabbreviated, canonical name of
 * exactly one real choice, not a guess between comparably plausible ones.
 * Without this, real sibling-choice pairs where one display is a strict
 * textual subset of another's — "Italian" / "Creamy Italian" on a dressing
 * group, "8 Pieces" / "14 Pieces" on a wings size group (the trailing
 * number is dropped as a sub-3-char stem, so both reduce to the identical
 * stem {"piece"}), "Medium Rare" sharing "rare" with a plain "Rare" choice —
 * answering with the full, exact name of the one truly-intended choice still
 * matched >1 choice's stem set and fell back to "ambiguous," permanently
 * stuck. Scoped narrowly to full-string equality only — it does not touch
 * the fuzzy subset logic for genuinely partial/ambiguous text (e.g. "large
 * pizza" against sibling choices "Large" and "Large Pizza" with neither
 * being the verbatim whole answer relative to the OTHER's presence — still
 * resolved by the unchanged logic below, still returns null when it should).
 */
export function matchChoiceInText(choices: EngineChoice[], text: string): EngineChoice | null {
  if (!text || choices.length === 0) return null;

  const normalizedText = normalizeForExactMatch(text);
  const exactHits = choices.filter(c => normalizeForExactMatch(c.display) === normalizedText);
  if (exactHits.length === 1) return exactHits[0];
  if (exactHits.length > 1) return null; // two choices sharing a display name — genuinely ambiguous, never guess

  const textStems = significantStems(text);
  return matchChoiceByStems(choices, textStems);
}

/**
 * Fuzzy stem-subset match against a pre-computed set of available stems,
 * rather than raw text — the primitive matchChoiceInText's fuzzy tier is
 * built on, and reused directly by resolveAskPlan's modifier matching
 * (round-3 fix above) to match against a RESIDUAL stem set — customerText's
 * stems minus whatever this same call already resolved via the item's own
 * name or an unrelated slot — without re-deriving a synthetic text string.
 */
function matchChoiceByStems(choices: EngineChoice[], availableStems: Set<string>): EngineChoice | null {
  if (availableStems.size === 0) return null;

  const hits: EngineChoice[] = [];
  for (const choice of choices) {
    const choiceStems = significantStems(choice.display);
    if (choiceStems.size === 0) continue;
    // Every stem the choice display contributes must appear among the
    // available stems (so "large" matches a choice displayed "Large" or
    // "Large 18 inch", but "large" alone never matches "Extra Large").
    const allPresent = [...choiceStems].every(s => availableStems.has(s));
    if (allPresent) hits.push(choice);
  }

  if (hits.length === 1) return hits[0];
  // Ambiguous (0 or >1 hits) — the sequencer will ask, not guess.
  return null;
}

/**
 * Item 8 fix (2026-09-08 P0, PO-signed-off "pepp"/dropped-line diagnosis,
 * 392894c): validates a model-PROPOSED choice against a step's real,
 * compiled choice list — exact (case-insensitive) name match only, no
 * fuzzy/stem tolerance. This is the code-side gate constraint 1 of that
 * fix requires: the model's tool-call `modifiers`/`options` input may
 * PROPOSE a choice, but it only ever becomes a resolved selection if it
 * names a REAL choice display verbatim. A string that doesn't match any
 * real choice here is silently ignored by the caller (falls through to
 * matchChoiceInText's fuzzy backstop, or stays unresolved) — it is never
 * written to ask_plan_selections on the strength of the model's word alone.
 * Same discipline the legacy add_item/modify_item paths already apply via
 * `group.choices.find(c => c.name.toLowerCase() === sel.toLowerCase())`.
 */
export function matchAssertedChoice(choices: EngineChoice[], assertedTexts: string[]): EngineChoice | null {
  if (assertedTexts.length === 0) return null;
  const normalizedAsserted = new Set(assertedTexts.map(t => t.trim().toLowerCase()).filter(Boolean));
  if (normalizedAsserted.size === 0) return null;
  for (const choice of choices) {
    if (normalizedAsserted.has(choice.display.trim().toLowerCase())) return choice;
  }
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
  // Item 8 fix (2026-09-08 P0, 392894c diagnosis, PO sign-off): the model's
  // OWN resolved understanding of this call — e.g. having correctly reasoned
  // per the system prompt's "COMPOSING A TOPPING-ONLY PIZZA REQUEST" rule
  // that "pepp" means Pepperoni — passed through as plain proposed-choice
  // strings (the flattened `modifiers`/`options` values from the tool call
  // that's resolving THIS step). Tried FIRST via matchAssertedChoice's exact-
  // name validation (never a raw write-through — see that function's doc);
  // matchChoiceInText's fuzzy/stem text scan over the whole turn's message
  // stays as the backstop for whatever the model didn't explicitly pass.
  // This is what actually closes the gap 392894c found: previously nothing
  // read the model's own options/modifiers input for a compiled item at all,
  // so "pepp" (which never stem-matches "Pepperoni") had no way to resolve,
  // full stop — regardless of how confidently the model itself understood it.
  modelAssertedChoiceTexts: string[] = [],
): EngineResult {
  const resolved: ResolvedSlot[] = [];
  let nextStep: CompiledStep | null = null;
  let totalDeltaCents = 0;

  // Fix (2026-09-09, ask-plan-engine modifier matching gap, round 3): the
  // SAME customerText is reused for every not-yet-resolved step this call
  // (by design — see the D1 fix doc above, an attribute stated once should
  // apply to every item it's stated for), but a modifier step reactively
  // matching that whole text has no way to tell "the customer asked for
  // this" apart from "this word is already spoken for by something else
  // this call resolved." Two real shapes of that, both found via the §8.3
  // live report (56 walk failures across both shops before this fix):
  //  (a) the add-item call for a brand new line is very often passed
  //      customerText that IS the item's own display_name and nothing else
  //      — spec §8.3's walk literally does this
  //      (`applyCompiledAddItem(cart, ..., askPlan.display_name, ...)`),
  //      and a real customer naming a specialty item behaves the same way
  //      ("I'll get the Mike's Hot Honey Pepperoni Sicilian"). When the
  //      item's OWN name already contains an ingredient word that also
  //      happens to be a real "Add Toppings"/"Add Extra" MODIFIER choice on
  //      that same item ("...Pepperoni Sicilian" vs. a topping choice
  //      "Pepperoni"), naming the item alone silently added a chargeable
  //      extra nobody asked for (47 of the 56 failures).
  //  (b) a REQUIRED SLOT answer can itself collide with an unrelated
  //      MODIFIER choice's display in a different group on the same item —
  //      real Zio's subs shape: a "Choose Cheese" slot (which cheese comes
  //      ON the sub, required) and an "Add Extra" modifier (an upcharge for
  //      MORE of that cheese) both offer "American Cheese" as a choice
  //      display. Answering the required slot question with "American
  //      Cheese" also reactively matched the unrelated modifier and silently
  //      added a $0.75 upcharge nobody asked for (4 of the 56 failures).
  // Fix: track every stem this call has already "spent" — starting with the
  // item's own display_name, growing by each slot choice's display the
  // moment THIS call resolves it (auto_single, apply_default, or a text
  // match; slot steps are always ordered before modifier steps by the
  // compiler's canonical ask order, so every slot this call can resolve is
  // already accounted for by the time the loop reaches a modifier step) —
  // and only match a modifier against whatever stems remain. A message that
  // says MORE than what's already spoken for (e.g. "...Sicilian with extra
  // bacon", or a slot answer plus a genuinely separate topping request)
  // keeps the extra stem and still matches normally. matchAssertedChoice
  // (the model's own separately-validated tool-call input) is untouched —
  // that is a different, higher-trust channel this text-only heuristic has
  // no business gating.
  const consumedStems = new Set(significantStems(askPlan.display_name));
  const customerTextStems = significantStems(customerText);

  for (const step of askPlan.steps) {
    if (alreadyResolvedGroupIds.has(step.group_id)) continue;

    // Modifiers (bug 4, 2026-09-07: "buffalo chicken pizza with pepperoni"
    // silently dropped the topping and its $3.00 price): apply reactively,
    // with the real compiled price, when the model's own tool-call input
    // (validated) or the SAME message's free text names a real modifier
    // choice — spec Appendix B's worked example ("large pepperoni pizza":
    // product + size + toppings Pepperoni pre-filled, no question asked).
    // Never gates `nextStep` — modifiers never block checkout or get asked
    // proactively here (the full offer_once "ask once" proactive question is
    // a separate, documented follow-up; this is strictly narrower:
    // match-if-mentioned-this-turn, same as a slot, minus the asking).
    if (step.kind === "modifier") {
      const availableStems = new Set([...customerTextStems].filter(s => !consumedStems.has(s)));
      const textMatch = matchChoiceByStems(step.choices, availableStems);
      const matched = matchAssertedChoice(step.choices, modelAssertedChoiceTexts) ?? textMatch;
      // P0 (2026-09-09, live money defect): neither matchAssertedChoice nor
      // matchChoiceInText is negation-aware — "large plain pizza, no extra
      // cheese" matched "Extra Cheese" (every one of its stems is present in
      // the text) and silently charged $4.00 for the exact option the
      // customer just declined. reactive-modifier-match.ts's legacy path
      // already guards this with isNegated; the compiled path had no
      // equivalent. Reused here rather than reimplemented, same rule this
      // module cites at its own header.
      if (matched && !consumedModifierChoiceIds?.has(matched.id) && !isNegated(customerText, matched.display)) {
        resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: matched });
        totalDeltaCents += matched.price_delta_cents;
      }
      continue;
    }

    if (step.ask_mode === "auto_single" && step.choices.length === 1) {
      const choice = step.choices[0];
      resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice });
      totalDeltaCents += choice.price_delta_cents;
      for (const s of significantStems(choice.display)) consumedStems.add(s);
      continue;
    }

    if (step.ask_mode === "apply_default") {
      const defaultId = defaultChoiceIdByGroup.get(step.group_id);
      const defaultChoice = defaultId ? step.choices.find(c => c.id === defaultId) : undefined;
      if (defaultChoice) {
        resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: defaultChoice });
        totalDeltaCents += defaultChoice.price_delta_cents;
        for (const s of significantStems(defaultChoice.display)) consumedStems.add(s);
        continue;
      }
      // No default resolvable from the data we have — fall through to
      // matching customer text / asking, same as a plain "ask" step.
    }

    const matched = matchAssertedChoice(step.choices, modelAssertedChoiceTexts) ?? matchChoiceInText(step.choices, customerText);
    if (matched) {
      resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: matched });
      totalDeltaCents += matched.price_delta_cents;
      for (const s of significantStems(matched.display)) consumedStems.add(s);
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

interface ResolveAndPriceOutcome {
  newSelections: Record<string, string>;
  resolvedCount: number;
  resolvedOptions: Record<string, string[]>;
  priceCents: number;
  nextQuestion: string | null;
  pendingGroupNames: string[] | undefined;
  nextStep: CompiledStep | null;
}

/**
 * P0 fix (2026-09-09, cart-mutation gap — see isRemovalRequested above): the
 * resolved-selections -> {options, price} projection, factored out so
 * applyCompiledModifyItem's removal path (which produces a selections map
 * resolveAndPriceSelections never sees, since removal deletes a key rather
 * than resolving one) can recompute the same real price/options from the
 * compiled ask_plan instead of hand-rolling a second copy of this loop that
 * could drift from the add path's.
 */
function priceSelections(
  askPlan: AskPlan,
  itemGroups: NonNullable<CompiledMenuItem["option_groups"]>,
  selections: Record<string, string>,
): { resolvedOptions: Record<string, string[]>; priceCents: number } {
  const resolvedOptions: Record<string, string[]> = {};
  let priceCents = askPlan.base_price_cents;
  for (const step of askPlan.steps) {
    const choiceId = selections[step.group_id];
    if (!choiceId) continue;
    const choice = step.choices.find(c => c.id === choiceId);
    if (!choice) continue;
    priceCents += choice.price_delta_cents;
    const group = itemGroups.find(g => g.id === step.group_id);
    if (group) resolvedOptions[group.name] = [choice.display];
  }
  return { resolvedOptions, priceCents };
}

/**
 * Item 8 fix (2026-09-08 P0, 392894c diagnosis): the resolve-then-price core
 * shared by applyCompiledAddItem (a NEW or continuing cart line) and
 * applyCompiledModifyItem (an EXISTING line, constraint 2 of the same fix).
 * Both need the identical validated-resolution + real-price computation
 * against `priorSelections` — extracting it here means there is exactly one
 * place that reads ask_plan.steps and writes a priced selection map, so
 * add_item and modify_item can never again drift into two different pricing
 * behaviors for the same compiled item.
 */
function resolveAndPriceSelections(
  askPlan: AskPlan,
  itemGroups: NonNullable<CompiledMenuItem["option_groups"]>,
  priorSelections: Record<string, string>,
  customerText: string,
  defaultChoiceIdByGroup: Map<string, string>,
  consumedModifierChoiceIds: Set<string> | undefined,
  modelAssertedChoiceTexts: string[],
): ResolveAndPriceOutcome {
  const alreadyResolvedGroupIds = new Set(Object.keys(priorSelections));
  const engineResult = resolveAskPlan(askPlan, customerText, alreadyResolvedGroupIds, defaultChoiceIdByGroup, consumedModifierChoiceIds, modelAssertedChoiceTexts);

  const newSelections: Record<string, string> = { ...priorSelections };
  for (const r of engineResult.resolved) newSelections[r.group_id] = r.choice.id;

  // Record every modifier choice this call resolved as consumed for the
  // rest of this turn (see resolveAskPlan's consumedModifierChoiceIds param
  // doc) — BEFORE the caller's merge/dedup logic runs, so it applies
  // regardless of whether this call ends up pushing a new line, filling a
  // continuation, modifying an existing line, or still finding an identical
  // existing line for some other legitimate reason.
  if (consumedModifierChoiceIds) {
    for (const r of engineResult.resolved) {
      const step = askPlan.steps.find(s => s.group_id === r.group_id);
      if (step?.kind === "modifier") consumedModifierChoiceIds.add(r.choice.id);
    }
  }

  const { resolvedOptions, priceCents } = priceSelections(askPlan, itemGroups, newSelections);

  const nextQuestion = engineResult.nextStep ? renderStepQuestion(engineResult.nextStep, askPlan.display_name) : null;
  const pendingGroupNames = engineResult.nextStep
    ? [itemGroups.find(g => g.id === engineResult.nextStep!.group_id)?.name ?? engineResult.nextStep.slot_key ?? "option"]
    : undefined;

  return {
    newSelections,
    resolvedCount: engineResult.resolved.length,
    resolvedOptions,
    priceCents,
    nextQuestion,
    pendingGroupNames,
    nextStep: engineResult.nextStep,
  };
}

/**
 * The full add_item integration for a compiled item (spec §7/§11 item 8).
 * Extracted as a pure function (cart is mutated in place, matching this
 * codebase's existing executeTool convention, but there is no I/O here —
 * the caller is responsible for `saveCart` when `cartChanged` is true) so
 * it is directly importable and testable, rather than requiring a
 * hand-copied mirror of inline switch-case logic.
 *
 * Scope: SLOT groups + reactively/explicitly-matched MODIFIER groups. See
 * this file's header comment and resolveAskPlan's modelAssertedChoiceTexts
 * doc for the modifier-resolution contract.
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
  // Item 8 fix (2026-09-08 P0, 392894c diagnosis, constraint 1): the
  // model's OWN resolved `modifiers`/`options` tool-call input for THIS
  // add_item call, flattened to plain strings by the caller (index.ts) and
  // validated here (via resolveAskPlan -> matchAssertedChoice) against the
  // item's real ask_plan choices before ever being written to
  // ask_plan_selections. Previously this input was destructured by the
  // caller and never read at all for a compiled item — see this file's
  // matchAssertedChoice doc for why an unmatched string is silently
  // dropped rather than trusted.
  modelAssertedChoiceTexts: string[] = [],
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

  const {
    newSelections, resolvedCount, resolvedOptions, priceCents, nextQuestion, pendingGroupNames, nextStep,
  } = resolveAndPriceSelections(askPlan, itemGroups, priorSelections, customerMessage, defaultChoiceIdByGroup, consumedModifierChoiceIds, modelAssertedChoiceTexts);

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
  const fullyResolvedExistingIdx = continuationIdx < 0 && resolvedCount === 0
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
      next_question_group: nextStep ? pendingGroupNames![0] : undefined,
      next_question_choices: nextStep ? nextStep.choices.map(c => c.display) : undefined,
      instruction: nextQuestion
        ? `A required option is still open. Ask the customer EXACTLY this, verbatim — do not invent your own wording or option names: "${nextQuestion}"`
        : "All required options are resolved. Do not ask about options for this item again.",
    },
  };
}

export interface CompiledModifyItemResult {
  ok: boolean;
  result: unknown;
  cartChanged: boolean;
}

/**
 * Item 8 fix (2026-09-08 P0, constraint 2 of 392894c's PO-signed-off
 * diagnosis): modify_item was a fully legacy, ask_plan-unaware handler for
 * a compiled item — it wrote options/price_cents/pending_options straight
 * onto the cart line's plain fields with zero interaction with
 * ask_plan_selections or consumedModifierChoiceIds. That is exactly how it
 * became an uncontrolled side channel: a model that reached for modify_item
 * instead of add_item on a compiled line silently desynced authoritative
 * engine state, and the "4 correct lines" runs in 392894c's BLOCKED.txt
 * entry only happened by accident, via a mechanism the design never
 * accounted for. Left unfixed next to a corrected add_item, the same
 * regression returns the moment the model happens to call modify_item.
 *
 * This routes a modify_item call for a compiled item through the SAME
 * resolveAskPlan/matchAssertedChoice validation used by add_item —
 * `modelAssertedChoiceTexts` may only PROPOSE a choice, resolveAndPriceSelections
 * still validates it against the item's real ask_plan choices before it is
 * ever merged into ask_plan_selections — and MERGES into the target line's
 * existing selections (never replaces them wholesale), so a compiled line's
 * state can no longer be mutated outside the engine.
 *
 * Scope: quantity is applied directly (it is not part of ask_plan_selections
 * and legacy already applied it the same way). Unmatched option/modifier
 * keys are silently dropped rather than recorded as `unverified_requests` —
 * the compiled path has no unverified-request equivalent yet (see this
 * file's header comment, "documented follow-ups, not silent gaps"); this fix
 * does not expand that scope.
 *
 * REMOVAL (P0 fix, 2026-09-09, live money — see isRemovalRequested's header
 * above for the full incident): resolveAndPriceSelections above only ever
 * ADDS a resolution — nothing in the compiled engine could previously strip
 * an already-selected modifier-kind choice (e.g. "remove the extra cheese"
 * on a pizza that already has Extra Cheese selected), so a modify_item call
 * for that intent was a structural no-op regardless of what the model's tool
 * args contained. Two independent removal signals are checked against every
 * currently-resolved MODIFIER-kind step (never a required SLOT — size/temp/
 * bread etc. have no "remove" state, only a different choice): (1) the raw
 * `explicitOptions` the model's own tool call passed, when it names a real
 * group with an empty array (the same "pass an empty list to clear" contract
 * the legacy non-compiled modify_item path already honors); (2)
 * isRemovalRequested against `customerMessage` — the actual words the
 * customer used this turn (plus one turn of carryforward, via the caller's
 * compiledMatchText), independent of whatever the model's tool-call args
 * happen to contain. Either signal is sufficient, so a bare
 * `modify_item(menu_item_id)` call with no other args still removes the
 * option the customer asked to drop.
 */
export function applyCompiledModifyItem(
  cart: CompiledCartLine[],
  menuItem: CompiledMenuItem,
  menuItemId: string,
  quantity: number | undefined,
  customerMessage: string,
  modelAssertedChoiceTexts: string[],
  consumedModifierChoiceIds?: Set<string>,
  // The model's raw (unflattened) `options` tool-call input, keyed by group
  // name — read ONLY for the explicit-clear signal above (an empty array for
  // a real group name). Optional/undefined at any call site that doesn't
  // have it handy; removal still works via `customerMessage` alone.
  explicitOptions?: Record<string, string[]>,
): CompiledModifyItemResult {
  const idx = cart.findIndex(ci => ci.menu_item_id === menuItemId);
  if (idx < 0) return { ok: false, cartChanged: false, result: { error: "Item not in cart." } };

  const line = cart[idx];
  const askPlan = menuItem.ask_plan;
  const itemGroups = menuItem.option_groups ?? [];
  let cartChanged = false;

  if (quantity !== undefined && quantity !== line.quantity) {
    line.quantity = quantity;
    cartChanged = true;
  }

  const defaultChoiceIdByGroup = new Map<string, string>();
  for (const g of itemGroups) {
    if (g.default_choice_id) defaultChoiceIdByGroup.set(g.id, g.default_choice_id);
  }

  const priorSelections = { ...(line.ask_plan_selections ?? {}) };
  const outcome = resolveAndPriceSelections(
    askPlan, itemGroups, priorSelections, customerMessage, defaultChoiceIdByGroup,
    consumedModifierChoiceIds, modelAssertedChoiceTexts,
  );

  const explicitlyClearedGroupIds = new Set(
    Object.entries(explicitOptions ?? {})
      .filter(([, vals]) => Array.isArray(vals) && vals.length === 0)
      .map(([name]) => itemGroups.find(g => g.name === name)?.id)
      .filter((id): id is string => !!id),
  );

  const selections = { ...outcome.newSelections };
  let removed = false;
  for (const step of askPlan.steps) {
    if (step.kind !== "modifier") continue;
    const choiceId = selections[step.group_id];
    if (!choiceId) continue;
    const choice = step.choices.find(c => c.id === choiceId);
    if (!choice) continue;
    if (explicitlyClearedGroupIds.has(step.group_id) || isRemovalRequested(customerMessage, choice.display)) {
      delete selections[step.group_id];
      removed = true;
    }
  }

  if (outcome.resolvedCount > 0 || removed) {
    const { resolvedOptions, priceCents } = removed
      ? priceSelections(askPlan, itemGroups, selections)
      : { resolvedOptions: outcome.resolvedOptions, priceCents: outcome.priceCents };
    line.ask_plan_selections = selections;
    line.options = Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined;
    line.price_cents = priceCents;
    line.pending_options = outcome.pendingGroupNames;
    cartChanged = true;
  }

  return {
    ok: true,
    cartChanged,
    result: {
      modified: askPlan.display_name,
      quantity: line.quantity,
      price: line.price_cents,
      next_question: outcome.nextQuestion,
      instruction: outcome.nextQuestion
        ? `A required option is still open. Ask the customer EXACTLY this, verbatim — do not invent your own wording or option names: "${outcome.nextQuestion}"`
        : "All required options are resolved. Do not ask about options for this item again.",
    },
  };
}
