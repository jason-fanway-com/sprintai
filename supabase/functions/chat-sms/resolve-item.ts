// Code-owned item resolution (docs/specs/2026-09-15-code-owned-resolution.md
// §4, work item 2).
//
// ROOT CAUSE this closes: Phase 2 had the model choose `menu_item_id`
// directly. Measured on Vito's, even after the lexicon had every correct
// term, 10 of 20 live calls still billed the wrong item — "cheeseburger"
// resolved to Bacon Cheeseburger ($10.99) instead of Cheese Burger ($8.49)
// in several phrasings, even though the correct lexicon term was already
// present. Item identity cannot be a model output; it has to be resolved
// deterministically in code. propose.ts's Proposal.adds now carries
// `item_span` — the verbatim substring of the customer's own message naming
// the item — and this module is the one place that turns a span into a
// menu_item_id, or explicitly refuses to.
//
// Pure, no I/O, no LLM call — same discipline as ask-plan-engine.ts and
// turn-engine.ts. Given a span and the shop's compiled item-level lexicon
// (the `lexicon` table, target_type = 'item', active = true — the exact
// same shape propose.ts's LexiconTerm already carries), find the LONGEST
// lexicon term that occurs in the normalized span as a whole-word run:
//
//   - exactly one target at that longest length -> resolved
//   - two or more DIFFERENT targets tie at that longest length -> ambiguous,
//     carrying every tying target so ASK can name them
//   - nothing matched at all -> unresolved
//
// Longest-match is the whole mechanism: it is what makes "bacon
// cheeseburger" beat "cheeseburger" only when the customer's span actually
// contains the word "bacon" — a span containing just "cheeseburger" can
// never match the two-word "bacon cheeseburger" term, because that term's
// word-run doesn't fit inside a one-word span. Ties are always ambiguous,
// never broken by any heuristic, tiebreak, popularity score, or fallback —
// see the spec's §2, confirmed directly by Jason: asking is the product
// behavior, not a defect to engineer away.
//
// 2026-09-18 PO dispatch (narrowing, not listing): the shared-name-terms
// recompile gave every item in a family a bare head-noun term on purpose
// ("salad" now has 7 targets so it routes to a question instead of dead-
// ending) — but that same wide term also ties a customer who fully named a
// SPECIFIC item ("house salad" — item "House", category "Salads") into the
// full 8-way list, because a one-word item-name span ("house") and a
// one-word wide term ("salad") tie at the same length and just union. Real
// Vito's data (probe): "salad" as a lexicon TERM covers only 7 of the 14
// actual Salads-category items (only the ones whose own stated name says
// "...Salad" — "House"/"Southwest"/"Greek" don't) and INCLUDES two
// Appetizers ("Side Salad", "Caprese Salad") that aren't Salads at all. So
// the wide term's own target set is not a reliable stand-in for "every item
// in the category" — narrowing needs each candidate's REAL `category` (and
// `size_label`, for "14-inch calzone" style phrasing), not just term/target
// relationships. Both are optional here because production's lexicon load
// (turn-engine-runner.ts's loadItemLexicon) selects only `term, target_id`
// today — see this dispatch's own report for the wiring gap that leaves
// open. LexiconTerm can carry them; resolveItem uses them when present and
// falls back to the pre-existing behavior when absent (every hand-typed
// fixture below and every existing caller).
export interface LexiconTerm {
  term: string;
  target_id: string;
  category?: string | null;
  size_label?: string | null;
}

// Round 2, item 1c (2026-09-19): a fresh add ("hawiaan" for "Hawaiian
// Pizza") that is NOT inside an open disambiguation could never resolve,
// typo or not — the only typo tolerance in the codebase lived in
// pending-disambiguation.ts's narrowCandidatesByFacetAnswer, reachable
// solely from an already-open list-answer question. Reusing the SAME rule
// here (guard19-fuzzy-item-match.ts's fuzzyWordMatch — see that file's own
// header for why a flat edit-distance-1 cap doesn't actually cover
// "hawiaan"/"hawaiian", dist 2) means every caller of resolveItem gets typo
// tolerance, not just the list-answer path.
import { fuzzyWordMatch } from "./guard19-fuzzy-item-match.ts";

