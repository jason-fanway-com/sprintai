/**
 * Read-only recompute (2026-09-15, PO dispatch part 2 acceptance #3): after
 * the derivedGroups slot_key fix (compile-menu/index.ts, use clause.label
 * when captured instead of hardcoding "choice"), how many NJB items still
 * have 2+ slot-kind groups sharing an identical slot_key?
 *
 * SELECTs only — zero writes, same discipline as item-9-readonly-compile-
 * report.ts. Does NOT call the compile-menu edge function and does not
 * recompile/deploy anything; it reuses normalizeMenuItems (the real, pure
 * module) plus a mirror of the FIXED one-line derivedGroups slot_key
 * formula, exactly as njb-slot-key-label-20260915.test.ts does.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        deno run --allow-env --allow-net scripts/tmp-njb-slot-key-collision-recompute-20260915.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { normalizeMenuItems, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL / SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const NJB_SHOP_ID = "b0000000-0000-0000-0000-000000000001";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const { data: menus, error: menuErr } = await supabase.from("menus").select("id").eq("shop_id", NJB_SHOP_ID);
if (menuErr) { console.error(menuErr); Deno.exit(1); }
const menuIds = (menus ?? []).map((m: any) => m.id);

interface MenuItemRow {
  id: string; menu_id: string; name: string; description: string | null;
  category: string | null; price_cents: number; size_label: string | null; active: boolean;
}
const PAGE_SIZE = 1000;
async function fetchAllRows<T>(qb: () => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await (qb() as any).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fetch failed: ${error.message ?? error}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

let items: MenuItemRow[] = [];
for (const menuId of menuIds) {
  items = items.concat(await fetchAllRows<MenuItemRow>(() =>
    supabase.from("menu_items")
      .select("id, menu_id, name, description, category, price_cents, size_label, active")
      .eq("menu_id", menuId)
      .eq("active", true) as any,
  ));
}
console.log(`NJB active menu_items: ${items.length}`);

const itemIds = items.map(i => i.id);
const IN_CLAUSE_CHUNK_SIZE = 100;
interface OptionGroupRow { id: string; menu_item_id: string; slot_key: string | null; kind: string }
let realGroups: OptionGroupRow[] = [];
for (let i = 0; i < itemIds.length; i += IN_CLAUSE_CHUNK_SIZE) {
  const chunk = itemIds.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
  realGroups = realGroups.concat(await fetchAllRows<OptionGroupRow>(() =>
    supabase.from("option_groups").select("id, menu_item_id, slot_key, kind").in("menu_item_id", chunk) as any,
  ));
}
const realGroupsByItem = new Map<string, OptionGroupRow[]>();
for (const g of realGroups) {
  const list = realGroupsByItem.get(g.menu_item_id) ?? [];
  list.push(g);
  realGroupsByItem.set(g.menu_item_id, list);
}

const rawRows: RawMenuItemRow[] = items.map(i => ({
  id: i.id, name: i.name, description: i.description, category: i.category,
  price_cents: i.price_cents, size_label: i.size_label,
}));
const normalized = normalizeMenuItems(rawRows);
const normalizedById = new Map(normalized.map(n => [n.id, n]));

function derivedGroupSlotKey(slot: { label?: string; anchor?: "choice_of" | "served_with" }): string {
  return slot.label ?? slot.anchor ?? "choice"; // mirror of the FIXED compile-menu/index.ts line
}

const survivors: { id: string; name: string; keys: string[] }[] = [];
let itemsWithAnyDerivedSlot = 0;

for (const item of items) {
  const norm = normalizedById.get(item.id);
  const derivedKeys = (norm?.slots ?? []).map(s => derivedGroupSlotKey(s));
  const realKeys = (realGroupsByItem.get(item.id) ?? [])
    .filter(g => g.kind === "slot")
    .map(g => g.slot_key ?? "(null)");
  const allKeys = [...realKeys, ...derivedKeys];
  if (derivedKeys.length > 0) itemsWithAnyDerivedSlot++;
  if (allKeys.length < 2) continue;
  const counts = new Map<string, number>();
  for (const k of allKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const collides = [...counts.values()].some(c => c >= 2);
  if (collides) survivors.push({ id: item.id, name: item.name, keys: allKeys });
}

console.log(`Items with >=1 derived (name/description) slot: ${itemsWithAnyDerivedSlot}`);
console.log(`\nItems with 2+ slot-kind groups sharing an identical slot_key AFTER the fix: ${survivors.length}`);
for (const s of survivors) {
  console.log(`  - ${s.name} (${s.id}): [${s.keys.join(", ")}]`);
}
