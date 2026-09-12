const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/menu_items?id=eq.35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd&select=id,name,category,bot_state,ask_plan,price_cents`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
);
const rows = await res.json();
await Deno.writeTextFile("/tmp/zios-cheese-item.json", JSON.stringify(rows[0], null, 2));
console.log("wrote", rows[0]?.name, "ask_plan steps:", rows[0]?.ask_plan?.steps?.length);
