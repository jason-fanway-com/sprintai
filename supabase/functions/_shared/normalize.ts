// Phase 0 item 2 (docs/specs/2026-09-07-conversation-ready-menu-design.md,
// §3 stage 3 "Normalize", §11 item 2). Rule-based, no LLM, no I/O — matches
// the pure-function pattern already used by pending-disambiguation.ts /
// phantom-add-guard.ts so this is unit-testable without spinning up an edge
// function or a DB write.
//
// Four things happen here, in order, per §6.2:
//   1. Size/quantity variants of the same base item fold into one
//      `product_key` ("Cheese - Large (16")" -> product `pizza:cheese`),
//      general across any category, not pizza-specific.
//   2. "X or Y" in the item NAME becomes a stated slot ("Gyro (Beef or
//      Chicken)" -> slot [Beef, Chicken], the clause drops from the name).
//   3. "choice of A, B or C" in the DESCRIPTION becomes a stated slot the
//      same way. A comma list with no trailing "or" ("choice of pasta,
//      garlic knots, side salad") is NOT a slot — those are three included
//      things, not three alternatives — so it must not fire here.
//   4. `display_name` is computed from the above (category-suffix and
//      "or"-clause stripped, size folded, title-cased), then a final pass
//      over the FULL set qualifies any two orderable items that still share
//      a display_name with their own category noun.
//
// `name` (the source/POS string) is read but never mutated or returned
// changed — `display_name` is a new, separate field.

export interface RawMenuItemRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_cents: number;
  size_label: string | null;
}

export interface NormalizedSlotChoice {
  display_name: string;
}

export interface NormalizedSlot {
  // Purely syntactic at this stage — classify/infer (§3 stages 4-5) assign
  // the real slot_key (temp, bread, protein, ...) from the archetype library.
  slot_key: "choice";
  source: "name" | "description";
  choices: NormalizedSlotChoice[];
  // Set only for a description-sourced slot extracted from "choice of X (A,
  // B, ...)" — X is the named sub-attribute the parenthetical answers
  // ("meat", "cheese"), lowercased. Unset for a bare enumeration ("choice
  // of bagel, bread, or roll") and for name-sourced slots. Real NJB text
  // states both shapes in the SAME description ("Choice of meat (Bacon,
  // Ham, Sausage, or Pork Roll) on choice of bagel, bread, or roll.") —
  // `label` is how a caller picks the bare-enumeration slot over the named
  // sub-clause when more than one description-sourced slot exists on an
  // item (see pickDescriptionSlot below).
  label?: string;
}

// A "choice of N <thing>" clause ("choice of three veggies", "choice of 1
// meat, 1 cheese & 2 vegetables") describes a bounded-pick MODIFIER, not a
// slot — the customer can add up to N of a kind, not pick exactly one from
// a stated list (there is no list; the count is the only thing stated).
// `slot_key` is a syntactic guess (singularized, lowercased noun from the
// clause) for a human to confirm/rename, not a real archetype slot_key.
export interface NormalizedModifier {
  slot_key: string;
  max_select: number;
  source_span: string;
}

export interface NormalizedMenuItem {
  id: string;
  name: string;
  category: string | null;
  price_cents: number;
  size_label: string | null;
  product_key: string;
  display_name: string;
  slots: NormalizedSlot[];
  modifiers: NormalizedModifier[];
}

// Picks the description-sourced slot a caller should treat as THIS item's
// stated answer for a bare-enumeration archetype slot (bread/toast/...).
// Prefers an unlabeled clause (a direct "choice of A, B, or C" list) over a
// labeled one (a named sub-clause like "choice of meat (...)") — every
// current archetype slot that reads from the description wants the bare
// enumeration, never a named sub-attribute the archetype library doesn't
// model yet. Falls back to the first (only) slot when none is unlabeled, or
// to name-sourced choices from name-slotted items — unaffected either way.
export function pickDescriptionSlot(item: NormalizedMenuItem): NormalizedSlot | undefined {
  const descriptionSlots = item.slots.filter(s => s.source === "description");
  return descriptionSlots.find(s => !s.label) ?? descriptionSlots[0];
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return /[a-z]/.test(word[0]) ? word[0].toUpperCase() + word.slice(1) : word;
}

function titleCase(text: string): string {
  return text.split(/\s+/).filter(Boolean).map(titleCaseWord).join(" ");
}

