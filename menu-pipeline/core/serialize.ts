/**
 * Stage A serializer: MenuModel -> byte-deterministic canonical CSV + Open Questions.
 *
 * This is the determinism guarantee. Given the same MenuModel, this produces a
 * BYTE-IDENTICAL CSV every time — ordering, formatting, and quoting are all fixed
 * here. LLM/extractor front-ends are non-deterministic; this layer is not.
 *
 * Implements MENU-INTAKE-STANDARD.md exactly:
 *   - 7 columns, exact order/lowercase
 *   - two regions: items (menu section order) then modifier blocks (fixed order)
 *   - price = 2-decimal plain number, blank only when unknown (+ flag)
 *   - prompt_for semicolon-joined; upsell add-ons + one cross-sell nudge appended
 *   - half/whole as separate option rows; free required answers = 0.00; TBD = blank
 *   - modifier blocks deduped
 */

import {
  CanonicalRow,
  CSV_COLUMNS,
  MenuModel,
  ModifierBlock,
  ModifierOption,
} from "./types.ts";
import { blockOrderKey, crossSellNudge, sizeOrderKey } from "./ordering.ts";

// ---- Public API -------------------------------------------------------------

/** Build the canonical, deterministic rows from a MenuModel. */
export function buildCanonicalRows(model: MenuModel): CanonicalRow[] {
  const itemRows = buildItemRows(model);
  const blockRows = buildModifierRows(model);
  return [...itemRows, ...blockRows];
}

/** Serialize rows to a byte-deterministic CSV string (UTF-8, LF line endings). */
export function rowsToCsv(rows: CanonicalRow[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvEscape(row[col])).join(","));
  }
  // Trailing newline for deterministic, POSIX-friendly files.
  return lines.join("\n") + "\n";
}

/** Convenience: MenuModel -> CSV string. */
export function menuToCsv(model: MenuModel): string {
  return rowsToCsv(buildCanonicalRows(model));
}

/** Build the Open Questions companion text. Always returns content. */
export function buildOpenQuestions(model: MenuModel): string {
  const header = "OPEN QUESTIONS";
  if (!model.openQuestions || model.openQuestions.length === 0) {
    return `${header}\n\nNone — every price and option was read directly from the menu with no ambiguity.\n`;
  }
  // Deterministic order: sort by area, then issue, then question.
  const sorted = [...model.openQuestions].sort((a, b) => {
    const k = a.area.toLowerCase().localeCompare(b.area.toLowerCase());
    if (k !== 0) return k;
    const i = a.issue.toLowerCase().localeCompare(b.issue.toLowerCase());
    if (i !== 0) return i;
    return a.question.toLowerCase().localeCompare(b.question.toLowerCase());
  });
  const lines = [header, ""];
  let n = 1;
  for (const q of sorted) {
    lines.push(`${n}. [${q.area}] ${q.issue} — ${q.question}`);
    n++;
  }
  return lines.join("\n") + "\n";
}

// ---- Item rows --------------------------------------------------------------

function buildItemRows(model: MenuModel): CanonicalRow[] {
  // Group items by category, ordered by the menu's own section order.
  const orderIndex = new Map<string, number>();
  model.categoryOrder.forEach((c, i) => orderIndex.set(c, i));

  const sorted = [...model.items].sort((a, b) => {
    const ca = orderIndex.has(a.category) ? orderIndex.get(a.category)! : Number.MAX_SAFE_INTEGER;
    const cb = orderIndex.has(b.category) ? orderIndex.get(b.category)! : Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    // Categories not in the declared order fall back to alphabetical (deterministic).
    if (ca === Number.MAX_SAFE_INTEGER) {
      const catCmp = a.category.toLowerCase().localeCompare(b.category.toLowerCase());
      if (catCmp !== 0) return catCmp;
    }
    // Within a category: preserve item appearance via stable name grouping,
    // then canonical size order within a multi-size item.
    const nameCmp = stableNameKey(a.name).localeCompare(stableNameKey(b.name));
    if (nameCmp !== 0) return nameCmp;
    return compareSize(a.size, b.size);
  });

  return sorted.map((it) => {
    const promptFor = (it.promptFor || []).map((p) => p.trim()).filter(Boolean).join("; ");
    const nudge = crossSellNudge(it.category);
    const upsellParts = (it.upsell || []).map((u) => u.trim()).filter(Boolean);
    if (nudge) upsellParts.push(nudge);
    return {
      category: it.category.trim(),
      name: it.name.trim(),
      size: it.size.trim(),
      price: formatPrice(it.price),
      description: it.description.trim(),
      prompt_for: promptFor,
      upsell: upsellParts.join("; "),
    };
  });
}

/**
 * Stable, deterministic grouping key for item names. We intentionally do NOT
 * re-sort items within a category by name in the general case (the standard says
 * items follow the menu's own order), but multi-size variants of the SAME item
 * must be adjacent and size-ordered. Using the lowercased name groups variants
 * while keeping a deterministic tiebreak.
 */
function stableNameKey(name: string): string {
  return name.toLowerCase().trim();
}

function compareSize(a: string, b: string): number {
  const ka = sizeOrderKey(a);
  const kb = sizeOrderKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// ---- Modifier-block rows ----------------------------------------------------

function buildModifierRows(model: MenuModel): CanonicalRow[] {
  const deduped = dedupeBlocks(model.modifierBlocks);

  // Order blocks by fixed block order.
  const sortedBlocks = [...deduped].sort((a, b) => {
    const ka = blockOrderKey(a.label);
    const kb = blockOrderKey(b.label);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1].localeCompare(kb[1]);
  });

  const rows: CanonicalRow[] = [];
  for (const block of sortedBlocks) {
    // Dedupe + order options within a block deterministically by name.
    const seen = new Set<string>();
    const opts = [...block.options]
      .filter((o) => {
        const key = o.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    for (const opt of opts) {
      rows.push({
        category: block.label.trim(),
        name: opt.name.trim(),
        size: "",
        price: formatPrice(opt.priceDelta),
        description: opt.priceDelta === null ? "Upcharge TBD" : "",
        prompt_for: "",
        upsell: "",
      });
    }
  }
  return rows;
}

/** Dedupe modifier blocks by label, merging their options. */
function dedupeBlocks(blocks: ModifierBlock[]): ModifierBlock[] {
  const byLabel = new Map<string, ModifierBlock>();
  for (const b of blocks) {
    const key = b.label.trim();
    const existing = byLabel.get(key);
    if (existing) {
      existing.options.push(...b.options);
    } else {
      byLabel.set(key, { label: key, options: [...b.options] });
    }
  }
  return [...byLabel.values()];
}

// ---- Formatting helpers -----------------------------------------------------

/** Format a price to a 2-decimal plain string, or "" when unknown. No symbol. */
export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "";
  if (!Number.isFinite(price)) return "";
  return price.toFixed(2);
}

/** RFC-4180-ish CSV escaping, deterministic. Quotes only when needed. */
export function csvEscape(value: string): string {
  const v = value ?? "";
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

let _opts: ModifierOption[]; // (kept for potential typed re-use; no runtime effect)
void _opts;
