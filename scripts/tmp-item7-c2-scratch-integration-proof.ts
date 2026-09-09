/**
 * ITEM 7 (C2 prompt renderer) — proof #4: end-to-end conversational proof
 * that buildSystemPromptV2, wired through the real gate in
 * handleChatSmsRequest, behaves correctly for a bagel-shop-shaped scratch
 * shop (bundle trigger works, real price/size from compiled menu) AND a
 * pizza-shop-shaped scratch shop (no bundle vocabulary leaks in — the exact
 * bug this stream fixes).
 *
 * Per the task's explicit instruction, prompt_version is set ONLY on new,
 * obviously-named SCRATCH shop rows created by this script — never on the
 * real Zio's/Vito's/Not Just Bagels rows. scripts/create-qa-twin.py is
 * DEPRECATED (RUNBOOK: cloning a real shop causes silent drift/confusion —
 * "two shops with the same name is a trap"), so this does NOT clone Zio's
 * or NJB; it creates small, distinctly-named scratch shops with just enough
 * menu data to exercise the renderer, then deletes everything it created.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... \
 *   deno run --allow-net --allow-env --no-check scripts/tmp-item7-c2-scratch-integration-proof.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const STAMP = Date.now();
const BAGEL_SHOP_ID = crypto.randomUUID();
const PIZZA_SHOP_ID = crypto.randomUUID();
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
  // Reverse dependency order.
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
    const { error } = await supabase.from("prompt_versions").insert({ version: 1, template: "buildSystemPromptV2", notes: "stream C2 renderer — scratch-shop integration proof" });
    if (error) throw new Error(`insert prompt_versions: ${error.message}`);
    created.push({ table: "prompt_versions", match: { version: 1 } });
  } else {
    console.log("prompt_versions(1) already exists — leaving it, not created by this run.");
  }

  console.log("=== Creating scratch shops (new rows only — real Zio's/NJB untouched) ===");
  await insertShop(BAGEL_SHOP_ID, `C2 Scratch Bagel Shop ${STAMP}`, `c2-scratch-bagel-${STAMP}`);
  await insertMenu(BAGEL_SHOP_ID, [
    { name: "Plain Bagel", price_cents: 195, category: "Bagels" },
    { name: "Half Dozen Bagels", price_cents: 750, category: "Bagels" },
    { name: "One Dozen Bagels", price_cents: 1500, category: "Bagels" },
  ]);
  await insertSettingsVoiceNotes(BAGEL_SHOP_ID, {
    quantity_words: { dozen: 14, "half dozen": 6 },
    persona: "Warm neighborhood bagel counter.",
    notes: ["BOBO=Bacon Egg&Cheese (bagel sandwich alias, scratch-test note)"],
  });

  await insertShop(PIZZA_SHOP_ID, `C2 Scratch Pizza Shop ${STAMP}`, `c2-scratch-pizza-${STAMP}`);
  await insertMenu(PIZZA_SHOP_ID, [
    { name: "Cheese Pizza (Large)", price_cents: 1650, category: "Pizza" },
    { name: "Buffalo Wings (10pc)", price_cents: 1295, category: "Wings" },
  ]);
  await insertSettingsVoiceNotes(PIZZA_SHOP_ID, {
    quantity_words: {}, // no bundle vocabulary for a pizza shop
    persona: "Friendly New York-Italian pizzeria assistant.",
    notes: [],
  });

  console.log("\n=== BAGEL scratch shop: 'a dozen' should trigger start_bundle(size=14, price=1500) ===");
  const bagelSession = `c2-scratch-bagel-${STAMP}`;
  const bagelReply = await send(BAGEL_SHOP_ID, "I'll take a dozen", bagelSession);
  console.log(`bot: ${bagelReply.reply}`);
  console.log(`cart: ${JSON.stringify(bagelReply.cart)}`);
  const bagelBundle = (bagelReply.cart ?? []).find((c: Record<string, unknown>) => c.type === "bundle");
  console.log(`bundle line present: ${!!bagelBundle}, target=${bagelBundle?.target}, price_cents=${bagelBundle?.price_cents}`);

  console.log("\n=== PIZZA scratch shop: 'a dozen wings' must NOT trigger start_bundle (the bug this fixes) ===");
  const pizzaSession = `c2-scratch-pizza-${STAMP}`;
  const pizzaReply = await send(PIZZA_SHOP_ID, "I'll take a dozen wings", pizzaSession);
  console.log(`bot: ${pizzaReply.reply}`);
  console.log(`cart: ${JSON.stringify(pizzaReply.cart)}`);
  const pizzaBundle = (pizzaReply.cart ?? []).find((c: Record<string, unknown>) => c.type === "bundle");
  console.log(`bundle line present (should be false/undefined): ${!!pizzaBundle}`);

} finally {
  console.log("\n=== Cleanup: deleting all scratch rows created by this script ===");
  await cleanup();
  console.log("Cleanup done.");
}
