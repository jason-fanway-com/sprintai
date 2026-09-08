// Zio's size-fold (2026-09-08, PO-approved plan ec35040, item A). Pure
// decision function, no I/O — same split as compile-menu.ts's
// planOwnerQuestionsRefresh: this computes WHAT to write, the caller
// (scripts/fold-zios-sizes.ts for the one-time backfill,
// scripts/load-zios-slice-options.mjs for future re-scrapes) does the I/O.
//
// PROBLEM: Zio's 220 active items each carry a required singleton "Size"
// option_group instead of Vito's shape (one menu_items ROW per size,
// "Base - SizeLabel" naming, size_label populated). normalize.ts's fold
// logic (stripSizeSuffix, product_key) only ever sees the SECOND shape --
// with every pizza a single row and size_label null, there is nothing for
// it to fold, so "large" has no clean match at order time. This function
// converts the first shape into the second, item by item.
//
// RULE (matches compile-menu.ts's own singleton principle, reused by
// archetypes.ts's guard 5.5b): a required group with exactly ONE choice is
// a fact already fully stated by the group existing at all, not a real
// choice among alternatives -- ec35040's own worked example, "Mike's Hot
// Honey Pepperoni Sicilian: Large 18" only". Explosion only makes sense
// when there is more than one real size to become its own row.
//
// BLAST RADIUS NOTE (see ec35040's own "BLAST RADIUS" section in
// BLOCKED.txt): this function returns a PLAN, not a write. The caller is
// responsible for (1) never deleting the original menu_items row --
// deactivate only, order_carts.cart_json embeds menu_item_id directly with
// no FK, so historical carts still need the row to exist for display; (2)
// ending with a recompile -- ask_plan/lexicon/product_key are compile-
// menu's write-back columns exclusively and this function never touches
// them.

export interface SizeFoldSourceItem {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  price_cents: number;
}

export interface SizeFoldChoice {
  id: string;
  name: string;
  display_name: string | null;
  // Delta relative to the item's own price_cents, same convention as every
  // other upcharge in this schema (see load-zios-slice-options.mjs's own
  // buildGroupRows comment) -- NOT an absolute price.
  price_cents: number | null;
}

export interface SizeFoldSingletonUpdate {
  kind: "singleton_update";
  item_id: string;
  size_label: string;
}

export interface SizeFoldExplodeInsert {
  kind: "explode_insert";
  base_item_id: string;
  name: string;
  size_label: string;
  price_cents: number;
  category: string | null;
  description: string | null;
}

export type SizeFoldAction = SizeFoldSingletonUpdate | SizeFoldExplodeInsert;

export interface SizeFoldPlan {
  item_id: string;
  item_name: string;
  choice_count: number;
  actions: SizeFoldAction[];
  // True iff choice_count > 1 -- the original row must be deactivated
  // (never deleted) once its explode_insert rows exist. False for the
  // singleton case: the original row IS the (now size-labeled) row, kept
  // active, nothing to retire.
  retiresOriginal: boolean;
}

function choiceLabel(choice: SizeFoldChoice): string {
  return (choice.display_name ?? choice.name).trim();
}

// Zero-choice groups (should not exist for a required group in practice,
// but defensively handled rather than assumed away) produce no plan at
// all -- nothing to fold, nothing to retire. Caller should treat this as a
// data anomaly worth a look, not silently skip it.
export function planSizeFold(item: SizeFoldSourceItem, choices: SizeFoldChoice[]): SizeFoldPlan {
  if (choices.length === 0) {
    return { item_id: item.id, item_name: item.name, choice_count: 0, actions: [], retiresOriginal: false };
  }

  if (choices.length === 1) {
    return {
      item_id: item.id,
      item_name: item.name,
      choice_count: 1,
      actions: [{ kind: "singleton_update", item_id: item.id, size_label: choiceLabel(choices[0]) }],
      retiresOriginal: false,
    };
  }

  const actions: SizeFoldExplodeInsert[] = choices.map(c => {
    const sizeLabel = choiceLabel(c);
    return {
      kind: "explode_insert",
      base_item_id: item.id,
      name: `${item.name} - ${sizeLabel}`,
      size_label: sizeLabel,
      price_cents: item.price_cents + (c.price_cents ?? 0),
      category: item.category,
      description: item.description,
    };
  });

  return {
    item_id: item.id,
    item_name: item.name,
    choice_count: choices.length,
    actions,
    retiresOriginal: true,
  };
}
