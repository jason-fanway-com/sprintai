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

for (const { plan } of explodePlans) {
  const insertRows = plan.actions
    .filter((a): a is Extract<typeof a, { kind: "explode_insert" }> => a.kind === "explode_insert")
    .map(a => ({
      menu_id: menuId, name: a.name, category: a.category, description: a.description,
      price_cents: a.price_cents, size_label: a.size_label, active: true, source: "manual",
    }));
  const { data: inserted, error: insErr } = await supabase.from("menu_items").insert(insertRows).select("id");
  if (insErr) { console.error(`  FAILED insert for "${plan.item_name}":`, insErr); failures++; continue; }
  insertedTotal += inserted?.length ?? 0;

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

console.log(`\nApplied: ${insertedTotal} inserted, ${retiredTotal} retired, ${singletonUpdatedTotal} singleton size_label updates, ${groupIds.length} Size groups deleted, ${failures} failures.`);
console.log("DONE. product_key/display_name/bot_state/ask_plan/lexicon are unchanged -- run a compile-menu recompile against Zio's next.");
