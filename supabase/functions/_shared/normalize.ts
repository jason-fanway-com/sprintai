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
function splitOrList(clause: string): string[] {
  const commaParts = clause.split(",").map(s => s.trim()).filter(Boolean);
  if (commaParts.length === 0) return [];
  const lastIdx = commaParts.length - 1;
  const orParts = commaParts[lastIdx].split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean);
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
function extractChoiceOfFromDescription(description: string | null): { choices: string[] } {
  if (!description) return { choices: [] };
  const m = description.match(/choice of\s+([^.;]+)/i);
  if (!m) return { choices: [] };
  const clause = m[1].trim();
  if (!/\bor\b/i.test(clause)) return { choices: [] };
  const choices = splitOrList(clause).map(titleCase);
  return choices.length >= 2 ? { choices } : { choices: [] };
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
    const { choices: descChoices } = extractChoiceOfFromDescription(row.description);

    const slots: NormalizedSlot[] = [];
    if (nameChoices.length >= 2) {
      slots.push({ slot_key: "choice", source: "name", choices: nameChoices.map(display_name => ({ display_name })) });
    }
    if (descChoices.length >= 2) {
      slots.push({ slot_key: "choice", source: "description", choices: descChoices.map(display_name => ({ display_name })) });
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