// Crude but sufficient — same tradeoff pending-disambiguation.ts's stemWord
// makes: this only needs to bridge the ordinary category words this system
// actually deals in, not handle general English morphology.
function singularize(word: string): string {
  if (word.length > 4 && /ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|ses|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

// The noun to qualify a display_name with when it collides with another
// item's ("Chicken Caesar" + Salads -> "Salad", + Wraps -> "Wrap"). Takes the
// category's last word so a multi-word category ("Hot Sandwiches") still
// yields an ordinary singular noun ("Sandwich").
function categoryNoun(category: string | null): string {
  if (!category) return "";
  const cleaned = category.replace(/\([^)]*\)/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return titleCaseWord(singularize(words[words.length - 1]));
}

function containsCI(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

// "A, B or C" / "A or B" -> ["A", "B", "C"]. Only the segment after the last
// comma is split on "or", so "pasta, garlic knots, side salad" (no "or" at
// all) is left as a single non-slot clause by the caller's `\bor\b` guard,
// and "Beef, Chicken or Lamb" splits correctly instead of treating "Chicken
// or Lamb" as one item.
//
// Oxford-comma phrasing ("bagel, bread, or roll", real NJB text) puts "or"
// at the very START of the last comma segment ("or roll"), so `\s+or\s+`
// never matches it (there's no leading whitespace to match at the start of
// a trimmed string) and the whole "or roll" segment falls through as one
// choice, title-casing to "Or Roll" — a bogus option a customer would
// actually see/hear. When the mid-segment split finds nothing, strip a
// leading "or " instead.
function splitOrList(clause: string): string[] {
  const commaParts = clause.split(",").map(s => s.trim()).filter(Boolean);
  if (commaParts.length === 0) return [];
  const lastIdx = commaParts.length - 1;
  const last = commaParts[lastIdx];
  const midSplit = last.split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean);
  const orParts = midSplit.length > 1 ? midSplit : [last.replace(/^or\s+/i, "")];
  return [...commaParts.slice(0, lastIdx), ...orParts];
}

// Drops a trailing "(Category)" from a name when it restates the item's own
// category ("Chicken Caesar (Salads)", category "Salads" -> "Chicken
// Caesar"). Guarded against a parenthetical that contains "or" so this never
// competes with extractOrClauseFromName below.
function stripCategorySuffix(name: string, category: string | null): string {
  if (!category) return name;
  const m = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return name;
  const paren = m[2].trim();
  if (/\bor\b/i.test(paren)) return name;
  const normParen = singularize(paren.toLowerCase());
  const normCat = singularize(category.trim().toLowerCase());
  if (paren.toLowerCase() === category.trim().toLowerCase() || normParen === normCat) {
    return m[1].trim();
  }
  return name;
}

function extractOrClauseFromName(name: string): { strippedName: string; choices: string[] } {
  const m = name.match(/^(.*?)\s*\(([^()]*\bor\b[^()]*)\)\s*$/i);
  if (!m) return { strippedName: name, choices: [] };
  const choices = splitOrList(m[2]).map(titleCase);
  if (choices.length < 2) return { strippedName: name, choices: [] };
  return { strippedName: m[1].trim(), choices };
}

// Same shape of slot, sourced from the description instead of the name
// ("choice of white, wheat or rye" -> [White, Wheat, Rye]). The `\bor\b`
// requirement is what keeps this from inventing a slot out of "choice of
// pasta, garlic knots, side salad" — real Vito's text where the three
// things are all included, not alternatives to pick one of.
//
// A description can state MORE THAN ONE "choice of" clause (real NJB:
// "Choice of meat (Bacon, Ham, Sausage, or Pork Roll) on choice of bagel,
// bread, or roll." and "Omelette with choice of meat (...). Served with ...
// and choice of bagel or toast.") — each "choice of" is its own anchor;
// the clause it introduces runs until the NEXT anchor or a sentence
// boundary (./;), whichever comes first, with a trailing "on"/"and"
// connector stripped. Every real two-clause item found sweeping NJB's full
// menu follows this shape; Vito's and Zio's have zero such items (checked
// against live data), so this only ever activates on NJB text today.
//
// Within one clause, two independent shapes both produce a slot:
//  1. A parenthetical list right after an optional named label ("meat (A,
//     B, or C)", or no label at all — "(A, B, ..., Z)"). This is checked
//     first: a parenthetical enumeration is a stronger, more general
//     signal than the trailing-"or" requirement below, and real NJB text
//     has bare-parenthetical items with NO "choice of" anchor at all
//     ("Flavored homemade cream cheese spread (Walnut Raisin, ...), sold
//     by the pound") — handled by the anchor-less fallback at the bottom
//     of this function, since there's nothing to anchor a clause to.
//  2. A bare "A, B or C" / "A or B" list with no parens, gated on `\bor\b`
//     the same way as the single-clause version historically was.
// A clause matching neither is handed to extractModifiersFromClause — a
// "choice of N <thing>" quantity has no list to become a slot from, but is
// real structured data (see NormalizedModifier), not a discard.
function extractDescriptionClauses(description: string | null): {
  slots: { choices: string[]; label?: string }[];
  modifiers: NormalizedModifier[];
} {
  const slots: { choices: string[]; label?: string }[] = [];
  const modifiers: NormalizedModifier[] = [];
  if (!description) return { slots, modifiers };

  const anchorRe = /choice of\s+/gi;
  const anchorStarts: number[] = [];
  const contentStarts: number[] = [];
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(description))) {
    anchorStarts.push(anchorMatch.index);
    contentStarts.push(anchorMatch.index + anchorMatch[0].length);
  }

  if (anchorStarts.length === 0) {
    // No "choice of" anywhere — the only remaining signal is a bare
    // parenthetical enumeration anywhere in the text (real NJB: a cream
    // cheese flavor list sold as its own line item, no "choice of" at all).
    const parenMatch = description.match(/\(([^()]+)\)/);
    if (parenMatch) {
      const choices = splitOrList(parenMatch[1]).map(titleCase);
      if (choices.length >= 2) slots.push({ choices });
    }
    return { slots, modifiers };
  }

  for (let i = 0; i < contentStarts.length; i++) {
    const hardEnd = i + 1 < anchorStarts.length ? anchorStarts[i + 1] : description.length;
    let clause = description.slice(contentStarts[i], hardEnd);
    const sentenceEnd = clause.search(/[.;]/);
    if (sentenceEnd !== -1) clause = clause.slice(0, sentenceEnd);
    clause = clause.replace(/\s+(on|and)\s*$/i, "").trim();
    if (!clause) continue;

    const parenMatch = clause.match(/^([^()]*?)\(([^()]+)\)\s*$/);
    if (parenMatch) {
      const label = parenMatch[1].trim().toLowerCase();
      const choices = splitOrList(parenMatch[2]).map(titleCase);
      if (choices.length >= 2) {
        slots.push({ choices, ...(label ? { label } : {}) });
        continue;
      }
    }

    if (/\bor\b/i.test(clause)) {
      const choices = splitOrList(clause).map(titleCase);
      if (choices.length >= 2) {
        slots.push({ choices });
        continue;
      }
    }

    modifiers.push(...extractModifiersFromClause(clause));
  }

  return { slots, modifiers };
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// "1 meat" / "three veggies" -> a bounded-pick count + a syntactic noun
// guess. Not anchored to a specific archetype's vocabulary — any clause
// shaped "<number> <noun phrase>" qualifies.
function parseQuantityNoun(segment: string): { slot_key: string; max_select: number } | null {
  const m = segment.trim().match(/^(\d+|one|two|three|four|five)\s+(.+)$/i);
  if (!m) return null;
  const max_select = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1].toLowerCase()];
  const slot_key = singularize(m[2].trim().toLowerCase());
  return slot_key ? { slot_key, max_select } : null;
}

