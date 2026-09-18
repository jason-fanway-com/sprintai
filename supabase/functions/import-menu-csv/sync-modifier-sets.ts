/**
 * Writes the modifier_sets/modifier_set_choices rows detectSharedModifierSets
 * (../_shared/modifier-set-detect.ts) found, then points each member item's
 * ALREADY-EXISTING option_groups.set_id / option_choices.set_choice_id at
 * them.
 *
 * Deliberately never creates a new option_groups/option_choices row: those
 * are chat-sms's live order-taking surface (buildEffectiveMenu reads them
 * directly, with no provenance gate — see compile-menu/index.ts's file
 * header for the same invariant on the compiler side), and syncGroups
 * (./apply.ts) already ran earlier in this same import to create/update
 * them normally. This function only adds a foreign key nothing reads yet
 * on top of rows that were going to exist regardless of whether a shared
 * set was ever detected — so a fresh import behaves identically to today
 * from chat-sms's point of view, with or without this file.
 */

import type { ModifierSetCandidate } from "../_shared/modifier-set-detect.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export interface SyncModifierSetsResult {
  setsCreated: number;
  setsUpdated: number;
  groupsLinked: number;
  choicesLinked: number;
}

export async function syncModifierSets(
  supabase: SupabaseLike,
  shopId: string,
  menuId: string,
  candidates: ModifierSetCandidate[],
  itemIdByImportKey: Map<string, string>,
): Promise<SyncModifierSetsResult> {
  const result: SyncModifierSetsResult = { setsCreated: 0, setsUpdated: 0, groupsLinked: 0, choicesLinked: 0 };
  if (candidates.length === 0) return result;

  const { data: exSetsRaw } = await supabase
    .from("modifier_sets").select("id, import_key, name").eq("menu_id", menuId);
  type ExSet = { id: string; import_key: string | null; name: string };
  const exSetByKey = new Map<string, ExSet>();
  for (const s of (exSetsRaw ?? []) as ExSet[]) if (s.import_key) exSetByKey.set(s.import_key, s);

  // Scope the option_groups/option_choices fetch to just the items these
  // candidates actually touch (same batching idiom as compile-menu's
  // fetchAllRowsBatchedIn, minus the pagination — an import's candidate set
  // is bounded by that one menu's item count, not 1000+ rows).
  const touchedItemIds = new Set<string>();
  for (const c of candidates) {
    for (const m of c.members) {
      const id = itemIdByImportKey.get(m.itemImportKey);
      if (id) touchedItemIds.add(id);
    }
  }
  const itemIds = [...touchedItemIds];
  const { data: groupRowsRaw } = itemIds.length
    ? await supabase.from("option_groups").select("id, menu_item_id, import_key").in("menu_item_id", itemIds)
    : { data: [] };
  type GroupRow = { id: string; menu_item_id: string; import_key: string | null };
  const groupIdByItemAndKey = new Map<string, string>();
  for (const g of (groupRowsRaw ?? []) as GroupRow[]) {
    if (g.import_key) groupIdByItemAndKey.set(`${g.menu_item_id}|${g.import_key}`, g.id);
  }

  const groupIds = [...groupIdByItemAndKey.values()];
  const { data: choiceRowsRaw } = groupIds.length
    ? await supabase.from("option_choices").select("id, option_group_id, import_key").in("option_group_id", groupIds)
    : { data: [] };
  type ChoiceRow = { id: string; option_group_id: string; import_key: string | null };
  const choiceIdByGroupAndKey = new Map<string, string>();
  for (const c of (choiceRowsRaw ?? []) as ChoiceRow[]) {
    if (c.import_key) choiceIdByGroupAndKey.set(`${c.option_group_id}|${c.import_key}`, c.id);
  }

  for (const candidate of candidates) {
    let setId: string;
    const existingSet = exSetByKey.get(candidate.key);
    if (existingSet) {
      setId = existingSet.id;
      if (existingSet.name !== candidate.name) {
        await supabase.from("modifier_sets")
          .update({ name: candidate.name, source_span: candidate.sourceSpan })
          .eq("id", setId);
      }
      result.setsUpdated++;
    } else {
      const { data, error } = await supabase.from("modifier_sets").insert({
        shop_id: shopId, menu_id: menuId, name: candidate.name, kind: candidate.kind,
        import_key: candidate.key, provenance: "stated", source_span: candidate.sourceSpan,
      }).select("id").single();
      if (error || !data) {
        console.error("[import-menu-csv] modifier_sets insert failed:", error?.message);
        continue;
      }
      setId = data.id as string;
      result.setsCreated++;
    }

    const { data: exChoicesRaw } = await supabase
      .from("modifier_set_choices").select("id, import_key").eq("set_id", setId);
    type ExChoice = { id: string; import_key: string | null };
    const exChoiceByKey = new Map<string, ExChoice>();
    for (const c of (exChoicesRaw ?? []) as ExChoice[]) if (c.import_key) exChoiceByKey.set(c.import_key, c);

    const setChoiceIdByImportKey = new Map<string, string>();
    for (const choice of candidate.choices) {
      const existingChoice = exChoiceByKey.get(choice.importKey);
      if (existingChoice) {
        setChoiceIdByImportKey.set(choice.importKey, existingChoice.id);
        await supabase.from("modifier_set_choices").update({
          name: choice.name, display_name: choice.name,
          price_cents: choice.priceCents, display_order: choice.displayOrder,
        }).eq("id", existingChoice.id);
      } else {
        const { data, error } = await supabase.from("modifier_set_choices").insert({
          set_id: setId, name: choice.name, display_name: choice.name,
          price_cents: choice.priceCents, display_order: choice.displayOrder,
          import_key: choice.importKey, provenance: "stated",
        }).select("id").single();
        if (error || !data) {
          console.error("[import-menu-csv] modifier_set_choices insert failed:", error?.message);
          continue;
        }
        setChoiceIdByImportKey.set(choice.importKey, data.id as string);
      }
    }

    for (const member of candidate.members) {
      const itemId = itemIdByImportKey.get(member.itemImportKey);
      if (!itemId) continue;
      const groupId = groupIdByItemAndKey.get(`${itemId}|${member.groupImportKey}`);
      if (!groupId) continue; // no existing per-item row to link — never create one here
      await supabase.from("option_groups").update({ set_id: setId }).eq("id", groupId);
      result.groupsLinked++;
      for (const choice of candidate.choices) {
        const choiceId = choiceIdByGroupAndKey.get(`${groupId}|${choice.importKey}`);
        const setChoiceId = setChoiceIdByImportKey.get(choice.importKey);
        if (!choiceId || !setChoiceId) continue;
        await supabase.from("option_choices").update({ set_choice_id: setChoiceId }).eq("id", choiceId);
        result.choicesLinked++;
      }
    }
  }

  return result;
}
