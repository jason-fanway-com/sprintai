// BLOCKER 1 (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md): Guard 7
// (index.ts, "ambiguous same-name match") asks a clarifying question when two
// active menu items share a name, but persisted no state — the next inbound
// message had no memory of which two candidates were offered, so it either
// re-asked the identical question or produced "I got mixed up" on a perfectly
// reasonable answer like "the 12.95 one". This module is the deterministic
// resolver: index.ts persists the offered candidates on
// order_carts.pending_disambiguation, and on the NEXT turn calls
// resolvePendingDisambiguation() BEFORE the LLM/tool loop ever runs.
//
// Pure functions only, no I/O — kept in their own module (matching
// invented-action-guard.ts / phantom-add-guard.ts) so the resolution logic
// and the "never repeat the identical re-ask" invariant are unit-testable
// without spinning up the whole edge function.

import { fuzzyWordMatch } from "./guard19-fuzzy-item-match.ts";

export interface PendingCandidate {
  menu_item_id: string;
  name:         string;
  // Menu-compiler-assigned disambiguated name (e.g. "Gyro Salad" vs "Gyro
  // Sandwich" for two rows that share the raw `name` "Gyro (Beef or
  // Chicken)") — optional because only GUARD 7/7b's menu-item candidates
  // (which come from EffectiveMenuItem.ask_plan) ever have one; cart-line
  // candidates (option-removal, named-removal) never set it and fall back
  // to `name` at every render site.
  display_name?: string;
  category:     string | null;
  price_cents:  number;
}

export interface PendingDisambiguation {
  query_name: string;
  candidates: PendingCandidate[];
  // P0 (2026-09-09, option-level removal): when set, resolving this
  // disambiguation must NOT add_item (the default, implicit behavior for
  // every pre-existing row/caller) — it must strip `option_phrase` from the
  // resolved candidate's cart line instead. Optional and additive so every
  // existing persisted row (and every other caller of this type, which never
  // sets it) keeps its current add_item resolution unchanged.
  action?: "remove_option";
  option_phrase?: string;
  // Backstop (2026-09-11, PO: "an infinite loop is worse than a wrong
  // guess"): consecutive turns this exact disambiguation has gone unresolved
  // with no tool call either (see index.ts's carriedDisambiguation handling).
  // Undefined/0 on every freshly-persisted payload — a NEW pendingPayload is
  // always built from scratch (never spread from the old one), so this can
  // never leak from one disambiguation into an unrelated later one.
  attempts?: number;
}

// Crude but sufficient stemmer: strips a trailing plural so "salad"/"salads"
// and "wrap"/"wraps" compare equal regardless of which side pluralizes.
// This is not a real linguistic stemmer — it only needs to bridge the
// singular/plural gap on the short, ordinary category words this system
// actually deals in (GUARD 7's original bug: an exact case-folded substring
// match that missed "salad" against "Salads" and "the wrap" against "Wraps").
export function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("es"))  return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s"))   return w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "one", "a", "an", "of", "by"]);

// PO fix (2026-09-15, 00-BJ, collision-scoped — measured broader first in
// 00-BI and correctly rejected: making every numeric token significant
// GLOBALLY broke 8 pre-existing tests, because the same 3-char floor is
// load-bearing elsewhere on purpose — "Medium 12\""/"Large 18\"" must stay
// matchable by the bare word "medium"/"large" alone (see
// ask-plan-engine.test.ts's own comment citing Jason's live repro). This
// param exists ONLY so ask-plan-engine.ts's matchChoiceInText/
// matchChoiceByStems can opt a single group's stem computation into numeric
// significance, and ONLY once that group's own choices would otherwise be
// indistinguishable ("10 Pieces"/"20 Pieces" -> {"piece"}/{"piece"}) — see
// groupNeedsNumericStems there for the collision check. Every other caller
// (categoryWordMatches below, option-removal-20260909.ts, reactive-
// modifier-match.ts's isNegated, index.ts, sequencer.ts, pizza-topping-
// compose.ts) omits this param and gets today's behavior, unchanged.
export function significantStems(text: string, numericTokensSignificant = false): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 0 && !STOPWORDS.has(w) && (w.length >= 3 || (numericTokensSignificant && /^\d+$/.test(w))))
      .map(stemWord),
  );
}

/**
 * Does the customer's message name this category? Singular/plural tolerant
 * via a shared stem set on both sides — "salad" <-> "Salads", "the wrap" <->
 * "Wraps". Used both by GUARD 7 (has the customer already disambiguated in
 * their original message?) and by resolvePendingDisambiguation below (does
 * their ANSWER to the clarifying question name a category?).
 */
export function categoryWordMatches(category: string | null | undefined, message: string): boolean {
  if (!category) return false;
  const catStems = significantStems(category);
  if (catStems.size === 0) return false;
  const msgStems = significantStems(message);
  for (const s of msgStems) if (catStems.has(s)) return true;
  return false;
}

// DEFECT 1 (2026-09-06 live QA): raw DB category names ("Salads", "Wraps") are
// internal, plural, capitalized labels — customers must never see "(Salads)"
// in a reply. This singularizes and lowercases a category into the ordinary
// word a person would actually say ("Salads" -> "salad"), for use in
// customer-facing text in place of the raw category string.
export function categoryDisplayWord(category: string | null | undefined): string {
  if (!category) return "";
  const w = category.trim().toLowerCase();
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|ses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// BUG 2 (2026-09-07, Jason, Zio's live verification): "what choose an
// option you'd like on the Buffalo Chicken Pizza" — Slice's import leaves
// several option groups with a generic, meaningless label ("Choose an
// option", confirmed live on Zio's real size groups for both the Buffalo
// Chicken Pizza and the Chicken Cheesesteak Sub) instead of a real name like
// "Size". That label is an internal import artifact, not something a
// customer should ever be read aloud — same category of leak
// categoryDisplayWord already guards against for raw DB category strings.
// Deliberately conservative: a genuinely GOOD imported group name ("Sauce",
// "Wing Flavor", "Dressing") is returned unchanged. Only a name matching a
// known generic/boilerplate label is replaced, with the plain, ungrammatical-
// nowhere fallback "option" ("what option you'd like on the X" reads fine;
// "what choose an option you'd like" does not). This does not attempt to
// infer a smarter label (e.g. "size") from the group's choices — that's the
// conversation-ready-menu compiler's job (item 4/9, display_name column,
// not yet populated for Zio's) once it has actually run; this is the
// zero-dependency stopgap that stops the raw internal string from leaking
// today, independent of whether/when that compiler runs.
const GENERIC_OPTION_GROUP_LABELS = new Set([
  "choose an option", "choose one option", "select an option", "select one",
  "select one option", "please select", "please choose", "please select one",
  "options", "option", "choose one", "make a selection", "make your selection",
]);

export function displayGroupName(groupName: string): string {
  const norm = groupName.trim().toLowerCase();
  return GENERIC_OPTION_GROUP_LABELS.has(norm) ? "option" : groupName;
}

// DEFECT 2 (2026-09-06 live QA): "forget the salad" was reaching
// resolvePendingDisambiguation's category-word check unfiltered — "salad"
// stem-matched the Salads candidate and got added, exactly the opposite of
// what the customer said. Negation/abandonment must be checked BEFORE any
// category/ordinal/price matching runs, not folded into it, so a decline is
// never misread as a selection.
//
// Rule 2 (2026-09-19, real conv 087abb8d, live $107.43-vs-~$85 money bug):
// "I didn't ask for any of those! Just the order I gave you." never matched
// this list at all — "don'?t" only matches the contraction "don't", and the
// uncontracted "did not" would already match the bare "\bnot\b" alternative
// below, but the CONTRACTED "didn't" is neither. The whole message fell
// through to the free-text item resolver instead of being read as the plain
// decline it is, and a stray word later in the same sentence got charged.
const DECLINE_CUES = /\b(?:forget|never\s*mind|cancel|skip|drop|don'?t|didn'?t|not|no)\b/i;

// Generic referents ("cancel THAT", "skip IT") don't name a candidate by
// word, but during an open disambiguation they can only refer to the
// pending item as a whole — treated as a candidate match for this check only.
const GENERIC_REFERENTS = new Set(["it", "that", "them", "those", "one"]);

/**
 * Does this message decline/abandon the pending disambiguation rather than
 * answer it? True only when a decline cue (forget/not/no/never mind/cancel/
 * skip/don't/drop) appears alongside a word that actually names one of the
 * candidates (its category, its name) or a generic referent to "the pending
 * item" ("that", "it"). A bare "no" with nothing else in the message doesn't
 * trip this — resolvePendingDisambiguation already returns null for it, same
 * outcome (nothing selected), so this function only needs to catch cases
 * where a candidate word is ALSO present and would otherwise have matched.
 */
export function isPendingDisambiguationDeclined(
  message:    string,
  candidates: PendingCandidate[],
): boolean {
  if (!DECLINE_CUES.test(message)) return false;

  const candidateStems = new Set<string>();
  for (const c of candidates) {
    for (const s of significantStems(c.name)) candidateStems.add(s);
    if (c.category) for (const s of significantStems(c.category)) candidateStems.add(s);
  }

  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const w of words) {
    if (GENERIC_REFERENTS.has(w)) return true;
    if (candidateStems.has(stemWord(w))) return true;
  }
  return false;
}

