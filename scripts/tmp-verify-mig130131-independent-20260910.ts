/**
 * INDEPENDENT verification (Melvin) of commit 519e15f + migration 131:
 * shops -> shop_settings sync trigger, buildSystemPromptV2 pause read,
 * delivery_radius_miles sync.
 *
 * Own scratch shops (prompt_version=1 AND null), obviously named, deleted in
 * finally. Coordinates + radius set so deliveryGeoAvailable is genuinely true
 * in production => the pause/off branch is the one that actually fires, not
 * the "finalizing delivery zone" geo fallback.
 *
 * Writes use supabase-js .from("shops").update() — byte-identical to the DB
 * operation admin-chat's applyAction issues for SET_DELIVERY_ENABLED /
 * PAUSE_DELIVERY / RESUME_DELIVERY (verified by reading index.ts). It fires the
 * same AFTER UPDATE OF trigger. shopSettings passed to buildSystemPromptV2 is
 * ALWAYS the row freshly re-fetched from the DB after the write, so the prompt
 * assertion reflects the real synced value, not a hardcoded literal.
 *
 * Run:
 *   SUPABASE_URL=$SPRINTAI_CHAT_SUPABASE_URL \
 *   SUPABASE_SERVICE_ROLE_KEY=$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY \
 *   OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-verify-mig130131-independent-20260910.ts
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

const OPEN_HOURS = {
  mon: [{ open: "09:00", close: "21:00" }], tue: [{ open: "09:00", close: "21:00" }],
  wed: [{ open: "09:00", close: "21:00" }], thu: [{ open: "09:00", close: "21:00" }],
  fri: [{ open: "09:00", close: "21:00" }], sat: [{ open: "09:00", close: "21:00" }],
  sun: [{ open: "09:00", close: "21:00" }],
};

async function insertShop(id: string, name: string, slug: string, pv: number | null) {
  const { error: tErr } = await supabase.from("tenants").insert({ id, name: `${name} (tenant)`, slug, plan: "starter", status: "active" });
  if (tErr) throw new Error(`insert tenant ${name}: ${tErr.message}`);
  created.push({ table: "tenants", match: { id } });
  const { error } = await supabase.from("shops").insert({
    id, tenant_id: id, name, slug, timezone: "America/New_York",
    open_hours: OPEN_HOURS, delivery_enabled: true,
    latitude: 40.7128, longitude: -74.0060, delivery_radius_mi: 5.0,
    is_test: true, protected: false, phone_number_e164: null, prompt_version: pv,
  });
  if (error) throw new Error(`insert shop ${name}: ${error.message}`);
  created.push({ table: "shops", match: { id } });
}

async function insertMenu(shopId: string) {
  const { data: menu, error: mErr } = await supabase.from("menus").insert({ shop_id: shopId, name: "Main Menu", source: "manual" }).select("id").single();
  if (mErr) throw new Error(`insert menu: ${mErr.message}`);
  created.push({ table: "menus", match: { id: menu.id } });
  const { error } = await supabase.from("menu_items").insert({ menu_id: menu.id, name: "Cheese Pizza (Large)", price_cents: 1650, category: "Pizza", active: true, display_order: 0 });
  if (error) throw new Error(`insert menu_item: ${error.message}`);
  created.push({ table: "menu_items", match: { menu_id: menu.id } });
}

async function send(shopId: string, message: string, sessionId: string, testFlag = true) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: testFlag }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}
async function fetchSettings(shopId: string) {
  const { data } = await supabase.from("shop_settings").select("fulfilment_modes, hours_line, delivery_radius_miles").eq("shop_id", shopId).maybeSingle();
  return data;
}
async function fetchShop(shopId: string) {
  const { data } = await supabase.from("shops").select("*").eq("id", shopId).single();
  return data;
}
// Render V2 prompt with the REAL freshly-fetched shop + shop_settings, and
// return just the two delivery-relevant lines as evidence.
async function deliveryLines(shopId: string, orderType: string | null = null) {
  const shop = await fetchShop(shopId);
  const ss = await fetchSettings(shopId);
  const geo = shop.delivery_enabled === true && shop.latitude != null && shop.longitude != null && Number(shop.delivery_radius_mi) > 0;
  const p = buildSystemPromptV2(
    shop as never, "greeting", [], [], new Date().toISOString(), true, null, false, [],
    orderType, null, null, null, shop.delivery_enabled, false, geo, null,
    ss as never, null, [], false,
  );
  return p.split("\n").filter((l) => /DELIVERY AVAILABLE:|ORDER TYPE:/.test(l)).join(" || ");
}

let allPassed = true;
function check(label: string, cond: boolean, evidence: string) {
  console.log(`${cond ? "PASS" : "FAIL"} - ${label}\n    evidence: ${evidence}`);
  if (!cond) allPassed = false;
}

try {
  const { data: existingPV } = await supabase.from("prompt_versions").select("version").eq("version", 1).maybeSingle();
  if (!existingPV) {
    await supabase.from("prompt_versions").insert({ version: 1, template: "buildSystemPromptV2", notes: "indep verify" });
    created.push({ table: "prompt_versions", match: { version: 1 } });
  }

  console.log("=== Creating scratch shops (V1 + legacy), both delivery on, geo set ===");
  await insertShop(V1_SHOP_ID, `Verify130 V1 Pizza ${STAMP}`, `verify130-v1-${STAMP}`, 1);
  await insertMenu(V1_SHOP_ID);
  await supabase.from("shop_settings").insert({ shop_id: V1_SHOP_ID, fulfilment_modes: ["pickup", "delivery"], delivery_radius_miles: 5.0, upsell_enabled: true, quantity_words: {} });
  created.push({ table: "shop_settings", match: { shop_id: V1_SHOP_ID } });
  await insertShop(LEGACY_SHOP_ID, `Verify130 Legacy Pizza ${STAMP}`, `verify130-legacy-${STAMP}`, null);
  await insertMenu(LEGACY_SHOP_ID);

  console.log(`\nbaseline V1 delivery lines: ${await deliveryLines(V1_SHOP_ID)}`);
  console.log(`baseline V1 shop_settings: ${JSON.stringify(await fetchSettings(V1_SHOP_ID))}`);

  // ===== CHECK 1: SET_DELIVERY_ENABLED off/on =====
  console.log("\n=== CHECK 1: delivery_enabled OFF ===");
  await supabase.from("shops").update({ delivery_enabled: false }).eq("id", V1_SHOP_ID);
  let s = await fetchSettings(V1_SHOP_ID);
  check("shop_settings.fulfilment_modes drops 'delivery' immediately", !s?.fulfilment_modes?.includes("delivery"), JSON.stringify(s?.fulfilment_modes));
  check("shop_settings keeps 'pickup'", !!s?.fulfilment_modes?.includes("pickup"), JSON.stringify(s?.fulfilment_modes));
  const offLines = await deliveryLines(V1_SHOP_ID);
  check("V2 prompt says pickup only when off", /DELIVERY AVAILABLE: No — this shop is pickup only/.test(offLines), offLines);
  const off = await send(V1_SHOP_ID, "hi, can I get delivery for a large cheese pizza?", `v-c1off-${STAMP}`);
  console.log(`    live bot(off): ${JSON.stringify(off.reply)}`);
  check("live turn does not offer delivery when off", !/we (can |do )?deliver|delivery is available|deliver it to you|for delivery/i.test(off.reply ?? ""), (off.reply ?? "").slice(0, 200));

  console.log("\n=== CHECK 1b: delivery_enabled ON (reverse) ===");
  await supabase.from("shops").update({ delivery_enabled: true }).eq("id", V1_SHOP_ID);
  s = await fetchSettings(V1_SHOP_ID);
  check("shop_settings.fulfilment_modes regains 'delivery'", !!s?.fulfilment_modes?.includes("delivery"), JSON.stringify(s?.fulfilment_modes));
  const onLines = await deliveryLines(V1_SHOP_ID);
  check("V2 prompt offers delivery again", /DELIVERY AVAILABLE: Yes/.test(onLines), onLines);

  // ===== CHECK 2: PAUSE / RESUME =====
  console.log("\n=== CHECK 2: PAUSE_DELIVERY (future ts + reason) ===");
  const until = new Date(Date.now() + 60 * 60_000).toISOString();
  await supabase.from("shops").update({ delivery_paused_until: until, delivery_pause_reason: "kitchen swamped" }).eq("id", V1_SHOP_ID);
  s = await fetchSettings(V1_SHOP_ID);
  const pauseLines = await deliveryLines(V1_SHOP_ID);
  check("V2 prompt states delivery is paused", /DELIVERY AVAILABLE: No — delivery is temporarily paused/.test(pauseLines), pauseLines);
  check("V2 prompt includes the pause reason", pauseLines.includes("kitchen swamped"), pauseLines);
  check("pause does NOT alter fulfilment_modes (still has delivery)", !!s?.fulfilment_modes?.includes("delivery"), JSON.stringify(s?.fulfilment_modes));
  const pause = await send(V1_SHOP_ID, "hi, can I get delivery for a large cheese pizza?", `v-c2pause-${STAMP}`, true);
  console.log(`    live bot(paused, test mode): ${JSON.stringify(pause.reply)}`);
  check("live turn does not confirm/offer delivery while paused", !/on its way|sure.{0,20}deliver|we'll deliver|delivering it/i.test(pause.reply ?? ""), (pause.reply ?? "").slice(0, 240));

  console.log("\n=== CHECK 2b: RESUME_DELIVERY (clear pause) ===");
  await supabase.from("shops").update({ delivery_paused_until: null, delivery_pause_reason: null }).eq("id", V1_SHOP_ID);
  const resumeLines = await deliveryLines(V1_SHOP_ID);
  check("V2 prompt no longer mentions a pause", !/temporarily paused/.test(resumeLines) && /DELIVERY AVAILABLE: Yes/.test(resumeLines), resumeLines);

  // ===== CHECK 3: legacy prompt_version=null unaffected =====
  console.log("\n=== CHECK 3: legacy shop (prompt_version=null) unaffected ===");
  const legacyShop = await fetchShop(LEGACY_SHOP_ID);
  check("legacy shop still has no shop_settings row (no dependency introduced by insert)", !(await fetchSettings(LEGACY_SHOP_ID)), JSON.stringify(await fetchSettings(LEGACY_SHOP_ID)));
  const legacy = await send(LEGACY_SHOP_ID, "hi, do you deliver? I'd like a large cheese pizza", `v-c3legacy-${STAMP}`);
  console.log(`    live bot(legacy, delivery on): ${JSON.stringify(legacy.reply)}`);
  check("legacy turn produces a normal non-error reply", typeof legacy.reply === "string" && legacy.reply.length > 0 && !legacy.error, JSON.stringify(legacy.error ?? "no error"));
  // Flip legacy delivery off via same write; trigger will CREATE a shop_settings
  // row (its behavior), but legacy renderer must ignore it and read shops.* directly.
  await supabase.from("shops").update({ delivery_enabled: false }).eq("id", LEGACY_SHOP_ID);
  created.push({ table: "shop_settings", match: { shop_id: LEGACY_SHOP_ID } });
  const legacyOff = await send(LEGACY_SHOP_ID, "hi, can I get delivery for a large cheese pizza?", `v-c3legacyoff-${STAMP}`);
  console.log(`    live bot(legacy, delivery off): ${JSON.stringify(legacyOff.reply)}`);
  check("legacy turn still works after flip (legacy path, no crash)", typeof legacyOff.reply === "string" && legacyOff.reply.length > 0 && !legacyOff.error, JSON.stringify(legacyOff.error ?? "no error"));
  await supabase.from("shops").update({ delivery_enabled: true }).eq("id", LEGACY_SHOP_ID);

  // ===== CHECK 4: delivery_radius_mi -> shop_settings.delivery_radius_miles =====
  console.log("\n=== CHECK 4: delivery_radius_mi sync ===");
  await supabase.from("shops").update({ delivery_radius_mi: 7.0 }).eq("id", V1_SHOP_ID);
  s = await fetchSettings(V1_SHOP_ID);
  check("shop_settings.delivery_radius_miles follows shops.delivery_radius_mi (7)", Number(s?.delivery_radius_miles) === 7, JSON.stringify(s?.delivery_radius_miles));
  await supabase.from("shops").update({ delivery_radius_mi: 3.5 }).eq("id", V1_SHOP_ID);
  s = await fetchSettings(V1_SHOP_ID);
  check("radius re-syncs to 3.5", Number(s?.delivery_radius_miles) === 3.5, JSON.stringify(s?.delivery_radius_miles));

  console.log(`\n==== ${allPassed ? "ALL PASS" : "SOME FAILED"} ====`);
} catch (e) {
  console.error("FATAL", e);
  allPassed = false;
} finally {
  console.log("\n=== cleanup ===");
  for (const { table, match } of [...created].reverse()) {
    const q = supabase.from(table).delete();
    for (const [k, v] of Object.entries(match)) q.eq(k, v as string);
    const { error } = await q;
    if (error) console.error(`cleanup ${table} ${JSON.stringify(match)}: ${error.message}`);
    else console.log(`cleaned ${table} ${JSON.stringify(match)}`);
  }
  console.log(allPassed ? "RESULT: PASS" : "RESULT: FAIL");
}
