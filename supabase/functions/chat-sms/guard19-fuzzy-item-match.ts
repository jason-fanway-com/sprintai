// GUARD 19 false-positive fix (2026-09-08 LIVE INCIDENT, real customers affected).
//
// GUARD 19 (guard19-quantity-only-no-item-named.ts) reverts a whole cart when a
// quantity-only message named zero menu items — its own decision core takes a
// caller-supplied `namedItemCount` and trusts it completely. index.ts computed
// that count with extractCustomerReferencedItems, which only matches a
// customer's words against full/last-word menu ITEM names. That is exactly
// zero matches for a real order like "1 pepp, 1 plain, 1 hawaiin, 1 meat
// lovers" — four real, distinct Zio's pizzas — because:
//   (a) "pepp" is a composed topping (f76d84f): Zio's has no standalone
//       "Pepperoni Pizza" item, only a "Pepperoni" choice inside the base
//       cheese pizza's "Add Toppings" option group. extractCustomerReferenced
//       Items only ever looks at ITEM names, never at option choice names, so
//       it cannot see this at all.
//   (b) "hawaiin" is a plain typo for the real item "Hawaiian Pizza".
//   (c) "meat lovers" drops the apostrophe and pluralizes differently than
//       the real item "Meat Lover's Pizza" ("lover's" -> "lover s" once
//       apostrophes normalize to spaces; "lovers" never matches that).
// GUARD 19 read all four as ungrounded and wiped the entire cart.
//
// This module is GUARD 19's OWN, wider signal check — not a replacement for
// extractCustomerReferencedItems (GUARD 9/13/20 keep using that unchanged; a
// fuzzy match is the right bar for "did the customer name ANYTHING real" but
// would be too loose for those guards' per-item revert decisions).
//
// NARROWED (2026-09-08, same day as f76d84f): this vocab used to also
// include every option_groups choice name and modifiers_json name across the
// whole menu, specifically so a bare composed topping ("pepp") would count
// as a real signal. That case is now resolved by pizza-topping-compose.ts
// BEFORE this guard ever runs — index.ts feeds a successful deterministic
// compose in directly (deterministicComposedThisTurn), which is a more
// reliable "something real was named" signal than fuzzy-matching topping
// vocabulary in free text ever was (it can confirm the compose actually
// happened; this vocab can only confirm a word LOOKS like a topping). This
// module's remaining job is narrower: fuzzy matching (prefix / small edit
// distance) against real ITEM names only, to absorb typos and loose
// pluralization/apostrophe dropping on a standalone item ("hawaiin" ->
// "Hawaiian Pizza") without needing an exact string match.
//
// GENERIC_LAST_WORDS (sizes/formats/course words: "large", "pizza", "plain",
// ...) is excluded from BOTH the vocab and the message-word scan, and this
// exclusion is load-bearing: without it, the genuine zero-signal incident
// this guard exists for ("I want four large pizzas", commit b865d3a's shape)
// would spuriously match "large"/"pizzas" against the menu's own size-
// variant item names and silently defeat the guard's real protection. A
// message naming ONLY generic words is exactly the trigger GUARD 19 must
// still catch; a message with even one distinctive word (a topping, a dish
// name, or a typo of either) is real customer intent and must never be
// reverted.

export interface Guard19MenuItemLike {
  name: string;
  option_groups?: Array<{ choices?: Array<{ name: string }> }> | null;
  modifiers_json?: Array<{ name: string }> | null;
}

/**
 * Words that describe a size, a format, or a whole course rather than a
 * specific dish — never a real signal on their own. Kept in sync with (and
 * intentionally the same set as) index.ts's own GENERIC_LAST_WORDS.
 */
export const GUARD19_GENERIC_WORDS = new Set([
  "large", "medium", "small", "regular", "mini", "jumbo", "giant", "personal",
  "half", "whole", "single", "double", "triple", "side", "sides", "plain",
  "pizza", "pizzas", "pie", "pies", "roll", "rolls", "wrap", "wraps", "sub",
  "subs", "sandwich", "sandwiches", "salad", "salads", "soup", "soups",
  "platter", "platters", "combo", "combos", "special", "specials", "dinner",
  "lunch", "breakfast", "meal", "meals", "plate", "plates", "basket",
  "pieces", "piece", "order", "orders", "cup", "bowl", "slice", "slices",
]);

function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 0);
}

export function buildGuard19FuzzyVocab(menu: Guard19MenuItemLike[]): Set<string> {
  const vocab = new Set<string>();
  const addWords = (text: string) => {
    for (const w of normalizeWords(text)) {
      if (w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w)) vocab.add(w);
    }
  };
  for (const item of menu) {
    addWords(item.name);
  }
  return vocab;
}

export function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Two words are "the same real word" if identical, if the shorter is a >=4-char
 * prefix of the longer ("pepp"/"pepperoni", "lover"/"lovers"), or — only when
 * BOTH words are 5+ chars — a small edit distance apart scaled by length
 * (distance<=1 for 5-7 chars covers single-letter typos like "hawaiin"/
 * "hawaiian"; distance<=2 for 8+ chars). Below 5 chars, edit distance is too
 * easy to false-positive on unrelated words ("four"/"flour") — short words
 * only match via exact or prefix above.
 */
export function fuzzyWordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
  // Edit-distance branch requires BOTH words to be at least 5 chars — a
  // 4-char word ("four") is one edit away from too many unrelated words
  // ("flour") to be safe here; short words only match via exact/prefix above.
  if (shorter.length < 5) return false;
  const maxDist = longer.length >= 8 ? 2 : 1;
  return levenshteinDistance(a, b) <= maxDist;
}

/**
 * GUARD 19's actual "did the customer name anything real" check — exact
 * menu-name match (namedThisTurnCount, from index.ts's own
 * extractCustomerReferencedItems, unchanged) OR a fuzzy/compose match against
 * the wider vocab above. See this module's header for the full incident.
 */
export function hasGuard19NamedSignal(
  userMessage: string,
  menu: Guard19MenuItemLike[],
  namedThisTurnCount: number,
): boolean {
  if (namedThisTurnCount > 0) return true;
  const vocab = buildGuard19FuzzyVocab(menu);
  const messageWords = normalizeWords(userMessage).filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w));
  for (const mw of messageWords) {
    for (const vw of vocab) {
      if (fuzzyWordMatch(mw, vw)) return true;
    }
  }
  return false;
}
