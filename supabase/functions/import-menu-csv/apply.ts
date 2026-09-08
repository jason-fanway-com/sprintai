/**
 * import-menu-csv DB-application helpers — split out of index.ts so the
 * item-update loop (upsert/reactivate/skip decisions) is testable against a
 * mock Supabase client without a live database or Deno.serve.
 */

import type { DesiredItem } from "../../../menu-pipeline/core/import-plan.ts";
import type { ItemDiff } from "../../../menu-pipeline/core/import-plan.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export async function upsertItem(
  supabase: SupabaseLike, menuId: string, d: DesiredItem, existingId: string | null,
): Promise<string | null> {
  const row = {
    menu_id: menuId,
    name: d.name,
    description: d.description || null,
    price_cents: d.priceCents ?? 0,
    category: d.category || "Uncategorized",
    size_label: d.sizeLabel || null,
    import_key: d.importKey,
    display_order: d.displayOrder,
    prompt_for: d.promptFor || null,
    upsell: d.upsell || null,
    modifiers_json: d.modifiersJson ?? null,
    active: true,
    is_available: true,
  };
  if (existingId) {
    await supabase.from("menu_items").update(row).eq("id", existingId);
    return existingId;
  }
  const { data, error } = await supabase.from("menu_items").insert(row).select("id").single();
  if (error) { console.error("[import-menu-csv] item insert failed:", error.message); return null; }
  return data.id as string;
}

/**
 * Sync option groups + choices for an item by import_key (diff-based).
 * Replaces machine-owned choices/groups that came from import. A group or
 * choice with owner_edited=true is never overwritten or deleted as stale —
 * an owner's hand-added wing flavor or hand-corrected price must survive
 * the next re-import. Owner-added groups/choices (import_key IS NULL, e.g.
 * from the shop editor) are invisible to this diff entirely and so are
 * never touched here regardless of owner_edited.
 */
export async function syncGroups(
  supabase: SupabaseLike, itemId: string, d: DesiredItem,
): Promise<{ skippedGroups: number; skippedChoices: number }> {
  let skippedGroups = 0, skippedChoices = 0;
  const desiredGroupKeys = new Set(d.groups.map((g) => g.importKey));

  // Existing groups for this item.
  const { data: exGroups } = await supabase
    .from("option_groups").select("id, import_key, owner_edited").eq("menu_item_id", itemId);
  type ExGroup = { id: string; import_key: string | null; owner_edited: boolean };

  // Deactivate-by-delete groups no longer desired (machine-owned, safe to remove) —
  // unless the owner has hand-edited that group.
  const staleGroups = (exGroups ?? []).filter(
    (g: ExGroup) => g.import_key && !desiredGroupKeys.has(g.import_key),
  );
  skippedGroups += staleGroups.filter((g: ExGroup) => g.owner_edited).length;
  const staleGroupIds = staleGroups.filter((g: ExGroup) => !g.owner_edited).map((g: ExGroup) => g.id);
  if (staleGroupIds.length) {
    await supabase.from("option_choices").delete().in("option_group_id", staleGroupIds);
    await supabase.from("option_groups").delete().in("id", staleGroupIds);
  }

  const exByKey = new Map<string, ExGroup>();
  for (const g of (exGroups ?? []) as ExGroup[]) if (g.import_key) exByKey.set(g.import_key, g);

  for (const g of d.groups) {
    const existing = exByKey.get(g.importKey);
    let groupId = existing?.id;
    if (existing?.owner_edited) {
      skippedGroups++;
    } else {
      const groupRow = {
        menu_item_id: itemId, name: g.name, required: g.required,
        min_select: g.minSelect, max_select: g.maxSelect,
        display_order: g.displayOrder, import_key: g.importKey,
      };
      if (groupId) {
        await supabase.from("option_groups").update(groupRow).eq("id", groupId);
      } else {
        const { data, error } = await supabase.from("option_groups").insert(groupRow).select("id").single();
        if (error || !data) { console.error("[import-menu-csv] group insert failed:", error?.message); continue; }
        groupId = data.id as string;
      }
    }
    if (!groupId) continue;

    // Sync choices for this group (independent of whether the group row itself
    // was owner-edited — an owner may have only touched one choice's price).
    const desiredChoiceKeys = new Set(g.choices.map((c) => c.importKey));
    const { data: exChoices } = await supabase
      .from("option_choices").select("id, import_key, owner_edited").eq("option_group_id", groupId);
    type ExChoice = { id: string; import_key: string | null; owner_edited: boolean };
    const staleChoices = (exChoices ?? []).filter(
      (c: ExChoice) => c.import_key && !desiredChoiceKeys.has(c.import_key),
    );
    skippedChoices += staleChoices.filter((c: ExChoice) => c.owner_edited).length;
    const staleChoiceIds = staleChoices.filter((c: ExChoice) => !c.owner_edited).map((c: ExChoice) => c.id);
    if (staleChoiceIds.length) await supabase.from("option_choices").delete().in("id", staleChoiceIds);

    const exChoiceByKey = new Map<string, ExChoice>();
    for (const c of (exChoices ?? []) as ExChoice[]) if (c.import_key) exChoiceByKey.set(c.import_key, c);

    for (const c of g.choices) {
      const existingChoice = exChoiceByKey.get(c.importKey);
      if (existingChoice?.owner_edited) { skippedChoices++; continue; }
      const choiceRow = {
        option_group_id: groupId, name: c.name, price_cents: c.priceCents,
        display_order: c.displayOrder, import_key: c.importKey,
      };
      if (existingChoice) await supabase.from("option_choices").update(choiceRow).eq("id", existingChoice.id);
      else await supabase.from("option_choices").insert(choiceRow);
    }
  }

  return { skippedGroups, skippedChoices };
}

export interface ApplyUpdatesResult {
  updated: number;
  skippedOwnerEdited: number;
  skippedOwnerEditedGroups: number;
  skippedOwnerEditedChoices: number;
}

/**
 * Apply diff.toUpdate: content (name/price/description/category/groups) is
 * only written for non-owner-edited items, but every item present in the
 * current import — owner-edited or not — is reactivated. owner_edited
 * protects hand-typed content from being clobbered by the CSV; it is not a
 * signal that the item should stay invisible to customers.
 */
export async function applyToUpdate(
  supabase: SupabaseLike, menuId: string, toUpdate: ItemDiff["toUpdate"],
): Promise<ApplyUpdatesResult> {
  let updated = 0, skippedOwnerEdited = 0, skippedOwnerEditedGroups = 0, skippedOwnerEditedChoices = 0;

  for (const u of toUpdate) {
    if (u.skippedOwnerEdited) {
      skippedOwnerEdited++;
    } else {
      await upsertItem(supabase, menuId, u.desired, u.id);
      const r = await syncGroups(supabase, u.id, u.desired);
      skippedOwnerEditedGroups += r.skippedGroups;
      skippedOwnerEditedChoices += r.skippedChoices;
      updated++;
    }
    // Reactivate unconditionally: the item is present in this import, so the
    // owner still wants it on the menu, regardless of content-protection status.
    await supabase.from("menu_items").update({ active: true }).eq("id", u.id);
  }

  return { updated, skippedOwnerEdited, skippedOwnerEditedGroups, skippedOwnerEditedChoices };
}
