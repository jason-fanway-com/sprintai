/**
 * slang-dictionary.ts — static list mapping a formal/menu-style term to
 * common US regional/generic slang synonyms customers use instead.
 *
 * No cuisine/region field exists anywhere in the schema (menu_items only has
 * a free-text `category` string) — this dictionary is deliberately schema-free.
 * It is matched against whatever menu data a shop actually has (see slang.ts),
 * so a shop with no matching item produces zero cases for that entry. Add new
 * pairs here only — no generator logic changes needed.
 *
 * `formalKeywords` are matched case-insensitively at token boundaries against
 * a menu item's `name` or `category` (see matchesKeyword in slang.ts) — never
 * as a raw substring, so e.g. "sub" won't false-match inside "substitute".
 *
 * Pairs seeded 2026-09-18, with reasoning for each:
 *   - sub / hoagie / grinder / hero — the classic four-way US regional split
 *     for a submarine sandwich (Philly/Mid-Atlantic, New England, NYC).
 *   - soda / pop — the two dominant US terms for a carbonated soft drink.
 *   - pizza / pie — "pie" for a WHOLE pizza is extremely common, especially
 *     Northeast pizzerias (exactly SprintAI's shop profile).
 *   - sprinkles / jimmies — New England term for sprinkles.
 *   - mozzarella sticks / mozz sticks — common shorthand, not really
 *     "regional" but universal enough menu-item-name shorthand to be worth
 *     testing the same way.
 *   - cream cheese / schmear — NY/NJ deli & bagel-shop term (SprintAI runs a
 *     bagel-shop tenant, Not Just Bagels, making this a live real-world case).
 *   - milkshake / frappe — included on judgment: in Rhode Island and eastern
 *     Massachusetts, "frappe" is the word for what most of the US calls a
 *     milkshake (a "milkshake" there can mean flavored milk with no ice
 *     cream at all). SprintAI's early shops are New England-heavy, so this
 *     is a real go-live risk, not a curiosity.
 *   - French fries / fries — deliberately SKIPPED per spec: same word, not a
 *     slang pair.
 */

export interface SlangEntry {
  /** Stable slug used to build test-case ids. */
  id: string;
  /** Formal/menu-style keyword(s) that identify a matching item by name or category. */
  formalKeywords: string[];
  /** Common regional/generic slang synonyms customers use instead of the formal term. */
  slangTerms: string[];
  /** Why this pair is in the dictionary (regional context / rationale). */
  note: string;
}

export const SLANG_DICTIONARY: SlangEntry[] = [
  {
    id: "sub-hoagie",
    formalKeywords: ["sub", "submarine"],
    slangTerms: ["hoagie"],
    note: "Philly/Mid-Atlantic term for a sub sandwich",
  },
  {
    id: "sub-grinder",
    formalKeywords: ["sub", "submarine"],
    slangTerms: ["grinder"],
    note: "New England term for a sub sandwich",
  },
  {
    id: "sub-hero",
    formalKeywords: ["sub", "submarine"],
    slangTerms: ["hero"],
    note: "NYC term for a sub sandwich",
  },
  {
    id: "soda-pop",
    formalKeywords: ["soda"],
    slangTerms: ["pop"],
    note: "Midwest/Northwest term for soda",
  },
  {
    id: "pizza-pie",
    formalKeywords: ["pizza"],
    slangTerms: ["pie"],
    note: "Common (esp. Northeast) term for a whole pizza",
  },
  {
    id: "sprinkles-jimmies",
    formalKeywords: ["sprinkles"],
    slangTerms: ["jimmies"],
    note: "New England term for sprinkles",
  },
  {
    id: "mozzarella-sticks-mozz-sticks",
    formalKeywords: ["mozzarella sticks"],
    slangTerms: ["mozz sticks"],
    note: "Common shorthand for mozzarella sticks",
  },
  {
    id: "cream-cheese-schmear",
    formalKeywords: ["cream cheese"],
    slangTerms: ["schmear"],
    note: "NY/NJ deli & bagel-shop term for cream cheese",
  },
  {
    id: "milkshake-frappe",
    formalKeywords: ["milkshake"],
    slangTerms: ["frappe"],
    note: "RI/eastern-MA term for a blended ice-cream drink",
  },
];
