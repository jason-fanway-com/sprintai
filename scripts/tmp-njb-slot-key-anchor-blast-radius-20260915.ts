/**
 * Read-only blast-radius measurement (2026-09-15, PO dispatch part 3
 * acceptance #3/#4): for all three shops, how many derived (name/
 * description) slot-kind groups' compiled slot_key actually CHANGES value
 * under the label ?? anchor ?? "choice" fix (compile-menu/index.ts:444),
 * vs. the label ?? "choice" formula 5639013c shipped? And does the fix ever
 * leave two slots on the SAME item sharing an identical slot_key?
 *
 * SELECTs only — zero writes, does not call the compile-menu edge function
 * and does not recompile/deploy anything. Reuses normalizeMenuItems (real,
 * pure) + buildAskPlan/renderStepQuestion (real, pure) against two mirrors
 * of the one-line derivedGroups slot_key formula (before/after), same
 * discipline as tmp-njb-slot-key-collision-recompute-20260915.ts.
 *
 * Usage: set -a; source ~/.openclaw/.secrets; set +a
 *        deno run --allow-env --allow-net scripts/tmp-njb-slot-key-anchor-blast-radius-20260915.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { normalizeMenuItems, type RawMenuItemRow } from "../supabase/functions/_shared/normalize.ts";
import { buildAskPlan, type CompileGroup, type CompileItem } from "../supabase/functions/_shared/compile-menu.ts";
import { renderStepQuestion } from "../supabase/functions/chat-sms/ask-plan-engine.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL / SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}

const SHOPS: Record<string, string> = {
  "NJB":    "b0000000-0000-0000-0000-000000000001",
  "Vito's": "e0000000-0000-0000-0000-000000000001",
  "Zio's":  "2cba7b51-211c-4437-8910-1af4dcc03498",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

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

function oldSlotKey(slot: { label?: string }): string {
  return slot.label ?? "choice"; // 5639013c formula
}
function newSlotKey(slot: { label?: string; anchor?: "choice_of" | "served_with" }): string {
  return slot.label ?? slot.anchor ?? "choice"; // this dispatch's formula
}

function buildDerivedCompileItem(row: RawMenuItemRow, keyFn: (slot: any) => string): CompileItem {
  const [normalized] = normalizeMenuItems([row]);
  const derivedGroups: CompileGroup[] = normalized.slots.map((slot, slotIdx) => ({
    id: `derived:${row.id}:${slotIdx}`,
    name: "Choice",
    kind: "slot",
    slot_key: keyFn(slot),
    min_select: 1,
    max_select: 1,
    kitchen_critical: false,
    price_critical: false,
    default_choice_id: null,
    ask_mode: null,
    provenance: "stated",
    display_order: 1000 + slotIdx,
    choices: slot.choices.map((c, choiceIdx) => ({
      id: `derived:${row.id}:${slotIdx}:${choiceIdx}`,
      name: c.display_name,
      display_name: c.display_name,
      price_cents: 0,
      is_default: false,
      provenance: "stated",
    })),
  }));
  return {
    id: row.id,
    name: row.name,
    display_name: normalized.display_name,
    category: row.category,
    price_cents: row.price_cents,
    active: true,
    price_provenance: "stated",
    product_key: normalized.product_key,
    missing_from_source_since: null,
    groups: derivedGroups,
  };
}

let totalGenericBefore = 0;
let totalChanged = 0;
let totalCollisionAfter = 0;
const perShop: Record<string, { generic: number; changed: number; collide: number; samples: { before: string; after: string }[] }> = {};

for (const [shopName, shopId] of Object.entries(SHOPS)) {
  const { data: menus, error: menuErr } = await supabase.from("menus").select("id").eq("shop_id", shopId);
  if (menuErr) { console.error(menuErr); Deno.exit(1); }
  const menuIds = (menus ?? []).map((m: any) => m.id);

  let items: MenuItemRow[] = [];
  for (const menuId of menuIds) {
    items = items.concat(await fetchAllRows<MenuItemRow>(() =>
      supabase.from("menu_items")
        .select("id, menu_id, name, description, category, price_cents, size_label, active")
        .eq("menu_id", menuId)
        .eq("active", true) as any,
    ));
  }

  const rawRows: RawMenuItemRow[] = items.map(i => ({
    id: i.id, name: i.name, description: i.description, category: i.category,
    price_cents: i.price_cents, size_label: i.size_label,
  }));

  let generic = 0;
  let changed = 0;
  let collide = 0;
  const samples: { before: string; after: string }[] = [];

  for (const row of rawRows) {
    const beforeItem = buildDerivedCompileItem(row, oldSlotKey);
    const afterItem = buildDerivedCompileItem(row, newSlotKey);
    if (beforeItem.groups.length < 1) continue;

    const beforeKeys = beforeItem.groups.map(g => g.slot_key);
    const afterKeys = afterItem.groups.map(g => g.slot_key);

    // Count generic-fallback groups (before) and how many of THOSE move.
    beforeKeys.forEach((bk, idx) => {
      if (bk === "choice") {
        generic++;
        if (afterKeys[idx] !== "choice") changed++;
      }
    });

    // Post-fix same-item collision check (cross-shop double-check).
    const afterCounts = new Map<string, number>();
    for (const k of afterKeys) afterCounts.set(k, (afterCounts.get(k) ?? 0) + 1);
    if ([...afterCounts.values()].some(c => c >= 2)) {
      collide++;
      console.log(`COLLISION AFTER FIX: shop=${shopName} item=${row.name} (${row.id}) keys=${JSON.stringify(afterKeys)}`);
    }

    // Sample real before/after rendered questions for groups whose key moved.
    if (samples.length < 5) {
      const beforePlan = buildAskPlan(beforeItem, "2026-09-15T00:00:00.000Z");
      const afterPlan = buildAskPlan(afterItem, "2026-09-15T00:00:00.000Z");
      beforeKeys.forEach((bk, idx) => {
        if (samples.length >= 5) return;
        if (bk !== "choice" || afterKeys[idx] === "choice") return;
        const beforeStep = beforePlan.steps.find(s => s.group_id === `derived:${row.id}:${idx}`);
        const afterStep = afterPlan.steps.find(s => s.group_id === `derived:${row.id}:${idx}`);
        if (!beforeStep || !afterStep) return;
        samples.push({
          before: `[${shopName} / ${row.name}] ${renderStepQuestion(beforeStep, beforePlan.display_name)}`,
          after: `[${shopName} / ${row.name}] ${renderStepQuestion(afterStep, afterPlan.display_name)}`,
        });
      });
    }
  }

  perShop[shopName] = { generic, changed, collide, samples };
  totalGenericBefore += generic;
  totalChanged += changed;
  totalCollisionAfter += collide;
}

console.log("\n=== Per-shop blast radius ===");
for (const [shopName, r] of Object.entries(perShop)) {
  console.log(`${shopName}: generic-fallback groups (before)=${r.generic}, moved to a new value (after)=${r.changed}, post-fix same-item collisions=${r.collide}`);
}
console.log(`\nTOTAL generic-fallback groups (before)=${totalGenericBefore}, moved=${totalChanged}, post-fix collisions=${totalCollisionAfter}`);

console.log("\n=== Sample before/after questions ===");
for (const [shopName, r] of Object.entries(perShop)) {
  console.log(`\n-- ${shopName} --`);
  for (const s of r.samples) {
    console.log(`BEFORE: ${s.before}`);
    console.log(`AFTER:  ${s.after}`);
  }
}
