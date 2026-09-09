// @ts-nocheck -- offline proof script; raw DB rows aren't typed as EffectiveMenuItem, run with --no-check.
/**
 * ITEM 7 (C2 prompt renderer) — proof #1/#2. Offline, read-only test: fetches
 * real shop / shop_settings / shop_voice / shop_notes / compiled-menu rows
 * for Zio's and Not Just Bagels from production Supabase, then renders each
 * shop's prompt through the NEW buildSystemPromptV2 renderer imported
 * directly from chat-sms/index.ts (local code, not deployed, no HTTP call,
 * no shop mutated, no LLM call). Prints the rendered prompts so they can be
 * grepped.
 *
 * Run:
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-item7-c2-renderer-proof.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
// @ts-ignore -- buildSystemPromptV2 is not yet in the file's public export
// surface check; imported here purely for this offline proof script.
import { buildSystemPrompt, buildSystemPromptV2 } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(2);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ZIOS_ID = "2cba7b51-211c-4437-8910-1af4dcc03498";
const NJB_ID  = "b0000000-0000-0000-0000-000000000001";

async function loadEffectiveMenu(shopId: string) {
  const { data: menu } = await supabase
    .from("menus").select("id").eq("shop_id", shopId)
    .or(`effective_until.is.null,effective_until.gte.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(1).single();
  if (!menu) return [];
  const { data: items } = await supabase
    .from("menu_items")
    .select("id, name, description, price_cents, category, modifiers_json, prompt_for, ask_plan, bot_state, bot_state_reason")
    .eq("menu_id", menu.id).eq("active", true)
    .order("display_order", { ascending: true }).order("id", { ascending: true });
  return (items ?? []).map((i: Record<string, unknown>) => ({ ...i, option_groups: [] }));
}

async function loadShopContext(shopId: string) {
  const { data: shop } = await supabase.from("shops").select("*").eq("id", shopId).single();
  const { data: settings } = await supabase.from("shop_settings")
    .select("hours_line, fulfilment_modes, delivery_radius_miles, quantity_words, upsell_enabled")
    .eq("shop_id", shopId).maybeSingle();
  const { data: voice } = await supabase.from("shop_voice")
    .select("greeting, sign_off, persona").eq("shop_id", shopId).maybeSingle();
  const { data: notes } = await supabase.from("shop_notes")
    .select("text").eq("shop_id", shopId).order("created_at", { ascending: true });
  const menu = await loadEffectiveMenu(shopId);
  return { shop, settings, voice, notes: notes ?? [], menu };
}

function render(ctx: Awaited<ReturnType<typeof loadShopContext>>) {
  return buildSystemPromptV2(
    ctx.shop, "building", ctx.menu, [], "2026-09-09T18:00:00Z", true,
    null, false, [], null, null, null, null,
    ctx.shop.delivery_enabled, true, undefined, null,
    ctx.settings, ctx.voice, ctx.notes,
  );
}

console.log("========== ZIO'S PIZZERIA — V2 rendered prompt ==========");
const zios = await loadShopContext(ZIOS_ID);
const ziosPrompt = render(zios);
console.log(ziosPrompt);

console.log("\n\n========== NOT JUST BAGELS — V2 rendered prompt ==========");
const njb = await loadShopContext(NJB_ID);
const njbPrompt = render(njb);
console.log(njbPrompt);

console.log("\n\n========== NOT JUST BAGELS — legacy (buildSystemPrompt) for comparison ==========");
const njbLegacy = buildSystemPrompt(
  njb.shop, "building", njb.menu, [], "2026-09-09T18:00:00Z", true,
  null, false, [], null, null, null, null,
  njb.shop.delivery_enabled, true, undefined, null,
);
console.log(njbLegacy.length > 0 ? "(rendered ok, length=" + njbLegacy.length + ")" : "(empty!)");

// Write both prompts to files for the grep proof step.
await Deno.writeTextFile("/tmp/zios-v2-prompt.txt", ziosPrompt);
await Deno.writeTextFile("/tmp/njb-v2-prompt.txt", njbPrompt);
console.log("\nWrote /tmp/zios-v2-prompt.txt and /tmp/njb-v2-prompt.txt");
