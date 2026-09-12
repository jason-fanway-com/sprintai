/**
 * Migration 130 acceptance proof — shops -> shop_settings sync trigger +
 * buildSystemPromptV2 delivery-pause read.
 *
 * Pattern follows scripts/tmp-item7-c2-scratch-integration-proof.ts: real
 * scratch shop rows (obviously named, prompt_version set only on these
 * rows, never on Zio's/Vito's/NJB), deleted in a finally block.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-mig130-acceptance-20260910.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest, buildSystemPromptV2 } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const STAMP = Date.now();
const V1_SHOP_ID = crypto.randomUUID();
const LEGACY_SHOP_ID = crypto.randomUUID();
const created: { table: string; match: Record<string, unknown> }[] = [];

const OPEN_HOURS_FULL_WEEK = {
  mon: [{ open: "09:00", close: "21:00" }], tue: [{ open: "09:00", close: "21:00" }],
  wed: [{ open: "09:00", close: "21:00" }], thu: [{ open: "09:00", close: "21:00" }],
  fri: [{ open: "09:00", close: "21:00" }], sat: [{ open: "09:00", close: "21:00" }],
  sun: [{ open: "09:00", close: "21:00" }],
};

async function insertShop(id: string, name: string, slug: string, promptVersion: number | null) {
  const { error: tErr } = await supabase.from("tenants").insert({ id, name: `${name} (tenant)`, slug, plan: "starter", status: "active" });
  if (tErr) throw new Error(`insert tenant ${name}: ${tErr.message}`);
  created.push({ table: "tenants", match: { id } });

  const { error } = await supabase.from("shops").insert({
    id, tenant_id: id, name, slug, timezone: "America/New_York",
    open_hours: OPEN_HOURS_FULL_WEEK, delivery_enabled: true,
    is_test: true, protected: false, phone_number_e164: null,
    prompt_version: promptVersion,
  });
  if (error) throw new Error(`insert shop ${name}: ${error.message}`);
  created.push({ table: "shops", match: { id } });
}

async function insertMenu(shopId: string) {
  const { data: menu, error: mErr } = await supabase.from("menus").insert({ shop_id: shopId, name: "Main Menu", source: "manual" }).select("id").single();
  if (mErr) throw new Error(`insert menu: ${mErr.message}`);
  created.push({ table: "menus", match: { id: menu.id } });
  const items = [
    { name: "Cheese Pizza (Large)", price_cents: 1650, category: "Pizza" },
    { name: "Garlic Knots", price_cents: 595, category: "Sides" },
  ];
  for (const [idx, item] of items.entries()) {
    const { error } = await supabase.from("menu_items").insert({ menu_id: menu.id, name: item.name, price_cents: item.price_cents, category: item.category, active: true, display_order: idx });
    if (error) throw new Error(`insert menu_item ${item.name}: ${error.message}`);
  }
  created.push({ table: "menu_items", match: { menu_id: menu.id } });
}

async function send(shopId: string, message: string, sessionId: string, testFlag = true) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: testFlag }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

async function fetchShopSettings(shopId: string) {
  const { data } = await supabase.from("shop_settings").select("fulfilment_modes, hours_line").eq("shop_id", shopId).maybeSingle();
  return data;
}

async function fetchShop(shopId: string) {
  const { data } = await supabase.from("shops").select("*").eq("id", shopId).single();
  return data;
}

async function cleanup() {
  for (const { table, match } of [...created].reverse()) {
    const q = supabase.from(table).delete();
    for (const [k, v] of Object.entries(match)) q.eq(k, v as string);
    const { error } = await q;
    if (error) console.error(`cleanup ${table} ${JSON.stringify(match)}: ${error.message}`);
  }
}

let allPassed = true;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} - ${label}`);
  if (!cond) allPassed = false;
}

try {
  console.log("=== prompt_versions(1) FK target: create only if missing ===");
  const { data: existingPV } = await supabase.from("prompt_versions").select("version").eq("version", 1).maybeSingle();
  if (!existingPV) {
    const { error } = await supabase.from("prompt_versions").insert({ version: 1, template: "buildSystemPromptV2", notes: "migration 130 acceptance proof" });
    if (error) throw new Error(`insert prompt_versions: ${error.message}`);
    created.push({ table: "prompt_versions", match: { version: 1 } });
  }

  console.log("=== Creating scratch shops ===");
  await insertShop(V1_SHOP_ID, `Mig130 V1 Scratch Pizza ${STAMP}`, `mig130-v1-${STAMP}`, 1);
  await insertMenu(V1_SHOP_ID);
  await supabase.from("shop_settings").insert({ shop_id: V1_SHOP_ID, fulfilment_modes: ["pickup", "delivery"], upsell_enabled: true, quantity_words: {} });
  created.push({ table: "shop_settings", match: { shop_id: V1_SHOP_ID } });

  await insertShop(LEGACY_SHOP_ID, `Mig130 Legacy Scratch Pizza ${STAMP}`, `mig130-legacy-${STAMP}`, null);
  await insertMenu(LEGACY_SHOP_ID);
  // Deliberately NO shop_settings row for the legacy shop — it must never be read.

  // ── TEST 1: SET_DELIVERY_ENABLED write -> shop_settings.fulfilment_modes sync ──
  console.log("\n=== TEST 1: delivery_enabled off -> fulfilment_modes drops 'delivery' ===");
  // Same single-column UPDATE admin-chat's SET_DELIVERY_ENABLED case performs
  // (supabase/functions/admin-chat/index.ts) against shops.delivery_enabled.
  await supabase.from("shops").update({ delivery_enabled: false }).eq("id", V1_SHOP_ID);
  let settings = await fetchShopSettings(V1_SHOP_ID);
  check("fulfilment_modes no longer contains 'delivery' after turning off", !settings?.fulfilment_modes?.includes("delivery"));
  check("fulfilment_modes still contains 'pickup'", !!settings?.fulfilment_modes?.includes("pickup"));

  const offReply = await send(V1_SHOP_ID, "hi, can I get delivery for a large cheese pizza?", `mig130-t1-off-${STAMP}`);
  console.log(`bot (delivery off): ${offReply.reply}`);
  check("chat-sms turn does not offer delivery when off", !/we (can |do )?deliver|delivery is available/i.test(offReply.reply ?? ""));

  console.log("\n=== TEST 1b: flip delivery_enabled back on -> fulfilment_modes regains 'delivery' ===");
  await supabase.from("shops").update({ delivery_enabled: true }).eq("id", V1_SHOP_ID);
  settings = await fetchShopSettings(V1_SHOP_ID);
  check("fulfilment_modes contains 'delivery' again after turning on", !!settings?.fulfilment_modes?.includes("delivery"));

  // ── TEST 2: PAUSE_DELIVERY -> buildSystemPromptV2 surfaces the pause ──
  console.log("\n=== TEST 2: PAUSE_DELIVERY -> next turn surfaces the pause instead of ignoring it ===");
  // Same shops.update shape as admin-chat's PAUSE_DELIVERY case with
  // duration "1_hour" (durationMinutes=60), which is the only duration that
  // actually sets a non-null delivery_paused_until on this table today.
  const pausedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  await supabase.from("shops").update({ delivery_paused_until: pausedUntil, delivery_pause_reason: "kitchen swamped" }).eq("id", V1_SHOP_ID);

  const shopRow = await fetchShop(V1_SHOP_ID);
  const promptStr = buildSystemPromptV2(
    shopRow as never, "greeting", [], [], new Date().toISOString(), true, null, false, [],
    null, null, null, null, true, false, undefined, null,
    { fulfilment_modes: ["pickup", "delivery"], hours_line: null, delivery_radius_miles: null, quantity_words: {}, upsell_enabled: true },
    null, [], false,
  );
  check("rendered prompt string states delivery is paused", /DELIVERY AVAILABLE: No — delivery is temporarily paused/.test(promptStr));
  check("rendered prompt string includes the pause reason", promptStr.includes("kitchen swamped"));

  // End-to-end via a live LLM turn, in TEST MODE so the phase==="greeting"
  // hard short-circuit (which does not fire when cart.test_mode is true) is
  // bypassed — this isolates the renderer fix from that pre-existing,
  // separate enforcement path.
  const pauseReply = await send(V1_SHOP_ID, "hi, can I get delivery for a large cheese pizza?", `mig130-t2-pause-${STAMP}`, true);
  console.log(`bot (delivery paused, test mode): ${pauseReply.reply}`);
  check("live turn does not confirm/offer delivery while paused", !/deliver(y|ing) (is |will be )?(on |your )?way|sure.{0,15}deliver/i.test(pauseReply.reply ?? ""));

  console.log("\n=== TEST 2b: RESUME_DELIVERY (paused_until cleared) -> prompt no longer mentions a pause ===");
  await supabase.from("shops").update({ delivery_paused_until: null, delivery_pause_reason: null }).eq("id", V1_SHOP_ID);
  const shopRowResumed = await fetchShop(V1_SHOP_ID);
  const promptStrResumed = buildSystemPromptV2(
    shopRowResumed as never, "greeting", [], [], new Date().toISOString(), true, null, false, [],
    null, null, null, null, true, false, undefined, null,
    { fulfilment_modes: ["pickup", "delivery"], hours_line: null, delivery_radius_miles: null, quantity_words: {}, upsell_enabled: true },
    null, [], false,
  );
  check("prompt reverts to delivery available after resume", promptStrResumed.includes("DELIVERY AVAILABLE: Yes"));

  // ── TEST 3: prompt_version=null shop is completely unaffected ──
  console.log("\n=== TEST 3: legacy (prompt_version=null) shop behavior unchanged, no shop_settings row involved ===");
  await supabase.from("shops").update({ delivery_enabled: false, delivery_paused_until: pausedUntil, delivery_pause_reason: "should never reach legacy prompt" }).eq("id", LEGACY_SHOP_ID);
  const legacySettings = await fetchShopSettings(LEGACY_SHOP_ID);
  check("trigger created a shop_settings row for the legacy shop too (harmless, never read by legacy)", !!legacySettings);
  const legacyReply = await send(LEGACY_SHOP_ID, "hi, can I get a large cheese pizza for pickup?", `mig130-t3-legacy-${STAMP}`);
  console.log(`bot (legacy, prompt_version=null): ${legacyReply.reply}`);
  check("legacy shop still gets a normal ordering reply (not an error, not empty)", typeof legacyReply.reply === "string" && legacyReply.reply.length > 0);

  console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  if (!allPassed) Deno.exit(1);
} finally {
  console.log("\n=== Cleanup: deleting all scratch rows created by this script ===");
  await cleanup();
  console.log("Cleanup done.");
}
