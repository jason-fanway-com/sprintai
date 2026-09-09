/**
 * F1 repair (2026-09-08 P0): Zio's size-fold's explode_insert (size-fold.ts)
 * only ever carried name/category/description/price_cents/size_label onto
 * the new per-size menu_items rows -- it never cloned the ORIGINAL item's
 * OTHER option_groups (Toppings, "Make it", "Add Extra", dressing groups,
 * etc; option_groups is FK'd to menu_item_id, so a brand-new row starts
 * with none). Confirmed live: all 142 already-exploded active rows have
 * zero option_groups, while their retired originals still hold the real
 * ones. This is why "1 pepp" can no longer compose onto the folded
 * "Neapolitan Cheese Pizza - Large 18''" -- there is no Toppings group left
 * to select "Pepperoni" from on that row at all.
 *
 * This is a one-time data repair for the 142 rows already exploded live.
 * The recurring code paths (scripts/fold-zios-sizes.ts for any future
 * one-time backfill of this kind, scripts/load-zios-slice-options.mjs for
 * ongoing re-scrapes) are fixed separately in the same commit -- this
 * script only backfills what's already live and broken.
 *
 * MECHANISM: menu_items has no base_item_id FK linking an exploded row back
 * to its retired original -- the only link is the naming convention
 * size-fold.ts itself defines ("<base name> - <size label>"). For each
 * active item with size_label set, strip the " - <size_label>" suffix to
 * recover the base name, find the retired (active=false) item in the same
 * menu with that exact name, and clone every one of ITS option_groups (+
 * their option_choices) onto the new item -- new group/choice ids, same
 * name/kind/required/min_select/max_select/provenance/source_span/
 * import_key/display_order, menu_item_id repointed at the new row. A row
 * that already has >=1 option_group is left untouched (idempotent, safe to
 * re-run).
 *
 * Does NOT touch bot_state/ask_plan/product_key/lexicon (compile-menu's
 * write-back columns) and does NOT invoke compile-menu -- run a recompile
 * against Zio's after this, same as fold-zios-sizes.ts's own contract.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *        SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *        deno run --allow-env --allow-net --allow-write scripts/repair-fold-missing-option-groups-20260908.ts [--apply]
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const ZIOS_SHOP_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";
const APPLY = Deno.args.includes("--apply");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

interface MenuItemRow { id: string; name: string; size_label: string | null; active: boolean; }
interface OptionGroupRow { id: string; menu_item_id: string; name: string; kind: string; required: boolean; min_select: number; max_select: number; provenance: string; source_span: string | null; import_key: string | null; display_order: number; }
interface OptionChoiceRow { id: string; option_group_id: string; name: string; display_name: string | null; price_cents: number; is_default: boolean; provenance: string; source_span: string | null; import_key: string | null; display_order: number; }

const { data: menus, error: menuErr } = await supabase
  .from("menus").select("id").eq("shop_id", ZIOS_SHOP_ID)
  .order("created_at", { ascending: false }).limit(1);
if (menuErr || !menus?.[0]) { console.error("no menu found for Zio's shop_id", menuErr); Deno.exit(1); }
const menuId = menus[0].id;

const { data: activeExploded, error: activeErr } = await supabase
  .from("menu_items").select("id,name,size_label,active")
  .eq("menu_id", menuId).eq("active", true).not("size_label", "is", null) as { data: MenuItemRow[] | null; error: unknown };
if (activeErr) { console.error(activeErr); Deno.exit(1); }

const { data: retired, error: retiredErr } = await supabase
  .from("menu_items").select("id,name,size_label,active")
  .eq("menu_id", menuId).eq("active", false) as { data: MenuItemRow[] | null; error: unknown };
if (retiredErr) { console.error(retiredErr); Deno.exit(1); }
const retiredByName = new Map((retired ?? []).map(r => [r.name, r]));

// Scoped to Zio's active+retired item ids only (NOT a whole-table fetch --
// option_choices has 8400+ rows shop-wide and PostgREST's default page size
// silently caps an unfiltered select at 1000, which under-populated every
// group past the first ~40 items on the first pass of this script).
const relevantItemIds = [...(activeExploded ?? []).map(i => i.id), ...(retired ?? []).map(i => i.id)];
const allGroups: OptionGroupRow[] = [];
for (let i = 0; i < relevantItemIds.length; i += 200) {
  const batch = relevantItemIds.slice(i, i + 200);
  const { data, error } = await supabase
    .from("option_groups")
    .select("id,menu_item_id,name,kind,required,min_select,max_select,provenance,source_span,import_key,display_order")
    .in("menu_item_id", batch) as { data: OptionGroupRow[] | null; error: unknown };
  if (error) { console.error(error); Deno.exit(1); }
  allGroups.push(...(data ?? []));
}
const groupsByItem = new Map<string, OptionGroupRow[]>();
for (const g of allGroups) {
  const l = groupsByItem.get(g.menu_item_id) ?? [];
  l.push(g);
  groupsByItem.set(g.menu_item_id, l);
}

// Paginated with .range() (not just batched by group-id count): a single
// in-scope request can still exceed PostgREST's default 1000-row page cap
// on its own (131 groups * ~20 choices each blew past 1000 in one shot
// during this script's own dry run — silently truncated with NO error, the
// same failure shape as the original whole-table fetch this replaced).
const allGroupIds = allGroups.map(g => g.id);
const allChoices: OptionChoiceRow[] = [];
for (let i = 0; i < allGroupIds.length; i += 200) {
  const batch = allGroupIds.slice(i, i + 200);
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("option_choices")
      .select("id,option_group_id,name,display_name,price_cents,is_default,provenance,source_span,import_key,display_order")
      .in("option_group_id", batch)
      .range(from, from + pageSize - 1) as { data: OptionChoiceRow[] | null; error: unknown };
    if (error) { console.error(error); Deno.exit(1); }
    allChoices.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
}
const choicesByGroup = new Map<string, OptionChoiceRow[]>();
for (const c of allChoices) {
  const l = choicesByGroup.get(c.option_group_id) ?? [];
  l.push(c);
  choicesByGroup.set(c.option_group_id, l);
}

interface RepairPlan {
  item: MenuItemRow;
  baseName: string;
  base: MenuItemRow;
  groupsToClone: OptionGroupRow[];
}

const plans: RepairPlan[] = [];
let noBase = 0, nothingToClone = 0, alreadyOk = 0, namePatternMismatch = 0;

for (const item of activeExploded ?? []) {
  const suffix = ` - ${item.size_label}`;
  if (!item.name.endsWith(suffix)) { namePatternMismatch++; continue; } // singleton size_label-in-place items, not exploded rows
  const baseName = item.name.slice(0, -suffix.length);
  const base = retiredByName.get(baseName);
  if (!base) { noBase++; continue; }
  const baseGroups = (groupsByItem.get(base.id) ?? []).filter(g => !/size/i.test(g.name));
  if (baseGroups.length === 0) { nothingToClone++; continue; }
  const existing = groupsByItem.get(item.id) ?? [];
  if (existing.length > 0) { alreadyOk++; continue; }
  plans.push({ item, baseName, base, groupsToClone: baseGroups });
}

const totalGroupsToClone = plans.reduce((s, p) => s + p.groupsToClone.length, 0);
const totalChoicesToClone = plans.reduce((s, p) => s + p.groupsToClone.reduce((s2, g) => s2 + (choicesByGroup.get(g.id)?.length ?? 0), 0), 0);

console.log(`shop_id=${ZIOS_SHOP_ID} menu_id=${menuId} mode=${APPLY ? "APPLY" : "dry-run"}`);
console.log(`active exploded (size_label set) items scanned: ${activeExploded?.length}`);
console.log(`  already had option_groups (ok, skipped): ${alreadyOk}`);
console.log(`  base had no non-Size groups (nothing to clone): ${nothingToClone}`);
console.log(`  no matching retired base found by name: ${noBase}`);
console.log(`  name didn't match "<base> - <size_label>" pattern (singleton, not exploded): ${namePatternMismatch}`);
console.log(`  NEEDS REPAIR: ${plans.length} items, ${totalGroupsToClone} groups, ${totalChoicesToClone} choices to clone\n`);

console.log("--- SAMPLE: first 8 repair plans ---");
for (const p of plans.slice(0, 8)) {
  console.log(`  "${p.item.name}" <- base "${p.baseName}" (${p.base.id}): clone ${p.groupsToClone.map(g => `${g.name}(${choicesByGroup.get(g.id)?.length ?? 0})`).join(", ")}`);
}

if (!APPLY) {
  console.log("\nDry run only — no writes made. Re-run with --apply to execute this plan.");
  Deno.exit(0);
}

let groupsInserted = 0, choicesInserted = 0, failures = 0;
for (const p of plans) {
  for (const g of p.groupsToClone) {
    const { data: newGroup, error: insGroupErr } = await supabase
      .from("option_groups")
      .insert({
        menu_item_id: p.item.id, name: g.name, kind: g.kind, required: g.required,
        min_select: g.min_select, max_select: g.max_select, provenance: g.provenance,
        source_span: g.source_span, import_key: g.import_key, display_order: g.display_order,
      })
      .select("id").single();
    if (insGroupErr || !newGroup) { console.error(`  FAILED group clone "${g.name}" for "${p.item.name}":`, insGroupErr); failures++; continue; }
    groupsInserted++;

    const choices = choicesByGroup.get(g.id) ?? [];
    if (choices.length === 0) continue;
    const insertChoiceRows = choices.map(c => ({
      option_group_id: newGroup.id, name: c.name, display_name: c.display_name, price_cents: c.price_cents,
      is_default: c.is_default, provenance: c.provenance, source_span: c.source_span,
      import_key: c.import_key, display_order: c.display_order,
    }));
    const { data: insertedChoices, error: insChoicesErr } = await supabase.from("option_choices").insert(insertChoiceRows).select("id");
    if (insChoicesErr) { console.error(`  FAILED choices clone for group "${g.name}" on "${p.item.name}":`, insChoicesErr); failures++; continue; }
    choicesInserted += insertedChoices?.length ?? 0;
  }
}

console.log(`\nApplied: ${groupsInserted} option_groups inserted, ${choicesInserted} option_choices inserted, ${failures} failures.`);
console.log("DONE. bot_state/ask_plan/product_key/lexicon are unchanged -- run a compile-menu recompile against Zio's next.");
