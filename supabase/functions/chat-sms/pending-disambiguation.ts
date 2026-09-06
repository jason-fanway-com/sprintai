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

export interface PendingCandidate {
  menu_item_id: string;
  name:         string;
  category:     string | null;
  price_cents:  number;
}

export interface PendingDisambiguation {
  query_name: string;
  candidates: PendingCandidate[];
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

function significantStems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
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

const ORDINAL_WORDS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
// Deliberately excludes "one": it is the single most common English filler
// pronoun ("the salad ONE", "that ONE", "the 12.95 ONE") and would falsely
// read as "position 1" on answers that are actually naming a category or a
// price. "first"/"1"/"1st" already cover every real way to say position 1.
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

/**
 * "the first one" / "1st" / "number one" / a bare "1" — every reasonable way
 * a human names a position in the numbered list the re-ask offers. Returns a
 * 0-based index, or null if the message names no position.
 *
 * The digit pattern excludes any digit run adjacent to a decimal point so it
 * never mistakes the fractional half of a price ("the 12.95 one") for a
 * position — that string must resolve via price, not ordinal.
 */
export function matchOrdinalPosition(message: string, count: number): number | null {
  const norm = message.trim().toLowerCase();
  if (!norm) return null;

  const digitMatch = norm.match(/(?<![.\d])(\d+)(?:st|nd|rd|th)?(?![.\da-z])/i);
  if (digitMatch) {
    const idx = parseInt(digitMatch[1], 10) - 1;
    if (idx >= 0 && idx < count) return idx;
  }
  for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
    if (idx < count && new RegExp(`\\b${word}\\b`).test(norm)) return idx;
  }
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    if (num <= count && new RegExp(`\\b${word}\\b`).test(norm)) return num - 1;
  }
  return null;
}

/** Dollar amounts named in the message, as integer cents ("$12.95", "12.95"). */
export function extractPriceCentsFromMessage(message: string): number[] {
  const matches = message.match(/\$?\s*\d+\.\d{2}\b/g) ?? [];
  return matches.map(m => Math.round(parseFloat(m.replace(/[^0-9.]/g, "")) * 100));
}

/**
 * Deterministic resolution of an answer to a pending disambiguation, checked
 * in the order the spec requires: category word, then ordinal/position,
 * then price. Returns the resolved candidate, or null if the message
 * resolves to none or more than one — callers must re-ask, never guess.
 */
export function resolvePendingDisambiguation(
  message:    string,
  candidates: PendingCandidate[],
): PendingCandidate | null {
  const categoryHits = candidates.filter(c => categoryWordMatches(c.category, message));
  if (categoryHits.length === 1) return categoryHits[0];

  const posIdx = matchOrdinalPosition(message, candidates.length);
  if (posIdx !== null) return candidates[posIdx];

  const prices = extractPriceCentsFromMessage(message);
  if (prices.length > 0) {
    const priceHits = candidates.filter(c => prices.some(p => Math.abs(p - c.price_cents) <= 1));
    if (priceHits.length === 1) return priceHits[0];
  }

  return null;
}

function replyNumbers(count: number): string {
  const nums = Array.from({ length: count }, (_, i) => String(i + 1));
  if (nums.length <= 1) return nums[0] ?? "1";
  return `${nums.slice(0, -1).join(", ")} or ${nums[nums.length - 1]}`;
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
    .map((c, i) => `${i + 1}) ${c.name}${c.category ? ` (${c.category})` : ""} — $${(c.price_cents / 100).toFixed(2)}`)
    .join("  ");
  const nums = replyNumbers(candidates.length);
  const primary = `Sorry, I didn't catch that — ${list}. Reply ${nums}.`;
  if (priorReply !== primary) return primary;
  return `Just to be sure — ${list}. Reply with the number: ${nums}.`;
}
