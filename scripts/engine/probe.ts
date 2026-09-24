// probe.ts — resolve customer spans against a shop's LIVE compiled menu, without a model call.
// usage (on the Air, secrets sourced): deno run -A scripts/engine/probe.ts [--shop <uuid>] "span one" "span two"
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadMenu, type RunnerShop } from "../../supabase/functions/chat-sms/engine/runner.ts";
import { resolveSpan } from "../../supabase/functions/chat-sms/engine/resolve.ts";
import { findWordRun, words } from "../../supabase/functions/chat-sms/engine/normalize.ts";

const args = [...Deno.args];
const si = args.indexOf("--shop"); const SHOP = si >= 0 ? args.splice(si, 2)[1] : "e0000000-0000-0000-0000-000000000001";
const sb: SupabaseClient = createClient(Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!, Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!);
const shop = (await sb.from("shops").select("id, tenant_id, name, delivery_enabled, delivery_fee_cents, tax_rate_bps, phone_number_e164, latitude, longitude, delivery_radius_mi").eq("id", SHOP).single()).data as RunnerShop;
const menu = await loadMenu(sb, shop, 99);
const name = (id: string) => menu.items.get(id)?.display_name ?? id;
for (const span of args) {
  const r = resolveSpan(span, menu);
  console.log(`\n== "${span}" ->`, r.kind === "item" ? name(r.id) : r.kind === "ambiguous" ? r.ids.map(name) : r.kind);
  const sw = words(span);
  const runs = menu.itemTerms.filter((t) => findWordRun(sw, t.words) >= 0).map((t) => `${t.words.join(" ")} -> ${name(t.target_id)} ${JSON.stringify(menu.items.get(t.target_id)?.facets)}`);
  console.log("  terms found in span:", runs.length); for (const x of runs.slice(0, 30)) console.log("   ", x);
}
