/**
 * parse-menu-pdf Edge Function
 *
 * POST multipart/form-data:
 *   file    — PDF file
 *   shop_id — UUID of the shop this menu belongs to
 *
 * Returns: { ok: true, menu_id: string, items_parsed: number }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

interface MenuItem {
  name:           string;
  description:    string | null;
  price_cents:    number;
  category:       string;
  modifiers_json: Array<{ name: string; price_cents: number }> | null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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

  // ── Parse form data ────────────────────────────────────────────────────────
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

  // ── Verify shop exists ─────────────────────────────────────────────────────
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("id, name")
    .eq("id", shop_id)
    .single();

  if (shopErr || !shop) {
    return jsonError("Shop not found", 404);
  }

  // ── Extract text from PDF ──────────────────────────────────────────────────
  let pdfText: string;
  try {
    pdfText = await extractPdfText(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-menu-pdf] PDF extraction failed:", msg);
    return jsonError("Failed to extract text from PDF: " + msg);
  }

  if (!pdfText.trim()) {
    return jsonError("No readable text found in PDF. Ensure the PDF contains selectable text (not a scanned image).");
  }

  console.log(`[parse-menu-pdf] Extracted ${pdfText.length} chars from "${file.name}" for shop ${shop_id}`);

  // ── Parse menu with Claude ─────────────────────────────────────────────────
  let menuItems: MenuItem[];
  try {
    menuItems = await parseMenuWithClaude(pdfText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-menu-pdf] Claude parsing failed:", msg);
    return jsonError("Failed to parse menu: " + msg);
  }

  if (!menuItems.length) {
    return jsonError("No menu items could be parsed. Ensure the PDF contains a valid restaurant menu.");
  }

  console.log(`[parse-menu-pdf] Claude parsed ${menuItems.length} items for shop ${shop_id}`);

  // ── Persist: menus row ─────────────────────────────────────────────────────
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

  // ── Persist: menu_items rows ───────────────────────────────────────────────
  const itemRows = menuItems.map((item, idx) => ({
    menu_id:       menu.id,
    name:          item.name,
    description:   item.description ?? null,
    price_cents:   item.price_cents,
    category:      item.category ?? "Uncategorized",
    modifiers_json: item.modifiers_json ?? null,
    display_order: idx,
    active:        true,
  }));

  const { error: itemsErr } = await supabase.from("menu_items").insert(itemRows);

  if (itemsErr) {
    // Roll back the menu row to keep DB consistent
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

// ─── PDF text extraction ──────────────────────────────────────────────────────
// Uses pdf-parse (npm) to extract text from a PDF File object.
// Falls back to manual byte scanning for simple text-based PDFs if pdf-parse
// is unavailable in the Deno runtime.

async function extractPdfText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();

  // Attempt pdf-parse via npm specifier (requires Deno Node compat)
  try {
    // @ts-ignore — npm: specifier, types not bundled
    const pdfParse = (await import("npm:pdf-parse/lib/pdf-parse.js")).default;
    const result   = await pdfParse(Buffer.from(buffer));
    return result.text ?? "";
  } catch (e) {
    console.warn("[parse-menu-pdf] pdf-parse unavailable, using fallback extractor:", (e as Error).message);
  }

  // Fallback: manual BT/ET text extraction (identical to train-tenant approach)
  return extractPdfTextFallback(new Uint8Array(buffer));
}

function extractPdfTextFallback(bytes: Uint8Array): string {
  const decoder = new TextDecoder("latin1");
  const raw     = decoder.decode(bytes);
  const lines:  string[] = [];

  const btEt = /BT\s*([\s\S]*?)\s*ET/g;
  let match: RegExpExecArray | null;
  while ((match = btEt.exec(raw)) !== null) {
    const block    = match[1];
    const strParen = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let m2: RegExpExecArray | null;
    while ((m2 = strParen.exec(block)) !== null) {
      const s = m2[1]
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
      lines.push(s);
    }
  }

  if (lines.length) return lines.join(" ").replace(/\s+/g, " ").trim();

  // Last resort: printable ASCII runs
  const asciiRuns = raw.match(/[\x20-\x7E]{4,}/g) ?? [];
  return asciiRuns
    .filter(s => /[a-zA-Z]/.test(s) && !/^[0-9\s.+\-*/=<>]+$/.test(s))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Claude menu parsing ──────────────────────────────────────────────────────

async function parseMenuWithClaude(menuText: string): Promise<MenuItem[]> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const prompt = `Parse this restaurant menu into structured JSON. Return ONLY a valid JSON array (no markdown fences, no extra text) where each element has:
- name: string (item name)
- description: string or null (item description if present)
- price_cents: integer (convert dollar amounts to cents, e.g. $9.99 → 999)
- category: string (section/category the item belongs to, e.g. "Appetizers", "Mains")
- modifiers_json: array of {name: string, price_cents: integer} or null (e.g. add-ons, sizes with upcharges)

Group items by their menu section. Be precise with prices. If a price is a range, use the base price.

Menu text:
${menuText.slice(0, 12000)}`; // cap to avoid token overflow

  const res = await fetch(CLAUDE_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 4096,
      messages:   [{ role: "user", content: prompt }],
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
    throw new Error(`Claude returned unparseable JSON. Raw response (first 500 chars): ${raw.slice(0, 500)}`);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
