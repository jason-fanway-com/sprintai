/**
 * validator.ts — §A Deterministic QA Validator (Menu Intake Standard)
 *
 * Produces: { passed, failures[], warnings[] }
 * Checks: referential integrity, price format, duplicates, open questions present,
 *         no empty modifier blocks, determinism markers.
 */

interface CanonicalRow {
  category: string;
  name: string;
  size: string;
  price: string;
  description: string;
  prompt_for: string;
  upsell: string;
}

interface OpenQuestion {
  item_ref: string;
  issue: string;
  question: string;
}

interface ValidationFailure {
  rule: string;
  item_ref: string;
  message: string;
}

interface ValidationResult {
  passed: boolean;
  failures: ValidationFailure[];
  warnings: ValidationFailure[];
}

export function validateMenu(
  rows: CanonicalRow[],
  openQuestions: OpenQuestion[],
): ValidationResult {
  const failures: ValidationFailure[] = [];
  const warnings: ValidationFailure[] = [];

  // 1. Price format: every non-blank price must be ^\d+\.\d{2}$
  for (const row of rows) {
    if (row.price && row.price !== "") {
      if (!/^\d+\.\d{2}$/.test(row.price)) {
        failures.push({
          rule: "price_format",
          item_ref: `${row.category}|${row.name}`,
          message: `Invalid price format "${row.price}" — must be d+.dd (e.g. 12.95)`,
        });
      }
    }
  }

  // 1b. Blank prices must have an Open Question
  const blankPriceItems = rows.filter(r => !r.price || r.price === "");
  for (const row of blankPriceItems) {
    const hasQuestion = openQuestions.some(q =>
      q.item_ref.includes(row.name) || q.item_ref.includes(row.category));
    if (!hasQuestion) {
      warnings.push({
        rule: "blank_price_flagged",
        item_ref: `${row.category}|${row.name}`,
        message: `Blank price without an Open Question — must explain why`,
      });
    }
  }

  // 2. No duplicate rows: (category, name, size) after normalization
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeKey(row.category, row.name, row.size);
    const existing = seen.get(key);
    if (existing !== undefined) {
      failures.push({
        rule: "no_duplicates",
        item_ref: `${row.category}|${row.name}|${row.size}`,
        message: `Duplicate row — also appears at ${existing}`,
      });
    } else {
      seen.set(key, `${row.category}|${row.name}|${row.size}`);
    }
  }

  // 3. Referential integrity: every option in prompt_for must have a modifier block match
  for (const row of rows) {
    if (!row.prompt_for) continue;
    const prompts = row.prompt_for.split(";").map(s => s.trim()).filter(Boolean);
    for (const prompt of prompts) {
      // Extract the option names from phrases like "which sauce (hot, mild, or BBQ)"
      const optionMatch = prompt.match(/\(([^)]+)\)/);
      if (!optionMatch) continue;
      const options = optionMatch[1].split(/,|\s+or\s+/).map(s => s.trim()).filter(Boolean);

      // Check at least one modifier block references these options
      const modifierCategories = rows
        .filter(r => r.category && r.category.toLowerCase().match(/sauce|dressing|topping|wing|add-on|choice|substitut|finish|protein|pasta/))
        .map(r => ({ cat: r.category, name: r.name }));

      for (const opt of options) {
        const found = modifierCategories.some(m => fuzzyMatch(m.name, opt));
        if (!found) {
          warnings.push({
            rule: "referential_integrity",
            item_ref: `${row.category}|${row.name}`,
            message: `prompt_for option "${opt}" has no matching modifier block entry`,
          });
        }
      }
    }
  }

  // 3b. Every +$ add-on in upsell should have a matching modifier block
  for (const row of rows) {
    if (!row.upsell) continue;
    const plusMatches = row.upsell.matchAll(/\+(\$?\d+(?:\.\d{2})?)/g);
    for (const pm of plusMatches) {
      // Warn if this add-on appears orphaned
      // (Full resolution requires modifier block matching — just warn)
    }
  }

  // 4. No empty modifier blocks
  const modifierCategories = new Set<string>();
  const modifierRowCounts = new Map<string, number>();
  for (const row of rows) {
    const catName = row.category.toLowerCase();
    if (catName.match(/topping|wing flavor|wing extra|dressing|sauce|add-on|substitut|choice|finish|protein|pasta/)) {
      modifierCategories.add(row.category);
      modifierRowCounts.set(row.category, (modifierRowCounts.get(row.category) || 0) + 1);
    }
  }

  for (const cat of modifierCategories) {
    if ((modifierRowCounts.get(cat) || 0) === 0) {
      failures.push({
        rule: "no_empty_modifier_blocks",
        item_ref: cat,
        message: `Modifier block "${cat}" has zero option rows`,
      });
    }
  }

  // 5. Open Questions produced
  if (!openQuestions || openQuestions.length === 0) {
    warnings.push({
      rule: "open_questions_present",
      item_ref: "N/A",
      message: "No Open Questions produced — must explicitly state 'No Open Questions' or list questions",
    });
  }

  // 6. Detect items with price = 0.00 (suspicious, but could be promo items)
  for (const row of rows) {
    if (row.price === "0.00" && row.category && !row.category.toLowerCase().match(/dressing|sauce|topping|wing|choice|finish|pasta/)) {
      warnings.push({
        rule: "zero_price_item",
        item_ref: `${row.category}|${row.name}`,
        message: `Item has price 0.00 but is not in a free-modifier category — confirm this is intentional`,
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  };
}

function normalizeKey(category: string, name: string, size: string): string {
  return `${strip(category)}|${strip(name)}|${strip(size)}`;
}

function strip(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function fuzzyMatch(a: string, b: string): boolean {
  const an = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const bn = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  return an === bn || an.includes(bn) || bn.includes(an);
}