// M2 fix (2026-09-19, PO dispatch, live conv d3539d12 #5, real $91.30
// overcharge including items the customer explicitly asked to have
// removed): "Please remove that small Pepperoni pizza. I want to stick with
// 2 Large Pepperoni pizzas, 2 Chicken Alfredo with linguine, and 1 Bleu
// Cheese." was open against a which-one question for an entirely different,
// unresolved item ("cheese pizza"'s sizes) — the word "small" in "remove
// that SMALL Pepperoni pizza" stem-matched the Small candidate's own name
// via the category+name-narrowing tier and got read as the customer's PICK,
// silently ignoring that the sentence opens with a removal verb against
// something already in the cart and goes on to restate an entirely
// different order. isPendingDisambiguationDeclined's own DECLINE_CUES above
// is the existing "checked first" escape hatch for a genuine decline, but
// "remove"/"take off"/"don't want" were never decline cues (and even
// "don't"/"not"/"no" there only fire when the declined text ALSO happens to
// share a word with the open candidates — irrelevant here, since the
// removal names a completely different item). This is that same "checked
// first, before any candidate-name/size matching" discipline for a distinct
// escape hatch: removal language is NEVER an answer to a which-one
// question — it is a remove request against the cart, full stop. Verb set
// deliberately narrow (does not reuse turn-engine.ts's broader
// REMOVAL_VERBS, which also includes ordinary words like "no"/"change"/
// "switch"/"drop"/"instead" that are too easily part of a genuine answer to
// a which-one question, e.g. "the second one instead of the first") — only
// the shapes that can never plausibly be a candidate pick.
//
// WIDENED (2026-09-19 night, PO dispatch, real live repro conv 6de8bd13
// #4): "I don't want either of those. Just the hoagie, cheeseburgers, and
// cheesesteak." — widening isDisambiguationListDropSignal below to
// recognize "don't want either/any of those" as abandoning the OPEN list
// (see that function's own header) collided head-on with THIS check: "don't
// want" alone already matched here, so answer()'s disambiguation case (this
// function is checked FIRST there, before any decline/candidate tier —
// see turn-engine.ts's own "disambiguation" case) treated it as a removal
// request against some OTHER, already-in-cart line, found nothing to
// remove (the cart was empty), and left the identical shrimp list open —
// the exact live bug, just re-caused by the new phrase instead of fixed by
// it. "don't want the salad" (M2's own real repro, "remove that small
// Pepperoni pizza") genuinely names a SPECIFIC target elsewhere and must
// keep matching here unchanged; "don't want either/any (of those/them)"
// names no specific target at all — it can only be talking about the
// CURRENTLY OPEN list itself — so that shape alone is excluded here and
// left for isDisambiguationListDropSignal's own, more specific handling.
const DISAMBIGUATION_ANSWER_REMOVAL_RE =
  /\b(?:remove|removing|removed|take\s+(?:that|this|it|them)?\s*off|took\s+(?:that|this|it|them)?\s*off|don'?t\s+want(?!\s+(?:either|any)\b)|do\s+not\s+want(?!\s+(?:either|any)\b))\b/i;

export function isDisambiguationAnswerRemovalRequest(message: string): boolean {
  return DISAMBIGUATION_ANSWER_REMOVAL_RE.test(message ?? "");
}

// Round 2 addendum item A, rule 2 (2026-09-19, live sim persona, real
// Vito's count-suffix collision — "3 small pizzas" -> a numbered list of
// three unrelated items sharing a "(3)" portion suffix, then "I just want
// the pizzas" answered FIVE times, FIVE byte-identical lists, no exit):
// once a numbered "which one?" list has already missed at least once (see
// turn-engine.ts's DialogueState/render() own use of `openRepeatCount` for
// this same list, and this function's caller-side gate in turn-engine-
// runner.ts), a reply that abandons the list outright — a bare "no"/"none"/
// "none of those", or "I('m) (just|only) want <something>" — drops it, same
// discipline as isPendingDisambiguationDeclined above (a real word, not
// silence, decides this), but deliberately narrower and NOT gated on
// naming a candidate: unlike a genuine decline, this fires specifically
// because the list has already proven itself unmatchable, so the customer
// restating what they want in their own words (not the list's words) is
// itself the signal, not incidental overlap with a candidate's name.
// "just"/"only" is REQUIRED, not merely optional — a bare "I want the
// large" is the single most ordinary way to answer ANY open question and
// must never be misread as abandonment; only the "just"/"only" framing
// ("I just want X", not "I want X") signals the customer restating from
// scratch rather than naming a candidate.
//
// LIVE BUG (2026-09-19, conv 009de656, item 4): the render() fallback that
// re-asks a missed disambiguation literally tells the customer to "say
// 'none of those'" as their way out — but "None of those." arrived
// followed by the customer's actual restated order on the SAME line ("None
// of those. 2x smothered fries...") and the old regex required the ENTIRE
// trimmed message to be nothing but "none of those" (the trailing `$`
// anchor), so it never matched and the identical list re-asked 8 times in a
// row. "none of those"/"none of them" is now a PREFIX match — matched at
// the start of the message, with optional trailing punctuation, then either
// end-of-message or a word boundary before whatever the customer restated.
// The restated text is not parsed here: this function only answers "did the
// customer invoke the escape hatch," and turn-engine-runner.ts's existing
// dropDisambiguationList handling already forwards the FULL input.message
// (untouched) to PROPOSE once this returns true, exactly the same path a
// bare "no"/"none" already takes — so the trailing order text is picked up
// there, not here. Bare "no"/"none" (with nothing else) stays an EXACT
// match, unchanged: a message starting with "no" that goes on to say
// something else ("no I want pepperoni") is not obviously the escape hatch
// and is out of scope for this fix.
//
// WIDENED (2026-09-19 night, PO dispatch, real repro conv 6de8bd13 #4): a
// shrimp wrap/appetizer disambiguation stayed open through "I don't want
// either of those. Just the hoagie, cheeseburgers, and cheesesteak." —
// same disease as the "None of those. <restated order>" bug above, just a
// phrasing the old prefix list didn't cover. Widened the SAME prefix
// mechanism (not a new one) to also recognize "I don't want either of
// those" / "don't want either" / "don't want any of those" / "neither" /
// "no thanks" as escape hatches, exactly like "none of those" — a leading
// clause, optional trailing punctuation, then either end-of-message or the
// customer's restated order. "either"/"any" is REQUIRED after "don't want"
// (not bare "don't want X") so a real decline-of-one-candidate answer like
// "I don't want the shrimp wrap, give me the appetizer" — which names a
// candidate the list should still try to resolve — is never mistaken for
// abandoning the whole list.
const LIST_DROP_PREFIX_RE =
  /^(?:none(?:\s+of\s+(?:those|them))?|neither(?:\s+of\s+(?:those|them))?|no\s+thanks|(?:i\s+)?don'?t\s+want\s+(?:either|any)(?:\s+of\s+(?:those|them))?)[.,!]*(?:\s|$)/i;
const DISAMBIGUATION_LIST_DROP_RE = /^(?:none(?:\s+of\s+(?:those|them))?|no)\.?!?$|\bi(?:'m| am)?\s+(?:just|only)\s+want\b/i;

export function isDisambiguationListDropSignal(message: string): boolean {
  const trimmed = (message ?? "").trim();
  return LIST_DROP_PREFIX_RE.test(trimmed) || DISAMBIGUATION_LIST_DROP_RE.test(trimmed);
}

// Dispatch 00-AT (conv 8b9636c9 live repro, and conv b65b60eb "Lobster
// Bisque - Bowl" vs "Cup"): category is frequently the SAME across every
// candidate a disambiguation ever offers (three Jack's Special sizes are
// all "Pizza"; a soup's Bowl/Cup pair are both whatever category that soup
// lives in) — categoryWordMatches can never tell them apart, so a customer
// who answers by naming the size/variant word itself ("Medium", "the bowl")
// fell through every existing tier and the question stayed open forever
// while every OTHER message that turn got re-read as a fresh order (see
// turn-engine-runner.ts's own header on this dispatch). Candidates' own
// NAME (and display_name, when the compiler minted one) routinely DOES
// carry the distinguishing word even when category doesn't — this tier
// scores each candidate by how many of its own name/display_name stems the
// message shares, and resolves only when exactly one candidate has a
// strictly higher count than every other (a tie, or an all-zero score,
// resolves nothing — same "never guess" discipline as every tier below).
function nameWordMatches(candidates: PendingCandidate[], message: string): PendingCandidate | null {
  const msgStems = significantStems(message);
  if (msgStems.size === 0) return null;
  const counts = candidates.map(c => {
    const nameStems = new Set(significantStems(c.name));
    if (c.display_name) for (const s of significantStems(c.display_name)) nameStems.add(s);
    let count = 0;
    for (const s of msgStems) if (nameStems.has(s)) count++;
    return count;
  });
  const max = Math.max(...counts);
  if (max === 0) return null;
  const winners = counts.filter(c => c === max);
  if (winners.length !== 1) return null;
  return candidates[counts.indexOf(max)];
}

const ORDINAL_WORDS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
// Deliberately excludes "one": it is the single most common English filler
// pronoun ("the salad ONE", "that ONE", "the 12.95 ONE") and would falsely
// read as "position 1" on answers that are actually naming a category or a
// price. "first"/"1"/"1st" already cover every real way to say position 1.
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

// A leading selection-framing token ("#3", "number 3", "option 3", "no. 3",
// "the third one") and a trailing filler word ("second please", "the third
// one") are the only wrapping a genuine positional pick wears. Anything else
// surviving after this single strip means the message is talking about
// something else that merely CONTAINS a number/ordinal word — never a
// position pick.
const LEADING_QUALIFIER = /^(?:#|number|option|no\.?|the)\s*/;
const TRAILING_FILLER = /\s*(?:one|please|thanks|pls)$/;

/**
 * "the first one" / "1st" / "number one" / a bare "1" — every reasonable way
 * a human names a position in the numbered list the re-ask offers. Returns a
 * 0-based index, or null if the message names no position.
 *
 * LIVE MONEY BUG (2026-09-15, Vito's + Zio's): this used to match a digit or
 * ordinal/number word ANYWHERE in the message — "10 pieces" (an already-
 * resolved quantity, nothing to do with the open disambiguation) matched the
 * bare digit and silently selected candidate #10; "two cheeseburgers and a
 * large fries" would equally have matched `\btwo\b` and picked candidate #2.
 * A positional pick must now match the WHOLE message (after stripping one
 * leading qualifier and one trailing filler word) — a stray number embedded
 * in an unrelated sentence no longer resolves anything.
 */
export function matchOrdinalPosition(message: string, count: number): number | null {
  let norm = message.trim().toLowerCase();
  if (!norm) return null;

  norm = norm.replace(LEADING_QUALIFIER, "").replace(TRAILING_FILLER, "").trim();
  if (!norm) return null;

  const digitMatch = norm.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (digitMatch) {
    const idx = parseInt(digitMatch[1], 10) - 1;
    return idx >= 0 && idx < count ? idx : null;
  }

  if (Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, norm)) {
    const idx = ORDINAL_WORDS[norm];
    return idx < count ? idx : null;
  }

  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, norm)) {
    const num = NUMBER_WORDS[norm];
    return num <= count ? num - 1 : null;
  }

  return null;
}

// PO dispatch (2026-09-18, live 50-conversation measurement, build aac8be0c):
// the shared-name fix (00-BJ) correctly asks a narrowing question, but a
// customer's natural-language ANSWER to that question was only understood
// as a bare digit — "3 please, the Chicken Cheesesteak hot sandwich!" and
// "I would like option 1) the Grilled Chicken salad - $12.95." both fell
// through resolvePendingDisambiguation and the same question repeated until
// the turn cap (conversations 40/16 of that run). A digit or ordinal word
// wrapped in real sentence structure is a genuine position pick as long as
// it's near the front of the message AND has selecting language attached —
// a qualifier immediately before it, punctuation glued right after it, a
// filler word right after it, or it's the whole message on its own. A bare
// leading number with none of that ("10 pieces", "two cheeseburgers and a
// large fries" — the exact LIVE MONEY BUG repros above this must keep
// rejecting; "2 of those, please" — a quantity, not a position) stays
// unresolved, same "never guess" discipline as every other tier.
// P0 fix (2026-09-19, live money bug, conv 4c52298c): "option"/"number"/
// "no."/"#" unambiguously FRAME a position — a customer who says "option 2"
// means position 2 no matter what (if anything) trails it. "the" and the
// natural-language two-word openers below carry no such framing on their
// own ("I'll take 2 Large Pepperoni pizzas" is an ORDER, not "give me
// candidate #2") — they only read as a position pick when nothing but
// filler follows the number, exactly the same discipline the unqualified
// lone-token tier below already applies. See hasOnlyFillerAfter and its use
// in matchLeadingOrdinal.
const LEADING_ORDINAL_EXPLICIT_QUALIFIERS = new Set(["option", "number", "no"]);
const LEADING_ORDINAL_AMBIGUOUS_ONE_WORD_QUALIFIERS = new Set(["the"]);
const LEADING_ORDINAL_TWO_WORD_QUALIFIERS: Array<[string, string]> = [
  ["i'll", "take"],
  ["i", "want"],
  ["i'd", "like"],
  ["go", "with"],
];
const LEADING_ORDINAL_FOLLOW_WORDS = new Set(["please", "thanks", "pls", "one"]);

// Money bug fix (2026-09-19, live conv 22b1a95a): matchLeadingOrdinal above
// only ever scans the first 6 words of the message — right for a bare "2
// please" or "option 1)" sitting at the front, but a real customer answering
// a which-one question mid-sentence, deep into a longer message ("I said I
// want 1 Cheesesteak homemade panini, that's option 1. I already told you
// the full order! ..."), puts "option 1" past that window entirely, so it
// was never seen at all — the pick was silently ignored and the rest of the
// (restated) message got misread as fresh adds instead (see turn-engine.ts's
// "disambiguation" case for the other half of that same fix).
// "option"/"number"/"option number" are UNAMBIGUOUS framing words — nothing
// else in ordinary English pairs either word directly with a bare digit —
// so unlike the bare-digit/ordinal-word tiers above, this one is safe to
// scan the ENTIRE message for, no leading-word-count limit and no trailing-
// filler requirement. Deliberately narrower than
// LEADING_ORDINAL_EXPLICIT_QUALIFIERS (drops "no"/"#"): "no" alone is too
// common a word to trust unanchored anywhere in a long message, and a bare
// "#" glued to a digit is already covered by matchLeadingOrdinal's own
// front-of-message scan since customers don't bury "#3" mid-sentence.
const EXPLICIT_OPTION_PICK_ANYWHERE_RE = /\b(?:option(?:\s+number)?|number)\s+(\d+)\b/i;

/**
 * "option 1", "that's option 1", "number 2", "option number 3" — anywhere in
 * the message, not just near the front. Returns a 0-based index, or null if
 * no such framing appears (or the number named isn't a real position in
 * this list).
 */
export function matchExplicitOptionPickAnywhere(message: string, count: number): number | null {
  const m = message.match(EXPLICIT_OPTION_PICK_ANYWHERE_RE);
  if (!m) return null;
  const idx = parseInt(m[1], 10) - 1;
  return idx >= 0 && idx < count ? idx : null;
}

function splitLeadingWord(word: string): { core: string; punct: string; hadHash: boolean } {
  const hadHash = word.startsWith("#");
  const withoutHash = hadHash ? word.slice(1) : word;
  const m = withoutHash.match(/^(.*?)([).,!.]*)$/);
  return { core: m ? m[1] : withoutHash, punct: m ? m[2] : "", hadHash };
}

