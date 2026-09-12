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

export function significantStems(text: string): Set<string> {
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
const DECLINE_CUES = /\b(?:forget|never\s*mind|cancel|skip|drop|don'?t|not|no)\b/i;

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
    .map((c, i) => `${i + 1}) ${candidateOptionText(c)}`)
    .join("  ");
  const nums = replyNumbers(candidates.length);
  const primary = `Sorry, I didn't catch that — ${list}. Reply ${nums}.`;
  if (priorReply !== primary) return primary;
  return `Just to be sure — ${list}. Reply with the number: ${nums}.`;
}
