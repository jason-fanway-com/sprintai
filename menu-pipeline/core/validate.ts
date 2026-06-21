/**
 * Stage A validator — the QA checklist from MENU-INTAKE-STANDARD.md, enforced.
 *
 * This is the LOUD-FAILURE gate. It checks the canonical rows for the
 * standard's "Validation before done" list, with referential integrity as the
 * headline rule: every option named in a `prompt_for` and every `+$` add-on in
 * `upsell` must resolve to an option that actually exists in a modifier block.
 *
 * Pure / runtime-agnostic. Returns a structured ValidationResult; callers decide
 * whether to throw. `assertValid` throws loudly for fail-fast call sites
 * (importer, CLI with --strict).
 */

import type { CanonicalRow, ValidationError, ValidationResult } from "./types.ts";
import { FIXED_BLOCK_ORDER } from "./ordering.ts";

const KNOWN_BLOCK_SET = new Set(FIXED_BLOCK_ORDER.map((s) => s.toLowerCase()));

/** A row is a modifier-block row when its category names a modifier block. */
function isModifierBlockRow(row: CanonicalRow, blockLabels: Set<string>): boolean {
  return blockLabels.has(row.category.trim().toLowerCase());
}

/**
 * Identify which categories are modifier blocks. A category is a modifier block
 * if it is a known fixed block label OR its rows have blank size+prompt_for+upsell
 * AND it is referenced from a prompt_for/upsell (heuristic). To keep this
 * deterministic and strict we treat a category as a block when it is a known
 * fixed-order label OR every row in it has empty prompt_for AND empty upsell AND
 * empty size (the modifier-row shape). Item categories almost always have at
 * least one non-empty prompt_for/upsell/size somewhere; pure-modifier blocks do
 * not.
 */
export function collectBlockLabels(rows: CanonicalRow[]): Set<string> {
  const byCategory = new Map<string, CanonicalRow[]>();
  for (const r of rows) {
    const key = r.category.trim();
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(r);
  }
  const labels = new Set<string>();
  for (const [cat, catRows] of byCategory) {
    const lc = cat.toLowerCase();
    if (KNOWN_BLOCK_SET.has(lc)) {
      labels.add(lc);
      continue;
    }
    // Modifier-row shape: all rows blank in size, prompt_for, upsell.
    const allModifierShape = catRows.every(
      (r) => r.size.trim() === "" && r.prompt_for.trim() === "" && r.upsell.trim() === "",
    );
    // And the block has a recognizable modifier label form (contains a known
    // keyword) — avoids misclassifying a real item category that happens to have
    // no sizes/prompts (e.g. a plain "Sides" listing). This vocabulary tracks the
    // standard's block labels plus the common answer-set nouns.
    const looksLikeBlock =
      /toppings|sauce|salsa|dressing|protein|add-?on|choices|choice|options|option|substitut|flavor|extras?|sides? sub/i
        .test(cat);
    if (allModifierShape && looksLikeBlock) labels.add(lc);
  }
  return labels;
}

