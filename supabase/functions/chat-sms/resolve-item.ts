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

export interface LexiconTerm {
  term: string;
  target_id: string;
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

export function resolveItem(span: string, lexicon: LexiconTerm[]): ResolveItemResult {
  const spanWords = toWords(normalize(span));
  if (spanWords.length === 0) return { kind: "unresolved" };

  let longestMatchedLength = 0;
  const targetIdsAtLongest = new Set<string>();

  for (const entry of lexicon) {
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

  if (targetIdsAtLongest.size === 0) return { kind: "unresolved" };
  if (targetIdsAtLongest.size === 1) {
    return { kind: "resolved", menu_item_id: [...targetIdsAtLongest][0] };
  }
  // Sorted for deterministic, byte-identical output on identical input —
  // never as a tiebreak (every id here is a genuine tie; none is dropped).
  return { kind: "ambiguous", candidates: [...targetIdsAtLongest].sort() };
}