function leadingOrdinalTokenValue(coreLower: string, count: number): number | null {
  const digitMatch = coreLower.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (digitMatch) {
    const idx = parseInt(digitMatch[1], 10) - 1;
    return idx >= 0 && idx < count ? idx : null;
  }
  if (Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, coreLower)) {
    const idx = ORDINAL_WORDS[coreLower];
    return idx < count ? idx : null;
  }
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, coreLower)) {
    const num = NUMBER_WORDS[coreLower];
    return num <= count ? num - 1 : null;
  }
  return null;
}

/**
 * A digit/ordinal/number word near the front of the message, with genuine
 * selecting language attached — a qualifier immediately before it ("option
 * 1)", "number 3", "#3", "the first"), punctuation glued directly after it
 * ("1)", "3."), a filler word right after it ("3 please", "the third one"),
 * or the token standing alone as the whole message ("3", "1"). Scans only
 * the first 6 words so a number buried deep in an unrelated sentence never
 * matches — the same anchoring discipline matchOrdinalPosition's own
 * 2026-09-15 live-money-bug fix relies on, just not requiring the position
 * pick to be the ENTIRE message the way that function does.
 */
// PO dispatch (2026-09-19, live money bug): a number immediately followed
// by "of" ("2 of the medium ones", "3 of those", "4 of them") is a
// QUANTITY-partitive construction, never a position pick — "I want 2 of the
// medium ones" against a rendered "1) Medium 2) Large 3) Small" was reading
// the "2" as picking list-option #2 (Large) via the "i want" qualifier
// below, silently discarding "medium" -- the word that actually answers the
// question -- and charging for the wrong size ($45.98 for what should have
// been $39.98). Checked before the qualifier/glued-terminator/lone-token
// tiers below so no wrapping language overrides it; a rejected token here
// simply isn't a pick, same "never guess" discipline as every other tier —
// the scan continues past it looking for a later, genuine one.
function isQuantityPartitive(words: string[], i: number): boolean {
  if (i + 1 >= words.length) return false;
  return splitLeadingWord(words[i + 1]).core.toLowerCase() === "of";
}

