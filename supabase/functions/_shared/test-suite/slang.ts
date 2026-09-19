/**
 * slang.ts — deterministic pre-go-live case generator for regional/generic
 * food-service SLANG resolution (e.g. a customer says "hoagie" for a menu
 * item filed as "Sub", or "pop" for "Soda").
 *
 * A new shop has no track record yet, and a misresolved item is a real
 * order/money error — this is additive to the existing menu-derived battery
 * in generator.ts, using the same expectedItemCents/expectedLineCount
 * deterministic grading fields proof.ts already checks (no LLM judge needed
 * for whether the right item + price landed in the cart).
 *
 * Menu-AGNOSTIC, same principle as category-coverage.ts: never hardcodes an
 * item name. Cases are only produced where the dictionary (see
 * slang-dictionary.ts) actually matches a real active menu item's name or
 * category — a shop with no matching item (e.g. no sandwiches) gets zero
 * slang-sub cases, not a forced failure on an irrelevant term.
 */

import type { TestCase } from "./library.ts";
import { SLANG_DICTIONARY, type SlangEntry } from "./slang-dictionary.ts";

export interface SlangMenuItem {
  id: string;
  name: string;
  category: string;
  price_cents: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, token-boundary match — "sub" matches "Italian Sub" or a
 * category of "Subs"/"Cold Subs" (optional trailing "s" for plural category
 * names) but never matches as a raw substring inside an unrelated word (e.g.
 * "substitute"). Multi-word keywords ("cream cheese") work the same way
 * since spaces already sit on a word boundary.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}s?\\b`, "i");
  return pattern.test(text);
}

function findMatchingEntries(item: SlangMenuItem): SlangEntry[] {
  return SLANG_DICTIONARY.filter((entry) =>
    entry.formalKeywords.some(
      (kw) => matchesKeyword(item.name, kw) || matchesKeyword(item.category ?? "", kw),
    )
  );
}

/** "Can I get a hoagie?" / "Can I get an order?" / "Can I get mozz sticks?" (no article for plural-looking terms). */
function phraseSlangOrder(term: string): string {
  if (/s$/i.test(term.trim())) return `Can I get ${term}?`;
  const article = /^[aeiou]/i.test(term) ? "an" : "a";
  return `Can I get ${article} ${term}?`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

export function buildSlangCases(menuItems: SlangMenuItem[]): TestCase[] {
  const cases: TestCase[] = [];
  menuItems.forEach((item, index) => {
    const matches = findMatchingEntries(item);
    if (matches.length === 0) return;
    // An item can match more than one entry sharing the same formal keyword
    // (e.g. "sub" → hoagie/grinder/hero). Rotate by item index so a shop with
    // several sub-family items exercises more than one synonym, instead of
    // every case using the same slang term.
    const entry = matches[index % matches.length];
    const slangTerm = entry.slangTerms[0];
    const message = phraseSlangOrder(slangTerm);
    cases.push({
      id: `slang-${slugify(entry.id)}-${slugify(item.name)}`,
      category: "slang-resolution",
      criticality: "critical",
      label: `Slang order: "${slangTerm}" should resolve to "${item.name}" (${entry.note})`,
      turns: [{ role: "customer", message }],
      success_criteria: [
        {
          id: "slang_resolved",
          description: `Bot resolves "${slangTerm}" to menu item "${item.name}" and adds it to the cart`,
          check_id: "invented_item",
        },
      ],
      expectedItemCents: item.price_cents,
      expectedLineCount: 1,
    });
  });
  return cases;
}