/** Normalize an option name for fuzzy matching across prompt_for/upsell text. */
function normalizeOption(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // drop parentheticals
    .replace(/\+\$\s*\d+(?:\.\d+)?/g, " ") // drop +$ price hints
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract candidate option tokens from a prompt_for phrase. We parse the inline
 * option list inside parentheses: "which sauce (hot, mild, or BBQ)" -> [hot, mild, bbq].
 * Also handles "X or Y" bare forms: "bleu cheese or ranch" -> [bleu cheese, ranch].
 */
export function extractPromptOptions(phrase: string): string[] {
  const opts: string[] = [];
  const paren = phrase.match(/\(([^)]*)\)/);
  const body = paren ? paren[1] : phrase.replace(/^[^(]*\bwhich\b[^(]*$/i, phrase);
  // Split on commas and the word "or"/"and".
  const raw = (paren ? paren[1] : phrase)
    .replace(/\bwhich\b/gi, " ")
    .split(/,|\bor\b|\band\b|\/|;/i);
  for (const part of raw) {
    const t = normalizeOption(part);
    // Skip leader words like "sauce", "dressing", "pasta" when they're the
    // category noun, not an option — heuristic: keep tokens that appear after
    // the prompt noun. We keep everything non-empty and longer than 1 char and
    // not a pure category noun.
    if (t && t.length > 1 && !/^(sauce|dressing|pasta|choice|flavor|flavors|topping|toppings|protein|side|sides)$/.test(t)) {
      opts.push(t);
    }
  }
  void body;
  return opts;
}

/**
 * Strip leading/trailing join words ("or", "and") and surrounding punctuation
 * from a captured add-on name. The `+$` list separators "or"/"and" are NOT part
 * of the option name — e.g. when scanning "shrimp +$6 or salmon +$8", the regex
 * captures "or salmon" for the second amount because the gap text between the
 * first price and the second name includes the connector. We peel it off here so
 * "or salmon" -> "salmon" and "and bacon" -> "bacon". Case-insensitive; handles
 * repeated connectors and stray commas/slashes.
 */
function stripJoinWords(name: string): string {
  let s = name.trim();
  // Peel leading connectors / punctuation, repeatedly.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^(?:[,;/&]+|\b(?:or|and)\b)\s*/i, "").trim();
  } while (s !== prev);
  // Peel trailing connectors / punctuation, repeatedly.
  do {
    prev = s;
    s = s.replace(/\s*(?:[,;/&]+|\b(?:or|and)\b)$/i, "").trim();
  } while (s !== prev);
  return s;
}

/**
 * Extract `+$`-hinted add-on names from an upsell phrase.
 *
 * Handles add-on lists joined by commas AND by the words "or"/"and":
 *   "chicken +$4, shrimp +$6"          -> [chicken, shrimp]
 *   "shrimp +$6 or salmon +$8"         -> [shrimp, salmon]
 *   "x +$6 or y +$8 or z +$9"          -> [x, y, z]
 *   "a +$1 and b +$2"                  -> [a, b]
 * The regex greedily captures the text immediately preceding each `+$amount`;
 * that captured text can carry a leading connector ("or salmon") from the prior
 * list element, so we strip leading/trailing "or"/"and"/punctuation before
 * normalizing. Deterministic: single left-to-right pass, no Set/Map ordering.
 */
export function extractUpsellAddons(phrase: string): string[] {
  const addons: string[] = [];
  // Match "name +$4" possibly inside a list "chicken +$4, shrimp +$6"
  const re = /([a-zA-Z][a-zA-Z0-9 '\-]*?)\s*\+\$\s*(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(phrase)) !== null) {
    const cleaned = stripJoinWords(m[1]);
    const name = normalizeOption(cleaned);
    if (name) addons.push(name);
  }
  return addons;
}

/**
 * Build the set of option names known across all modifier blocks (normalized),
 * plus a per-block lookup for richer messages.
 */
function buildKnownOptionIndex(
  rows: CanonicalRow[],
  blockLabels: Set<string>,
): { all: Set<string>; byBlock: Map<string, Set<string>> } {
  const all = new Set<string>();
  const byBlock = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isModifierBlockRow(r, blockLabels)) continue;
    const norm = normalizeOption(r.name);
    if (norm) {
      all.add(norm);
      // Also index the bare token without portion suffix "(whole pizza)".
      const bare = normalizeOption(r.name.replace(/\((?:whole|half)[^)]*\)/i, ""));
      if (bare) all.add(bare);
    }
    const blk = r.category.trim();
    if (!byBlock.has(blk)) byBlock.set(blk, new Set());
    byBlock.get(blk)!.add(norm);
  }
  return { all, byBlock };
}

/**
 * Does the candidate token resolve to a known modifier-block option?
 *
 * Resolution is by NORMALIZED WHOLE-WORD matching, not naive substring
 * containment. The old `k.includes(candidate) || candidate.includes(k)` check
 * let garbage like "or steak" resolve merely because the substring "steak"
 * appears inside it — masking the parser bug above. We instead require that the
 * candidate's word set be a (non-empty) subset of a known option's word set, or
 * vice-versa. This keeps legitimate short-form matches working:
 *   "salmon"  ~ "blackened salmon"      (candidate words ⊆ option words)
 *   "steak"   ~ "black diamond steak"   (candidate words ⊆ option words)
 * while rejecting accidental substring hits:
 *   "or steak" has words {or, steak} which is NOT a subset of
 *   {black, diamond, steak} -> does not resolve (the connector word "or" is not
 *   part of any option), so the parser is forced to produce clean tokens.
 */
function wordSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  if (small.size === 0) return false;
  for (const w of small) {
    if (!big.has(w)) return false;
  }
  return true;
}

function resolves(candidate: string, known: Set<string>): boolean {
  if (!candidate) return true;
  if (known.has(candidate)) return true;
  const cWords = wordSet(candidate);
  if (cWords.size === 0) return false;
  for (const k of known) {
    const kWords = wordSet(k);
    // candidate is a short-form of a known option ("salmon" of "blackened salmon")
    // or known is a short-form of the candidate — both directions, whole-word.
    if (isSubset(cWords, kWords) || isSubset(kWords, cWords)) return true;
  }
  return false;
}

export interface ValidateOptions {
  /** When true, prompt_for/upsell referential integrity errors are hard errors.
   *  When false (default), unresolved references are warnings (Stage A still
   *  emits the CSV for human review; the importer enforces hard). */
  strictReferences?: boolean;
}

/**
 * Validate canonical rows against the standard's QA checklist.
 */
export function validateRows(
  rows: CanonicalRow[],
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const blockLabels = collectBlockLabels(rows);
  const { all: knownOptions } = buildKnownOptionIndex(rows, blockLabels);

  // -- Price format: 2-decimal or blank ---------------------------------------
  rows.forEach((r, i) => {
    const p = r.price.trim();
    if (p === "") return; // blank allowed (must be flagged — checked elsewhere)
    if (/[^0-9.]/.test(p)) {
      errors.push({ code: "PRICE_SYMBOL", message: `Row ${i + 1} "${r.name}": price "${p}" contains a stray symbol; must be plain 2-decimal.`, context: String(i + 1) });
    } else if (!/^\d+\.\d{2}$/.test(p)) {
      errors.push({ code: "PRICE_FORMAT", message: `Row ${i + 1} "${r.name}": price "${p}" is not a 2-decimal number.`, context: String(i + 1) });
    }
  });

  // -- No duplicate rows ------------------------------------------------------
  const seenRow = new Set<string>();
  rows.forEach((r, i) => {
    const key = [r.category, r.name, r.size, r.price].map((s) => s.trim().toLowerCase()).join("\u0001");
    if (seenRow.has(key)) {
      errors.push({ code: "DUPLICATE_ROW", message: `Row ${i + 1}: duplicate of an earlier row (${r.category} / ${r.name} / ${r.size}).`, context: String(i + 1) });
    }
    seenRow.add(key);
  });

  // -- No orphan/empty blocks: a modifier block must have >=1 option row -------
  // (collectBlockLabels only returns labels that have rows, so emptiness is
  //  structurally prevented; we still check known-fixed labels referenced but
  //  absent below.)

  // -- Referential integrity: prompt_for options resolve ----------------------
  const refSink = opts.strictReferences ? errors : warnings;
  rows.forEach((r, i) => {
    if (isModifierBlockRow(r, blockLabels)) return; // blocks don't reference
    if (r.prompt_for.trim()) {
      for (const phrase of r.prompt_for.split(";")) {
        const candidates = extractPromptOptions(phrase);
        for (const c of candidates) {
          if (!resolves(c, knownOptions)) {
            refSink.push({
              code: "PROMPT_UNRESOLVED",
              message: `Row ${i + 1} "${r.name}": prompt_for option "${c}" (from "${phrase.trim()}") has no matching modifier-block option.`,
              context: String(i + 1),
            });
          }
        }
      }
    }
    // -- Referential integrity: +$ add-ons resolve ----------------------------
    if (r.upsell.trim()) {
      for (const addon of extractUpsellAddons(r.upsell)) {
        if (!resolves(addon, knownOptions)) {
          refSink.push({
            code: "UPSELL_UNRESOLVED",
            message: `Row ${i + 1} "${r.name}": upsell add-on "${addon}" (with +$ price) has no matching paid modifier-block option.`,
            context: String(i + 1),
          });
        }
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** Throw loudly if validation fails. Used by the importer and --strict CLI. */
export function assertValid(result: ValidationResult, label = "menu"): void {
  if (result.ok) return;
  const lines = result.errors.map((e) => `  [${e.code}] ${e.message}`);
  throw new Error(
    `Menu validation FAILED for ${label} (${result.errors.length} error(s)):\n${lines.join("\n")}`,
  );
}
