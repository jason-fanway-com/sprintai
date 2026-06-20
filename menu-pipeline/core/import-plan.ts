/**
 * Stage B planning — confirmed canonical CSV -> a diff-based DB import plan.
 *
 * Pure / runtime-agnostic. Produces a DESIRED state (menu_items + option_groups
 * + option_choices keyed by stable import_key), then diffs it against the EXISTING
 * DB state to emit inserts/updates/deactivations. The Supabase applier (separate
 * file / edge function) executes the plan. This keeps the hard logic testable
 * without a database.
 *
 * Mapping (per spec 04, Stage B):
 *   - item rows  -> menu_items (one row per sellable variant; size in name+size_label)
 *   - prompt_for -> required option_groups + option_choices (price 0), resolved
 *                   against the matching modifier block.
 *   - upsell +$  -> optional option_groups + option_choices (positive deltas),
 *                   resolved against the matching modifier block.
 *   - referential integrity is enforced (strict) BEFORE planning; import fails
 *     loudly if any reference is unresolved.
 */

import type { CanonicalRow } from "./types.ts";
import { collectBlockLabels, extractPromptOptions, extractUpsellAddons } from "./validate.ts";

// ---- Desired-state shapes --------------------------------------------------

export interface DesiredChoice {
  importKey: string; // groupKey | choiceName(lower)
  name: string;
  priceCents: number;
  displayOrder: number;
}

export interface DesiredGroup {
  importKey: string; // itemKey | groupName(lower)
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  displayOrder: number;
  choices: DesiredChoice[];
}

export interface DesiredItem {
  importKey: string; // category|name|size (lower)
  name: string; // includes size label when present
  description: string;
  priceCents: number | null; // null = blank price (flagged); import leaves price as 0 + flag note
  category: string;
  sizeLabel: string;
  displayOrder: number;
  groups: DesiredGroup[];
}

export interface ImportPlan {
  menuName: string;
  items: DesiredItem[];
  /** Stable content hash of the desired state (for idempotent no-op skip). */
  importHash: string;
}

// ---- Helpers ---------------------------------------------------------------

const lc = (s: string) => s.trim().toLowerCase();