// Mirrors compile-menu.ts's own (unexported) categoryNoun/singularizeWord/
// pluralizeWord exactly, so "the shop's actual categories" reduce to the
// same noun a customer would say ("Hot Sandwiches" -> "sandwich") as the
// compiler's own rule-3 category terms would. Duplicated rather than
// imported: this dispatch is scoped to this file and its test only, and
// those three helpers aren't exported by compile-menu.ts.
function singularizeWord(word: string): string {
  if (word.length > 4 && /ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|ses|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

function pluralizeWord(singular: string): string {
  return /s$/i.test(singular) ? singular : `${singular}s`;
}

function categoryNoun(category: string): string {
  const cleaned = category.replace(/\([^)]*\)/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return singularizeWord(words[words.length - 1].toLowerCase());
}

// Fixed vocabulary, per spec — never inferred from the lexicon. "14-inch"/
// "14\""/"14" all reduce to the bare word "14" post-normalize (normalize()
// strips the hyphen and the quote the same way it strips any other
// punctuation).
const SIZE_WORD_TOKENS = new Set(["small", "medium", "large", "personal"]);
const SIZE_DIGIT_TOKENS = new Set(["10", "14", "16"]);

// 2026-09-19 PO dispatch (compiler priority item 2, size-qualified bare
// name): compile-menu.ts's itemLexiconTerms Rule 2b now emits a size digit
// PLUS the literal word "inch" as part of an item's own term text ("14
// inch calzone", via canonicalizeSizeTokens' existing "<digits> inch"
// convention) — the first time any lexicon term has ever carried that word.
// Neither coreContentWords nor coreContentWordsForEntry below stripped it,
// so widenIntoSizedFamily's own core-word comparison reduced "14 inch
// calzone" to ["inch","calzone"] instead of ["calzone"] — "inch" survived
// as if it were real dish vocabulary, uniting the 14" and 16" items as
// "the same dish, different size" siblings purely because they share a
// unit word that names nothing, and collapsed an already-unique,
// maximally-specific match ("just a 14-inch calzone") back into a false
// 2-way tie. Live regression this dispatch's own fix would otherwise have
// introduced (caught by this file's existing test suite, not live) — same
// treatment as SIZE_WORD_TOKENS/SIZE_DIGIT_TOKENS: a unit word that only
// ever rides along a real size signal, never a dish word on its own.
const SIZE_UNIT_WORDS = new Set(["inch"]);

// 2026-09-19 PO dispatch (conv22 live-runner gap, real $23.94-vs-$11.98
// money bug, reopens cb37bda9): real customer/model text routinely
// abbreviates a size word ("2 med pepperoni pizzas") but the compiled
// lexicon only ever carries the SIZE_WORD_TOKENS' own spelled-out forms
// ("medium pepperoni pizza(s)") — an abbreviated span word matches neither
// that 3-word term (occursAsWholeWordRun is exact, no stemming) nor
// SIZE_WORD_TOKENS itself, so it ties across every size sharing the bare
// "pepperoni" term instead of resolving to the one the customer named.
// Expanded once, here, inside toWords() — the single chokepoint both span
// words AND every lexicon term's own words already flow through — so a span
// abbreviation and a fully-spelled lexicon term compare equal without
// touching either side's matching logic. Exported so turn-engine.ts's own
// item-span-in-message guard (itemSpanNamedInMessage) can apply the exact
// same expansion before comparing a model's item_span against the
// customer's raw words, instead of maintaining a second, driftable copy.
export const SIZE_WORD_ALIASES: Record<string, string> = { med: "medium", lg: "large", sm: "small" };

function detectSizeToken(spanWords: string[]): string | null {
  for (const w of spanWords) {
    if (SIZE_WORD_TOKENS.has(w) || SIZE_DIGIT_TOKENS.has(w)) return w;
  }
  return null;
}

function sizeLabelMatchesToken(sizeLabel: string | null | undefined, token: string): boolean {
  if (!sizeLabel) return false;
  return toWords(normalize(sizeLabel)).includes(token);
}

// 2026-09-18 PO dispatch (edge 2 — a stated size must be honored even when a
// bare term already resolves uniquely): "slice" is simultaneously Regular
// Slice's own bare item term AND the category noun for "By the Slice", so it
// gets excluded from itemNameEntries below and the span falls through to the
// unfiltered, unnarrowed scan. "a 16-inch slice" must not silently resolve to
// the $2.85 Regular Slice just because it was the only DIRECT term hit — "The
// Slice - 16\"" family names the same dish via its own compiled terms
// ("the slice stromboli", "slice stromboli", etc, all carrying its own
// category noun "stromboli"), and must be offered instead. FILLER_WORDS
// strips determiners; SIZE_*_TOKENS strip size vocabulary; a term's own
// entry.category noun is ALSO stripped (see coreContentWordsForEntry) so
// "the slice stromboli" reduces to the same ["slice"] core as the bare
// "slice" term that actually matched the span, without requiring a literal
// "the slice" (no category word) term to exist in the compiled lexicon.
const FILLER_WORDS = new Set(["a", "an", "the"]);

// The matched term's own reduction — filler/size only. Never strips a
// category noun here: this is applied to the term that ALREADY matched the
// span (e.g. "slice", Regular Slice's own bare term), and stripping its own
// category noun ("slice" is also "By the Slice"'s noun) would wipe it to
// nothing.
//
// 2026-09-18 PO dispatch (plural family widening): each surviving word is
// SINGULARIZED (reusing this file's own singularizeWord, the same stemmer
// compile-menu.ts uses) before being returned. Real Vito's shape: the
// Stromboli Rolls "Meat Lovers" item's own name is plural, while the Meat
// Lover pizza family's bare base-key term is singular — an exact,
// unstemmed word comparison (sameWordSet) saw {meat, lovers} != {meat,
// lover} and never recognized the two as the same dish family, so a stated
// size on the pizza never widened the roll's own unique-but-wrong hit into
// the real 4-way tie.
function coreContentWords(words: string[]): string[] {
  return words
    .filter(w => !FILLER_WORDS.has(w) && !SIZE_WORD_TOKENS.has(w) && !SIZE_DIGIT_TOKENS.has(w) && !SIZE_UNIT_WORDS.has(w))
    .map(singularizeWord);
}

// A CANDIDATE sibling's reduction — filler/size AND that entry's own
// category noun (singular + plural). This is what lets "the slice stromboli"
// (Stromboli's own category noun "stromboli") reduce down to the same
// ["slice"] core the bare "slice" term matched, so the two surface forms are
// recognized as naming the same dish family despite neither containing the
// other verbatim. Singularized for the same reason as coreContentWords
// above — filtering against categoryNounWords (already both singular and
// plural) happens on the RAW word first, singularizing only the survivors.
function coreContentWordsForEntry(entry: LexiconTerm): string[] {
  const words = toWords(normalize(entry.term));
  const categoryNounWords = new Set<string>();
  if (entry.category) {
    const noun = categoryNoun(entry.category);
    if (noun) {
      categoryNounWords.add(noun);
      categoryNounWords.add(pluralizeWord(noun));
    }
  }
  return words
    .filter(w => !FILLER_WORDS.has(w) && !SIZE_WORD_TOKENS.has(w) && !SIZE_DIGIT_TOKENS.has(w) && !SIZE_UNIT_WORDS.has(w) && !categoryNounWords.has(w))
    .map(singularizeWord);
}

function sameWordSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((w, i) => w === sortedB[i]);
}

// Which of `targetId`'s own lexicon terms is the one that actually matched
// the span at the winning length — needed to know what "the same dish
// family, modulo filler/size words" means for THIS resolution, not just any
// term the target happens to carry.
function findMatchedTermWords(
  targetId: string,
  length: number,
  spanWords: string[],
  entries: LexiconTerm[],
): string[] | null {
  for (const entry of entries) {
    if (entry.target_id !== targetId) continue;
    const termWords = toWords(normalize(entry.term));
    if (termWords.length !== length) continue;
    if (occursAsWholeWordRun(spanWords, termWords)) return termWords;
  }
  return null;
}

// word -> every category (among whatever `lexicon` this call was given —
// the shop's own real categories, not a fixed list) whose singular or
// plural noun is that word. Scanned across the WHOLE array, not just the
// current tied candidates, so a category word is recognized even when none
// of the category's own items happen to be in the current tie.
function buildCategoryNounIndex(lexicon: LexiconTerm[]): Map<string, Set<string>> {
  const categories = new Set<string>();
  for (const entry of lexicon) {
    if (entry.category) categories.add(entry.category);
  }
  const index = new Map<string, Set<string>>();
  for (const category of categories) {
    const noun = categoryNoun(category);
    if (!noun) continue;
    for (const word of new Set([noun, pluralizeWord(noun)])) {
      const set = index.get(word) ?? new Set<string>();
      set.add(category);
      index.set(word, set);
    }
  }
  return index;
}

export type ResolveItemResult =
  | { kind: "resolved"; menu_item_id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unresolved" };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toWords(normalized: string): string[] {
  if (normalized.length === 0) return [];
  return normalized.split(" ").map(w => SIZE_WORD_ALIASES[w] ?? w);
}

// Does `termWords` occur in `spanWords` as a contiguous, whole-word run?
// This is the entire "not a substring inside another word" guarantee — a
// term's words are matched one-for-one against span words, never against a
// slice of a single longer word.
function occursAsWholeWordRun(spanWords: string[], termWords: string[]): boolean {
  if (termWords.length === 0 || termWords.length > spanWords.length) return false;
  for (let start = 0; start <= spanWords.length - termWords.length; start++) {
    let matched = true;
    for (let i = 0; i < termWords.length; i++) {
      if (spanWords[start + i] !== termWords[i]) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

// Round 2, item 1c: the same whole-word-run scan as occursAsWholeWordRun,
// except each word pair may also match via fuzzyWordMatch instead of exact
// equality — so a single typo'd word inside an otherwise-correct span
// ("hawiaan pizza") still finds the term ("hawaiian pizza") it names.
function occursAsWholeWordRunFuzzy(spanWords: string[], termWords: string[]): boolean {
  if (termWords.length === 0 || termWords.length > spanWords.length) return false;
  for (let start = 0; start <= spanWords.length - termWords.length; start++) {
    let matched = true;
    for (let i = 0; i < termWords.length; i++) {
      const sw = spanWords[start + i];
      const tw = termWords[i];
      if (sw !== tw && !fuzzyWordMatch(sw, tw)) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

// Fuzzy sibling of longestMatch, used ONLY as a fallback once an exact scan
// found nothing at all (resolveItem below) — never runs alongside, and
// never overrides, an exact hit or an exact tie.
//
// S3 fix (2026-09-19, live money bug, real conv 22347973, "sticks are
// back"): a ONE-word term ("sticks", Mozzarella Sticks) fuzzy-matching a
// single stray span word ("stick", from "...just stick with those two items
// for pickup!") has no corroborating second word anywhere in the term to
// confirm the guess — unlike "pepperoni pizzas" fuzzy-matching the term
// "pepperoni pizza", where "pepperoni" already matched EXACTLY and only the
// plural "s" on the second word is being tolerated. `minTermWords` lets a
// caller feeding raw/derived customer text (no model-endorsed span) with no
// other exact anchor require every fuzzy candidate to be a genuine multi-
// word term — never a single fuzzy guess standing entirely on its own.
// Defaulted to 1 (today's behavior, unchanged) for every pre-existing caller.
function fuzzyLongestMatch(
  spanWords: string[],
  entries: LexiconTerm[],
  minTermWords = 1,
): { length: number; targetIds: Set<string> } {
  let longestMatchedLength = 0;
  const targetIdsAtLongest = new Set<string>();
  for (const entry of entries) {
    const termWords = toWords(normalize(entry.term));
    if (termWords.length === 0 || termWords.length < minTermWords) continue;
    if (!occursAsWholeWordRunFuzzy(spanWords, termWords)) continue;

    if (termWords.length > longestMatchedLength) {
      longestMatchedLength = termWords.length;
      targetIdsAtLongest.clear();
      targetIdsAtLongest.add(entry.target_id);
    } else if (termWords.length === longestMatchedLength) {
      targetIdsAtLongest.add(entry.target_id);
    }
  }
  return { length: longestMatchedLength, targetIds: targetIdsAtLongest };
}

// The original, unmodified longest-match scan — unchanged behavior, used
// both as the primary pass (below) and as the exact fallback for a phrase
// that names nothing but a bare category word ("salad" alone).
function longestMatch(spanWords: string[], entries: LexiconTerm[]): { length: number; targetIds: Set<string> } {
  let longestMatchedLength = 0;
  const targetIdsAtLongest = new Set<string>();
  for (const entry of entries) {
    const termWords = toWords(normalize(entry.term));
    if (termWords.length === 0) continue;
    if (!occursAsWholeWordRun(spanWords, termWords)) continue;

    if (termWords.length > longestMatchedLength) {
      longestMatchedLength = termWords.length;
      targetIdsAtLongest.clear();
      targetIdsAtLongest.add(entry.target_id);
    } else if (termWords.length === longestMatchedLength) {
      targetIdsAtLongest.add(entry.target_id);
    }
  }
  return { length: longestMatchedLength, targetIds: targetIdsAtLongest };
}

// 2026-09-18 PO dispatch (plural family widening, real conv c9027bee): "2
// small Meat Lovers pizzas" resolved to the $9.99 Stromboli Roll "Meat
// Lovers" instead of the $12.95 Meat Lover - Small (10") pizza. Root
// cause: the Roll's own exact name is plural ("Meat Lovers"), the pizza
// family's bare base-key term is singular ("Meat Lover" — compile-menu.ts
// folds every size onto one base-key term regardless of the raw import's
// own plural/singular spelling), so the plural span word "lovers" matched
// the Roll's own term at length 2 while the singular pizza term never
// matched at all (occursAsWholeWordRun is an exact word comparison, no
// stemming) — a UNIQUE, non-tied hit that silently ignored a real sibling
// family sharing the same dish name, one word apart.
//
// This is the SAME shape edge 2 below already solves for a stated size
// that doesn't match the one hit found ("a 16-inch slice" must not
// silently resolve to the cheap Regular Slice) — the fix generalizes that
// mechanism two ways: (1) coreContentWords/coreContentWordsForEntry now
// SINGULARIZE each word before comparing, so "lovers" and "lover" reduce
// to the identical core and the pizza family is actually found as a
// sibling; (2) this same widening now also runs for a unique ITEM-NAME
// match (not just the bare-fallback-scan case edge 2 originally covered),
// since "Meat Lovers" is a real item-name term, not a bare category word.
//
// Specific enough to resolve straight to one sibling: either the customer
// names the family with its own definite article ("the meat lover(s)",
// edge 2's original signal), OR the span states a CATEGORY word matching
// one of the newly-surfaced siblings ("pizzas" — a stronger, more direct
// signal than a bare size number ever was, which is why "a 16-inch slice"
// — no category word for the sibling "Stromboli" family — still correctly
// stays ambiguous rather than resolving). Neither signal present, or the
// stated size doesn't uniquely match one sibling, returns every family
// member as an ambiguous list — "meat lovers" alone (no size, no category
// word) must never silently resolve to the roll either; it's genuinely
// unclear which of the four the customer means.
function widenIntoSizedFamily(
  baseId: string,
  matchedLength: number,
  spanWords: string[],
  lexicon: LexiconTerm[],
  namedCategories: Set<string>,
): ResolveItemResult | null {
  const matchedWords = findMatchedTermWords(baseId, matchedLength, spanWords, lexicon);
  if (!matchedWords) return null;

  // 2026-09-19 PO dispatch (compiler priority item 2, size-qualified bare
  // name): this whole function exists to rescue a SIZE-BLIND base match
  // ("meat lovers", no size word anywhere in the matched term itself) by
  // checking whether the customer's span states a size elsewhere. It was
  // never meant to run when the base match ALREADY carries its own size —
  // compile-menu.ts's Rule 2b now emits terms like "14 inch calzone" that
  // do exactly that, and coreContentWords' own stripping of the size
  // digit/unit words (needed for the size-blind case) would otherwise throw
  // that specificity away and go hunting for "same dish, different size"
  // siblings that were never actually in question — collapsing an already-
  // maximally-specific match back into a false tie with those siblings.
  // A base match that already names its own size needs no widening at all.
  if (matchedWords.some(w => SIZE_WORD_TOKENS.has(w) || SIZE_DIGIT_TOKENS.has(w))) return null;

  const wantedCore = coreContentWords(matchedWords);
  if (wantedCore.length === 0) return null;

  const siblingIds = new Set<string>();
  for (const entry of lexicon) {
    if (sameWordSet(coreContentWordsForEntry(entry), wantedCore)) siblingIds.add(entry.target_id);
  }
  const hasSizedSibling = [...siblingIds].some(
    id => id !== baseId && lexicon.find(e => e.target_id === id)?.size_label != null,
  );
  // Only widen at all when some sibling actually carries a real size —
  // otherwise the shared core word genuinely names nothing else, and the
  // original single hit is still the right answer.
  if (!hasSizedSibling) return null;

  siblingIds.add(baseId);

  const namesFamilyDefinitely = occursAsWholeWordRun(spanWords, ["the", ...wantedCore]);
  const namesSiblingCategory = [...siblingIds].some(id => {
    const category = lexicon.find(e => e.target_id === id)?.category;
    return category != null && namedCategories.has(category);
  });

  if (namesFamilyDefinitely || namesSiblingCategory) {
    const sizeToken = detectSizeToken(spanWords);
    if (sizeToken) {
      const sized = [...siblingIds].filter(id =>
        sizeLabelMatchesToken(lexicon.find(e => e.target_id === id)?.size_label, sizeToken)
      );
      if (sized.length === 1) return { kind: "resolved", menu_item_id: sized[0] };
    }
  }
  return { kind: "ambiguous", candidates: [...siblingIds].sort() };
}

// DEFECT 3 (2026-09-19 live QA, conv 009de656, item 4): "Can I also get a
// side of bleu cheese?" tied 3 Cheese pizza SIZES — the only candidates the
// single-word term "cheese" (a real, correct term for ordering a Cheese
// pizza) resolves to, once the shop's own longer, more specific, correctly-
// targeted term "bleu cheese" is excluded from `lexicon` for being
// inactive/non-orderable (real Vito's data: "bleu cheese" -> the real
// "Bleu Cheese" row, a display_only pizza-finish, never a standalone
// orderable side — see loadItemLexicon's own header for why its term is
// deliberately dropped before this function ever sees it). The bug was
// falling all the way back to the unrelated single-word match instead of
// recognizing that a MORE SPECIFIC, curated answer was found and correctly
// excluded — the right response is "I don't know that item," never a guess
// at three pizzas the customer never asked about.
//
// `inactiveLexicon` carries exactly those excluded rows (same shape as
// `lexicon`, term/target_id only — category/size_label are irrelevant here,
// this never resolves anything on its own, only vetoes a guess) purely so
// this one check can see them. Optional and defaulted to `[]` so every
// pre-existing call site and test fixture (which never had this concept)
// is completely unaffected.
//
// 2026-09-19/20 PO dispatch (bleu-cheese off-menu decline, real conv
// 009de656 follow-up): returns the matched inactive LexiconTerm itself
// (rather than a bare boolean) so findVetoedOffMenuTerm below can hand its
// caller the actual excluded term text — resolveItem's own veto branch
// below still only checks truthiness, so this is a pure signature widening
// with byte-identical behavior for every existing caller/test.
//
// 2026-09-20 PO dispatch (live money regression, v567 conv 7ecc60e6 #30:
// "Chicken Noodle - Cup"/"- Bowl" wrongly refused): real Vito's compiler
// emits BOTH an active, shorter alias ("chicken noodle", 2 words, tied
// across the Cup AND Bowl items) AND an inactive, longer, full-name term
// for the SAME orderable item ("chicken noodle - cup", 3 words, target_id
// = the Cup item itself) — the longer-inactive-term check below existed to
// catch a span that resolves to NOTHING real once a more specific excluded
// term is found (bleu cheese: the excluded term's target is a display-only
// item, never one of the tied Cheese pizzas), but it fired here too, even
// though the "more specific" excluded term is just the SAME real item's own
// fuller name — the shorter active match had already tied it in. `resolvedTargetIds`
// (the caller's own `base.targetIds`, i.e. what the normal resolution path
// already resolved or tied to before this veto runs) lets this tell the two
// cases apart: an inactive term whose target is already among the real
// candidates names something that DOES resolve, so it can never be the
// "this doesn't exist" case the veto exists for — skip it and keep looking
// (a later, genuinely-unmatched inactive entry can still veto).
function findLongerInactiveTerm(
  spanWords: string[],
  inactiveLexicon: LexiconTerm[],
  matchedLength: number,
  resolvedTargetIds: ReadonlySet<string>,
): LexiconTerm | null {
  for (const entry of inactiveLexicon) {
    if (resolvedTargetIds.has(entry.target_id)) continue;
    const termWords = toWords(normalize(entry.term));
    if (termWords.length > matchedLength && occursAsWholeWordRun(spanWords, termWords)) return entry;
  }
  return null;
}

// 2026-09-20 PO dispatch (off-menu category-mismatch, real conv 75b6e542,
// live $22.99 money bug): generalizes the SAME class of defect
// uniqueBaseCategoryConflict already solves for a UNIQUE base match
// (below) to a genuine TIE. Real Vito's shape: "buffalo chicken fries" ties
// resolveItem's own real, correct 2-word term "buffalo chicken" across
// Buffalo Chicken Pizza (S/M/L)/Flatbread/Wrap — a real word-pair — but the
// span's own trailing/head word "fries" names a real, separate dish family
// (French Fries, Crab Fries, Sweet Potato Fries, ...) that NONE of those
// tied candidates belong to. Vito's has no menu_items.category literally
// named "Fries" (they're filed under "Appetizers" alongside a dozen
// unrelated items), so the existing categoryNounIndex (built from the
// shop's own DB `category` strings, see buildCategoryNounIndex) can never
// recognize "fries" as a category word the way it recognizes "salad" or
// "pizza". Real menu items that ARE fries state so directly in their OWN
// name/lexicon term ("French Fries", "Crab Fries", ...) — this builds a
// second, item-NAME-derived word index (buildNameWordIndex) purely to
// catch that shape: a word the customer used, not already part of what
// matched THIS tie, that is some OTHER real item's own stated word and
// NONE of the tied candidates'. That is "off-menu for this tie" regardless
// of whether the shop's DB category taxonomy happens to have a matching
// name for it.
//
// Scanned trailing-word-first (spanWords in reverse) on purpose, mirroring
// categoryNoun's own "last word of the phrase is the head noun" convention
// elsewhere in this file: "side of buffalo chicken fries" must flag on
// "fries" (the real head noun), not "side" (an incidental filler word that
// happens to also be part of the real "Side Salad" item's own name) --
// checking from the end of the span finds the head noun first and returns
// on the first genuine hit, exactly like categoryNoun always takes the
// LAST word of a category name.
//
// Only ever a veto: returns the single word that doesn't belong, never
// picks a "best" candidate itself. `matchedWordsAcrossCandidates` is the
// union of every tied candidate's own matched term words (not just one),
// so a word genuinely part of what ANY tied candidate is actually named
// ("chicken" inside "Buffalo Chicken Pizza") is never treated as an
// outside qualifier — the same "already inside the candidate's own
// name/category" exemption uniqueBaseCategoryConflict already applies for
// the unique case.
//
// `categoryNounIndex` words are ALSO exempt here, deliberately: a word that
// IS one of the shop's own real DB category nouns ("pizza", "sandwich",
// "salad") already has its own dedicated, heavily-tested mechanism just
// below (the `namedCategories` filter + its edge-1 "never wipe a real tie
// to zero" fallback) — including real, correct cases this function must
// never re-decide differently, e.g. "cheese pizza" (all 3 tied Cheese
// candidates genuinely ARE Pizza — "pizza" just isn't the word that
// disambiguates the size) and "a House Personal pizza" (House ties across
// two Stromboli sizes; "pizza" is the customer's own mistaken category
// guess for a real, specific item that DOES exist — freeze-queue item 4's
// category-confirm hold-and-ask exists precisely to recover that case by
// resolving it normally, not declining it here). This function's own job
// starts exactly where that mechanism's vocabulary runs out: a head noun
// like "fries" that names a real dish family with no DB category of its
// own at all.
function offMenuCategoryMismatchWord(
  spanWords: string[],
  candidateIds: ReadonlySet<string>,
  matchedLength: number,
  itemNameEntries: LexiconTerm[],
  nameWordIndex: Map<string, Set<string>>,
  categoryNounIndex: Map<string, Set<string>>,
): string | null {
  if (candidateIds.size < 2) return null;
  const matchedWordsAcrossCandidates = new Set<string>();
  for (const id of candidateIds) {
    const words = findMatchedTermWords(id, matchedLength, spanWords, itemNameEntries);
    if (words) for (const w of words) matchedWordsAcrossCandidates.add(w);
  }
  for (let i = spanWords.length - 1; i >= 0; i--) {
    const word = spanWords[i];
    if (matchedWordsAcrossCandidates.has(word)) continue;
    if (categoryNounIndex.has(word)) continue;
    const owners = nameWordIndex.get(word);
    if (!owners || owners.size === 0) continue;
    // The word already belongs to (at least) one of the tied candidates
    // themselves — not an outside qualifier, even if it didn't happen to be
    // part of the specific term that WON the length tie for that candidate
    // (e.g. a shorter, alternate term for the same item also carries it).
    if ([...owners].some(id => candidateIds.has(id))) continue;
    return word;
  }
  return null;
}

// word -> every OTHER real item's own target_id whose active item-name
// lexicon term (filler/size stripped, never singularized — this must match
// occursAsWholeWordRun's own literal, unstemmed comparison, the same
// discipline buildCategoryNounIndex already follows for `entry.category`)
// contains that word. Deliberately scoped to `itemNameEntries` (STATED/
// item-own terms, category-noun-only single-word terms already excluded by
// the caller) so a wide, shared, DERIVED trailing-word-run term can never
// inflate this into a false "outside" owner.
function buildNameWordIndex(itemNameEntries: LexiconTerm[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of itemNameEntries) {
    const words = toWords(normalize(entry.term))
      .filter(w => !FILLER_WORDS.has(w) && !SIZE_WORD_TOKENS.has(w) && !SIZE_DIGIT_TOKENS.has(w) && !SIZE_UNIT_WORDS.has(w));
    for (const w of words) {
      const set = index.get(w) ?? new Set<string>();
      set.add(entry.target_id);
      index.set(w, set);
    }
  }
  return index;
}

// 2026-09-20 PO dispatch (off-menu category-mismatch): resolveItem's own
// veto above (offMenuCategoryMismatchWord) only returns unresolved — same
// "no info about why" gap DEFECT 3's findVetoedOffMenuTerm already
// documents for the bleu-cheese veto, same fix shape: a caller-facing
// function that redoes resolveItem's own base-tie computation far enough to
// learn which word tripped the veto and what real items DO carry it, so
// turn-engine.ts can decline by NAME and offer the real alternative
// (French Fries, Crab Fries, ...) instead of a bare "didn't catch that."
export function findOffMenuCategoryMismatch(
  span: string,
  lexicon: LexiconTerm[],
): { headNoun: string; alternativeMenuItemIds: string[] } | null {
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return null;
  const categoryNounIndex = buildCategoryNounIndex(lexicon);
  const itemNameEntries = lexicon.filter(entry => {
    const termWords = toWords(normalize(entry.term));
    return termWords.length > 0 && !(termWords.length === 1 && categoryNounIndex.has(termWords[0]));
  });
  const base = longestMatch(spanWords, itemNameEntries);
  if (base.targetIds.size < 2) return null;
  const nameWordIndex = buildNameWordIndex(itemNameEntries);
  const word = offMenuCategoryMismatchWord(spanWords, base.targetIds, base.length, itemNameEntries, nameWordIndex, categoryNounIndex);
  if (!word) return null;
  const owners = nameWordIndex.get(word) ?? new Set<string>();
  return { headNoun: word, alternativeMenuItemIds: [...owners].sort() };
}

// Shared by resolveItem's own named-category narrowing (below) and
// findCategoryFilterDiscardedRealItem (below): a candidate survives a named
// category word either by an exact match on its own real category, or by
// the existing "textually contains/is contained by" synonym rule (Data fix
// (b) extension, 2026-09-19 — "a pepperoni stromboli" must keep the
// Stromboli Rolls candidate even though its real category is "Stromboli
// Rolls", not the bare "Stromboli" the span's word maps to). Extracted
// verbatim from resolveItem's own inline filter so both call sites can never
// silently drift apart on what "survives" means.
function categorySurvivesNamedCategoryWord(category: string | null | undefined, namedCategories: ReadonlySet<string>): boolean {
  if (category == null) return false;
  if (namedCategories.has(category)) return true;
  const categoryLower = category.toLowerCase();
  for (const nc of namedCategories) {
    const ncLower = nc.toLowerCase();
    if (categoryLower.includes(ncLower) || ncLower.includes(categoryLower)) return true;
  }
  return false;
}

// 2026-09-20 PO dispatch (off-menu category-mismatch, REVERSE direction,
// real PO probe "can I change that to a small BBQ Chicken pizza instead?").
// offMenuCategoryMismatchWord/findOffMenuCategoryMismatch above catch a head
// noun that names NO real item among the tied candidates at all ("fries" —
// none of the tied Buffalo Chicken items are fries) and deliberately EXEMPT
// any word that IS a recognized DB category noun ("pizza"), deferring to
// resolveItem's own namedCategories filter just below for those. This is the
// case that filter's own "never wipe a real tie to zero" discipline doesn't
// cover: a genuine, real item DOES exist for the customer's own more
// specific, distinguishing word — just filed under a DIFFERENT real
// category than the one the customer also (correctly, for the OTHER
// candidates) named.
//
// Real Vito's shape: "small BBQ Chicken pizza" — longestMatch's own tie-
// break finds TWO DIFFERENT winning terms at the identical length 2: "bbq
// chicken" (BBQ Chicken Flatbread's own, unique, correctly-spelled name)
// and "chicken pizza" (a generic, derived 2-word term shared by BOTH Buffalo
// Chicken Pizza and Thai Sweet Chili Chicken Pizza, matching only because
// "chicken" and the trailing category word "pizza" happen to sit next to
// each other in the span). resolveItem's namedCategories filter correctly
// narrows the 3-way tie down to the two Pizza candidates ("pizza" really is
// a live category dimension here) — but the candidate it discards, BBQ
// Chicken Flatbread, is discarded for the RIGHT reason (it's not a pizza)
// while its OWN distinguishing word, "bbq", is left completely unaccounted
// for by either surviving candidate's own matched term ("chicken pizza" —
// neither word is "bbq"). A customer who typed "bbq" was never asking about
// Buffalo Chicken or Thai Sweet Chili at all; silently listing those two as
// "which one?" is exactly as wrong as silently adding the wrong one would
// be. Never fires on a genuine same-category size tie ("cheese pizza",
// "buffalo chicken pizza" with no size) — those keep EVERY tied candidate
// through the category filter (nothing discarded), so there is nothing here
// to check.
function categoryFilterDiscardedRealItemId(
  spanWords: string[],
  originalIds: ReadonlySet<string>,
  survivingIds: readonly string[],
  matchedLength: number,
  itemNameEntries: LexiconTerm[],
): string | null {
  const survivingSet = new Set(survivingIds);
  const survivorWords = new Set<string>();
  for (const id of survivingIds) {
    const words = findMatchedTermWords(id, matchedLength, spanWords, itemNameEntries);
    if (words) for (const w of words) survivorWords.add(w);
  }
  for (const id of originalIds) {
    if (survivingSet.has(id)) continue;
    const words = findMatchedTermWords(id, matchedLength, spanWords, itemNameEntries);
    if (words && words.some(w => !survivorWords.has(w))) return id;
  }
  return null;
}

// Caller-facing pair for categoryFilterDiscardedRealItemId, same shape as
// findOffMenuCategoryMismatch just above: redoes resolveItem's own base-tie
// and named-category computation far enough to learn WHICH real item was
// wrongly discarded and WHICH category word discarded it, so turn-engine.ts
// can decline by naming the real item and its real category (e.g. "we don't
// have BBQ Chicken as a pizza — it's on our Flatbreads menu") instead of
// silently opening a which-one question between two unrelated items.
export function findCategoryFilterDiscardedRealItem(
  span: string,
  lexicon: LexiconTerm[],
): { headNoun: string; realItemMenuId: string; realItemCategory: string } | null {
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return null;
  const categoryNounIndex = buildCategoryNounIndex(lexicon);
  const itemNameEntries = lexicon.filter(entry => {
    const termWords = toWords(normalize(entry.term));
    return termWords.length > 0 && !(termWords.length === 1 && categoryNounIndex.has(termWords[0]));
  });
  const base = longestMatch(spanWords, itemNameEntries);
  if (base.targetIds.size < 2) return null;

  const namedCategories = new Set<string>();
  for (const [word, categories] of categoryNounIndex) {
    if (spanWords.includes(word)) for (const c of categories) namedCategories.add(c);
  }
  if (namedCategories.size === 0) return null;

  const targetInfo = new Map<string, { category?: string | null }>();
  for (const entry of lexicon) {
    if (!targetInfo.has(entry.target_id)) targetInfo.set(entry.target_id, { category: entry.category });
  }
  if (![...base.targetIds].some(id => targetInfo.get(id)?.category != null)) return null;

  const survivingIds = [...base.targetIds].filter(id => categorySurvivesNamedCategoryWord(targetInfo.get(id)?.category, namedCategories));
  if (survivingIds.length === 0 || survivingIds.length === base.targetIds.size) return null;

  const discardedRealItemId = categoryFilterDiscardedRealItemId(spanWords, base.targetIds, survivingIds, base.length, itemNameEntries);
  if (!discardedRealItemId) return null;

  const survivorCategories = new Set(survivingIds.map(id => targetInfo.get(id)?.category).filter((c): c is string => c != null));
  const headNoun = [...categoryNounIndex.entries()].find(
    ([word, cats]) => spanWords.includes(word) && [...cats].some(c => survivorCategories.has(c)),
  )?.[0] ?? [...namedCategories][0];

  return {
    headNoun,
    realItemMenuId: discardedRealItemId,
    realItemCategory: targetInfo.get(discardedRealItemId)?.category ?? "",
  };
}

// 2026-09-19/20 PO dispatch (bleu-cheese off-menu decline, real conv
// 009de656 follow-up, live: "can I add a side of Bleu Cheese" wrongly tied
// 3 Cheese pizzas): the veto above correctly stops resolveItem from ever
// guessing a wrong item once a real, more-specific, curated-but-excluded
// term covers more of the span — but resolveItem's own `{ kind:
// "unresolved" }` carries no information about WHY, so a caller has no way
// to tell "the customer named something real that just isn't orderable
// this way" apart from "nothing on the menu resembles this at all." That
// distinction matters: real Vito's data has "Bleu Cheese" as a genuine,
// orderable choice elsewhere (a salad Dressing option) even though it's
// correctly excluded as a standalone item — the customer deserves to be
// told that, not just "sorry, didn't catch that."
//
// Deliberately NOT folded into resolveItem's own return value: an existing
// test (this file's own DEFECT 3 coverage) asserts the veto path returns
// exactly `{ kind: "unresolved" }` via assertEquals, and widening that
// object with extra fields would break that assertion for no behavioral
// gain — resolveItem's contract (resolved/ambiguous/unresolved, nothing
// more) is unchanged. This mirrors resolveItem's own base-match computation
// (itemNameEntries filter, primary-then-fallback longestMatch) just far
// enough to learn which excluded term the veto actually fired on, then
// hands back that term (never anything from a call that wouldn't have
// vetoed at all — same "only ever a veto, never a guess" discipline as
// findLongerInactiveTerm itself).
export function findVetoedOffMenuTerm(
  span: string,
  lexicon: LexiconTerm[],
  inactiveLexicon: LexiconTerm[],
): LexiconTerm | null {
  if (inactiveLexicon.length === 0) return null;
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return null;
  const categoryNounIndex = buildCategoryNounIndex(lexicon);
  const itemNameEntries = lexicon.filter(entry => {
    const termWords = toWords(normalize(entry.term));
    return termWords.length > 0 && !(termWords.length === 1 && categoryNounIndex.has(termWords[0]));
  });
  const primary = longestMatch(spanWords, itemNameEntries);
  const base = primary.targetIds.size > 0 ? primary : longestMatch(spanWords, lexicon);
  return findLongerInactiveTerm(spanWords, inactiveLexicon, base.length, base.targetIds);
}

// 2026-09-19 PO dispatch (rule 1, real conv 087abb8d, live $107.43-vs-~$85
// money bug): the fuzzy fallback below exists to absorb genuine typos
// ("hawiaan" -> "hawaiian"), but fuzzyWordMatch's own prefix rule (a 4+ char
// word that is a literal prefix of a longer one) treats ANY singular word as
// a "typo" of a lexicon term that is just its plural — "stick" (a real,
// complete, unrelated word — the customer was saying "let's stick to that,"
// declining the open list) matched Vito's own active term "sticks"
// (Mozzarella Sticks) this way and silently added an $8.99 item nobody
// ordered. There is no lexical way to tell "stick" apart from a genuine
// truncation like "pepp" using this same rule, so turn-engine.ts's answer-
// turn new-item detector (messageNamesItemOutsideCandidates) passes `false`
// here to require an exact, whole-word/whole-term match only — never a
// fuzzy guess — while every other caller (fresh adds, replacements) keeps
// today's typo tolerance unchanged.
// GAP (b) dispatch (2026-09-19 PO dispatch, live conv 040f91dd #47): "regular"
// standing alone can tie two completely UNRELATED one-word lexicon terms at
// the same length (this file's own longestMatch tie rule) — e.g. a shop
// whose ONLY bare "regular" term is a Regular-labeled Cheese Pizza row ties
// against "coke" in "regular coke", unioning Coke sizes with Cheese Pizza
// sizes into one nonsensical ambiguous result. Confirmed via direct
// resolveItem probing, but NOT stripped here: "regular" is also, on other
// real shops, part of a genuine item's own name/term ("Regular Slice" —
// see modifier-floor-20260917.test.ts's "00-BF END TO END" coverage, a real
// live-bug regression test this stripping broke when tried). This function
// is shared by every fresh-order add across the whole engine, with no
// per-family fallback to fall back on if a strip goes wrong — unlike the
// disambiguation-narrowing layer (pending-disambiguation.ts's own
// NON_SEARCH_FILLER_WORD_RE / resolveDefaultCandidate), which scopes the
// identical filler-word protection to an already-open candidate set and has
// a safe default to land on. The live, confirmed fixture for this gap (conv
// 040f91dd) is entirely mid-narrowing; fixed there. Flagged, not silently
// applied here: a fresh "can I get a regular Coke" (first message, no
// narrowing open yet) that happens to tie against an unrelated "Regular X"
// item elsewhere in the SAME shop's menu remains an open risk this dispatch
// did not close — worth a follow-up that's scoped to when a filler word
// contributes to a tie with NO OTHER corroborating span word, rather than a
// blanket strip.
//
// S3 fix (2026-09-19, live money bug, real conv 22347973): `fuzzyMinTermWords`
// (see fuzzyLongestMatch's own header) lets a caller feeding raw/derived
// customer text — never a model-endorsed span — require every fuzzy
// candidate to be a genuine multi-word term with a real corroborating exact
// word, not a single fuzzy guess standing entirely on its own. Defaulted to
// 1 (today's behavior, unchanged) for every pre-existing caller; the two
// decide() recovery passes (turn-engine.ts) pass 2.
export function resolveItem(
  span: string,
  lexicon: LexiconTerm[],
  inactiveLexicon: LexiconTerm[] = [],
  allowFuzzyFallback = true,
  fuzzyMinTermWords = 1,
): ResolveItemResult {
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return { kind: "unresolved" };

  const categoryNounIndex = buildCategoryNounIndex(lexicon);
  const namedCategories = new Set<string>();
  for (const [word, categories] of categoryNounIndex) {
    if (spanWords.includes(word)) for (const c of categories) namedCategories.add(c);
  }

  // A bare CATEGORY-NOUN entry is a single word whose text IS one of the
  // shop's own category nouns ("salad" for category "Salads"). Excluded
  // from the item-name pass below so a wide category word can never tie
  // (and union) with a specific item-name span for the same phrase — see
  // this file's header, 2026-09-18 PO dispatch. A phrase naming nothing but
  // a bare category word falls back to the unfiltered scan (next block),
  // which is exactly the pre-existing behavior — this dispatch does not
  // change what a lone category word does on its own.
  const itemNameEntries = lexicon.filter(entry => {
    const termWords = toWords(normalize(entry.term));
    return termWords.length > 0 && !(termWords.length === 1 && categoryNounIndex.has(termWords[0]));
  });

  const primary = longestMatch(spanWords, itemNameEntries);
  const usingItemNameSpan = primary.targetIds.size > 0;
  const base = usingItemNameSpan ? primary : longestMatch(spanWords, lexicon);

  // See findLongerInactiveTerm's own header (DEFECT 3, 2026-09-19): a real,
  // more specific term was excluded from `lexicon` entirely (inactive/non-
  // orderable target) and matches MORE of the span than anything we're
  // about to guess with — never fall back to a shorter, unrelated match in
  // that case. Checked once, before any downstream branch (resolved,
  // ambiguous, or the fuzzy fallback below) gets a chance to guess with the
  // shorter match instead.
  if (findLongerInactiveTerm(spanWords, inactiveLexicon, base.length, base.targetIds)) {
    return { kind: "unresolved" };
  }

  // 2026-09-20 PO dispatch (off-menu category-mismatch, real conv 75b6e542,
  // live $22.99 money bug): see offMenuCategoryMismatchWord's own header —
  // a genuine TIE (base.targetIds.size > 1) whose span carries a real,
  // separate dish-family word ("fries") that NONE of the tied candidates
  // themselves carry must never fall through to the unfiltered ambiguous
  // list below; the customer asked for something none of these items are.
  // Scoped to `usingItemNameSpan` — a bare category-word-only span (no
  // qualifier to conflict with) was never this dispatch's territory. Checked
  // once, exactly like the inactive-term veto just above, before any
  // downstream narrowing gets a chance to guess or list with the wrong tie.
  if (usingItemNameSpan && offMenuCategoryMismatchWord(spanWords, base.targetIds, base.length, itemNameEntries, buildNameWordIndex(itemNameEntries), categoryNounIndex)) {
    return { kind: "unresolved" };
  }

  // Round 2, item 1c: nothing matched EXACTLY at all — try the same scan
  // fuzzy (occursAsWholeWordRunFuzzy) before giving up. Resolves ONLY when
  // it narrows to a single target family (targetIds.size === 1), same
  // "never guess" discipline as everywhere else in this function — two or
  // more fuzzy-matching families, or none, stays unresolved rather than
  // guessing or listing a fuzzy-derived candidate set.
  if (base.targetIds.size === 0) {
    if (!allowFuzzyFallback) return { kind: "unresolved" };
    const fuzzyPrimary = fuzzyLongestMatch(spanWords, itemNameEntries, fuzzyMinTermWords);
    const fuzzyBase = fuzzyPrimary.targetIds.size > 0 ? fuzzyPrimary : fuzzyLongestMatch(spanWords, lexicon, fuzzyMinTermWords);
    if (fuzzyBase.targetIds.size === 1) {
      return { kind: "resolved", menu_item_id: [...fuzzyBase.targetIds][0] };
    }
    return { kind: "unresolved" };
  }

  // No item-name span in the phrase (a bare category word, matched only via
  // the fallback scan above) — no qualifier to narrow with, and narrowing a
  // bare category word's own candidate set was never part of this dispatch.
  if (!usingItemNameSpan) {
    // 2026-09-18 PO dispatch, edge 2: a single fallback hit can still be the
    // WRONG single hit when the span also states a size — check the
    // resolved item's own size_label against that size before trusting it.
    const sizeToken = detectSizeToken(spanWords);
    if (sizeToken && base.targetIds.size === 1) {
      const [baseId] = base.targetIds;
      const baseSizeLabel = lexicon.find(e => e.target_id === baseId)?.size_label;
      if (!sizeLabelMatchesToken(baseSizeLabel, sizeToken)) {
        const widened = widenIntoSizedFamily(baseId, base.length, spanWords, lexicon, namedCategories);
        if (widened) return widened;
      }
    }

    if (base.targetIds.size === 1) return { kind: "resolved", menu_item_id: [...base.targetIds][0] };
    return { kind: "ambiguous", candidates: [...base.targetIds].sort() };
  }

  // From here on: an item-name span matched. Narrow (never list) using a
  // named category and/or size token before deciding resolved/ambiguous/
  // unresolved — spec steps 1-2, applied even to an already-unique base
  // result so a stated category/size can still CONFIRM it, not just narrow
  // a tie (step 3's "confirm/narrow").
  const targetInfo = new Map<string, { category?: string | null; size_label?: string | null }>();
  for (const entry of lexicon) {
    if (!targetInfo.has(entry.target_id)) {
      targetInfo.set(entry.target_id, { category: entry.category, size_label: entry.size_label });
    }
  }
  let candidates = [...base.targetIds];

  // Data fix (b), 2026-09-19, real live bug: "pepperoni pizza" resolved to
  // the Stromboli Roll "Pepperoni" — its own stated term is the single word
  // "pepperoni" (no 2-word "pepperoni pizza" term competes for it), so
  // "pizza" is a span word left OVER, outside the matched term itself, that
  // happens to be a category noun conflicting with the resolved item's own
  // real category ("Stromboli"). Recorded here (not acted on yet) — edge 1's
  // "never let the category filter wipe a real TIE to zero" rule just below
  // is still exactly right for a genuine tie (`base.targetIds.size > 1`),
  // AND for a unique match whose ENTIRE span is consumed by its own matched
  // term ("side salad" — "salad" is part of the item's own two-word name,
  // not an extra qualifier; "the slice cheesesteak" — same shape). Only a
  // category-noun word that is NOT part of the matched term counts as a
  // real conflict — checked once widenIntoSizedFamily below has had its
  // existing chance to find a same-name sibling in the named category
  // instead (real live case: "small meat lovers pizzas" must still find the
  // Meat Lover pizza, not just disqualify the Stromboli hit and give up).
  let uniqueBaseCategoryConflict = false;

  // Only apply the filter if category is actually a live dimension for the
  // CURRENT candidates — a named category word with nothing here carrying
  // real category data would otherwise wipe every candidate for no reason.
  //
  // 2026-09-18 PO dispatch, edge 1: if the named category leaves ZERO
  // candidates, the category word wasn't actually a live dimension for
  // THIS tie (the customer named a real item and a real category, but the
  // category just doesn't apply to any of the item's own candidates) — keep
  // the unfiltered tie rather than discarding real candidates down to
  // unresolved. Never guess which one they meant; ASK still gets a real
  // list to offer.
  if (namedCategories.size > 0 && candidates.some(id => targetInfo.get(id)?.category != null)) {
    // Data fix (b) extension, 2026-09-19 (wart b, real live bug): the exact
    // membership check alone only ever recognizes a named category that IS
    // one of the tied candidates' own category strings verbatim. Real
    // Vito's shape: "a pepperoni stromboli" ties the real Pepperoni Pizza
    // family against the Stromboli Rolls "Pepperoni" — categoryNoun's own
    // "last word only" rule maps the span's word "stromboli" to the
    // UNRELATED "Stromboli" platter category, never to "Stromboli Rolls",
    // so the roll — the one candidate actually named — was wrongly
    // filtered OUT instead of kept. Same "a word already inside a
    // candidate's own category name is a synonym for it, not an outside
    // qualifier" rule the unique-base branch below already applies,
    // generalized to a genuine tie: a named category that textually
    // contains (or is contained by) this candidate's REAL category is the
    // same dish family by another name, so the candidate survives. See
    // categorySurvivesNamedCategoryWord's own header — shared with
    // findCategoryFilterDiscardedRealItem so both can never drift apart.
    const filteredByCategory = candidates.filter(id => categorySurvivesNamedCategoryWord(targetInfo.get(id)?.category, namedCategories));
    if (filteredByCategory.length > 0) {
      // 2026-09-20 PO dispatch (off-menu category-mismatch, REVERSE
      // direction, real PO probe "small BBQ Chicken pizza"): see
      // categoryFilterDiscardedRealItemId's own header — this filter just
      // correctly narrowed the tie by a real category word, but may have
      // discarded a candidate whose OWN distinguishing word (e.g. "bbq") is
      // left completely unaccounted for by every surviving candidate's own
      // matched term. Checked only when something was actually discarded
      // (filteredByCategory.length < candidates.length) — a same-category
      // size tie ("cheese pizza") keeps every candidate here and never
      // reaches this check.
      if (filteredByCategory.length < candidates.length &&
        categoryFilterDiscardedRealItemId(spanWords, base.targetIds, filteredByCategory, base.length, itemNameEntries)) {
        return { kind: "unresolved" };
      }
      candidates = filteredByCategory;
    } else if (base.targetIds.size === 1 && targetInfo.get(candidates[0])?.category != null) {
      const matchedWords = new Set(findMatchedTermWords(candidates[0], base.length, spanWords, lexicon) ?? []);
      const ownCategory = targetInfo.get(candidates[0])?.category;
      // Real Vito's shape that must NOT trip this: "pepperoni stromboli"
      // resolving to the Stromboli Rolls "Pepperoni" — the shop has TWO
      // real categories both about the same dish family ("Stromboli" and
      // "Stromboli Rolls"), so categoryNoun's own "last word only" rule
      // maps the word "stromboli" to the OTHER one. A word that already
      // appears inside the candidate's OWN category name (either way) is a
      // synonym for what it already is, never an outside qualifier — only a
      // word with NO textual relationship to the item's own category
      // counts as a real conflict ("pizza" shares nothing with "Stromboli
      // Rolls" at all).
      const ownCategoryLower = (ownCategory ?? "").toLowerCase();
      const extraConflictingWord = [...categoryNounIndex.entries()].some(([word, cats]) =>
        spanWords.includes(word) && !matchedWords.has(word) && !ownCategoryLower.includes(word) &&
        [...cats].some(c => c !== ownCategory && namedCategories.has(c)),
      );
      if (extraConflictingWord) uniqueBaseCategoryConflict = true;
    }
  }

  const sizeToken = detectSizeToken(spanWords);
  // Same principle as the category guard, including the edge-1 empty-result
  // fallback: only filter on size when at least one current candidate
  // actually carries a size_label, and never let the size filter wipe a
  // real tie down to zero.
  if (sizeToken && candidates.some(id => targetInfo.get(id)?.size_label != null)) {
    const filteredBySize = candidates.filter(id => sizeLabelMatchesToken(targetInfo.get(id)?.size_label, sizeToken));
    if (filteredBySize.length > 0) candidates = filteredBySize;
  }

  if (candidates.length === 1) {
    // 2026-09-18 PO dispatch (plural family widening): only when `base`
    // itself was ALREADY unique (size 1) BEFORE either filter above ran —
    // never when a real tie got narrowed down to one by the category/size
    // filters actually doing their job ("just a 14-inch calzone" ties all
    // 3 sizes on the bare "calzone" term, then the size filter correctly
    // narrows to the 14" one — that candidate's own real size_label WAS
    // tested and matched, so there's nothing left to widen into). A `base`
    // that started at exactly 1 never had that chance: no tie existed for
    // the size/category filters to narrow in the first place, which is
    // exactly the "a real sibling family exists but this candidate's own
    // words never matched it" shape (a plural/singular mismatch, or any
    // other surface-form gap the core-word reduction catches).
    if (base.targetIds.size === 1) {
      const widened = widenIntoSizedFamily(candidates[0], base.length, spanWords, lexicon, namedCategories);
      if (widened) return widened;
    }
    // Data fix (b): widening above found no sibling in the named category
    // either — this singleton's own real category conflicts with what the
    // customer said, and there is nothing else to resolve to. Genuinely
    // unresolved, never silently returned.
    if (uniqueBaseCategoryConflict) return { kind: "unresolved" };
    return { kind: "resolved", menu_item_id: candidates[0] };
  }
  // Sorted for deterministic, byte-identical output on identical input —
  // never as a tiebreak (every id here is a genuine tie; none is dropped).
  return { kind: "ambiguous", candidates: candidates.sort() };
}