// True when position `i` in `words` is either the last word, or immediately
// followed only by a filler word ("please", "thanks", "pls", "one") — the
// only shapes a genuine position pick wears once an ambiguous qualifier
// ("the", "I'll take", "I want", "I'd like", "go with") sits in front of it.
// Anything else trailing (a size word, an item name, "of") means the number
// is naming a QUANTITY for whatever the rest of the message names, not a
// position — see LEADING_ORDINAL_EXPLICIT_QUALIFIERS's own header.
function hasOnlyFillerAfter(words: string[], i: number): boolean {
  const isLastWord = i === words.length - 1;
  if (isLastWord) return true;
  const nextCore = splitLeadingWord(words[i + 1]).core.toLowerCase();
  return LEADING_ORDINAL_FOLLOW_WORDS.has(nextCore);
}

function matchLeadingOrdinal(message: string, count: number): number | null {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const scanLimit = Math.min(words.length, 6);

  for (let i = 0; i < scanLimit; i++) {
    const { core, punct, hadHash } = splitLeadingWord(words[i]);
    const idx = leadingOrdinalTokenValue(core.toLowerCase(), count);
    if (idx === null) continue;
    if (isQuantityPartitive(words, i)) continue;

    let hasExplicitQualifier = hadHash;
    let hasAmbiguousQualifier = false;
    if (!hasExplicitQualifier && i > 0) {
      const prevCore = splitLeadingWord(words[i - 1]).core.toLowerCase();
      if (LEADING_ORDINAL_EXPLICIT_QUALIFIERS.has(prevCore)) hasExplicitQualifier = true;
      else if (LEADING_ORDINAL_AMBIGUOUS_ONE_WORD_QUALIFIERS.has(prevCore)) hasAmbiguousQualifier = true;
      if (!hasExplicitQualifier && !hasAmbiguousQualifier && i > 1) {
        const prev2Core = splitLeadingWord(words[i - 2]).core.toLowerCase();
        for (const [a, b] of LEADING_ORDINAL_TWO_WORD_QUALIFIERS) {
          if (prev2Core === a && prevCore === b) hasAmbiguousQualifier = true;
        }
      }
    }
    if (hasExplicitQualifier) return idx;
    if (hasAmbiguousQualifier && hasOnlyFillerAfter(words, i)) return idx;

    const gluedTerminator = punct === ")" || punct === ".";
    if (gluedTerminator) return idx;

    if (i === 0 && hasOnlyFillerAfter(words, i)) return idx;
  }
  return null;
}

// P0 fix (2026-09-19, TOP live money bug, conv 4c52298c): "I'll take 2
// Large Pepperoni pizzas, please." against a 3-size which-one list (option 2
// = Small in that real transcript) had the leading "2" read as a position
// pick — matchLeadingOrdinal's "I'll take" qualifier used to return idx
// unconditionally, so it grabbed candidate #2 (Small, $17.45 each) and never
// asked a clarifying question, ignoring the customer's own stated "Large".
// The distinction, per the PO ruling this fixes: a number is a QUANTITY,
// never a position index, whenever real content — a size word, an item/
// family word, or a partitive "of" — follows it; an index is specifically a
// BARE number ("2"), "option N"/"number N"/"#N"/"N)", or an ordinal word
// ("the second one"). matchLeadingOrdinal above already refuses to read the
// number as an index in every one of those quantity shapes (its own
// isQuantityPartitive check plus this file's hasOnlyFillerAfter gating on
// the ambiguous qualifiers) — this is the companion read: when a leading
// digit/number-word is rejected as an index for exactly that reason, it IS
// the quantity for whichever candidate the rest of resolvePendingDisambiguation's
// tiers (category+name narrowing, in practice) pick out. Deliberately
// narrow: skips only "of"/"the"/"a"/"an" (the shape "2 of the large" and "2
// large" both take), scans the same first-6-words window as
// matchLeadingOrdinal so a number buried later in an unrelated sentence
// never qualifies, and returns null (no override — caller keeps whatever
// quantity was already open) for every shape matchLeadingOrdinal or
// matchOrdinalPosition already treat as a genuine index pick.
const DISAMBIGUATION_QUANTITY_SKIP_WORDS = new Set(["of", "the", "a", "an"]);

// R2 fix (2026-09-19, live conv 836bf473 #29): "I asked for the Cup, so 2
// please" restates the pick BEFORE stating the quantity, trailing "so" near
// the very end of the message -- a shape the loop below never sees, for two
// independent reasons: (1) the "2" sits past the leading 6-word scan window
// deliberately used everywhere else in this file to keep a stray number in
// an unrelated clause from ever qualifying; (2) even inside that window, a
// number followed by nothing but filler ("2 please") is treated as an INDEX
// shape by design (see the loop's own "nextCore" check and the "2"/"option
// 2" tests this file already has) -- correct for a BARE answer where no
// item has been named at all, but wrong once the item was already resolved
// by name earlier in the very same sentence, at which point there is no
// index interpretation left to protect. "so" is the disambiguating signal:
// nobody restates a position pick with "so" ("so option 2" is not
// idiomatic), while "so N" renaming a just-stated count is exactly the
// customer talking about quantity. Deliberately its own separate, narrow
// tier -- scanned across the WHOLE message (it exists specifically to catch
// what the leading-window loop above cannot) but anchored tightly to the
// literal word "so" so a stray trailing number elsewhere is never caught by
// it.
const TRAILING_SO_QUANTITY_RE =
  /\bso\b[,:]?\s+(\d+|two|three|four|five)\b(?:[,\s]+(?:please|thanks|pls))*\s*[.!]?\s*$/i;

export function extractDisambiguationAnswerQuantity(message: string): number | null {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const scanLimit = Math.min(words.length, 6);

  for (let i = 0; i < scanLimit; i++) {
    const { core, punct, hadHash } = splitLeadingWord(words[i]);
    const lower = core.toLowerCase();
    const digitMatch = lower.match(/^(\d+)$/);
    const value = digitMatch ? parseInt(digitMatch[1], 10)
      : Object.prototype.hasOwnProperty.call(NUMBER_WORDS, lower) ? NUMBER_WORDS[lower]
      : null;
    if (value === null) continue;
    // Explicit index framing ("#2", "2)", "2.") -- never a quantity, whatever follows.
    if (hadHash || punct === ")" || punct === ".") continue;
    if (i > 0) {
      const prevCore = splitLeadingWord(words[i - 1]).core.toLowerCase();
      if (LEADING_ORDINAL_EXPLICIT_QUALIFIERS.has(prevCore)) continue; // "option 2", "number 2", "no. 2"
    }

    let j = i + 1;
    while (j < words.length && DISAMBIGUATION_QUANTITY_SKIP_WORDS.has(splitLeadingWord(words[j]).core.toLowerCase())) j++;
    if (j >= words.length) continue; // nothing but skip-words/end-of-message follows -- a bare index pick, not a quantity
    const nextCore = splitLeadingWord(words[j]).core.toLowerCase();
    if (LEADING_ORDINAL_FOLLOW_WORDS.has(nextCore)) continue; // only filler follows -- still an index pick

    return value;
  }

  const trailingSo = message.match(TRAILING_SO_QUANTITY_RE);
  if (trailingSo) {
    const lower = trailingSo[1].toLowerCase();
    const digitMatch = lower.match(/^(\d+)$/);
    if (digitMatch) return parseInt(digitMatch[1], 10);
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, lower)) return NUMBER_WORDS[lower];
  }
  return null;
}

