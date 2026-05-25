/**
 * parse-menu-pdf Edge Function
 *
 * POST multipart/form-data:
 *   file    -- PDF file
 *   shop_id -- UUID of the shop this menu belongs to
 *
 * Returns: { ok: true, menu_id: string, items_parsed: number }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLAUDE_MODEL   = "claude-sonnet-4-6";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_PDF_BYTES  = 10 * 1024 * 1024; // 10 MB

interface MenuItem {
  name:           string;
  description:    string | null;
  price_cents:    number;
  category:       string;
  modifiers_json: Array<{ name: string; price_cents: number }> | null;
}

// ---- Main handler ------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  const contentType = req.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonError("Expected multipart/form-data with 'file' and 'shop_id' fields");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // -- Parse form data ---------------------------------------------------------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError("Failed to parse multipart form data");
  }

  const shop_id = formData.get("shop_id") as string | null;
  const file    = formData.get("file")    as File   | null;

  if (!shop_id) return jsonError("shop_id is required");
  if (!file)    return jsonError("file is required");
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("Only PDF files are supported (.pdf extension required)");
  }

  // -- File size check ---------------------------------------------------------
  if (file.size > MAX_PDF_BYTES) {
    return jsonError(`PDF exceeds the 10 MB limit (received ${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  // -- Verify shop exists ------------------------------------------------------
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name")
    .eq("id", shop_id)
    .single();

  if (shopErr || !shop) {
    return jsonError("Shop not found", 404);
  }

  // -- Read PDF as base64 ------------------------------------------------------
  let pdfBase64: string;
  try {
    const buffer = await file.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    let binary   = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    pdfBase64 = btoa(binary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-menu-pdf] Failed to read PDF:", msg);
    return jsonError("Failed to read PDF file: " + msg);
  }

  console.log(`[parse-menu-pdf] Sending "${file.name}" (${(file.size / 1024).toFixed(1)} KB) to Claude for shop ${shop_id}`);

  // -- Parse menu with Claude --------------------------------------------------
  let menuItems: MenuItem[];
  try {
    menuItems = await parseMenuWithClaude(pdfBase64);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-menu-pdf] Claude parsing failed:", msg);
    return jsonError("Failed to parse menu: " + msg);
  }

  if (!menuItems.length) {
    return jsonError("No menu items could be parsed. Ensure the PDF contains a valid restaurant menu.");
  }

  console.log(`[parse-menu-pdf] Claude parsed ${menuItems.length} items for shop ${shop_id}`);

  // -- Delete old menus + items for this shop ----------------------------------
  const { data: oldMenus } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shop_id);

  if (oldMenus && oldMenus.length > 0) {
    const oldMenuIds = oldMenus.map((m: { id: string }) => m.id);
    await supabase.from("menu_items").delete().in("menu_id", oldMenuIds);
    await supabase.from("menus").delete().in("id", oldMenuIds);
    console.log(`[parse-menu-pdf] Deleted ${oldMenus.length} old menu(s) and their items for shop ${shop_id}`);
  }

  // -- Persist: menus row ------------------------------------------------------
  const menuName = file.name.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");

  const { data: menu, error: menuErr } = await supabase
    .from("menus")
    .insert({
      shop_id,
      name:           menuName,
      source:         "pdf",
      raw_json:       menuItems,
      effective_from: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (menuErr || !menu) {
    console.error("[parse-menu-pdf] Failed to insert menu:", menuErr?.message);
    return jsonError("Failed to create menu record: " + (menuErr?.message ?? "unknown"), 500);
  }

  // -- Persist: menu_items rows ------------------------------------------------
  const itemRows = menuItems.map((item, idx) => ({
    menu_id:        menu.id,
    name:           item.name,
    description:    item.description ?? null,
    price_cents:    item.price_cents,
    category:       item.category ?? "Uncategorized",
    modifiers_json: item.modifiers_json ?? null,
    display_order:  idx,
    active:         true,
  }));

  const { error: itemsErr } = await supabase.from("menu_items").insert(itemRows);

  if (itemsErr) {
    await supabase.from("menus").delete().eq("id", menu.id);
    console.error("[parse-menu-pdf] Failed to insert menu_items:", itemsErr.message);
    return jsonError("Failed to save menu items: " + itemsErr.message, 500);
  }

  return jsonResponse({
    ok:           true,
    menu_id:      menu.id,
    items_parsed: menuItems.length,
  });
});

// ---- Claude menu parsing (PDF document API) ---------------------------------

async function parseMenuWithClaude(pdfBase64: string): Promise<MenuItem[]> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const prompt = `You are an expert menu parser for a restaurant ordering system. Your job is to extract EVERY orderable item from this menu into structured JSON. This data will power an AI ordering assistant, so accuracy and completeness are critical.

Return ONLY a valid JSON array (no markdown fences, no commentary) where each element has:
- name: string (item name, clear and specific)
- description: string or null (brief description if present on the menu)
- price_cents: integer (convert dollar amounts to cents, e.g. $9.99 -> 999)
- category: string (menu section this belongs to)
- modifiers_json: array of {name: string, price_cents: integer} or null

CRITICAL PARSING RULES:

1. QUANTITY AND TIER PRICING: This is CRITICAL. Menus often have pricing tiers for the same item type at different quantities or sizes. Examples: single/half dozen/dozen, small/medium/large, slice/whole pie, half pound/full pound, 6-piece/12-piece. You MUST create a SEPARATE item for EACH pricing tier. Name them clearly with the quantity or size in the name. Include notes in the description (e.g. if a "dozen" means 14, say "14 count, pick your flavors"). These tier items exist IN ADDITION to individual variety/flavor items. Both must be in the output. Look carefully for quantity pricing anywhere on the menu, including separate lines, footnotes, sidebars, or headers above item lists. Do not miss it.

2. SIZE VARIATIONS: If an item comes in Small/Large or Regular/Large at different prices, create separate items for each size OR use modifiers_json. Use modifiers if the price difference is small. Use separate items if sizes are listed as distinct menu entries.

3. FLAVOR/TYPE LISTS: If the menu lists a type of item (e.g. "Bagels") with a list of available flavors/varieties (e.g. Plain, Everything, Sesame), create a SEPARATE ITEM for EACH flavor/variety. This is critical because the shop owner needs to mark individual flavors as sold out. For example, if the menu shows "Bagels: Plain, Everything, Sesame, Poppy - $1.50", create: "Plain Bagel" ($1.50), "Everything Bagel" ($1.50), "Sesame Bagel" ($1.50), "Poppy Bagel" ($1.50) as four separate items. If some flavors cost extra, set the higher price on those items.

4. ADD-ONS AND EXTRAS: Capture all add-on items, extras, and upcharges as separate items in an "Extras" or "Add-Ons" category. These are things customers can add to other items.

5. CHOICE-BASED ITEMS: If a sandwich says "choice of bagel, bread, or roll" with upcharges for some (e.g. flagel +$0.60, wrap +$1.00), include these as modifiers on the item.

6. COMBO/PLATTER ITEMS: Platters that come with sides (e.g. "served with home fries and choice of bagel") should note the included sides in the description.

7. DO NOT SKIP ITEMS: Every single priced item on the menu must appear in your output. Go through the menu section by section and verify you have captured everything. Items listed in small print, sidebars, or footnotes are just as important.

8. PRICING: Always use the base price. If a price says "from $X" or "starting at $X", use X. Never guess a price. If no price is listed for an item, skip it.

9. CATEGORIES: Use the exact section headers from the menu when possible. Common categories: Bagels, Breakfast Sandwiches, Cold Sandwiches, Hot Sandwiches, Wraps, Omelettes, Platters, Salads, Sides, Drinks, Desserts, Spreads, Extras.

Before outputting, mentally walk through the entire menu one more time and ask: "Did I capture every priced item? Did I miss any bulk/quantity pricing? Did I miss any sizes?" Then output the final JSON.`;

  const res = await fetch(CLAUDE_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":    "pdfs-2024-09-25",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 32768,
      messages: [{
        role: "user",
        content: [
          {
            type:   "document",
            source: {
              type:       "base64",
              media_type: "application/pdf",
              data:       pdfBase64,
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data?.content?.[0]?.text ?? "";

  // Strip any accidental markdown fences Claude might emit
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Attempt to recover truncated JSON array: find last complete object and close the array
    const lastCompleteObj = cleaned.lastIndexOf('},');
    const lastObj = cleaned.lastIndexOf('}');
    if (lastCompleteObj > 0) {
      try {
        parsed = JSON.parse(cleaned.slice(0, lastCompleteObj + 1) + ']');
        console.warn(`[parse-menu-pdf] Recovered truncated JSON: salvaged ${(parsed as unknown[]).length} items`);
      } catch {
        // Try at the last } instead
        if (lastObj > lastCompleteObj) {
          try {
            parsed = JSON.parse(cleaned.slice(0, lastObj + 1) + ']');
            console.warn(`[parse-menu-pdf] Recovered truncated JSON (alt): salvaged ${(parsed as unknown[]).length} items`);
          } catch {
            throw new Error(`Claude returned unparseable JSON. Raw response (first 500 chars): ${raw.slice(0, 500)}`);
          }
        } else {
          throw new Error(`Claude returned unparseable JSON. Raw response (first 500 chars): ${raw.slice(0, 500)}`);
        }
      }
    } else {
      throw new Error(`Claude returned unparseable JSON. Raw response (first 500 chars): ${raw.slice(0, 500)}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Claude response is not a JSON array");
  }

  return (parsed as MenuItem[]).filter(item =>
    typeof item.name        === "string" &&
    typeof item.price_cents === "number" &&
    item.price_cents        >= 0
  );
}

// ---- Helpers ----------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
