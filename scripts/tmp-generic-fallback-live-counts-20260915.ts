/**
 * Read-only sanity check (2026-09-15): reconcile this dispatch's blast-radius
 * measurement against the PO-cited baseline (Vito's 38, Zio's 155 generic-
 * fallback groups) by reading the REAL live-compiled ask_plan column for
 * every active item on all three shops, same "generic" definition as
 * tmp-mixed-generic-group-lookup-20260915.ts (prompt_template's key not in
 * the fixed TEMPLATE_QUESTIONS set) — and splitting by whether the group_id
 * is a compile-menu/index.ts derivedGroups synthetic id ("derived:...", the
 * only kind this dispatch's fix can touch) vs. a real DB-backed option_group
 * (untouched by this fix regardless of its slot_key).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const KNOWN_TEMPLATE_KEYS = new Set(["temp", "bread", "dressing", "size", "flavor", "protein", "bagel"]);

const { data: shops } = await supabase.from("shops").select("id, name");
const shopNameById = new Map((shops ?? []).map((s: any) => [s.id, s.name]));
const { data: menus } = await supabase.from("menus").select("id, shop_id");
const menuShopMap = new Map((menus ?? []).map((m: any) => [m.id, m.shop_id]));
const { data: items, error } = await supabase
  .from("menu_items")
  .select("id, name, menu_id, ask_plan, active")
  .not("ask_plan", "is", null)
  .eq("active", true);
if (error) { console.error(error); Deno.exit(1); }

const counts: Record<string, { genericTotal: number; genericDerived: number; genericReal: number }> = {};

for (const item of items ?? []) {
  const shopName = shopNameById.get(menuShopMap.get((item as any).menu_id)) ?? "?";
  if (!counts[shopName]) counts[shopName] = { genericTotal: 0, genericDerived: 0, genericReal: 0 };
  const plan = (item as any).ask_plan;
  for (const step of plan?.steps ?? []) {
    if (step.kind !== "slot") continue;
    const key = (step.prompt_template ?? "").split(".")[0] || "";
    if (KNOWN_TEMPLATE_KEYS.has(key)) continue;
    counts[shopName].genericTotal++;
    if (String(step.group_id).startsWith("derived:")) counts[shopName].genericDerived++;
    else counts[shopName].genericReal++;
  }
}

for (const [shopName, c] of Object.entries(counts)) {
  console.log(`${shopName}: generic total=${c.genericTotal}, derived (affected by this fix)=${c.genericDerived}, real DB-backed (NOT affected)=${c.genericReal}`);
}