function dollarsToCents(price: string): number | null {
  const p = price.trim();
  if (p === "") return null;
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Build a normalized index of modifier-block options -> price delta cents. */
interface BlockOption {
  name: string;
  cents: number; // 0 for free, positive for paid; null deltas treated as 0 here (flagged upstream)
}
function buildBlockIndex(
  rows: CanonicalRow[],
  blockLabels: Set<string>,
): { byNorm: Map<string, BlockOption>; blocks: Map<string, BlockOption[]> } {
  const byNorm = new Map<string, BlockOption>();
  const blocks = new Map<string, BlockOption[]>();
  for (const r of rows) {
    if (!blockLabels.has(lc(r.category))) continue;
    const cents = dollarsToCents(r.price) ?? 0;
    const opt: BlockOption = { name: r.name.trim(), cents };
    const norm = normName(r.name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, opt);
    const bareNorm = normName(r.name.replace(/\((?:whole|half)[^)]*\)/i, ""));
    if (bareNorm && !byNorm.has(bareNorm)) byNorm.set(bareNorm, opt);
    const blk = r.category.trim();
    if (!blocks.has(blk)) blocks.set(blk, []);
    blocks.get(blk)!.push(opt);
  }
  return { byNorm, blocks };
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\+\$\s*\d+(?:\.\d+)?/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveOption(candidate: string, byNorm: Map<string, BlockOption>): BlockOption | null {
  if (byNorm.has(candidate)) return byNorm.get(candidate)!;
  for (const [k, v] of byNorm) {
    if (k.includes(candidate) || candidate.includes(k)) return v;
  }
  return null;
}

/** Cheap deterministic content hash (FNV-1a, hex) of the desired state. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

// ---- Plan builder ----------------------------------------------------------

/**
 * Build the desired-state import plan from confirmed canonical rows.
 * Throws loudly on unresolved references (referential-integrity gate).
 */
export function buildImportPlan(rows: CanonicalRow[], menuName: string): ImportPlan {
  const blockLabels = collectBlockLabels(rows);
  const { byNorm } = buildBlockIndex(rows, blockLabels);

  const itemRows = rows.filter((r) => !blockLabels.has(lc(r.category)));
  const items: DesiredItem[] = [];
  const refErrors: string[] = [];

  itemRows.forEach((r, idx) => {
    const sizeLabel = r.size.trim();
    const fullName = sizeLabel ? `${r.name.trim()} - ${sizeLabel}` : r.name.trim();
    const itemKey = [lc(r.category), lc(r.name), lc(r.size)].join("|");
    const groups: DesiredGroup[] = [];

    // prompt_for -> required groups
    if (r.prompt_for.trim()) {
      r.prompt_for.split(";").map((s) => s.trim()).filter(Boolean).forEach((phrase, gi) => {
        const groupName = promptGroupName(phrase);
        const candidates = extractPromptOptions(phrase);
        const choices: DesiredChoice[] = [];
        candidates.forEach((c, ci) => {
          const resolved = resolveOption(c, byNorm);
          if (!resolved) {
            refErrors.push(`item "${fullName}": prompt_for option "${c}" (from "${phrase}") unresolved`);
            return;
          }
          choices.push({
            importKey: `${itemKey}|${lc(groupName)}|${lc(resolved.name)}`,
            name: resolved.name,
            priceCents: resolved.cents, // free required choices are 0 in the block
            displayOrder: ci,
          });
        });
        if (choices.length) {
          groups.push({
            importKey: `${itemKey}|${lc(groupName)}`,
            name: groupName,
            required: true,
            minSelect: 1,
            maxSelect: /flavor\(s\)|toppings|multiple/i.test(phrase) ? 99 : 1,
            displayOrder: gi,
            choices,
          });
        }
      });
    }

    // upsell +$ add-ons -> optional groups
    if (r.upsell.trim()) {
      const addons = extractUpsellAddons(r.upsell);
      if (addons.length) {
        const choices: DesiredChoice[] = [];
        addons.forEach((a, ci) => {
          const resolved = resolveOption(a, byNorm);
          if (!resolved) {
            refErrors.push(`item "${fullName}": upsell add-on "${a}" unresolved`);
            return;
          }
          choices.push({
            importKey: `${itemKey}|add-ons|${lc(resolved.name)}`,
            name: resolved.name,
            priceCents: resolved.cents,
            displayOrder: ci,
          });
        });
        if (choices.length) {
          groups.push({
            importKey: `${itemKey}|add-ons`,
            name: "Add-ons",
            required: false,
            minSelect: 0,
            maxSelect: 99,
            displayOrder: groups.length,
            choices,
          });
        }
      }
    }

    items.push({
      importKey: itemKey,
      name: fullName,
      description: r.description.trim(),
      priceCents: dollarsToCents(r.price),
      category: r.category.trim(),
      sizeLabel,
      displayOrder: idx,
      groups,
    });
  });

  if (refErrors.length) {
    throw new Error(
      `Stage B import FAILED referential integrity (${refErrors.length}):\n` +
        refErrors.map((e) => "  - " + e).join("\n"),
    );
  }

  const canonicalForHash = JSON.stringify(items);
  return { menuName, items, importHash: hashString(canonicalForHash) };
}

/** Derive a human group name from a prompt_for phrase ("which pasta (...)" -> "Pasta"). */
function promptGroupName(phrase: string): string {
  const m = phrase.match(/which\s+([a-z ]+?)(?:\s*\(|$)/i);
  if (m) {
    const noun = m[1].trim();
    return noun.charAt(0).toUpperCase() + noun.slice(1);
  }
  // "bleu cheese or ranch" -> "Choice"
  const head = phrase.split("(")[0].trim();
  if (head.length > 0 && head.length <= 30) {
    return head.charAt(0).toUpperCase() + head.slice(1);
  }
  return "Choice";
}

// ---- Diff against existing DB state ----------------------------------------

export interface ExistingItem {
  id: string;
  importKey: string | null;
  ownerEdited: boolean;
}

export interface ItemDiff {
  toInsert: DesiredItem[];
  /** existing id -> desired item (update, unless owner-edited). */
  toUpdate: Array<{ id: string; desired: DesiredItem; skippedOwnerEdited: boolean }>;
  /** existing ids no longer present in the desired set -> deactivate (never hard-delete). */
  toDeactivate: string[];
}

/** Diff desired items against existing DB items by import_key. */
export function diffItems(desired: DesiredItem[], existing: ExistingItem[]): ItemDiff {
  const byKey = new Map<string, ExistingItem>();
  for (const e of existing) if (e.importKey) byKey.set(e.importKey, e);

  const toInsert: DesiredItem[] = [];
  const toUpdate: ItemDiff["toUpdate"] = [];
  const desiredKeys = new Set<string>();

  for (const d of desired) {
    desiredKeys.add(d.importKey);
    const ex = byKey.get(d.importKey);
    if (!ex) {
      toInsert.push(d);
    } else {
      toUpdate.push({ id: ex.id, desired: d, skippedOwnerEdited: ex.ownerEdited });
    }
  }

  const toDeactivate: string[] = [];
  for (const e of existing) {
    if (e.importKey && !desiredKeys.has(e.importKey)) toDeactivate.push(e.id);
  }

  return { toInsert, toUpdate, toDeactivate };
}
