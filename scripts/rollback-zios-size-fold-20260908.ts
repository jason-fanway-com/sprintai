/**
 * Emergency rollback for the Zio's size-fold apply (scripts/fold-zios-sizes.ts),
 * 2026-09-08. Triggered by the standing rollback rule: the post-apply
 * compile-menu recompile surfaced 51 newly-blocked items (Hot Subs / Cold
 * Subs bread question) that were orderable before this session's apply.
 * Root cause not yet confirmed to be the fold itself vs. a pre-existing,
 * never-before-exercised compile-menu classification -- reverting the
 * structural change first to test in isolation and restore safety.
 *
 * Reverses fold-zios-sizes.ts's --apply exactly:
 *   1. Re-inserts the 78 option_groups + 159 option_choices from the
 *      rollback export (original ids preserved).
 *   2. For the 61 "explode" groups (>=2 choices): reactivates the
 *      original menu_items row (active=true) and deletes the new
 *      per-size rows this session inserted (identified by name =
 *      "<original name> - <size_label>", same menu_id, active=true).
 *   3. For the 17 "singleton" groups (1 choice): clears size_label back
 *      to null on the original row (no new rows to delete for these).
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *        deno run --allow-env --allow-net scripts/rollback-zios-size-fold-20260908.ts <rollback-json-path> [--apply]
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  Deno.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const jsonPath = Deno.args.find(a => !a.startsWith("--"));
const APPLY = Deno.args.includes("--apply");
if (!jsonPath) { console.error("Usage: rollback-zios-size-fold-20260908.ts <path> [--apply]"); Deno.exit(1); }

const rollback = JSON.parse(await Deno.readTextFile(jsonPath));
const { menu_id: menuId, option_groups: groups, option_choices: choices } = rollback;

const choicesByGroup = new Map<string, any[]>();
for (const c of choices) {
  const list = choicesByGroup.get(c.option_group_id) ?? [];
  list.push(c);
  choicesByGroup.set(c.option_group_id, list);
}

const explodeGroups = groups.filter((g: any) => (choicesByGroup.get(g.id)?.length ?? 0) >= 2);
const singletonGroups = groups.filter((g: any) => (choicesByGroup.get(g.id)?.length ?? 0) === 1);

console.log(`mode=${APPLY ? "APPLY" : "dry-run"} groups=${groups.length} choices=${choices.length} explode=${explodeGroups.length} singleton=${singletonGroups.length}`);

const explodeItemIds = explodeGroups.map((g: any) => g.menu_item_id);
const singletonItemIds = singletonGroups.map((g: any) => g.menu_item_id);

const { data: originalItems } = await supabase.from("menu_items").select("id,name,menu_id,active").in("id", [...explodeItemIds, ...singletonItemIds]);
const origById = new Map((originalItems ?? []).map((i: any) => [i.id, i]));

// Find the new per-size rows to delete: name = "<original name> - <size_label>"
const toDelete: string[] = [];
for (const g of explodeGroups) {
  const orig = origById.get(g.menu_item_id);
  if (!orig) { console.error(`  MISSING original item for group ${g.id} (menu_item_id ${g.menu_item_id})`); continue; }
  const wantedNames = (choicesByGroup.get(g.id) ?? []).map((c: any) => `${orig.name} - ${c.display_name ?? c.name}`);
  const { data: matches } = await supabase.from("menu_items").select("id,name").eq("menu_id", menuId).eq("active", true).in("name", wantedNames);
  for (const m of matches ?? []) toDelete.push(m.id);
  if ((matches ?? []).length !== wantedNames.length) {
    console.error(`  WARNING: expected ${wantedNames.length} new rows for "${orig.name}", found ${(matches ?? []).length}`, wantedNames, matches);
  }
}

console.log(`\nPlan: reactivate ${explodeItemIds.length} originals, clear size_label on ${singletonItemIds.length} singletons, delete ${toDelete.length} new rows, restore ${groups.length} groups + ${choices.length} choices.`);

if (!APPLY) {
  console.log("\nDry run only -- no writes made. Re-run with --apply to execute.");
  Deno.exit(0);
}

let failures = 0;

if (toDelete.length) {
  const { error } = await supabase.from("menu_items").delete().in("id", toDelete);
  if (error) { console.error("FAILED deleting new rows:", error); failures++; }
  else console.log(`Deleted ${toDelete.length} new rows.`);
}

if (explodeItemIds.length) {
  const { error } = await supabase.from("menu_items").update({ active: true }).in("id", explodeItemIds);
  if (error) { console.error("FAILED reactivating originals:", error); failures++; }
  else console.log(`Reactivated ${explodeItemIds.length} original rows.`);
}

if (singletonItemIds.length) {
  const { error } = await supabase.from("menu_items").update({ size_label: null }).in("id", singletonItemIds);
  if (error) { console.error("FAILED clearing singleton size_label:", error); failures++; }
  else console.log(`Cleared size_label on ${singletonItemIds.length} singleton rows.`);
}

const { error: groupsInsErr } = await supabase.from("option_groups").insert(groups);
if (groupsInsErr) { console.error("FAILED restoring option_groups:", groupsInsErr); failures++; }
else console.log(`Restored ${groups.length} option_groups.`);

const { error: choicesInsErr } = await supabase.from("option_choices").insert(choices);
if (choicesInsErr) { console.error("FAILED restoring option_choices:", choicesInsErr); failures++; }
else console.log(`Restored ${choices.length} option_choices.`);

console.log(`\nRollback complete. failures=${failures}`);