/** Dollar amounts named in the message, as integer cents ("$12.95", "12.95"). */
export function extractPriceCentsFromMessage(message: string): number[] {
  const matches = message.match(/\$?\s*\d+\.\d{2}\b/g) ?? [];
  return matches.map(m => Math.round(parseFloat(m.replace(/[^0-9.]/g, "")) * 100));
}

// PO dispatch (2026-09-18, amendment to the tier-1/2/3 fix above, live
// 50-conversation measurement at build 6db8e123): real customers routinely
// restate their WHOLE order later in the same message ("I'll go with the
// Gyro hot sandwich for $10.99. So that's an Alfredo..., a Gyro sandwich,
// and a medium Hawaiian pizza.") — the restatement's stray "medium"/"pizza"
// words pulled the leading-ordinal/category-narrowing tiers toward an
// unrelated candidate (a $19.99 pizza) instead of the actual answer,
// charging the customer for an item they never asked for. The answer to a
// disambiguation question lives in the ANSWER CLAUSE, not whatever comes
// after it — so tiers 2/3 run there first, and only fall back to the whole
// message if the clause itself names nothing.
const SENTENCE_BOUNDARY_RE = /[.!?]\s|\n/;
const RESTATEMENT_MARKERS = [
  "so that's", "so that is", "just to confirm", "to confirm", "to recap",
  "and also", "oh and",
];

export function extractAnswerClause(message: string): { clause: string; truncated: boolean } {
  const lower = message.toLowerCase();
  let cutIdx = message.length;

  const boundary = message.match(SENTENCE_BOUNDARY_RE);
  if (boundary && boundary.index !== undefined && boundary.index < cutIdx) {
    cutIdx = boundary.index;
  }

  for (const marker of RESTATEMENT_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx !== -1 && idx < cutIdx) cutIdx = idx;
  }

  return { clause: message.slice(0, cutIdx).trim(), truncated: cutIdx < message.length };
}

// DEFECT 2 (2026-09-19 live QA, conv 009de656, item 4): "I'll take 2x Large
// (16\") Pepperoni pizzas for $21 each, please! So that's 2x Chicken
// Alfredo..." resolved the right candidate (Large Pepperoni, via the
// category+name-narrowing tier above) but the caller (turn-engine.ts's
// "disambiguation" case) added it at `state.open.quantity` — whatever
// quantity the disambiguation was ORIGINALLY opened with — never re-reading
// the answer text itself, so the customer's own restated "2x" was silently
// discarded ($21 charged instead of the $42 actually asked for). Scoped to
// the SAME answer clause extractAnswerClause already isolates above (never
// the whole restated order) so a LATER, unrelated item's own "2x" further
// in the message ("2x Chicken Alfredo") can never be misread as this
// candidate's count. "Nx" is deliberately the only shape recognized: a bare
// leading digit ("2 Large...") is exactly the ordinal-position shape this
// same resolver already claims elsewhere (picking option #2 from the list),
// so treating it as a quantity here would collide with that; the "x" is
// what marks it unambiguously as a count instead of a position.
const ANSWER_QUANTITY_RE = /\b(\d+)\s*x\b/i;

