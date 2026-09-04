/**
 * SprintAI extract-menu-items Edge Function
 * Takes shop_id + menu_text, runs LLM extraction, inserts items.
 * Called asynchronously by scrape-shop so each has its own 150s budget.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// INSTRUCTION-10 item F: each extracted item carries a confidence score (0-100) and,
// when confidence < 75, a specific flag_reason question for the owner to answer.
const MENU_EXTRACT_PROMPT = `Extract the restaurant's menu items from the following website content. Return ONLY a JSON object with an "items" array. Each item has:
- "name" (string, required)
- "price_cents" (integer, price in cents — e.g. $14.99 = 1499; 0 if truly unknown)
- "category" (string)
- "description" (string)
- "size_label" (string | null)
- "confidence" (integer 0-100, your certainty about this item's name, price, and category)
- "flag_reason" (string | null, a short specific question for the owner when confidence < 75; null otherwise)

Rules for extraction:
- Only include items with a clear, explicitly-stated price. Never guess a price.
- If a price range is given (e.g. "$12-$18"), skip that item.
- Standardize category names (Pizza, Appetizers, Salads, Pasta, Desserts, Drinks, etc.).
- Include every item you can find with a clear price. Never silently drop items that have a stated price.
- Pizza base prices (e.g. "$15.25+") are fine — extract the base price. If size-specific prices are explicitly listed, create one row per size with the size_label field set (e.g. "Small 12\"", "Medium 14\"", "Large 16\"", "Sicilian", "Half Tray", "Full Tray"). Otherwise leave size_label null.

Rules for confidence and flag_reason:
- confidence 90-100: name, price, and category are all unambiguous from the source.
- confidence 75-89: minor uncertainty — item parsed cleanly but description sparse or category inferred.
- confidence 50-74: price may be a base price of a size range; item name may be abbreviated; category unclear.
- confidence < 50: name or price is guessed or the listing is very ambiguous.
- flag_reason: required when confidence < 75. Write one plain-English question the restaurant owner can answer to confirm this row (e.g. "Is the Chicken Parm $14.99 for the sandwich or the dinner plate?" or "What category does the House Salad belong to — Salads or Appetizers?"). Null when confidence >= 75.

Return valid JSON only, no other text.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

type RawItem = {
  name: string;
  price_cents: number;
  category: string;
  description: string;
  size_label?: string;
  confidence?: number;
  flag_reason?: string | null;
};

async function extractMenuItems(
  combinedText: string,
  openRouterKey: string,
): Promise<RawItem[] | null> {
  let raw = "";
  try {
    const menuPrompt = MENU_EXTRACT_PROMPT + "\n\n" + combinedText.substring(0, 50_000);
    console.log("[extract-menu-items] LLM call: promptChars=" + menuPrompt.length);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        max_tokens: 16384,
        messages: [{ role: "user", content: menuPrompt }],
      }),
    });
    console.log("[extract-menu-items] LLM response status: " + res.status);
    if (!res.ok) {
      const errBody = await res.text();
      console.error("[extract-menu-items] LLM failed:", res.status, errBody.substring(0, 500));
      return null;
    }
    const data = await res.json();
    raw = (data?.choices?.[0]?.message?.content ?? "").trim();
    console.log("[extract-menu-items] Raw length: " + raw.length);
    raw = raw.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/, "");
    console.log("[extract-menu-items] Stripped length: " + raw.length + " starts: " + raw.substring(0, 100));
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error("[extract-menu-items] Parse error:", err, "rawLen:", raw?.length ?? 0);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405);

  let body: { shop_id?: string; menu_text?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { shop_id, menu_text } = body;
  if (!shop_id) return jsonResponse({ error: "shop_id is required" }, 400);
  if (!menu_text) return jsonResponse({ error: "menu_text is required (pass the scraped menu page content)" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!openRouterKey) return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);

  const menuItems = await extractMenuItems(menu_text, openRouterKey);
  console.log("[extract-menu-items] Extracted items:", menuItems?.length ?? "null");

  if (!menuItems || menuItems.length === 0) {
    await supabase.from("shops").update({
      crawl_status: "done",
      crawl_error: "Menu extraction returned 0 items — menu page may not have prices or JS render failed",
    }).eq("id", shop_id);
    return jsonResponse({ ok: true, items_extracted: 0, items_inserted: 0 });
  }

  // Get the shop's menu_id
  const { data: menuData } = await supabase
    .from("menus").select("id").eq("shop_id", shop_id).maybeSingle();

  if (!menuData) {
    await supabase.from("shops").update({
      crawl_status: "done",
      crawl_error: "No menu row found for shop",
    }).eq("id", shop_id);
    return jsonResponse({ ok: true, items_extracted: menuItems.length, items_inserted: 0, error: "no_menu_row" });
  }

  // Idempotent: only insert if menu is empty (never overwrite owner-edited items)
  const { count } = await supabase
    .from("menu_items").select("id", { count: "exact", head: true }).eq("menu_id", menuData.id);

  if (count && count > 0) {
    console.log("[extract-menu-items] Menu already has " + count + " items — skipping insert");
    return jsonResponse({ ok: true, items_extracted: menuItems.length, items_inserted: 0, skipped: "menu_has_items" });
  }

  const rows = menuItems.map((it, idx) => {
    const confidence = typeof it.confidence === "number" ? it.confidence : 100;
    const lowConf = confidence < 75;
    return {
      menu_id: menuData.id,
      name: it.name,
      price_cents: it.price_cents || 0,
      category: it.category || "",
      description: it.description || "",
      size_label: it.size_label || null,
      display_order: idx,
      active: true,
      is_available: true,
      owner_edited: false,
      // Item F: confidence score (0.0-1.0) for menu curation sorting
      confidence_score: confidence / 100,
      // Item F: flag low-confidence rows for owner review
      flag_review: lowConf,
      flag_reason: lowConf ? (it.flag_reason ?? "Please verify this item's name, price, and category.") : null,
    };
  });

  const { error: insertErr } = await supabase.from("menu_items").insert(rows);
  if (insertErr) {
    console.error("[extract-menu-items] Insert failed:", insertErr);
    await supabase.from("shops").update({
      crawl_status: "done",
      crawl_error: "Menu insert failed: " + String(insertErr.message).substring(0, 800),
    }).eq("id", shop_id);
    return jsonResponse({ ok: false, error: "insert_failed", detail: String(insertErr.message) });
  }

  console.log("[extract-menu-items] Inserted " + rows.length + " items for shop " + shop_id);
  return jsonResponse({ ok: true, items_extracted: menuItems.length, items_inserted: rows.length });
});