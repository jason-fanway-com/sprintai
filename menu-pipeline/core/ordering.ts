/**
 * Deterministic ordering rules from MENU-INTAKE-STANDARD.md.
 *
 * Determinism is THE feature: same input -> byte-identical CSV. Every ordering
 * decision in the serializer is driven by the tables/functions in this file so
 * the rules live in exactly one place.
 */

/**
 * Fixed modifier-block order. Blocks are emitted in this order; only those that
 * apply are included. "[other required-choice sets]" in the standard maps to
 * OTHER_BLOCKS_SLOT — any block label not in this list is sorted alphabetically
 * and inserted at that slot, keeping the output deterministic.
 */
export const FIXED_BLOCK_ORDER: string[] = [
  "Pizza Toppings - Regular",
  "Pizza Toppings - Gourmet",
  "Slice Toppings - Regular",
  "Slice Toppings - Gourmet",
  "Wing Flavors",
  "Wing Extras",
  "Salad Dressings",
  "Extra Dressing",
  "Salad Protein Add-ons",
  "Quesadilla/Other Protein Add-ons",
  "Pasta Choices",
  "Buffalo Sauce Options",
  // --- OTHER_BLOCKS_SLOT: unknown blocks sorted alphabetically inserted here ---
  "Side Substitutions",
  "Side Substitutions - Kids",
];

/** Index in FIXED_BLOCK_ORDER where "[other required-choice sets]" live. */
const OTHER_BLOCKS_SLOT_AFTER = "Buffalo Sauce Options";

/**
 * Returns a deterministic sort key for a modifier block label.
 * Known labels sort by their fixed index. Unknown labels sort alphabetically
 * within the OTHER_BLOCKS_SLOT (right after Buffalo Sauce Options).
 */
export function blockOrderKey(label: string): [number, string] {
  const idx = FIXED_BLOCK_ORDER.indexOf(label);
  if (idx >= 0) return [idx, ""];
  // Unknown block: place at the OTHER slot, ordered alphabetically by label.
  const slotIdx = FIXED_BLOCK_ORDER.indexOf(OTHER_BLOCKS_SLOT_AFTER);
  // Use a fractional position so unknowns sort after the slot anchor but before
  // the next fixed block, and among themselves alphabetically.
  return [slotIdx + 0.5, label.toLowerCase()];
}

/**
 * Canonical size order. Lower number sorts first. Anything unrecognized sorts
 * after known sizes, then alphabetically (deterministic).
 *
 * Standard: small -> medium -> large; cup -> bowl; personal -> mid -> large
 * (e.g. Personal -> 14" -> 16"). We detect by keyword + embedded inches.
 */
export function sizeOrderKey(size: string): [number, number, string] {
  const s = size.toLowerCase().trim();
  if (s === "") return [-1, 0, ""]; // blank size (single-size) sorts first/stable

  // Keyword tiers.
  const keywordTiers: Array<[RegExp, number]> = [
    [/\bpersonal\b/, 10],
    [/\bsmall\b|\bsm\b/, 20],
    [/\bcup\b/, 25],
    [/\bmedium\b|\bmed\b|\bmid\b/, 30],
    [/\bbowl\b/, 35],
    [/\bregular\b|\breg\b/, 40],
    [/\blarge\b|\blg\b/, 50],
    [/\bx-?large\b|\bextra large\b|\bxl\b/, 60],
    [/\bfamily\b/, 70],
  ];
  for (const [re, tier] of keywordTiers) {
    if (re.test(s)) {
      const inches = extractInches(s);
      return [tier, inches, s];
    }
  }

  // No keyword: order by embedded inches if present (e.g. 10", 14", 16").
  const inches = extractInches(s);
  if (inches > 0) return [100, inches, s];

  // Unknown size: sort after everything else, alphabetically.
  return [999, 0, s];
}

function extractInches(s: string): number {
  // Matches 10", 14 in, 16-inch, (16")
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:"|''|in\b|inch)/);
  if (m) return parseFloat(m[1]);
  return 0;
}

/**
 * Category cross-sell defaults (the appended nudge for the upsell column).
 * Keyed by a normalized category name; matched by substring/keyword so menu
 * section names like "Specialty Pizzas" still resolve to the Pizza nudge.
 *
 * Returns "" (no nudge) for beverages and unknown categories.
 */
export function crossSellNudge(category: string): string {
  const c = category.toLowerCase();
  // Order matters: more specific first.
  const rules: Array<[RegExp, string]> = [
    [/by the slice|^slices?$|\bslice\b/, "suggest making it a combo with a drink"],
    [/\bpizza\b|\bpie\b|stromboli|calzone/, "suggest wings, garlic knots, or drinks"],
    [/baked pasta/, "suggest a side salad or drink"],
    [/\bwings?\b/, "suggest fries and a drink"],
    [/\bsalad/, "suggest a drink"],
    [/wrap|panini|sandwich|burger|quesadilla|hoagie|sub\b/, "suggest a drink"],
    [/entree|dinner|pasta|platter|main/, "suggest an appetizer and drinks"],
    [/\bkid/, "suggest a kids drink"],
    [/beverage|\bdrinks?\b|soda|fountain/, ""],
  ];
  for (const [re, nudge] of rules) {
    if (re.test(c)) return nudge;
  }
  return ""; // unknown category -> no invented nudge
}
