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

// REMOVED (2026-09-09 P0, third recurrence of the pepperoni-bleed defect):
// isolatePhraseForItem used to re-derive "which phrase belongs to this item"
// from scratch on every call, by stem-overlap guessing across the whole
// turn's re-split text. That guess worked on the phrasing it was tested
// against and failed on the next one — three times in three days, per PO's
// 2026-09-09 escalation. The guess is deleted, not tightened: a cart line's
// own phrase identity is now established ONCE, at the moment code (compose)
// or a validated model claim (add_item's source_phrase, see index.ts) first
// resolves it, and threaded forward as a plain index (`sourcePhraseIndex` /
// `modifierScopeText` below) — nothing downstream re-searches for it.

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

// D1 fix (2026-09-09, live money, both directions — BLOCKED.txt Vito's/
// Zio's "extra cheese on one of two pizzas" repro): a quantity-N cart line
// is N IDENTICAL units sharing one price_cents/options pair — there is no
// way to represent "one of these two has extra cheese" on a single line.
// applyCompiledModifyItem used to mutate that shared pair directly, so a
// change meant for one unit ("a large cheese pizza with extra cheese and a
// plain large cheese pizza", added as one qty-2 line then differentiated
// via modify_item) silently applied to EVERY unit in the line — Zio's
// verified repro: $4.00 Extra Cheese requested once, charged twice
// ($43.98 instead of $39.98+$4.00=$43.98... i.e. priced as if both pizzas
// got it). The fix below splits one unit off into its own quantity-1 line
// carrying the change, leaving the rest of the original line's units and
// their price untouched — UNLESS the customer's own words say the change
// is for every unit (ALL_UNITS_RE), in which case the whole line is
// updated as before. Same "missing beats wrong" convention as
// isRemovalRequested above: an undetected "both" still ends up money-safe
// (the customer can just ask again for the second unit), whereas an
// undetected "one" silently overcharging/mischarging every time is the
// worse failure this fix exists to close.
const ALL_UNITS_RE =
  /\b(?:both|all(?:\s+of\s+(?:them|these|those))?|every(?:\s*one)?|each(?:\s+one)?|the\s+whole\s+order)\b/i;

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

/**
 * P0 fix (2026-09-10, live money — Zio's "large cheese pizza with pepperoni
 * and mushrooms" undercharge): matchAssertedChoice returns only the FIRST
 * choice whose display is in the asserted-text set, by design (its own
 * contract is "validate one proposed choice"). A modifier step whose option
 * group allows more than one selection (min/max on the group, e.g. "Add
 * Toppings" min 0 max 25) can legitimately have SEVERAL of its real choices
 * asserted in one call — Pepperoni AND Mushrooms are both valid, separately
 * priced siblings in the same step. Returns EVERY choice whose display is in
 * assertedTexts, in the step's own choice order, so resolveAskPlan's
 * modifier branch can resolve all of them instead of just the first. Same
 * validation discipline as matchAssertedChoice: exact (case/whitespace-
 * normalized) name match only, never a fuzzy/stem guess.
 */
export function matchAllAssertedChoices(choices: EngineChoice[], assertedTexts: string[]): EngineChoice[] {
  if (assertedTexts.length === 0) return [];
  const normalizedAsserted = new Set(assertedTexts.map(t => t.trim().toLowerCase()).filter(Boolean));
  if (normalizedAsserted.size === 0) return [];
  return choices.filter(c => normalizedAsserted.has(c.display.trim().toLowerCase()));
}