// A clause that isn't a list ("choice of three veggies") or is a compound
// of several quantities joined by commas/"&"/"and" ("choice of 1 meat, 1
// cheese & 2 vegetables", real NJB "Build Your Own Omelette Platter" text)
// decomposes into one modifier per quantity+noun segment when EVERY segment
// parses cleanly. A clause with no leading quantity anywhere (e.g. the bare
// "cheese, mayo, lettuce..." topping list on Chicken Cutlet Sandwich) yields
// no modifiers — it's an included-toppings clause, not a pick-N modifier,
// and inventing one would be the same kind of guess §4.3 forbids for slots.
function extractModifiersFromClause(clause: string): NormalizedModifier[] {
  const sourceSpan = `choice of ${clause}`;

  // Compound form checked FIRST: "1 meat, 1 cheese & 2 vegetables" would
  // otherwise match the single-quantity regex greedily on its leading "1"
  // alone, swallowing the rest of the clause as one bogus noun phrase
  // instead of decomposing into three modifiers.
  const segments = clause.split(/\s*(?:,|&|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    const parsed = segments.map(parseQuantityNoun);
    if (parsed.every(p => p !== null)) {
      return (parsed as { slot_key: string; max_select: number }[]).map(p => ({ ...p, source_span: sourceSpan }));
    }
  }

  const whole = parseQuantityNoun(clause);
  return whole ? [{ ...whole, source_span: sourceSpan }] : [];
}

// Splits "Cheese - Small (10")" (size_label "Small (10")") into base "Cheese"
// and a spoken size adjective "Small" (parenthetical dimension dropped). Any
// set of rows sharing (category, base) folds to one product_key regardless
// of what the size words actually are — this is the general, non-pizza-
// specific rule §11 item 2 asks for.
function stripSizeSuffix(name: string, sizeLabel: string | null): { base: string; sizeAdjective: string | null } {
  if (!sizeLabel) return { base: name, sizeAdjective: null };
  const escaped = sizeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(.*?)\\s*-\\s*${escaped}$`, "i");
  const m = name.match(re);
  if (!m) return { base: name, sizeAdjective: null };
  const base = m[1].trim();
  const sizeAdjective = sizeLabel.replace(/\s*\([^)]*\)/g, "").trim();
  return { base, sizeAdjective: sizeAdjective || null };
}

export function normalizeMenuItems(rows: RawMenuItemRow[]): NormalizedMenuItem[] {
  const items: NormalizedMenuItem[] = rows.map(row => {
    const afterCategoryStrip = stripCategorySuffix(row.name, row.category);
    const { strippedName, choices: nameChoices } = extractOrClauseFromName(afterCategoryStrip);
    const { slots: descClauses, modifiers } = extractDescriptionClauses(row.description);

    const slots: NormalizedSlot[] = [];
    if (nameChoices.length >= 2) {
      slots.push({ slot_key: "choice", source: "name", choices: nameChoices.map(display_name => ({ display_name })) });
    }
    for (const clause of descClauses) {
      slots.push({
        slot_key: "choice",
        source: "description",
        choices: clause.choices.map(display_name => ({ display_name })),
        ...(clause.label ? { label: clause.label } : {}),
      });
    }

    const { base, sizeAdjective } = stripSizeSuffix(strippedName, row.size_label);

    // A folded (size-varying) product always states its category noun, per
    // the worked example in Appendix B ("Cheese" -> "Cheese Pizza" before
    // the size prefix) — a bare size adjective on its own ("Small Cheese")
    // doesn't read as an order-able thing. A singleton item never gets this;
    // that's what keeps "Gyro (Beef or Chicken)" as bare "Gyro" rather than
    // becoming "Gyro Sandwich" pre-emptively.
    let productBase = base;
    if (sizeAdjective) {
      const noun = categoryNoun(row.category);
      if (noun && !containsCI(productBase, noun)) {
        productBase = `${productBase} ${noun}`;
      }
    }
    productBase = titleCase(productBase);

    let displayName = productBase;
    if (sizeAdjective && !containsCI(productBase, sizeAdjective)) {
      displayName = `${titleCase(sizeAdjective)} ${productBase}`;
    }

    const productKey = `${slugify(row.category ?? "uncategorized")}:${slugify(base)}`;

    return {
      id: row.id,
      name: row.name,
      category: row.category,
      price_cents: row.price_cents,
      size_label: row.size_label,
      product_key: productKey,
      display_name: displayName,
      slots,
      modifiers,
    };
  });

  // Duplicate display-name qualification (§6.2, rule 5): a pass over the
  // FULL set, because a collision can't be known until every display_name
  // above has been computed. Only cross-category collisions qualify — two
  // rows of the same folded product never collide here because their size
  // prefix already differs.
  const groups = new Map<string, NormalizedMenuItem[]>();
  for (const item of items) {
    const key = item.display_name.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const distinctCategories = new Set(group.map(i => i.category ?? ""));
    if (distinctCategories.size < 2) continue;
    for (const item of group) {
      const noun = categoryNoun(item.category);
      if (noun && !containsCI(item.display_name, noun)) {
        item.display_name = `${item.display_name} ${noun}`;
      }
    }
  }

  return items;
}
