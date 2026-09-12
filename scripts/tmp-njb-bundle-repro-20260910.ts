/**
 * Repro for the NJB bundle money bug (2026-09-10, menu-single-2 /
 * menu-baker-dozen acceptance failures). Scratch bagel shop, same shape
 * as scripts/tmp-item7-c2-scratch-integration-proof.ts, prompt_version=1.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-njb-bundle-repro-20260910.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const STAMP = Date.now();
const BAGEL_SHOP_ID = crypto.randomUUID();
const created: { table: string; match: Record<string, unknown> }[] = [];

async function insertShop(id: string, name: string, slug: string) {
  const { error: tErr } = await supabase.from("tenants").insert({
    id, name: `${name} (tenant)`, slug, plan: "starter", status: "active",
  });
  if (tErr) throw new Error(`insert tenant ${name}: ${tErr.message}`);
  created.push({ table: "tenants", match: { id } });

  const { error } = await supabase.from("shops").insert({
    id, tenant_id: id, name, slug,
    timezone: "America/New_York",
    open_hours: { mon: [{ open: "09:00", close: "21:00" }], tue: [{ open: "09:00", close: "21:00" }], wed: [{ open: "09:00", close: "21:00" }], thu: [{ open: "09:00", close: "21:00" }], fri: [{ open: "09:00", close: "21:00" }], sat: [{ open: "09:00", close: "21:00" }], sun: [{ open: "09:00", close: "21:00" }] },
    is_test: true, protected: false, phone_number_e164: null,
    prompt_version: 1,
  });
  if (error) throw new Error(`insert shop ${name}: ${error.message}`);
  created.push({ table: "shops", match: { id } });
}

async function insertMenu(shopId: string, items: Array<{ name: string; price_cents: number; category: string }>) {
  const { data: menu, error: mErr } = await supabase.from("menus").insert({ shop_id: shopId, name: "Main Menu", source: "manual" }).select("id").single();
  if (mErr) throw new Error(`insert menu: ${mErr.message}`);
  created.push({ table: "menus", match: { id: menu.id } });
  for (const [idx, item] of items.entries()) {
    const { error } = await supabase.from("menu_items").insert({
      menu_id: menu.id, name: item.name, price_cents: item.price_cents, category: item.category,
      active: true, display_order: idx,
    });
    if (error) throw new Error(`insert menu_item ${item.name}: ${error.message}`);
  }
  created.push({ table: "menu_items", match: { menu_id: menu.id } });
}

async function insertSettingsVoiceNotes(shopId: string, opts: {
  quantity_words: Record<string, number>;
  persona: string;
  notes: string[];
}) {
  await supabase.from("shop_settings").insert({
    shop_id: shopId, fulfilment_modes: ["pickup"], quantity_words: opts.quantity_words, upsell_enabled: true,
  });
  created.push({ table: "shop_settings", match: { shop_id: shopId } });
  await supabase.from("shop_voice").insert({ shop_id: shopId, persona: opts.persona });
  created.push({ table: "shop_voice", match: { shop_id: shopId } });
  for (const text of opts.notes) {
    await supabase.from("shop_notes").insert({ shop_id: shopId, text });
  }
  if (opts.notes.length > 0) created.push({ table: "shop_notes", match: { shop_id: shopId } });
}

async function send(shopId: string, message: string, sessionId: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: shopId, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

async function cleanup() {
  for (const { table, match } of [...created].reverse()) {
    const q = supabase.from(table).delete();
    for (const [k, v] of Object.entries(match)) q.eq(k, v as string);
    const { error } = await q;
    if (error) console.error(`cleanup ${table} ${JSON.stringify(match)}: ${error.message}`);
  }
}

try {
  console.log("=== prompt_versions(1) FK target: create only if missing ===");
  const { data: existingPV } = await supabase.from("prompt_versions").select("version").eq("version", 1).maybeSingle();
  if (!existingPV) {
    const { error } = await supabase.from("prompt_versions").insert({ version: 1, template: "buildSystemPromptV2", notes: "NJB bundle repro — scratch-shop integration" });
    if (error) throw new Error(`insert prompt_versions: ${error.message}`);
    created.push({ table: "prompt_versions", match: { version: 1 } });
  } else {
    console.log("prompt_versions(1) already exists — leaving it, not created by this run.");
  }

  console.log("=== Creating scratch bagel shop (NJB-shaped: quantity_words dozen=14, half dozen=6) ===");
  await insertShop(BAGEL_SHOP_ID, `NJB Repro Bagel Shop ${STAMP}`, `njb-repro-bagel-${STAMP}`);
  await insertMenu(BAGEL_SHOP_ID, [
    { name: "Plain Bagel", price_cents: 195, category: "Bagels" },
    { name: "Half Dozen Bagels", price_cents: 750, category: "Bagels" },
    { name: "One Dozen Bagels", price_cents: 1500, category: "Bagels" },
  ]);
  await insertSettingsVoiceNotes(BAGEL_SHOP_ID, {
    quantity_words: { dozen: 14, "half dozen": 6 },
    persona: "Warm neighborhood bagel counter.",
    notes: [],
  });

  console.log("\n=== CASE A (menu-single-2 shape): 'I'd like a One Dozen Bagels please' ===");
  const sessionA = `njb-repro-a-${STAMP}`;
  const replyA = await send(BAGEL_SHOP_ID, "I'd like a One Dozen Bagels please", sessionA);
  console.log(`bot: ${replyA.reply}`);
  console.log(`cart: ${JSON.stringify(replyA.cart)}`);

  console.log("\n=== CASE B (menu-baker-dozen shape): 'I'd like a dozen bagels — mix of plain, everything, and sesame' ===");
  const sessionB = `njb-repro-b-${STAMP}`;
  const replyB = await send(BAGEL_SHOP_ID, "I'd like a dozen bagels — mix of plain, everything, and sesame", sessionB);
  console.log(`bot: ${replyB.reply}`);
  console.log(`cart: ${JSON.stringify(replyB.cart)}`);

} finally {
  console.log("\n=== Cleanup: deleting all scratch rows created by this script ===");
  await cleanup();
  console.log("Cleanup done.");
}