export function extractAnswerQuantity(clause: string): number | null {
  const m = clause.match(ANSWER_QUANTITY_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : null;
}

// The category+name-narrowing tier is terminal once it finds more than one
// candidate sharing a category — "never guess further" applies whether the
// narrowing lands on a unique winner or a tie (see the original 2026-09-15
// comment this preserves). `terminal: true, candidate: null` means "stop,
// ask again"; `terminal: false` means the text named no category at all, so
// the caller is free to keep trying other tiers.
function runCategoryNarrowingTier(
  candidates: PendingCandidate[],
  text:       string,
): { terminal: boolean; candidate: PendingCandidate | null } {
  const hits = candidates.filter(c => categoryWordMatches(c.category, text));
  if (hits.length === 1) return { terminal: true, candidate: hits[0] };
  if (hits.length > 1) return { terminal: true, candidate: nameWordMatches(hits, text) };
  return { terminal: false, candidate: null };
}

/**
 * Deterministic resolution of an answer to a pending disambiguation, checked
 * in this order: exact rendered label, leading ordinal, category+name
 * narrowing, then (unchanged) broad name match, whole-message ordinal, and
 * price last. Every tier returns ONLY on a unique hit; zero or multiple
 * matches fall through to the next tier (or, for the category+name
 * narrowing tier specifically, straight to null — see below) so the caller
 * re-asks instead of guessing.
 *
 * PO dispatch (2026-09-18): the first three tiers are what actually answer a
 * natural-language reply to the numbered list ("3 please, the Chicken
 * Cheesesteak hot sandwich!", "I would like option 1) the Grilled Chicken
 * salad - $12.95.") instead of requiring a bare digit — see the tier-2
 * helper's own header for why a bare leading number alone ("10 pieces",
 * "two cheeseburgers...", "2 of those, please") still doesn't resolve.
 *
 * Amendment (2026-09-18): the leading-ordinal and category+name-narrowing
 * tiers run against the ANSWER CLAUSE (the text up to the first sentence
 * boundary or restatement marker) first, falling back to the whole message
 * only when the clause names nothing — see extractAnswerClause's header.
 * The exact-label tier above and the price tier below are unaffected: both
 * must still match anywhere in the message ("$10.99" alone already names
 * exactly one candidate, wherever it appears). In the whole-message
 * fallback specifically, a restatement naming more than one distinct
 * category ("sandwich" and "pizza" both present) is never narrowed to a
 * single candidate — it re-asks instead.
 */
export function resolvePendingDisambiguation(
  message:    string,
  candidates: PendingCandidate[],
): PendingCandidate | null {
  const lowerMessage = message.toLowerCase();
  const labelHits = candidates.filter(c => lowerMessage.includes(candidateNameForConfirm(c).toLowerCase()));
  if (labelHits.length === 1) return labelHits[0];

  const { clause, truncated } = extractAnswerClause(message);

  const clauseOrdinalIdx = matchLeadingOrdinal(clause, candidates.length);
  if (clauseOrdinalIdx !== null) return candidates[clauseOrdinalIdx];

  const clauseCategory = runCategoryNarrowingTier(candidates, clause);
  if (clauseCategory.terminal && clauseCategory.candidate) return clauseCategory.candidate;

  if (truncated) {
    const wholeOrdinalIdx = matchLeadingOrdinal(message, candidates.length);
    if (wholeOrdinalIdx !== null) return candidates[wholeOrdinalIdx];

    const wholeCategoryHits = candidates.filter(c => categoryWordMatches(c.category, message));
    const distinctCategories = new Set(wholeCategoryHits.map(c => c.category));
    if (distinctCategories.size > 1) return null;
    if (wholeCategoryHits.length === 1) return wholeCategoryHits[0];
    if (wholeCategoryHits.length > 1) return nameWordMatches(wholeCategoryHits, message);
  } else if (clauseCategory.terminal) {
    return null;
  }

  const nameMatch = nameWordMatches(candidates, message);
  if (nameMatch) return nameMatch;

  const posIdx = matchOrdinalPosition(message, candidates.length);
  if (posIdx !== null) return candidates[posIdx];

  const prices = extractPriceCentsFromMessage(message);
  if (prices.length > 0) {
    const priceHits = candidates.filter(c => prices.some(p => Math.abs(p - c.price_cents) <= 1));
    if (priceHits.length === 1) return priceHits[0];
  }

  return null;
}

// 2026-09-07 (production removal bug): stored cart-line names are the raw
// variant label ("Cheese - Large (16\")"), not the customer's word for the
// dish ("pizza") — a literal-name-only matcher for "remove the pizza" finds
// nothing on a real cart, even though every human reading the line knows
// exactly which item that is. Two independent signals catch it, either one
// sufficient: the message names the item's MENU CATEGORY (same stem-matcher
// GUARD 7's disambiguation flow already uses — "pizza" <-> category "Pizza"),
// or the message shares a significant word-stem with the item's own stored
// NAME ("large" <-> "Cheese - Large (16\")", "knots" <-> "Garlic Knots").
// Deliberately separate from resolvePendingDisambiguation (which answers a
// different question — "which of these N already-offered candidates did the
// customer just pick" — and is relied on by the live disambiguation re-ask
// flow); this only ever narrows a removal request against the current cart,
// so it can evolve independently without risking that flow's behavior.
export function resolveNamedCartRemoval(
  capturedName: string,
  candidates: PendingCandidate[],
): PendingCandidate[] {
  const queryStems = significantStems(capturedName);
  if (queryStems.size === 0) return [];
  return candidates.filter(c => {
    if (categoryWordMatches(c.category, capturedName)) return true;
    const nameStems = significantStems(c.name);
    for (const s of queryStems) if (nameStems.has(s)) return true;
    return false;
  });
}

// BUG 1 (2026-09-11, PO — Vito's Gyro live loop): every disambiguation
// render site used to build its text from the raw, duplicate `name` plus a
// computed category word, ignoring `display_name` sitting right on the same
// candidate. Convention matches this codebase's other display_name reads
// (resolver.ts, pizza-topping-compose.ts): `display_name ?? name`.
function candidateDisplayName(c: PendingCandidate): string {
  return c.display_name && c.display_name.trim() ? c.display_name : c.name;
}

// A real display_name (e.g. "Gyro Salad") already disambiguates on its own —
// appending the category word too would be redundant ("the Gyro Salad
// salad"). Only candidates still on the shared raw name (no display_name
// ever written for them, e.g. the option-removal/cart-line candidates that
// never set this field) get the older name+category-word phrasing.
function hasDistinctDisplayName(c: PendingCandidate): boolean {
  return !!(c.display_name && c.display_name.trim() && c.display_name !== c.name);
}

/** "Gyro Sandwich" or, falling back, "Chicken Caesar salad". No article, no price — for a bare confirmation ("Got it — X added."). */
export function candidateNameForConfirm(c: PendingCandidate): string {
  if (hasDistinctDisplayName(c)) return candidateDisplayName(c);
  const word = categoryDisplayWord(c.category);
  return `${c.name}${word ? ` ${word}` : ""}`;
}

/** "Gyro Sandwich" or, falling back, "the Chicken Caesar salad". No price — for "did you want X or Y?" phrasing. */
export function candidateShortText(c: PendingCandidate): string {
  if (hasDistinctDisplayName(c)) return candidateDisplayName(c);
  const word = categoryDisplayWord(c.category);
  return `the ${c.name}${word ? ` ${word}` : ""}`;
}

/** "Gyro Sandwich — $10.99" or, falling back, "the Chicken Caesar salad — $12.95". For an options list. */
export function candidateOptionText(c: PendingCandidate): string {
  if (hasDistinctDisplayName(c)) {
    return `${candidateDisplayName(c)} — $${(c.price_cents / 100).toFixed(2)}`;
  }
  const word = categoryDisplayWord(c.category);
  return `the ${c.name}${word ? ` ${word}` : ""} — $${(c.price_cents / 100).toFixed(2)}`;
}

/**
 * `"Gyro Salad — $14.99 or Gyro Sandwich — $10.99"` — the alternatives clause
 * inside GUARD 7's "We've got a couple options called X — [alternatives]. Which
 * one?" prompt. One writer; call sites do not hand-join candidateOptionText calls.
 *
 * Reply inversion, stage 2 (2026-09-13): this function closes the last
 * remaining inline `.map(candidateOptionText).join(" or ")` at a `reply =`
 * site (site #40 in the classification pass). See the Stage 2 enforcement test
 * (reply-inversion-stage2-enforcement.test.ts) for the structural proof.
 */
export function renderOptionAlternatives(candidates: PendingCandidate[]): string {
  return candidates.map(c => candidateOptionText(c)).join(" or ");
}

function replyNumbers(count: number): string {
  const nums = Array.from({ length: count }, (_, i) => String(i + 1));
  if (nums.length <= 1) return nums[0] ?? "1";
  return `${nums.slice(0, -1).join(", ")} or ${nums[nums.length - 1]}`;
}

// PO ruling (2026-09-15, turn-engine `ambiguous` vs `unresolved` split):
// "ambiguous means ASK" is confident, correct product behavior, not a
// failure — the engine understood the customer and found several real
// matches; it isn't apologizing for missing them. renderDisambiguationReask
// above (and its "Sorry, I didn't catch that" opener) is reserved for an
// actual RE-ask, after a first answer attempt already failed to resolve the
// pending disambiguation — it stays completely unchanged, and every one of
// its existing callers (GUARD 7/7b's live re-ask flow in index.ts) keeps
// using it exactly as before. This sibling function is for the FIRST time a
// set of ambiguous candidates is offered within a turn (turn-engine.ts's
// `ask()`/`render()` disambiguation path) — same numbered-list shape, a
// question with no apology, so the reply actually reads like what it is.
export function renderAmbiguousItemQuestion(candidates: PendingCandidate[]): string {
  const list = candidates
    .map((c, i) => `${i + 1}) ${candidateOptionText(c)}`)
    .join("  ");
  const nums = replyNumbers(candidates.length);
  return `Which one would you like — ${list}? Reply ${nums}.`;
}

// 2026-09-19 PO dispatch (real live incident: a fused question-clause
// narrowing loop where the customer's own narrowing word — "chicken" — is
// contained in every one of 11 remaining candidates, so
// narrowCandidatesByFacetAnswer makes ZERO progress and the caller was about
// to re-ask the exact same "Sure — what kind?" question a second time, with
// no way out). When narrowing genuinely can't split a candidate set any
// further, the fallback is a plain numbered list — same shape
// renderAmbiguousItemQuestion already uses for a small, never-narrowed set —
// except this set is, by construction, exactly the kind
// isNarrowingCandidateSet flags as too big to safely enumerate raw (that's
// why it needed narrowing in the first place). Reuses the SAME truncate-and-
// append-"…and N more" pattern renderFacetOptionsList already uses for the
// facet-values list, so a numbered list of 11+ candidates never reproduces
// the original 3,378-char Telnyx/Twilio-rejected overflow this whole
// narrowing feature exists to avoid.
const AMBIGUOUS_LIST_SMS_CEILING = 480;

export function renderCappedAmbiguousItemQuestion(candidates: PendingCandidate[]): string {
  const nums = replyNumbers(candidates.length);
  const prefix = "Which one would you like — ";
  const suffix = `? Reply ${nums}.`;
  const items = candidates.map((c, i) => `${i + 1}) ${candidateOptionText(c)}`);
  const full = `${prefix}${items.join("  ")}${suffix}`;
  if (full.length <= AMBIGUOUS_LIST_SMS_CEILING) return full;

  const tailTemplate = (remaining: number) => `  …and ${remaining} more — text the number you want.`;
  const kept: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const remaining = items.length - (i + 1);
    const candidateText = `${prefix}${[...kept, items[i]].join("  ")}${remaining > 0 ? tailTemplate(remaining) : suffix}`;
    if (candidateText.length > AMBIGUOUS_LIST_SMS_CEILING) break;
    kept.push(items[i]);
  }
  const remaining = items.length - kept.length;
  return remaining > 0
    ? `${prefix}${kept.join("  ")}${tailTemplate(remaining)}`
    : `${prefix}${kept.join("  ")}${suffix}`;
}

/**
 * The re-ask after a failed resolution attempt: an explicit numbered list,
 * never GUARD 7's original "X or Y" sentence, so an unresolved answer never
 * repeats that first question verbatim. `priorReply` is the last assistant
 * message; if this render would reproduce it exactly (a SECOND consecutive
 * failed answer), an alternate phrasing is used instead. Two distinct
 * templates for the same candidate set means the identical string can never
 * appear on two consecutive turns — impossible by construction, not by
 * convention.
 */
export function renderDisambiguationReask(
  candidates: PendingCandidate[],
  priorReply?: string | null,
): string {
  const list = candidates
    .map((c, i) => `${i + 1}) ${candidateOptionText(c)}`)
    .join("  ");
  const nums = replyNumbers(candidates.length);
  const primary = `Sorry, I didn't catch that — ${list}. Reply ${nums}.`;
  if (priorReply !== primary) return primary;
  return `Just to be sure — ${list}. Reply with the number: ${nums}.`;
}

// P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md, live
// conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b): "4 large pizzas" hit Vito's 20
// large-pizza candidates and renderAmbiguousItemQuestion enumerated all of
// them — a 3,378-character reply Telnyx/Twilio silently refused to carry, so
// the customer got nothing. The compiler does not yet expose a dedicated
// kind/size facet column (that's the durable fix the spec asks for); this
// derives the same two facets from data already on every candidate — its own
// `name` and `category` — so the fix doesn't have to wait on a compiler
// migration + redeploy. A menu-item name is one of two shapes in practice:
// "Pepperoni Pizza - Large 18''" (compiler-derived rows: base name, dash,
// size label) or "Large Pepperoni Pizza" (a plain imported row with the size
// word folded into the name itself) — this handles both.
//
// R2 fix (2026-09-19, live conv 836bf473 #29): "Cup"/"Bowl" are this menu's
// own size labels for soups ("Lobster Bisque - Cup" vs "- Bowl"), exactly
// the same dash-suffix shape a pizza's "- Large" wears — but neither word
// was in this list, so a soup family's Cup/Bowl tie could never be closed by
// M1's own name-derived narrowing (narrowAmbiguousCandidatesBySpanSize,
// turn-engine.ts) the way a pizza's stated size already is, and a customer's
// own "Cup" answer to a which-one question resolved only via the generic
// name-word-match tier (nameWordMatches) — not the size-aware one — so nothing
// downstream that specifically depends on knowing "this was a size pick"
// (this file's own candidateSizeValue/filterCandidatesBySizeWord) ever saw it
// as one for a soup.
const NARROWING_SIZE_WORD_RE = /\b(Small|Medium|Large|X-?Large|XL|Family|Personal|Jumbo|Mini|Regular|Cup|Bowl)\b/i;

