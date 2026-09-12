/**
 * Read-only scan: find compiled menu_items (ask_plan not null) whose ask_plan
 * has a non-size, non-topping slot step (bread/dressing/temp/egg_style/etc)
 * with >=2 real choices, across shops with compiled_ordering_engine_enabled.
 * SELECTs only, zero writes.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env. Run: set -a; source ~/.openclaw/.secrets; set +a");
  Deno.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const { data: shops, error: shopErr } = await supabase
  .from("shops")
  .select("id, name, compiled_ordering_engine_enabled");
if (shopErr) { console.error(shopErr); Deno.exit(1); }
console.log("SHOPS:", JSON.stringify(shops, null, 2));

const enabledShopIds = (shops ?? []).filter((s: any) => s.compiled_ordering_engine_enabled === true).map((s: any) => s.id);
console.log("Compiled-engine-enabled shop ids:", enabledShopIds);

const { data: menus } = await supabase.from("menus").select("id, shop_id");
const menuShopMap = new Map((menus ?? []).map((m: any) => [m.id, m.shop_id]));

const { data: items, error } = await supabase
  .from("menu_items")
  .select("id, name, menu_id, ask_plan, active, category")
  .not("ask_plan", "is", null)
  .eq("active", true);
if (error) { console.error(error); Deno.exit(1); }

console.log(`Total compiled (ask_plan not null) active items: ${items?.length ?? 0}`);

const slotKindCounts: Record<string, number> = {};
const candidates: any[] = [];

for (const item of items ?? []) {
  const shopId = menuShopMap.get((item as any).menu_id);
  const steps = (item.ask_plan as any)?.steps ?? [];
  for (const step of steps) {
    const key = `${step.kind}:${step.slot_key}`;
    slotKindCounts[key] = (slotKindCounts[key] ?? 0) + 1;
    const isSizeOrTopping = /size|topping|pepp/i.test(step.slot_key ?? "");
    const isDressing = /dressing/i.test(step.slot_key ?? "");
    if (((step.kind === "slot" && !isSizeOrTopping) || isDressing) && (step.choices?.length ?? 0) >= 2) {
      candidates.push({
        item_id: item.id, item_name: item.name, category: (item as any).category, shop_id: shopId,
        kind: step.kind, slot_key: step.slot_key, group_id: step.group_id,
        choices: step.choices.map((c: any) => c.display),
      });
    }
  }
}

console.log("\nSlot/kind histogram across all compiled items:");
console.log(JSON.stringify(slotKindCounts, null, 2));

console.log(`\nNon-size/non-topping SLOT candidates with >=2 real choices: ${candidates.length}`);
console.log(JSON.stringify(candidates.slice(0, 20), null, 2));
