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

// Fixed vocabulary, per spec — never inferred from the lexicon (no SIZE
// lexicon terms exist yet; compile-menu.ts's own header says folded
// product/size terms are P1, not built). "14-inch"/"14\""/"14" all reduce to
// the bare word "14" post-normalize (normalize() strips the hyphen and the
// quote the same way it strips any other punctuation).
const SIZE_WORD_TOKENS = new Set(["small", "medium", "large", "personal"]);
const SIZE_DIGIT_TOKENS = new Set(["10", "14", "16"]);

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
  return normalized.length > 0 ? normalized.split(" ") : [];
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

export function resolveItem(span: string, lexicon: LexiconTerm[]): ResolveItemResult {
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return { kind: "unresolved" };

  const categoryNounIndex = buildCategoryNounIndex(lexicon);

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

  if (base.targetIds.size === 0) return { kind: "unresolved" };

  // No item-name span in the phrase (a bare category word, matched only via
  // the fallback scan above) — no qualifier to narrow with, and narrowing a
  // bare category word's own candidate set was never part of this dispatch.
  if (!usingItemNameSpan) {
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

  const namedCategories = new Set<string>();
  for (const [word, categories] of categoryNounIndex) {
    if (spanWords.includes(word)) for (const c of categories) namedCategories.add(c);
  }
  // Only apply the filter if category is actually a live dimension for the
  // CURRENT candidates — a named category word with nothing here carrying
  // real category data would otherwise wipe every candidate for no reason.
  if (namedCategories.size > 0 && candidates.some(id => targetInfo.get(id)?.category != null)) {
    candidates = candidates.filter(id => {
      const category = targetInfo.get(id)?.category;
      return category != null && namedCategories.has(category);
    });
    if (candidates.length === 0) return { kind: "unresolved" };
  }

  const sizeToken = detectSizeToken(spanWords);
  // Same principle as the category guard: only filter on size when at
  // least one current candidate actually carries a size_label — otherwise a
  // stray "small"/"large" elsewhere in the phrase has nothing to narrow.
  if (sizeToken && candidates.some(id => targetInfo.get(id)?.size_label != null)) {
    candidates = candidates.filter(id => sizeLabelMatchesToken(targetInfo.get(id)?.size_label, sizeToken));
    if (candidates.length === 0) return { kind: "unresolved" };
  }

  if (candidates.length === 1) return { kind: "resolved", menu_item_id: candidates[0] };
  // Sorted for deterministic, byte-identical output on identical input —
  // never as a tiebreak (every id here is a genuine tie; none is dropped).
  return { kind: "ambiguous", candidates: candidates.sort() };
}