// 2026-09-19 PO dispatch (N3, probe-narrow2, live money bug: 16" added when
// the customer said 14"): a menu item family sized ONLY by inches ("The
// Slice - 14\"", "The Slice - 16\"") carries no NARROWING_SIZE_WORD_RE word
// at all, so extractSizeAndKind's `size` came back null for every candidate
// — narrowCandidatesByFacetAnswer's "size" branch (below) then had nothing
// to filter on and findDisambiguationCategoryRejectionCandidate
// (turn-engine.ts) silently fell back to `candidates[0]`, an arbitrary array
// order that has nothing to do with what the customer actually said. Same
// suffix shape the named-size regex already reads ("Name - <size>"),
// extended to also recognize a bare inch measurement when no named size
// word is present, so a numeric-only size family narrows exactly the same
// way a named-size one already did.
const NUMERIC_SIZE_RE = /\b(\d{1,2})\s*(?:"|”|″|inch(?:es)?\b)/i;

export function extractSizeAndKind(name: string): { kind: string; size: string | null } {
  const suffixMatch = name.match(/^(.*?)\s*-\s*([^-]+)$/);
  const base = suffixMatch ? suffixMatch[1].trim() : name;
  const sizeSource = suffixMatch ? suffixMatch[2].trim() : name;

  const sizeMatch = sizeSource.match(NARROWING_SIZE_WORD_RE);
  const numericMatch = sizeMatch ? null : sizeSource.match(NUMERIC_SIZE_RE);
  const size = sizeMatch ? sizeMatch[1] : (numericMatch ? `${numericMatch[1]}"` : null);
  const kind = base.replace(NARROWING_SIZE_WORD_RE, "").replace(/\s+/g, " ").trim();
  return { kind: kind || base, size };
}

// Extracts a bare inch measurement from customer text ("the 14\" pizza" ->
// "14\""), normalized to the same `${n}"` shape extractSizeAndKind derives
// for a numeric-only candidate size, so the two sides of the comparison in
// narrowCandidatesByFacetAnswer always speak the same format.
function extractNumericSizeWord(text: string): string | null {
  const m = text.match(NUMERIC_SIZE_RE);
  return m ? `${m[1]}"` : null;
}

// Strips the category's own singular word ("Pizza") out of a kind value
// ("Pepperoni Pizza" -> "Pepperoni") so the narrowing question's examples
// name only the distinguishing word, not the noun already in the question
// itself ("What kind of pizza? pepperoni, cheese…", never "…pepperoni
// pizza, cheese pizza…"). Falls back to the un-stripped kind rather than an
// empty string if stripping would remove the whole thing.
function stripCategoryNoun(kind: string, category: string | null | undefined): string {
  const word = categoryDisplayWord(category);
  if (!word) return kind;
  const stripped = kind.replace(new RegExp(`\\b${word}\\b`, "i"), "").replace(/\s+/g, " ").trim();
  return stripped || kind;
}

function distinctLowerValues(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const lower = v.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

export interface NarrowingQuestion {
  facet: "kind" | "size";
  question: string;
}

/**
 * The facet that splits an ambiguous candidate set, per Jason's direction
 * (docs/specs/2026-09-15-narrowing-questions.md): kind first, then size.
 * PO amendment (2026-09-19): the question itself is fixed copy chosen by the
 * facet alone — "What kind?"/"What size?" — never a candidate list or
 * examples; turn-engine.ts's render() prepends the acknowledgement phrase
 * and owns the one "And the size on the other one?" follow-up variant.
 * Returns null when neither facet distinguishes the set (every candidate
 * shares the same derived kind AND size) — the caller falls back to the
 * full list rather than ask a question that can't narrow anything.
 */
export function pickNarrowingFacet(candidates: PendingCandidate[]): NarrowingQuestion | null {
  const category = candidates[0]?.category ?? null;
  const parsed = candidates.map(c => {
    const { kind, size } = extractSizeAndKind(candidateDisplayName(c));
    return { kind: stripCategoryNoun(kind, category), size };
  });

  const kindValues = distinctLowerValues(parsed.map(p => p.kind));
  if (kindValues.length > 1) return { facet: "kind", question: "What kind?" };

  const sizeValues = distinctLowerValues(parsed.map(p => p.size));
  if (sizeValues.length > 1) return { facet: "size", question: "What size?" };

  return null;
}

/** A candidate's own derived size ("Large"), or null if its name carries none. */
export function candidateSizeValue(c: PendingCandidate): string | null {
  return extractSizeAndKind(candidateDisplayName(c)).size;
}

// PO amendment (2026-09-19): candidates.length > 5 (or a full priced list
// that would exceed the SMS-safe ceiling) is the exact threshold render()'s
// disambiguation case already uses to choose narrowing over enumeration —
// factored out here so answer()'s resolution side and render()'s question
// side can never disagree about which mode a given candidate set is in.
export function isNarrowingCandidateSet(candidates: PendingCandidate[]): boolean {
  return candidates.length > 5 || renderAmbiguousItemQuestion(candidates).length > 480;
}

// GAP (b) fix (2026-09-19 PO dispatch, live conv 040f91dd #47): "regular"
// and "just (a)" are filler a customer uses to say "nothing special," never
// a real facet word — but NARROWING_SIZE_WORD_RE above treats "Regular" as a
// legitimate size token, and significantStems (its own 3-char-floor
// stop-list) has no opinion on "regular"/"just" either. "Just a regular
// Coke" against a Coke family tied only on SIZE (no candidate literally
// labeled "Regular") matched "regular" as the wanted size, found zero hits,
// and returned null — an outright dead end four times running (see
// narrowCandidatesByFacetAnswer's own header on the fallback this enables).
// Stripped here, once, before either facet branch ever sees the message, so
// neither tier can be pulled toward an unrelated candidate (or a false
// zero-hit dead end) by a word that was never naming anything.
//
// "plain" — named alongside these two in the PO's own dispatch — is
// deliberately EXCLUDED here: resolveKindClauseViaLexicon (turn-engine.ts)
// and this module's own pre-existing tests treat "plain" as a real,
// intentional lexicon ALIAS for Cheese Pizza, not filler — stripping it
// broke turn-engine.test.ts's "round 2 addendum" coverage of that alias
// (a resolveItem-level regression, same root cause, see resolve-item.ts's
// own NON_SEARCH_FILLER_WORDS header for the full reasoning). Flagged, not
// silently dropped.
const NON_SEARCH_FILLER_WORD_RE = /\b(?:regular|just)\b/gi;

function hasNonSearchFillerWord(text: string): boolean {
  return /\b(?:regular|just)\b/i.test(text);
}

export function stripNonSearchFillerWords(text: string): string {
  return text.replace(NON_SEARCH_FILLER_WORD_RE, " ").replace(/\s+/g, " ").trim();
}

// GAP (b) fix, continued: once "regular"/"just" are stripped, "just
// a regular Coke" narrowing a Coke-family size tie has literally nothing
// left to distinguish by — and that IS the answer: the customer wants the
// plain, ordinary version of this family, not a repeat of the question. This
// codebase has no ITEM-level "is_default" concept to defer to (only
// option_groups' own default_choice_id, a different layer entirely — see
// PendingCandidate's own fields, which carry no default flag) — flagged
// here rather than invented. Best-effort in its absence: a candidate whose
// OWN derived kind/size is literally "regular" (the most literal reading of
// what the customer said, and exactly right when the family really does
// have a "Regular" row) if the CURRENT candidate set has one; otherwise the
// cheapest of the current candidates, as the plainest available stand-in.
function resolveDefaultCandidate(candidates: PendingCandidate[]): PendingCandidate | null {
  if (candidates.length === 0) return null;
  const regularMatch = candidates.find(c => {
    const { kind, size } = extractSizeAndKind(candidateDisplayName(c));
    return kind.trim().toLowerCase() === "regular" || (size ?? "").toLowerCase() === "regular";
  });
  if (regularMatch) return regularMatch;
  return candidates.reduce((cheapest, c) => (c.price_cents < cheapest.price_cents ? c : cheapest));
}

/**
 * Which of `candidates` does `message` name, for the given facet? For
 * "size" this is a direct size-word match against the message. For "kind"
 * it's a stem-overlap score against each distinct kind value (never a
 * single candidate — a kind can still span more than one size, which is
 * exactly the case that leaves the caller with another facet to ask).
 * Returns null on no match or a genuine tie — same "never guess" discipline
 * as resolvePendingDisambiguation's own tiers. "regular"/"just" are
 * stripped before either tier runs (see NON_SEARCH_FILLER_WORD_RE's own
 * header) — when that stripping is what leaves the message with nothing to
 * narrow by, falls back to resolveDefaultCandidate instead of the ordinary
 * null (see that function's own header), so "just a regular Coke" resolves
 * once instead of re-asking the identical question forever.
 */
export function narrowCandidatesByFacetAnswer(
  candidates: PendingCandidate[],
  facet: "kind" | "size",
  message: string,
): PendingCandidate[] | null {
  const stripped = stripNonSearchFillerWords(message);
  const matched = narrowCandidatesByFacetAnswerCore(candidates, facet, stripped);
  if (matched) return matched;
  if (hasNonSearchFillerWord(message)) {
    const fallback = resolveDefaultCandidate(candidates);
    if (fallback) return [fallback];
  }
  return null;
}

function narrowCandidatesByFacetAnswerCore(
  candidates: PendingCandidate[],
  facet: "kind" | "size",
  message: string,
): PendingCandidate[] | null {
  if (facet === "size") {
    const m = message.match(NARROWING_SIZE_WORD_RE);
    const wanted = m ? m[1].toLowerCase() : extractNumericSizeWord(message)?.toLowerCase();
    if (!wanted) return null;
    const hits = candidates.filter(c => (candidateSizeValue(c) ?? "").toLowerCase() === wanted);
    return hits.length > 0 ? hits : null;
  }

  const category = candidates[0]?.category ?? null;
  const msgStems = significantStems(message);
  if (msgStems.size === 0) return null;

  const groups = new Map<string, PendingCandidate[]>();
  for (const c of candidates) {
    const { kind } = extractSizeAndKind(candidateDisplayName(c));
    const key = stripCategoryNoun(kind, category).toLowerCase();
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  let bestKey: string | null = null;
  let bestScore = 0;
  let tie = false;
  // Round 2 addendum item B, 2026-09-19 (live/offline: Vito's "White" vs
  // "Gourmet White Fiesta", "one white" clause): the loop below scores by
  // raw stem-overlap count alone, so a short kind name that is fully named
  // ("white" naming "White" exactly) ties with a longer kind that merely
  // CONTAINS that word ("Gourmet White Fiesta" only partially named) —
  // both score 1, `tie` fires, and the clause was silently dropped (never
  // even reaching the clarify-message fallback). `exactKeys` collects
  // every kind whose ENTIRE stem set is named in the message (score equals
  // that kind's own stem count) — an exact name always outranks a partial
  // one, checked before the tie above ever gets a say.
  const exactKeys: string[] = [];
  for (const key of groups.keys()) {
    const kindStems = significantStems(key);
    let score = 0;
    for (const s of msgStems) if (kindStems.has(s)) score++;
    if (kindStems.size > 0 && score === kindStems.size) exactKeys.push(key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
      tie = false;
    } else if (score > 0 && score === bestScore && key !== bestKey) {
      tie = true;
    }
  }
  // Exactly one kind was named in full: that wins outright, whether or not
  // the raw-overlap loop above called it a tie. Two or more exact matches
  // is a genuine tie between real kinds (falls through, same "never guess"
  // discipline as everywhere else in this function) — ask about it by name
  // rather than pick one.
  if (exactKeys.length === 1) return groups.get(exactKeys[0]) ?? null;
  if (bestScore > 0 && !tie && bestKey !== null) return groups.get(bestKey) ?? null;

  // Data fix (c), 2026-09-19, real customer typo ("hawiaan" for "hawaiian"):
  // no exact stem overlap at all — try a bounded fuzzy fallback (6+ letter
  // words only, fuzzyWordMatch's own graduated tolerance — see
  // itemSpanNamedInMessage's sibling fix in turn-engine.ts for why a flat
  // edit-distance-1 cap does not actually cover this repro:
  // levenshteinDistance("hawaiian","hawiaan") is 2) before giving up. Fires
  // ONLY when EXACTLY ONE candidate family has a fuzzy-matching stem — two
  // or more within tolerance is genuine ambiguity between real kinds, never
  // guessed at, same as the exact-match tie rule just above.
  let fuzzyKey: string | null = null;
  let fuzzyTie = false;
  for (const key of groups.keys()) {
    const kindStems = [...significantStems(key)].filter(s => s.length >= 6);
    if (kindStems.length === 0) continue;
    const hasFuzzyHit = [...msgStems].some(s =>
      s.length >= 6 && kindStems.some(ks => fuzzyWordMatch(s, ks)),
    );
    if (!hasFuzzyHit) continue;
    if (fuzzyKey === null) fuzzyKey = key;
    else if (key !== fuzzyKey) fuzzyTie = true;
  }
  if (fuzzyKey !== null && !fuzzyTie) return groups.get(fuzzyKey) ?? null;
  return null;
}

/**
 * The distinct values a facet takes across `candidates`, in first-seen
 * order and ORIGINAL casing (unlike the internal grouping above, which
 * lowercases only for comparison) — for rendering "what are the options"
 * lists ("Pepperoni, Cheese, Sausage…"), never for matching.
 */
export function facetDisplayValues(candidates: PendingCandidate[], facet: "kind" | "size"): string[] {
  const category = candidates[0]?.category ?? null;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const c of candidates) {
    const { kind, size } = extractSizeAndKind(candidateDisplayName(c));
    const raw = facet === "kind" ? stripCategoryNoun(kind, category) : size;
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(raw);
  }
  return values;
}

// PO amendment (2026-09-19, exact repro "2 pizzas, one large"): a stated
// size can apply to only PART of the stated quantity — the customer named a
// sub-count strictly less than the total, tagged with its own size, in a
// clause after a comma. Distinct from a size word that applies to the WHOLE
// span ("4 large pizzas" — see extractGlobalSizeWord below): that shape has
// no comma-separated sub-quantity naming fewer units than the total.
const PARTIAL_SIZE_QTY_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const PARTIAL_SIZE_CLAUSE_RE =
  /,\s*(\d+|one|two|three|four|five)\s+(Small|Medium|Large|X-?Large|XL|Family|Personal|Jumbo|Mini|Regular)\b/i;

export function extractPartialSizeClause(
  spanText: string,
  totalQuantity: number,
): { sizeWord: string; sizeQuantity: number } | null {
  const m = spanText.match(PARTIAL_SIZE_CLAUSE_RE);
  if (!m) return null;
  const rawQty = m[1].toLowerCase();
  const qty = /^\d+$/.test(rawQty) ? parseInt(rawQty, 10) : PARTIAL_SIZE_QTY_WORDS[rawQty];
  if (!qty || qty >= totalQuantity) return null;
  return { sizeWord: m[2], sizeQuantity: qty };
}

/** A size word naming the WHOLE stated quantity ("4 large pizzas" -> "large", "the 14\" pizza" -> "14\""). */
export function extractGlobalSizeWord(spanText: string): string | null {
  const m = spanText.match(NARROWING_SIZE_WORD_RE);
  return m ? m[1] : extractNumericSizeWord(spanText);
}

/** Narrows to candidates whose own derived size matches `sizeWord`; falls back to the unfiltered set if none do (defensive — never produces an empty question). */
export function filterCandidatesBySizeWord(candidates: PendingCandidate[], sizeWord: string): PendingCandidate[] {
  const wanted = sizeWord.toLowerCase();
  const hits = candidates.filter(c => (candidateSizeValue(c) ?? "").toLowerCase() === wanted);
  return hits.length > 0 ? hits : candidates;
}

// Explicit-request detection for spec point 4 ("Enumeration only happens if
// the customer explicitly asks what the options are"). Deliberately NOT
// wired to "any failed answer" the way the slot case's enumerateSlotChoices
// is (turn-engine.ts render()'s "slot" case) — a disambiguation set can be
// 60+ candidates, so silently falling back to the full list on every
// mis-parsed answer would reintroduce this exact P0's oversized-reply risk
// on a different trigger. Only a message that actually names "options" (or
// the "what do you have" variant Jason's own spec quotes) counts.
const DISAMBIGUATION_OPTIONS_REQUEST_RE =
  /\bwhat\s+(?:are|is|'s|s)?\s*(?:the\s+)?options\b|\bwhat\s+(?:kinds?|sizes?)\s+do\s+you\s+have\b|\bwhat\s+do\s+you\s+have\b/i;

export function isDisambiguationOptionsRequest(message: string): boolean {
  return DISAMBIGUATION_OPTIONS_REQUEST_RE.test(message);
}
