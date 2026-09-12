const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS = "e0000000-0000-0000-0000-000000000001";

const menuRes = await fetch(
  `${SUPABASE_URL}/rest/v1/menus?shop_id=eq.${VITOS}&select=id,created_at&order=created_at.desc&limit=1`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
);
const menus = await menuRes.json();
console.log("menu", menus);
const menuId = menus[0].id;

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/menu_items?menu_id=eq.${menuId}&name=ilike.*cheese*&select=id,name,category,bot_state,ask_plan`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
);
const rows = await res.json();
console.log("status", res.status, Array.isArray(rows) ? rows.length : rows);
for (const r of rows) {
  console.log("=== ", r.name, r.category, r.bot_state);
  console.log(JSON.stringify(r.ask_plan, null, 2)?.slice(0, 3000));
}
