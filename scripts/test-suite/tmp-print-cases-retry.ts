import { generateCases } from "./generator.ts";
const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const { cases } = await generateCases({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, shopId: "b0000000-0000-0000-0000-000000000001" });
for (const c of cases) {
  if (c.id === "menu-single-2" || c.id === "menu-baker-dozen") {
    console.log(JSON.stringify(c, null, 2));
  }
}
