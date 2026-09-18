// Phase 1 (docs/specs/2026-09-07-conversation-ready-menu-design.md, §2.3
// lines 198-210, §11 Phase 1 "extractor emits shared lists with spans").
// Pure, zero-I/O, same testable-without-a-DB pattern as normalize.ts /
// archetypes.ts.
//
// Finds option lists that are genuinely shared across more than one item in
// the SAME import — the "Toppings appears on 20 pizzas" case — so a caller
// can write ONE modifier_sets row instead of 20 duplicate per-item lists.
//
// §4.3 "never invent" rule, applied here: a list only becomes a candidate
// set when at least two items state the EXACT SAME group name, the same
// required/optional kind, and the exact same choice names + prices (order
// ignored). One differing choice, one differing price, one differing group
// name — any of those puts the two groups in different buckets and NEITHER
// becomes a set on that item; the caller leaves both items on their existing
// per-item option_groups/option_choices rows, unset (no set_id), rather than
// guess. This is deliberately a stricter bar than fuzzy text similarity.
//
// This module only ever reads DesiredItem[] (the whole-menu desired state
// menu-pipeline/core/import-plan.ts already builds) and returns plain data.
// It does not touch option_groups/option_choices, and it does not create
// new per-item groups/choices — see sync-modifier-sets.ts for why linking is
// restricted to rows that already exist.

import type { DesiredChoice, DesiredItem } from "../../../menu-pipeline/core/import-plan.ts";

export interface ModifierSetCandidateChoice {
  importKey: string;
  name: string;
  priceCents: number;
  displayOrder: number;
}

export interface ModifierSetCandidateMember {
  itemImportKey: string;
  groupImportKey: string;
}

export interface ModifierSetCandidate {
  /** Stable content key (name + kind + choice signature) — used as
   *  modifier_sets.import_key so re-running detection on an unchanged menu
   *  resolves to the same set instead of creating a duplicate. */
  key: string;
  /** modifier_sets.name — see dedupeCandidateNames below for how a
   *  same-named-but-different-content collision is disambiguated to satisfy
   *  the table's UNIQUE (menu_id, name) constraint. */
  name: string;
  kind: "slot" | "modifier";
  sourceSpan: string;
  choices: ModifierSetCandidateChoice[];
  /** Every item+group this set was found on. Always length >= MIN_SHARED_ITEMS. */
  members: ModifierSetCandidateMember[];
}

// A list shared by exactly one item isn't a "shared list" — it's just that
// item's own group. Two is the smallest number that makes "the same list
// appears on multiple items" a true statement.
const MIN_SHARED_ITEMS = 2;

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Order-independent so "Pepperoni, Mushroom" and "Mushroom, Pepperoni" (same
// list, different CSV row order) still match — the choice SET is what needs
// to be identical, not its order. Order is preserved separately per-choice
// via displayOrder for when the set is later rendered.
function choiceSignature(choices: DesiredChoice[]): string {
  return choices
    .map((c) => `${normName(c.name)}:${c.priceCents}`)
    .sort()
    .join("|");
}

export function detectSharedModifierSets(items: DesiredItem[]): ModifierSetCandidate[] {
  const buckets = new Map<
    string,
    { group: DesiredItem["groups"][number]; itemImportKey: string }[]
  >();

  for (const item of items) {
    for (const group of item.groups) {
      // A group with 0-1 choices isn't a list to share — same guard
      // normalize.ts uses for its own slot detection (choices.length < 2).
      if (group.choices.length < 2) continue;
      const sig = `${normName(group.name)}|${group.required ? "slot" : "modifier"}|${choiceSignature(group.choices)}`;
      const bucket = buckets.get(sig);
      if (bucket) bucket.push({ group, itemImportKey: item.importKey });
      else buckets.set(sig, [{ group, itemImportKey: item.importKey }]);
    }
  }

  const candidates: ModifierSetCandidate[] = [];
  for (const [sig, entries] of buckets) {
    const distinctItems = new Set(entries.map((e) => e.itemImportKey));
    if (distinctItems.size < MIN_SHARED_ITEMS) continue;

    const first = entries[0].group;
    candidates.push({
      key: sig,
      name: first.name,
      kind: first.required ? "slot" : "modifier",
      sourceSpan: first.choices.map((c) => c.name).join(", "),
      choices: first.choices.map((c) => ({
        importKey: c.importKey,
        name: c.name,
        priceCents: c.priceCents,
        displayOrder: c.displayOrder,
      })),
      members: entries.map((e) => ({ itemImportKey: e.itemImportKey, groupImportKey: e.group.importKey })),
    });
  }

  return dedupeCandidateNames(candidates);
}

// modifier_sets has UNIQUE (menu_id, name) — but two DIFFERENT shared lists
// can legitimately share a group name within one menu (e.g. pizzas' "Add-ons"
// upsell list and wraps' unrelated "Add-ons" upsell list, same label,
// different toppings). Those are two distinct buckets above (different
// choiceSignature) and so two distinct candidates; give the second and later
// ones a disambiguated name so the insert doesn't collide. Deterministic
// given the same input order, so a re-import doesn't rename a set that
// didn't change.
function dedupeCandidateNames(candidates: ModifierSetCandidate[]): ModifierSetCandidate[] {
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    const norm = normName(c.name);
    const count = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, count);
    return count === 1 ? c : { ...c, name: `${c.name} #${count}` };
  });
}
