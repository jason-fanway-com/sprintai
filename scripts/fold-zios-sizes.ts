/**
 * Zio's size-fold backfill (2026-09-08, PO-approved plan ec35040, item A).
 *
 * Explodes each of Zio's 78 required singleton "Size"-named option_groups
 * into folded item rows (one menu_items row per size, "Base - SizeLabel"
 * naming, size_label populated) -- the same shape Vito's own 88 size-rows
 * already have. Pure decision logic lives in
 * supabase/functions/_shared/size-fold.ts (planSizeFold); this script is
 * the I/O shell around it, same split as refresh-owner-questions.ts /
 * njb-infer-only-20260907.ts.
 *
 * WHAT THIS SCRIPT DOES, IN ORDER (--apply only):
 *   1. For each of the 78 items, compute planSizeFold(item, choices).
 *   2. Multi-choice (2-3 choices, ~61 of 78): INSERT one new menu_items row
 *      per choice (active=true, size_label set, price_cents = base +
 *      delta), then set the ORIGINAL row active=false. NEVER deletes the
 *      original -- order_carts.cart_json embeds menu_item_id directly with
 *      no FK; a hard delete would break historical cart display (see
 *      ec35040's own "BLAST RADIUS" note in BLOCKED.txt).
 *   3. Single-choice true singletons (17 of 78, e.g. "Mike's Hot Honey
 *      Pepperoni Sicilian: Large 18\" only"): sets size_label directly on
 *      the existing row, no new row, original stays active.
 *   4. Exports every one of the 78 Size option_groups + their option_choices
 *      to a timestamped JSON file BEFORE deleting them (rollback data --
 *      same convention as this morning's /tmp/zios/zios-extract.json dry-
 *      run log), then deletes them. Safe: no order_carts row references
 *      option_group_id/option_choice_id (checked live, see ec35040).
 *
 * Does NOT touch ask_plan/bot_state/product_key/lexicon (compile-menu's
 * write-back columns exclusively) and does NOT invoke compile-menu itself
 * -- the fold does nothing for a live customer until a recompile follows
 * this script, which is a separate, explicit step per the dispatch.
 *
 * HARD GATE (Jason, explicit, via the PO dispatch): dry-run output must be
 * shown and reported back BEFORE ever running --apply. Dry-run is the
 * default; --apply is required to write anything.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net --allow-write scripts/fold-zios-sizes.ts [--apply]
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { planSizeFold, type SizeFoldSourceItem, type SizeFoldChoice, type SizeFoldPlan } from "../supabase/functions/_shared/size-fold.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";
const APPLY = Deno.args.includes("--apply");
const ROLLBACK_EXPORT_PATH = `/tmp/zios-size-fold-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

interface MenuItemRow {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  price_cents: number;
  active: boolean;
}
interface OptionGroupRow { id: string; menu_item_id: string; name: string; kind: string; required: boolean; min_select: number; max_select: number; provenance: string; source_span: string | null; import_key: string | null; display_order: number; }
interface OptionChoiceRow { id: string; option_group_id: string; name: string; display_name: string | null; price_cents: number; is_default: boolean; provenance: string; source_span: string | null; import_key: string | null; display_order: number; }

const { data: menus, error: menuErr } = await supabase
  .from("menus").select("id").eq("shop_id", ZIOS_SHOP_ID)
  .order("created_at", { ascending: false }).limit(1);
if (menuErr || !menus?.[0]) { console.error("no menu found for Zio's shop_id", menuErr); Deno.exit(1); }
const menuId = menus[0].id;

const { data: activeItems, error: itemsErr } = await supabase
  .from("menu_items").select("id,name,category,description,price_cents,active")
  .eq("menu_id", menuId).eq("active", true) as { data: MenuItemRow[] | null; error: unknown };
if (itemsErr) { console.error(itemsErr); Deno.exit(1); }
const itemById = new Map((activeItems ?? []).map(i => [i.id, i]));
const activeItemIds = [...itemById.keys()];

const { data: sizeGroups, error: groupsErr } = await supabase
  .from("option_groups")
  .select("id,menu_item_id,name,kind,required,min_select,max_select,provenance,source_span,import_key,display_order")
  .eq("kind", "slot").eq("required", true).ilike("name", "%size%")
  .in("menu_item_id", activeItemIds) as { data: OptionGroupRow[] | null; error: unknown };
if (groupsErr) { console.error(groupsErr); Deno.exit(1); }

const groupIds = (sizeGroups ?? []).map(g => g.id);
const { data: choiceRows, error: choicesErr } = await supabase
  .from("option_choices")
  .select("id,option_group_id,name,display_name,price_cents,is_default,provenance,source_span,import_key,display_order")
  .in("option_group_id", groupIds) as { data: OptionChoiceRow[] | null; error: unknown };
if (choicesErr) { console.error(choicesErr); Deno.exit(1); }

const choicesByGroup = new Map<string, OptionChoiceRow[]>();
for (const c of choiceRows ?? []) {
  const list = choicesByGroup.get(c.option_group_id) ?? [];
  list.push(c);
  choicesByGroup.set(c.option_group_id, list);
}

// F1 fix (2026-09-08 P0 follow-up): option_groups is FK'd to menu_item_id,
// so an explode_insert's brand-new row starts with ZERO option_groups --
// planSizeFold only ever decided what to do with the SIZE group, it never
// carried the item's OTHER groups (Toppings, "Make it", "Add Extra",
// dressing substitutions, etc) forward. Confirmed live: every one of the
// first 142 rows this script ever exploded ended up with no Toppings group
// at all, breaking "compose a bare topping onto the base pizza" (no group
// left to select the topping from) -- see
// scripts/repair-fold-missing-option-groups-20260908.ts for the one-time
// backfill of that damage. This fetch + the clone loop below (APPLY only)
// is the fix so this can't happen again on a future run of this script.
const { data: otherGroupsRaw, error: otherGroupsErr } = await supabase
  .from("option_groups")
  .select("id,menu_item_id,name,kind,required,min_select,max_select,provenance,source_span,import_key,display_order")
  .in("menu_item_id", (sizeGroups ?? []).map(g => g.menu_item_id))
  .not("id", "in", `(${groupIds.length ? groupIds.join(",") : "00000000-0000-0000-0000-000000000000"})`) as { data: OptionGroupRow[] | null; error: unknown };
if (otherGroupsErr) { console.error(otherGroupsErr); Deno.exit(1); }
const otherGroupsByItem = new Map<string, OptionGroupRow[]>();
for (const g of otherGroupsRaw ?? []) {
  const list = otherGroupsByItem.get(g.menu_item_id) ?? [];
  list.push(g);
  otherGroupsByItem.set(g.menu_item_id, list);
}
const otherGroupIds = (otherGroupsRaw ?? []).map(g => g.id);
const otherChoicesByGroup = new Map<string, OptionChoiceRow[]>();
for (let i = 0; i < otherGroupIds.length; i += 200) {
  const batch = otherGroupIds.slice(i, i + 200);
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("option_choices")
      .select("id,option_group_id,name,display_name,price_cents,is_default,provenance,source_span,import_key,display_order")
      .in("option_group_id", batch)
      .range(from, from + pageSize - 1) as { data: OptionChoiceRow[] | null; error: unknown };
    if (error) { console.error(error); Deno.exit(1); }
    for (const c of data ?? []) {
      const list = otherChoicesByGroup.get(c.option_group_id) ?? [];
      list.push(c);
      otherChoicesByGroup.set(c.option_group_id, list);
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
}
console.log(`other (non-Size) option_groups on items being exploded: ${otherGroupsRaw?.length ?? 0}, choices: ${[...otherChoicesByGroup.values()].reduce((s, l) => s + l.length, 0)}`);

console.log(`shop_id=${ZIOS_SHOP_ID} menu_id=${menuId} mode=${APPLY ? "APPLY" : "dry-run"}`);
console.log(`active menu_items: ${activeItems?.length}`);
console.log(`required Size-named option_groups: ${sizeGroups?.length}`);
console.log(`option_choices across those groups: ${choiceRows?.length}\n`);

const plans: { group: OptionGroupRow; plan: SizeFoldPlan }[] = [];
for (const g of sizeGroups ?? []) {
  const item = itemById.get(g.menu_item_id);
  if (!item) { console.error(`  SKIP group ${g.id}: menu_item ${g.menu_item_id} not found/active`); continue; }
  const choices = choicesByGroup.get(g.id) ?? [];
  const sourceItem: SizeFoldSourceItem = { id: item.id, name: item.name, category: item.category, description: item.description, price_cents: item.price_cents };
  const sourceChoices: SizeFoldChoice[] = choices.map(c => ({ id: c.id, name: c.name, display_name: c.display_name, price_cents: c.price_cents }));
  plans.push({ group: g, plan: planSizeFold(sourceItem, sourceChoices) });
}

const explodePlans = plans.filter(p => p.plan.retiresOriginal);
const singletonPlans = plans.filter(p => !p.plan.retiresOriginal && p.plan.choice_count === 1);
const anomalyPlans = plans.filter(p => p.plan.choice_count === 0);

const totalNewRows = explodePlans.reduce((s, p) => s + p.plan.actions.length, 0);

console.log(`plan: ${explodePlans.length} items explode into ${totalNewRows} new rows (originals retired), ${singletonPlans.length} items get size_label set in place (no new rows), ${anomalyPlans.length} anomalies (0 choices, skipped)\n`);

console.log("--- SAMPLE: first 5 explode plans (before -> after) ---");
for (const p of explodePlans.slice(0, 5)) {
  console.log(`  [${p.group.menu_item_id}] "${p.plan.item_name}" (${p.plan.choice_count} choices) ->`);
  for (const a of p.plan.actions) {
    if (a.kind === "explode_insert") {
      console.log(`      + "${a.name}" size_label="${a.size_label}" price_cents=${a.price_cents}`);
    }
  }
  console.log(`      original row -> active=false`);
}

console.log("\n--- SAMPLE: first 5 singleton plans (size_label set in place) ---");
for (const p of singletonPlans.slice(0, 5)) {
  const action = p.plan.actions[0];
  console.log(`  [${p.group.menu_item_id}] "${p.plan.item_name}" -> size_label="${action.kind === "singleton_update" ? action.size_label : "?"}" (no new row, original stays active)`);
}

if (anomalyPlans.length > 0) {
  console.log("\n--- ANOMALIES (0 choices on a required Size group -- not folded, flagging) ---");
  for (const p of anomalyPlans) console.log(`  [${p.group.menu_item_id}] "${p.plan.item_name}" group=${p.group.id}`);
}

const activeCountAfter = activeItems!.length - explodePlans.length + totalNewRows;
console.log(`\nNet active item count: ${activeItems?.length} -> ${activeCountAfter} (${explodePlans.length} retired, ${totalNewRows} new, ${singletonPlans.length} updated in place, ${anomalyPlans.length} untouched anomalies)`);
console.log(`Rollback export will be written to: ${ROLLBACK_EXPORT_PATH}`);

if (!APPLY) {
  console.log("\nDry run only — no writes made. Re-run with --apply to execute this plan.");
  Deno.exit(0);
}

// ---- APPLY ----
let insertedTotal = 0, retiredTotal = 0, singletonUpdatedTotal = 0, failures = 0;
let clonedGroupsTotal = 0, clonedChoicesTotal = 0;

for (const { plan } of explodePlans) {
  const insertRows = plan.actions
    .filter((a): a is Extract<typeof a, { kind: "explode_insert" }> => a.kind === "explode_insert")
    .map(a => ({
      menu_id: menuId, name: a.name, category: a.category, description: a.description,
      price_cents: a.price_cents, size_label: a.size_label, active: true, source: "manual",
    }));
  // Postgres preserves input row order for a single multi-row INSERT ...
  // RETURNING, so `inserted[i]` corresponds to `insertRows[i]` / `plan.actions[i]`.
  const { data: inserted, error: insErr } = await supabase.from("menu_items").insert(insertRows).select("id");
  if (insErr) { console.error(`  FAILED insert for "${plan.item_name}":`, insErr); failures++; continue; }
  insertedTotal += inserted?.length ?? 0;

  // Clone the item's OTHER (non-Size) option_groups + choices onto each new
  // size row -- see the "F1 fix" comment above where these are fetched.
  // Without this, a folded item starts with none of its topping/modifier
  // groups (option_groups is FK'd to menu_item_id, a new row has no rows
  // pointing at it yet).
  const groupsToClone = otherGroupsByItem.get(plan.item_id) ?? [];
  if (groupsToClone.length > 0 && inserted) {
    for (const row of inserted) {
      for (const g of groupsToClone) {
        const { data: newGroup, error: cloneGroupErr } = await supabase
          .from("option_groups")
          .insert({
            menu_item_id: row.id, name: g.name, kind: g.kind, required: g.required,
            min_select: g.min_select, max_select: g.max_select, provenance: g.provenance,
            source_span: g.source_span, import_key: g.import_key, display_order: g.display_order,
          })
          .select("id").single();
        if (cloneGroupErr || !newGroup) { console.error(`  FAILED to clone group "${g.name}" onto new row for "${plan.item_name}":`, cloneGroupErr); failures++; continue; }
        clonedGroupsTotal++;
        const choices = otherChoicesByGroup.get(g.id) ?? [];
        if (choices.length === 0) continue;
        const choiceRowsToInsert = choices.map(c => ({
          option_group_id: newGroup.id, name: c.name, display_name: c.display_name, price_cents: c.price_cents,
          is_default: c.is_default, provenance: c.provenance, source_span: c.source_span,
          import_key: c.import_key, display_order: c.display_order,
        }));
        const { data: newChoices, error: cloneChoicesErr } = await supabase.from("option_choices").insert(choiceRowsToInsert).select("id");
        if (cloneChoicesErr) { console.error(`  FAILED to clone choices for group "${g.name}" onto new row for "${plan.item_name}":`, cloneChoicesErr); failures++; continue; }
        clonedChoicesTotal += newChoices?.length ?? 0;
      }
    }
  }

  const { error: retireErr } = await supabase.from("menu_items").update({ active: false }).eq("id", plan.item_id);
  if (retireErr) { console.error(`  FAILED retire for "${plan.item_name}":`, retireErr); failures++; continue; }
  retiredTotal++;
}

for (const { plan } of singletonPlans) {
  const action = plan.actions[0];
  if (action.kind !== "singleton_update") continue;
  const { error: updErr } = await supabase.from("menu_items").update({ size_label: action.size_label }).eq("id", action.item_id);
  if (updErr) { console.error(`  FAILED singleton update for "${plan.item_name}":`, updErr); failures++; continue; }
  singletonUpdatedTotal++;
}

// Export before delete (rollback data).
const rollbackExport = {
  exported_at_iso: new Date().toISOString(),
  shop_id: ZIOS_SHOP_ID,
  menu_id: menuId,
  option_groups: sizeGroups,
  option_choices: choiceRows,
};
Deno.writeTextFileSync(ROLLBACK_EXPORT_PATH, JSON.stringify(rollbackExport, null, 2));
console.log(`\nRollback export written: ${ROLLBACK_EXPORT_PATH} (${sizeGroups?.length} groups, ${choiceRows?.length} choices)`);

const { error: delChoicesErr } = await supabase.from("option_choices").delete().in("option_group_id", groupIds);
if (delChoicesErr) { console.error("FAILED to delete option_choices:", delChoicesErr); failures++; }
const { error: delGroupsErr } = await supabase.from("option_groups").delete().in("id", groupIds);
if (delGroupsErr) { console.error("FAILED to delete option_groups:", delGroupsErr); failures++; }

console.log(`\nApplied: ${insertedTotal} inserted, ${retiredTotal} retired, ${singletonUpdatedTotal} singleton size_label updates, ${clonedGroupsTotal} other option_groups cloned onto new rows, ${clonedChoicesTotal} option_choices cloned, ${groupIds.length} Size groups deleted, ${failures} failures.`);
console.log("DONE. product_key/display_name/bot_state/ask_plan/lexicon are unchanged -- run a compile-menu recompile against Zio's next.");