// PO fix (2026-09-11, live quality regression — compiled path scored 40% vs
// legacy's 70% on the same 10 cases, proof unaffected): these used to always
// interpolate the FULL enumerated choice list into the question itself
// ("How would you like the Cheese Burger cooked? Well Done, Medium, Rare,
// Medium Well, or Medium Rare"), on every single turn, for a group as short
// as two choices. renderStepQuestion (below) now renders these SHORT by
// default and enumerates only when the customer's answer didn't match a
// real choice or they explicitly asked what the options are — see that
// function's doc. Appendix C: identical wording every run regardless; the
// LLM never rewrites these, it only relays them verbatim.
const TEMPLATE_QUESTIONS: Record<string, string> = {
  temp:      "How would you like the {display_name} cooked?",
  bread:     "What bread for the {display_name}?",
  dressing:  "Which dressing on the {display_name}?",
  size:      "What size {display_name}?",
  flavor:    "Which flavor for the {display_name}?",
  protein:   "Which protein for the {display_name}?",
  bagel:     "Which bagel?",
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
// PO fix (2026-09-11): `enumerate` is false by default — the short,
// non-enumerating question is the DEFAULT canonical text now, generalized
// across any group name (this function never hardcodes a per-group choice
// list; TEMPLATE_QUESTIONS's fixed rows and the generic fallback both stay
// name-only). Pass `enumerate: true` ONLY for the two deterministic
// fallback cases the spec still requires the customer see the real choices
// for: (a) their answer didn't match any real choice for this slot, or (b)
// they explicitly asked what the options/choices are (see asksForOptions).
// Both cases are decided by the caller (resolveAndPriceSelections below),
// never by the model — same "code decides, model relays" discipline as
// before, just against a shorter default.
export function renderStepQuestion(step: CompiledStep, displayName: string, enumerate = false): string {
  const key = step.prompt_template.split(".")[0] || "";
  const template = TEMPLATE_QUESTIONS[key];
  const base = template
    ? template.replace("{display_name}", displayName)
    // Generic fallback for a slot_key not in the fixed Appendix C list —
    // still fully deterministic, still built only from compiled choices.
    : `What ${key ? key.replace(/_/g, " ") : "option"} would you like for the ${displayName}?`;
  if (!enumerate) return base;
  // "size" (and the generic fallback, which has never had its own template
  // row to omit prices from) show price deltas alongside each choice, same
  // as before this fix; every other known group lists bare choice names.
  const withPrices = !template || key === "size";
  return `${base} ${renderChoiceList(step.choices, withPrices)}.`;
}

// PO fix (2026-09-11): deterministic detector for "the customer is asking
// what the choices/options are" — the second of the two cases that must
// still enumerate a slot's real choices (see renderStepQuestion above).
// Deliberately narrow/literal (not a fuzzy stem match) since this only
// needs to catch the customer directly asking the question, not any
// message that happens to share a word with it.
const ASKS_FOR_OPTIONS_RE =
  /\bwhat\s+(?:are\s+)?(?:my|the|your)?\s*(?:options|choices)\b|\b(?:options|choices)\s+(?:do (?:you|ya) have|are there|are available)\b|\bwhat\s+do\s+you\s+have\b|\bwhat(?:'|’)s\s+available\b/i;

export function asksForOptions(text: string): boolean {
  return !!text && ASKS_FOR_OPTIONS_RE.test(text);
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
 * missing): any sentence in the model's reply that already names one of
 * the step's real choices is dropped (that's the model's own paraphrase
 * attempt — keeping it alongside the canonical line would show the
 * customer two different, possibly contradictory, renderings of the same
 * question, or, since the 2026-09-11 fix below, a stray enumerated tail
 * next to an otherwise-correct short question) and the canonical question
 * is appended after whatever warmth is left, unless it's there already.
 * Reuses `significantStems` (same primitive `matchChoiceInText` above
 * already uses for choice matching) rather than a new ad hoc quote/format
 * regex — it strips punctuation, so "12"" vs "12''" no longer causes a
 * false miss.
 */
// PO fix (2026-09-11): factored out of enforceVerbatimStepQuestion so
// stripDeferredStepQuestion (two-question-collision guard, below) can reuse
// the identical sentence-level filter rather than a second copy of it.
function filterOutSentencesMatchingStems(text: string, dropStems: Set<string>): string {
  if (dropStems.size === 0) return text;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter(s => {
    const stems = significantStems(s);
    return ![...dropStems].some(ds => stems.has(ds));
  });
  return kept.join(" ").trim();
}

// Regression fix (2026-09-12, PO live testing): the choice-stem filter above
// only catches a model paraphrase that NAMES one of the step's real choices
// ("...cooked rare?"). A paraphrase of the canonical question itself that
// never names a choice ("What temp would you like the Cheese Burger
// cooked?" vs. canonical "How would you like the Cheese Burger cooked?")
// shares no choice stems, so both sentences used to ship in the same reply.
// significantStems doesn't strip question-y filler words ("what"/"how"/
// "would"/"like"/"you"/...), so those are excluded here explicitly — left
// in, they'd cause the loose any-overlap match below (same discipline as
// the choice-stem filter above) to drop unrelated sentences that merely
// contain "you" or "like". What's left after stripping filler and the
// item's own display name (an unrelated "item added" sentence may
// legitimately contain that) is the canonical question's real distinctive
// content — e.g. just "cooked" for the temp template.
const GENERIC_QUESTION_STEMS = new Set([
  "what", "how", "which", "who", "would", "will", "do", "does", "did",
  "you", "your", "like", "want", "on",
]);

function canonicalQuestionStems(nextQuestion: string, displayName: string): Set<string> {
  const displayStems = significantStems(displayName);
  return new Set(
    [...significantStems(nextQuestion)].filter(s => !displayStems.has(s) && !GENERIC_QUESTION_STEMS.has(s)),
  );
}

// PO fix (2026-09-11): the old byte-for-byte early return ("if modelReply
// already contains nextQuestion, leave the WHOLE reply alone") skipped
// filtering entirely whenever `nextQuestion` (now a much shorter default —
// see renderStepQuestion above) appeared anywhere in modelReply, even as a
// strict prefix of a longer reply that then went on to append its OWN
// choice list right after it ("...cooked? Well Done, Medium, Rare...") — a
// short canonical question followed by content nextQuestion itself never
// contained) — that trailing enumeration used to reach the customer
// unfiltered. Fixed by locating nextQuestion's own span in modelReply (when
// present) and filtering only the text BEFORE and AFTER that span, leaving
// the span itself untouched — so a long, already-enumerated nextQuestion
// that legitimately contains choice names in the model's verbatim relay
// survives (the original "left alone" case, still covered), while a SHORT
// nextQuestion with extra choice-mentioning content stapled onto it gets
// that extra content dropped, same as any other paraphrase attempt.
export function enforceVerbatimStepQuestion(
  modelReply: string,
  nextQuestion: string,
  choiceDisplays: string[],
  displayName = "",
): string {
  const choiceStems = new Set(choiceDisplays.flatMap(d => [...significantStems(d)]));
  const dropStems = new Set([...choiceStems, ...canonicalQuestionStems(nextQuestion, displayName)]);
  const idx = modelReply.indexOf(nextQuestion);
  if (idx >= 0) {
    const before = filterOutSentencesMatchingStems(modelReply.slice(0, idx), dropStems);
    const after = filterOutSentencesMatchingStems(modelReply.slice(idx + nextQuestion.length), dropStems);
    return [before, nextQuestion, after].filter(Boolean).join(" ").trim();
  }
  const leadIn = filterOutSentencesMatchingStems(modelReply, dropStems);
  return leadIn ? `${leadIn} ${nextQuestion}` : nextQuestion;
}

/**
 * Two-question-collision guard support (2026-09-11, PO-directed fix): when
 * the order-type question (pickup/delivery) already went out this same
 * turn — see index.ts's collision guard, right where this is called — a
 * compiled slot question opened THIS turn must be deferred rather than
 * stacked on top of it. This strips whatever form of the slot question the
 * model wrote — its own short paraphrase, an enumerated tail, or both —
 * out of the reply entirely (nothing is appended in its place; the caller
 * re-asks it alone, next turn, if it's still unresolved).
 *
 * Reuses enforceVerbatimStepQuestion's own sentence filter for choice
 * names (ANY real choice name mentioned drops that sentence — choice
 * names are specific enough that a false-positive match is vanishingly
 * unlikely). The BASE question phrasing needs a stricter rule: its own
 * significant words (e.g. "how", "would", "cooked") are ordinary enough
 * that requiring just ONE to appear in a sentence would misfire on
 * unrelated content — the order-type question ("Are you ordering pickup
 * or delivery today?") shares the word "you" with "How would you like the
 * Cheese Burger cooked?" but is obviously not the same question. So the
 * base question requires EVERY one of its distinctive words (its own
 * words minus the item's display name, which the unrelated "item added"
 * confirmation sentence legitimately also contains) to be present in a
 * candidate sentence — full-subset, not any-overlap, same discipline as
 * matchChoiceByStems above. Fewer than two distinctive words left is too
 * weak a signal to act on at all (missing beats wrong) — that sentence is
 * left alone.
 */
export function stripDeferredStepQuestion(
  modelReply: string,
  nextQuestion: string,
  choiceDisplays: string[],
  displayName: string,
): string {
  const choiceStems = new Set(choiceDisplays.flatMap(d => [...significantStems(d)]));
  const displayStems = significantStems(displayName);
  const questionStems = [...significantStems(nextQuestion)].filter(s => !displayStems.has(s));

  const sentences = modelReply.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter(s => {
    const stems = significantStems(s);
    if ([...choiceStems].some(cs => stems.has(cs))) return false;
    if (questionStems.length >= 2 && questionStems.every(qs => stems.has(qs))) return false;
    return true;
  });
  return kept.join(" ").trim();
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
  // REPLACES otherItemPhraseHints (2026-09-09 P0, see the REMOVED note
  // above isNegated's imports). The text to reactively match MODIFIER-kind
  // steps against — this call's own phrase, and ONLY this call's own
  // phrase, established by the caller (compose's own segment text, or
  // index.ts's validated add_item `source_phrase` claim) BEFORE this
  // function ever runs.
  //   undefined -> the caller has no phrase-scoping concept at all (every
  //     call site that predates this fix, plus the genuine one-phrase-turn
  //     case) -> falls back to `customerText` unchanged, byte-for-byte the
  //     old whole-text behavior.
  //   "" (empty string) -> the caller DOES scope by phrase but could not
  //     confidently identify THIS call's phrase in a multi-phrase turn ->
  //     no modifier text at all this call, not a fallback to the whole
  //     turn — missing beats wrong, exactly the outcome an unidentified
  //     phrase must produce (an unresolved modifier surfaces as a normal
  //     unasked optional extra, never a silent cross-item guess).
  //   non-empty string -> exactly this call's own phrase; the only text a
  //     modifier can reactively match against.
  modifierScopeText?: string,
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
      // Rank-2 fix (2026-09-09, PO direction — fourth recurrence of the
      // pepperoni-bleed defect): reactive text scanning REMOVED entirely.
      // matchChoiceByStems IS the bug — every prior fix constrained it and
      // failed on the next phrasing. Modifiers now resolve ONLY via
      // matchAssertedChoice (the model's explicit per-call tool-call input,
      // or the compose module's toppingChoiceDisplay). A choice with no
      // explicit assertion is left unresolved — missing beats wrong.
      //
      // P0 fix (2026-09-10, live money — Zio's undercharge, see
      // matchAllAssertedChoices's doc above): a modifier group legitimately
      // allows more than one selection (option group min/max, e.g. "Add
      // Toppings" min 0 max 25) — resolve EVERY asserted choice this step's
      // real choices contain, not just the first. A choice text that
      // matches NOTHING in step.choices still falls through unresolved
      // (matchAllAssertedChoices only ever returns real, validated choices)
      // — that "genuinely unverifiable" case is unchanged by this fix.
      const assertedChoices = matchAllAssertedChoices(step.choices, modelAssertedChoiceTexts);
      const negText = modifierScopeText ?? customerText;
      for (const asserted of assertedChoices) {
        if (consumedModifierChoiceIds?.has(asserted.id)) continue;
        if (isNegated(negText, asserted.display)) continue;
        resolved.push({ group_id: step.group_id, slot_key: step.slot_key, choice: asserted });
        totalDeltaCents += asserted.price_delta_cents;
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
  // Group id -> resolved choice id(s). A single string for every slot group
  // (always exactly one choice) and for a modifier group with exactly one
  // resolved choice; an array of ids ONLY when a modifier group's option
  // group allows more than one selection and more than one was resolved
  // (P0 fix 2026-09-10, see matchAllAssertedChoices's doc in this file) —
  // kept as a bare string in the common single-choice case rather than
  // always an array, so every pre-existing exact-string comparison
  // elsewhere (index.ts GUARD 16, this file's identical-line dedup) keeps
  // working unchanged for the overwhelmingly common case.
  ask_plan_selections?: Record<string, string | string[]>;
  // The 0-based index (within this turn's own splitCustomerPhrases ordering)
  // of the customer phrase that created this line — set once, at creation,
  // never re-derived. See pizza-topping-compose.ts's ComposedPizzaToken and
  // index.ts's add_item `source_phrase` validation for the two places that
  // establish it. Absent for a line that predates this field, or one added
  // when identity couldn't be confidently established this turn.
  sourcePhraseIndex?: number;
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
  newSelections: Record<string, string | string[]>;
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
  selections: Record<string, string | string[]>,
): { resolvedOptions: Record<string, string[]>; priceCents: number } {
  const resolvedOptions: Record<string, string[]> = {};
  let priceCents = askPlan.base_price_cents;
  for (const step of askPlan.steps) {
    const sel = selections[step.group_id];
    if (!sel) continue;
    // P0 fix (2026-09-10): a modifier group's selection may be more than
    // one choice id (see CompiledCartLine.ask_plan_selections's doc) — price
    // and record every one, not just a single value.
    const choiceIds = Array.isArray(sel) ? sel : [sel];
    if (choiceIds.length === 0) continue;
    const group = itemGroups.find(g => g.id === step.group_id);
    for (const choiceId of choiceIds) {
      const choice = step.choices.find(c => c.id === choiceId);
      if (!choice) continue;
      priceCents += choice.price_delta_cents;
      if (group) resolvedOptions[group.name] = [...(resolvedOptions[group.name] ?? []), choice.display];
    }
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
  priorSelections: Record<string, string | string[]>,
  customerText: string,
  defaultChoiceIdByGroup: Map<string, string>,
  consumedModifierChoiceIds: Set<string> | undefined,
  modelAssertedChoiceTexts: string[],
  modifierScopeText?: string,
  // PO fix (2026-09-11): true iff this call is resolving a line that ALREADY
  // existed before this turn's customer text arrived (add_item's
  // continuationIdx >= 0, or any modify_item call — that handler only ever
  // targets an existing line by definition). Combined with the engine
  // resolving nothing new this call, that means the step now left as
  // `nextStep` was ALSO the open question on the line before this call ran
  // — i.e. it was already asked, in a prior turn, and whatever the customer
  // just said didn't answer it. That's the deterministic "wrong answer"
  // trigger for enumerating real choices (renderStepQuestion's `enumerate`
  // — see its doc); a brand new line's very first open question is never
  // enumerated by this signal, only a genuine repeat is.
  isContinuation = false,
): ResolveAndPriceOutcome {
  const alreadyResolvedGroupIds = new Set(Object.keys(priorSelections));
  const engineResult = resolveAskPlan(askPlan, customerText, alreadyResolvedGroupIds, defaultChoiceIdByGroup, consumedModifierChoiceIds, modelAssertedChoiceTexts, modifierScopeText);

  // P0 fix (2026-09-10): a single step can now push MULTIPLE resolved
  // entries sharing one group_id (a modifier step resolving more than one
  // asserted choice — see resolveAskPlan's modifier branch above). Group
  // them by group_id before writing into newSelections so a second choice
  // for the same group doesn't clobber the first (the old `newSelections[
  // r.group_id] = r.choice.id` one-liner this replaces did exactly that).
  // Collapsed back to a bare string when only one id resolved for a group,
  // and sorted when more than one, so two calls that assert the same set of
  // choices in a different order still produce byte-identical selections —
  // load-bearing for the identical-line merge/no-op-guard comparisons below,
  // which compare selections via JSON.stringify.
  const newSelections: Record<string, string | string[]> = { ...priorSelections };
  const resolvedIdsByGroup = new Map<string, string[]>();
  for (const r of engineResult.resolved) {
    const ids = resolvedIdsByGroup.get(r.group_id) ?? [];
    ids.push(r.choice.id);
    resolvedIdsByGroup.set(r.group_id, ids);
  }
  for (const [groupId, ids] of resolvedIdsByGroup) {
    newSelections[groupId] = ids.length === 1 ? ids[0] : [...ids].sort();
  }

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

  // PO fix (2026-09-11): enumerate real choices ONLY on a genuine repeat
  // (this call resolved nothing new on an already-existing line — see
  // isContinuation's doc above) or an explicit ask for the options — never
  // as the default. See renderStepQuestion's doc for the full rationale.
  const shouldEnumerateChoices = (isContinuation && engineResult.resolved.length === 0) || asksForOptions(customerText);
  const nextQuestion = engineResult.nextStep ? renderStepQuestion(engineResult.nextStep, askPlan.display_name, shouldEnumerateChoices) : null;
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

/**
 * Are two cart lines' resolved options the same real-world selection?
 * Compares group name -> sorted choice display names, not the opaque
 * option_group_id/option_choice_id pairs `ask_plan_selections` carries —
 * those ids can differ across a recompile for the exact same human choice,
 * which is what let a same-item, same-selection double-add through on
 * 2026-09-11 (see the P0 fix note at its call sites).
 */
function sameResolvedOptions(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
): boolean {
  const na = a ?? {};
  const nb = b ?? {};
  const keysA = Object.keys(na).sort();
  const keysB = Object.keys(nb).sort();
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every(k => {
    const va = [...na[k]].sort();
    const vb = [...(nb[k] ?? [])].sort();
    return va.length === vb.length && va.every((v, i) => v === vb[i]);
  });
}
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
  // See resolveAskPlan's modifierScopeText doc — replaces otherItemPhraseHints.
  modifierScopeText?: string,
  // The phrase-identity this call itself was resolved from (compose's own
  // segment index, or index.ts's validated add_item `source_phrase` index).
  // Recorded on the cart line so a LATER call (e.g. this same item's own
  // modify_item, or a future turn's reactive match) never has to re-derive
  // which phrase this line came from — undefined when identity is unknown,
  // same "missing beats wrong" convention as modifierScopeText.
  sourcePhraseIndex?: number,
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
  } = resolveAndPriceSelections(askPlan, itemGroups, priorSelections, customerMessage, defaultChoiceIdByGroup, consumedModifierChoiceIds, modelAssertedChoiceTexts, modifierScopeText, continuationIdx >= 0);

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
  //
  // D1 fix (2026-09-09, live money — Zio's "a large cheese pizza with extra
  // cheese and a plain large cheese pizza" repro): this used to match on
  // menu_item_id alone — ANY fully-resolved existing line for this item was
  // enough to call the new call a no-op, even when that line's OWN
  // selections don't match what THIS call would produce. Real sequence
  // observed live: call 1 resolves "with extra cheese" onto a new line;
  // call 2 (the plain pizza, resolvedCount=0 since it names nothing new)
  // matched call 1's ALREADY-toppinged line here and was silently dropped
  // as a no-op — the second, plain pizza never became its own line at all.
  // The model then resorted to modify_item(quantity:2) to force the count
  // up, which multiplied the toppinged line's price by 2 ($43.98 instead of
  // $39.98). Requiring the candidate line's selections to equal THIS call's
  // newSelections (same sorted-entries comparison the identicalExisting
  // merge below already uses) keeps the guard's real target — a truly
  // redundant re-call for the SAME configuration — while a differently
  // configured second order for the same base item now correctly falls
  // through to the genuine-new-add path below instead of vanishing.
  // P0 fix (2026-09-11, live money defect — Vito's Gyro double-charge):
  // this used to compare `ask_plan_selections`, whose keys are opaque
  // option_group_id/option_choice_id pairs. Vito's menu was recompiled
  // twice today; a cart line created against an EARLIER compile's ids and
  // a fresh resolution against the CURRENT compile's ids describe the
  // exact same real-world selection ("Beef", "Ranch") but no longer share
  // a single matching id, so this check silently stopped recognizing them
  // as the same order and let a second, fully-priced line through — same
  // item charged twice. `options` (group display name -> choice display
  // name[]) is what a human/receipt actually sees and is stable across a
  // recompile as long as the menu's real options don't change, so identity
  // is now decided on that, never on internal ids that can churn under it.
  const fullyResolvedExistingIdx = continuationIdx < 0 && resolvedCount === 0
    ? cart.findIndex(ci =>
        ci.menu_item_id === menuItemId && !!ci.ask_plan_selections &&
        allSlotsResolved(askPlan, new Set(Object.keys(ci.ask_plan_selections))) &&
        sameResolvedOptions(ci.options, resolvedOptions))
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
    if (sourcePhraseIndex !== undefined) line.sourcePhraseIndex = sourcePhraseIndex;
  } else {
    // A genuine new add: merge into an existing FULLY-resolved line with
    // identical selections (real "another one, same way"), else push a
    // new line. Same identity fix as fullyResolvedExistingIdx above —
    // compare human-meaningful `options`, never the opaque, recompile-
    // fragile `ask_plan_selections` ids.
    const fullyResolved = allSlotsResolved(askPlan, new Set(Object.keys(newSelections)));
    const identicalExisting = fullyResolved ? cart.findIndex(ci =>
      ci.menu_item_id === menuItemId && !!ci.ask_plan_selections &&
      sameResolvedOptions(ci.options, resolvedOptions)
    ) : -1;
    if (identicalExisting >= 0) {
      cart[identicalExisting].quantity += quantity;
    } else {
      cart.push({
        menu_item_id: menuItemId, name: askPlan.display_name, quantity, price_cents: priceCents,
        modifiers: [], options: Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined,
        pending_options: pendingGroupNames, ask_plan_selections: newSelections,
        sourcePhraseIndex,
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
  // See resolveAskPlan's modifierScopeText doc — same phrase-identity
  // scoping applied here so a modify_item call is exposed to the identical
  // multi-item bleed risk as add_item, closes symmetrically.
  modifierScopeText?: string,
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
    consumedModifierChoiceIds, modelAssertedChoiceTexts, modifierScopeText,
    // modify_item, by definition, always targets an EXISTING line — see
    // isContinuation's doc on resolveAndPriceSelections.
    true,
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
    const sel = selections[step.group_id];
    if (!sel) continue;
    // P0 fix (2026-09-10): a modifier group's selection may now hold more
    // than one choice id (see CompiledCartLine.ask_plan_selections's doc) —
    // removal must drop only the SPECIFIC choice(s) the customer named,
    // leaving any other already-selected choice in the same group intact
    // (e.g. "remove the pepperoni" on a line that also has mushrooms must
    // not clear mushrooms too).
    const choiceIds = Array.isArray(sel) ? sel : [sel];
    if (explicitlyClearedGroupIds.has(step.group_id)) {
      delete selections[step.group_id];
      removed = true;
      continue;
    }
    const remainingIds = choiceIds.filter(choiceId => {
      const choice = step.choices.find(c => c.id === choiceId);
      return !choice || !isRemovalRequested(customerMessage, choice.display);
    });
    if (remainingIds.length === choiceIds.length) continue;
    removed = true;
    if (remainingIds.length === 0) delete selections[step.group_id];
    else selections[step.group_id] = remainingIds.length === 1 ? remainingIds[0] : remainingIds;
  }

  let splitOffLine: CompiledCartLine | null = null;
  if (outcome.resolvedCount > 0 || removed) {
    const { resolvedOptions, priceCents } = removed
      ? priceSelections(askPlan, itemGroups, selections)
      : { resolvedOptions: outcome.resolvedOptions, priceCents: outcome.priceCents };
    if (line.quantity > 1 && !ALL_UNITS_RE.test(customerMessage)) {
      // See ALL_UNITS_RE's doc above: split one unit off rather than
      // silently re-pricing every unit sharing this line.
      line.quantity -= 1;
      splitOffLine = {
        menu_item_id: line.menu_item_id,
        name: line.name,
        quantity: 1,
        price_cents: priceCents,
        modifiers: line.modifiers,
        options: Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined,
        pending_options: outcome.pendingGroupNames,
        ask_plan_selections: selections,
        sourcePhraseIndex: line.sourcePhraseIndex,
      };
      cart.splice(idx + 1, 0, splitOffLine);
    } else {
      line.ask_plan_selections = selections;
      line.options = Object.keys(resolvedOptions).length > 0 ? resolvedOptions : undefined;
      line.price_cents = priceCents;
      line.pending_options = outcome.pendingGroupNames;
    }
    cartChanged = true;
  }

  const reportLine = splitOffLine ?? line;
  return {
    ok: true,
    cartChanged,
    result: {
      modified: askPlan.display_name,
      quantity: reportLine.quantity,
      price: reportLine.price_cents,
      next_question: outcome.nextQuestion,
      instruction: splitOffLine
        ? `Only ONE ${askPlan.display_name} was changed, not the whole quantity — the cart now has ${line.quantity} unchanged plus 1 with this update, as two separate lines. Say so plainly; do not imply all ${line.quantity + 1} were changed.`
        : (outcome.nextQuestion
            ? `A required option is still open. Ask the customer EXACTLY this, verbatim — do not invent your own wording or option names: "${outcome.nextQuestion}"`
            : "All required options are resolved. Do not ask about options for this item again."),
    },
  };
}
