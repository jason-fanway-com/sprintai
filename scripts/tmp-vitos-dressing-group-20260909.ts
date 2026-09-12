const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MENU_ID = "54a42842-32be-43b5-9e0c-00fae0ce48fc";

const itemsRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?menu_id=eq.${MENU_ID}&select=id,name`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const items = await itemsRes.json();
const idToName = new Map(items.map((i: any) => [i.id, i.name]));

const groupsRes = await fetch(`${SUPABASE_URL}/rest/v1/option_groups?menu_item_id=in.(${items.map((i: any) => i.id).join(",")})&name=ilike.*dressing*&select=id,menu_item_id,name,required`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const groups = await groupsRes.json();
for (const g of groups) {
  console.log(g.id, idToName.get(g.menu_item_id), g.name, "required=", g.required);
}
