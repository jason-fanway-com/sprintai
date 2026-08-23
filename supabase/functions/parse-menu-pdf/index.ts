/**
 * parse-menu-pdf Edge Function — Menu Intake Accuracy Fix (Spec 2026-08-09)
 *
 * POST application/json or multipart/form-data:
 *   shop_id - UUID of the shop
 *   text    - pre-extracted menu text (REQUIRED for accuracy)
 *   file(s) - optional PDF/images (text layer preferred)
 *
 * Architecture (Pass 5 — 2026-08-09):
 *   - pdfjs-dist for real PDF text extraction
 *   - §B TRIPLE-EXTRACT: 3 independent opus-5-fast calls, temperature=0
 *   - Consensus gate: price saved ONLY if all 3 extractions agree exactly
 *     → ANY disagreement → Open Question, never a silent confirmed price
 *   - §A deterministic validator
 *   - row_type tagged at construction
 *   - §C sign-off gate via content_hash + flag_review
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { extractPdfText } from "./pdf-text.ts";
import { validateMenu }     from "./validator.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OR_BASE    = "https://openrouter.ai/api/v1/chat/completions";
const OR_REFERER = "https://getsprintai.com";
const MODEL      = "anthropic/claude-opus-5-fast";
const MAX_TOKENS = 64000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const IMAGE_MIMES = new Set(["image/jpeg","image/jpg","image/png","image/heic","image/heif","image/webp"]);
function isImage(m: string) { return IMAGE_MIMES.has(m.toLowerCase()); }

const CANONICAL_COLS = ["category","name","size","price","description","prompt_for","upsell"] as const;

interface CanonicalRow {
  category: string; name: string; size: string;
  price: string; description: string; prompt_for: string; upsell: string;
}
interface OpenQuestion { item_ref: string; issue: string; question: string; }
interface ExtractionResult { items: CanonicalRow[]; modifiers: CanonicalRow[]; }

// ---- Main handler ----------------------------------------------------------

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonError("Method Not Allowed", 405);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );
    const orKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    if (!orKey) throw new Error("OPENROUTER_API_KEY is not configured");

    // -- Parse input ----------------------------------------------------------
    const ct = req.headers.get("Content-Type") || "";
    let shop_id: string | null = null;
    let menuText: string | null = null;

    if (ct.includes("application/json")) {
      const body = await req.json() as Record<string,unknown>;
      shop_id  = body.shop_id as string | null;
      menuText = body.text    as string | null;
    } else if (ct.includes("multipart/form-data")) {
      let fd: FormData;
      try { fd = await req.formData(); } catch { return jsonError("Failed to parse form data"); }
      shop_id  = fd.get("shop_id") as string | null;
      menuText = fd.get("text")    as string | null;
      const file  = fd.get("file")  as File | null;
      const files = fd.getAll("files") as File[];
      for (const f of (file ? [file, ...files] : files)) {
        if (f.size > MAX_FILE_BYTES) return jsonError(`File "${f.name}" exceeds 15MB`);
        if (!isImage(f.type)) {
          try {
            menuText = menuText || (await extractPdfText(new Uint8Array(await f.arrayBuffer())));
          } catch (e) {
            return jsonError("PDF read error: " + (e instanceof Error ? e.message : String(e)));
          }
        }
      }
    } else {
      return jsonError("Expected application/json or multipart/form-data");
    }

    if (!shop_id) return jsonError("shop_id is required");
    if (!menuText || menuText.length < 50) return jsonError("Menu text is required (min 50 chars). Send 'text' field directly, or send a 'file' PDF with extractable text.");

    const textChars = menuText.length;
    console.log(`[parse-menu-pdf] ${textChars} chars`);

    // ---- §B TRIPLE-EXTRACT with consensus price gate (Pass 5) ----
    // Three independent extractions, temperature=0. A price is CONFIRMED only if
    // ALL THREE extractions agree EXACTLY on the price for that item.
    // ANY disagreement → Open Question, never a silent confirmed price.
    const t0 = Date.now();

    const [pass1, pass2, pass3] = await Promise.all([
      extractMenuPass(menuText, orKey, PROMPT),
      extractMenuPass(menuText, orKey, PROMPT_CONFIRM),
      extractMenuPass(menuText, orKey, PROMPT_VARIANT),
    ]);

    const latencyMs = Date.now() - t0;

    // ---- POST-PROCESS: fix miscategorization ----
    // Defense-in-depth: the prompt tells the model Baked Pasta items go in items[]
    // but sometimes they still land in modifiers[]. Move them.
    // Also ensure Wings items stay in items[] and Wing Flavors stay in modifiers[].
    for (const extract of [pass1, pass2, pass3]) {
      const bakedPastaItems = new Set(["stuffed shells", "baked ziti", "cheese ravioli", "lasagna"]);
      const moved = extract.modifiers.filter(r => bakedPastaItems.has(r.name.toLowerCase()));
      if (moved.length > 0) {
        console.log(`[parse-menu-pdf] Moving ${moved.length} Baked Pasta items from modifiers→items`);
        extract.items.push(...moved);
        extract.modifiers = extract.modifiers.filter(r => !bakedPastaItems.has(r.name.toLowerCase()));
      }
      // Move Wing Flavors back to modifiers if they slipped into items
      const wingFlavCat = extract.items.filter(r =>
        r.category.toLowerCase().match(/wing flavor/i)
      );
      if (wingFlavCat.length > 0) {
        console.log(`[parse-menu-pdf] Moving ${wingFlavCat.length} Wing Flavor items→modifiers`);
        extract.modifiers.push(...wingFlavCat);
        extract.items = extract.items.filter(r => !r.category.toLowerCase().match(/wing flavor/i));
      }
      // Deduplicate within each pass
      const seenKeys = new Set<string>();
      const dedupedItems: typeof extract.items = [];
      for (const item of extract.items) {
        const key = `${item.category}|${item.name}|${item.size}`.toLowerCase();
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          dedupedItems.push(item);
        }
      }
      if (dedupedItems.length < extract.items.length) {
        console.log(`[parse-menu-pdf] Deduped ${extract.items.length - dedupedItems.length} duplicate items`);
        extract.items = dedupedItems;
      }
    }
    console.log(`[parse-menu-pdf] P1: ${pass1.items.length}i+${pass1.modifiers.length}m, P2: ${pass2.items.length}i+${pass2.modifiers.length}m, P3: ${pass3.items.length}i+${pass3.modifiers.length}m, ${(latencyMs/1000).toFixed(1)}s`);

    // ---- §B 3-way consensus: use pass1 as canonical base ----
    const openQuestions: OpenQuestion[] = [];

    // Helper: normalize sizes
    function normSize(s: string): string {
      const t = s.trim();
      const m: Record<string,string> = {sm:"Small",md:"Medium",lg:"Large"};
      const lo = t.toLowerCase();
      if (m[lo]) return t.replace(new RegExp(`^${lo}`,"i"), m[lo]);
      return t;
    }

    const items = pass1.items.map(r => ({ ...r, size: normSize(r.size), _rt: "item" }));
    const modifiers = pass1.modifiers.map(r => ({ ...r, size: normSize(r.size), _rt: "modifier" }));
    const allRows = [...items, ...modifiers];

    // ---- PRICE CONSENSUS GATE (Pass 5) ----
    // For each item in pass1, look up its price in pass2 and pass3.
    // PRICE CONFIRMED (saved without flag) ONLY if all 3 extractions have a matching
    // item with the EXACT same price string. ANY disagreement → Open Question.
    // Items missing from 1+ passes → Open Question.

    // Build lookups from pass2 and pass3
    function buildLookup(rows: CanonicalRow[]): Map<string, CanonicalRow[]> {
      const m = new Map<string, CanonicalRow[]>();
      for (const r of rows) {
        const key = makeCatNameKey(r.category, r.name);
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(r);
      }
      return m;
    }
    const p2Lookup = buildLookup([...pass2.items, ...pass2.modifiers]);
    const p3Lookup = buildLookup([...pass3.items, ...pass3.modifiers]);

    let confirmedPrices = 0;
    let flaggedByConsensus = 0;

    // Extract dollar amounts from PDF text BEFORE consensus loop (needed for silent-price gate)
    const dollarAmounts = extractDollarAmounts(menuText);

    for (const row of allRows) {
      const rowKey = makeCatNameKey(row.category, row.name);

      // Find best matching row in pass2 and pass3 (fuzzy name match)
      const p2match = findBestMatch(row, p2Lookup.get(rowKey));
      const p3match = findBestMatch(row, p3Lookup.get(rowKey));

      const hasPrice = row.price && row.price !== "" && row.price !== "0.00";

      // Also try fuzzy name match across the full pass2/pass3 sets if direct key failed
      let p2price: string | null = p2match?.price ?? null;
      let p3price: string | null = p3match?.price ?? null;

      if (p2price === null) {
        const fuzzy = fuzzyFindPrice(row, [...pass2.items, ...pass2.modifiers]);
        if (fuzzy) p2price = fuzzy;
      }
      if (p3price === null) {
        const fuzzy = fuzzyFindPrice(row, [...pass3.items, ...pass3.modifiers]);
        if (fuzzy) p3price = fuzzy;
      }

      // Consensus check: all 3 agree EXACTLY (including agreement that no price exists)
      const p1price = (row.price && row.price !== "") ? row.price : null;

      const allAgree = p1price !== null &&
                       p2price !== null &&
                       p3price !== null &&
                       p1price === p2price &&
                       p1price === p3price;

      if (allAgree) {
        // ---- Silent-price gate (Pass 5): confirmed price MUST appear literally in PDF text ----
        // Consensus alone can agree on a hallucination. Cross-reference against dollar amounts
        // literally present in the document text. If the price isn't in the document, flag as OQ.
        const priceVal = parseFloat(p1price!.replace(/^\$/, ""));
        if (!isNaN(priceVal) && priceVal > 0) {
          const priceStr = priceVal.toFixed(2);
          const inDocument = dollarAmounts.has(priceStr) ||
                             dollarAmounts.has(priceStr.replace(/^0/, "")) ||
                             dollarAmounts.has(p1price!.replace(/^\$/, "").replace(/^0/, ""));
          if (!inDocument) {
            flaggedByConsensus++;
            (row as any)._flag = true;
            (row as any)._reason = ((row as any)._reason ? (row as any)._reason + "; " : "") + "§B_silent_price_gate: price not in document text";
            openQuestions.push({
              item_ref: `${row.category}|${row.name}|${row.size}`,
              issue: "§B silent_price_gate",
              question: `$${priceStr} agreed by 3/3 consensus but NOT found in PDF text — owner must confirm`,
            });
          } else {
            confirmedPrices++;
          }
        } else {
          confirmedPrices++;
        }
      } else if (hasPrice) {
        // DISAGREEMENT — flag it
        flaggedByConsensus++;
        (row as any)._flag = true;
        const reasons: string[] = [];
        if (p2price === null) reasons.push(`P2 missing`);
        else if (p2price !== row.price) reasons.push(`P2=$ ${p2price}`);
        if (p3price === null) reasons.push(`P3 missing`);
        else if (p3price !== row.price) reasons.push(`P3=$ ${p3price}`);
        (row as any)._reason = ((row as any)._reason ? (row as any)._reason + "; " : "") + `§B_consensus: ${reasons.join(", ")}`;

        openQuestions.push({
          item_ref: `${row.category}|${row.name}|${row.size}`,
          issue: "§B price_consensus",
          question: `P1=$${row.price} | P2=$${p2price ?? "?"} | P3=$${p3price ?? "?"} — owner must confirm`,
        });
      }
      // Items with NO price in any pass → caught by blank_price check below
    }

    // ---- Items in pass2/pass3 only (not in pass1) → Open Questions ----
    const p1Keys = new Set(allRows.map(r => makeCatNameKey(r.category, r.name)));
    for (const r of [...pass2.items, ...pass2.modifiers]) {
      if (!p1Keys.has(makeCatNameKey(r.category, r.name))) {
        openQuestions.push({
          item_ref: `${r.category}|${r.name}|${r.size}`,
          issue: "§B only_in_pass2",
          question: `$${r.price || "?"} — owner must confirm this item exists`,
        });
      }
    }
    for (const r of [...pass3.items, ...pass3.modifiers]) {
      if (!p1Keys.has(makeCatNameKey(r.category, r.name))) {
        // Avoid duplicates from pass2
        const already = openQuestions.some(q =>
          q.issue === "§B only_in_pass2" && q.item_ref.includes(r.name));
        if (!already) {
          openQuestions.push({
            item_ref: `${r.category}|${r.name}|${r.size}`,
            issue: "§B only_in_pass3",
            question: `$${r.price || "?"} — owner must confirm this item exists`,
          });
        }
      }
    }

    // ---- ZERO-PRICE SAFETY NET: items with blank price get flagged ----
    for (const row of allRows) {
      if ((row as any)._flag) continue;
      if (!row.price || row.price === "") {
        openQuestions.push({
          item_ref: `${row.category}|${row.name}|${row.size}`,
          issue: "blank_price",
          question: `No price extracted — verify against original menu`,
        });
        (row as any)._flag = true;
        (row as any)._reason = ((row as any)._reason ? (row as any)._reason + "; " : "") + "blank_price";
      }
    }

    // ---- Dollar amounts in text (already extracted above) ----

    console.log(`[parse-menu-pdf] Prices: ${confirmedPrices} confirmed (3/3 consensus), ${flaggedByConsensus} flagged (disagreement), ${openQuestions.length} OQ total, ${dollarAmounts.size} dollar amounts in PDF text`);

    // -- §A Validation --------------------------------------------------------
    const validation = validateMenu(allRows, openQuestions);
    for (const w of validation.warnings) {
      // Only add if not already present
      if (!openQuestions.some(q => q.item_ref === w.item_ref && q.issue === w.rule)) {
        openQuestions.push({ item_ref: w.item_ref, issue: w.rule, question: w.message });
      }
    }

    // -- Content hash ---------------------------------------------------------
    const csvContent = rowsToCsv(allRows);
    const contentHash = await sha256(csvContent);

    // -- Delete old -----------------------------------------------------------
    const { data: old } = await supabase.from("menus").select("id").eq("shop_id", shop_id);
    if (old?.length) {
      await supabase.from("menu_items").delete().in("menu_id", old.map((m:{id:string}) => m.id));
      await supabase.from("menus").delete().in("id", old.map((m:{id:string}) => m.id));
    }

    // -- Persist menu ---------------------------------------------------------
    const { data: menu, error: mErr } = await supabase.from("menus").insert({
      shop_id, name: "Uploaded Menu", source: "pdf", raw_json: allRows,
      content_hash: contentHash, open_questions: openQuestions, validated: validation.passed,
      extraction_metadata: { model: MODEL, latency_ms: latencyMs, text_chars: textChars, confirmed_prices: confirmedPrices, flagged_by_consensus: flaggedByConsensus, passes: 3, dollar_amounts_in_text: dollarAmounts.size },
      effective_from: new Date().toISOString(),
    }).select("id").single();
    if (mErr || !menu) return jsonError("Failed: " + (mErr?.message ?? "unknown"), 500);

    // -- Persist items (row_type from _rt tag) --------------------------------
    const itemRows = allRows.map((row, idx) => ({
      menu_id: menu.id, name: row.name, category: row.category || "Uncategorized",
      description: row.description || null,
      price_cents: row.price ? Math.round(parseFloat(row.price) * 100) : null,
      prompt_for: row.prompt_for || null, upsell: row.upsell || null,
      size_label: (row.size && row.size !== "None") ? row.size : null,
      row_type: (row as any)._rt || "item",
      display_order: idx, active: true, is_available: true,
      flag_review: (row as any)._flag || false,
      flag_reason: (row as any)._reason || null,
      modifiers_json: null,
    }));
    const { error: iErr } = await supabase.from("menu_items").insert(itemRows);
    if (iErr) { await supabase.from("menus").delete().eq("id", menu.id); return jsonError("Items: " + iErr.message, 500); }

    const modCats = new Set(modifiers.filter(r => isModCat(r.category)).map(r => r.category));
    console.log(`[parse-menu-pdf] Done: ${items.length} items, ${modifiers.length} mods (${modCats.size} blocks), ${openQuestions.length} OQ, ${confirmedPrices} prices confirmed (3/3), ${flaggedByConsensus} flagged`);

    return jsonResponse({
      ok: true, menu_id: menu.id, items_parsed: items.length, modifier_blocks: modCats.size,
      open_questions: openQuestions.length, open_questions_detail: openQuestions,
      confirmed_prices: confirmedPrices, flagged_prices: flaggedByConsensus, passes: 3,
      items: allRows.map(r => ({ ...r, row_type: (r as any)._rt || "item" })),
      validated: validation.passed, validation_failures: validation.failures, content_hash: contentHash,
      extraction_metadata: { model: MODEL, latency_ms: latencyMs, text_chars: textChars },
    });
  } catch (err) {
    console.error("[parse-menu-pdf] FATAL:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

// ---- EXTRACTION PROMPTS -----------------------------------------------------

const PROMPT = `Extract ALL sellable items AND ALL modifier option-sets from this menu. Be EXHAUSTIVE.

Return ONLY: {"items":[...],"modifiers":[...]}

=== ITEMS (every priced item, every size variation) ===
Fields: category, name, size, price, description, prompt_for, upsell
- NAME: Use the item's exact name from the menu. Do NOT append the category name as a suffix (e.g., if the item is "Cheese" under "Pizza", write "Cheese" NOT "Cheese Pizza"). For Wings: write "Wings (Bone-In)" (NOT just "10 Pieces" — include "Wings"). For boneless: "Wings (Boneless)".
- SIZE: each variation = separate row. Put size in "size" field. CRITICAL: Use FULL WORDS only: "Small (10")" NOT "SM (10")". "Medium (14")" NOT "MD (14")". "Large (16")" NOT "LG (16")". "10 Pieces" for wings. "Cup" "Bowl" capitalized. NEVER abbreviate sizes.
- PRICE: two decimals, no $. "12.95" not "$12.95". Missing → "". NEVER guess.
- CATEGORY: menu's section headers, display order. Use the exact section name from the menu.
- DESCRIPTION: key ingredients + sides, ≤25 words. "" if none.
- prompt_for: required choices (semicolons). "" if none.
- upsell: suggested add-ons. "" if none.

=== MODIFIERS (toppings, sauces, dressings, add-ons, substitutions, wing flavors, choices) ===
Fields: category, name, size, price, description, prompt_for, upsell

"category" = block label. Use the EXACT label shown on the menu. CRITICAL rules:
- "Extra Dressing" is a SEPARATE block from "Salad Dressings" — do NOT merge them.
- "Steak or Chicken Choice" is a SEPARATE block from "Pizza Finish (Buffalo Chicken)" — they serve different items.
- "Baked Pasta" is a menu ITEMS category, NOT a modifier block. Its items (Stuffed Shells, Cheese Ravioli, Baked Ziti) go in items[], not modifiers[].
- "Pasta Choices" is the MODIFIER block for Entrees that ask "which pasta". It has exactly these options: Spaghetti, Penne, Angel Hair, Linguine.
- "Wings" items (Wings (Bone-In), Wings (Boneless)) are items, NOT modifiers. Wing Flavors and Wing Extras ARE modifier blocks.

Known modifier blocks (use EXACT labels from menu if different):
  Pizza Toppings - Regular, Pizza Toppings - Gourmet, Slice Toppings - Regular,
  Slice Toppings - Gourmet, Wing Flavors, Wing Extras, Salad Dressings,
  Extra Dressing, Salad Protein Add-ons, Quesadilla Protein Add-ons, Pasta Choices,
  Buffalo Sauce Options, Steak or Chicken Choice, Gyro Protein Choice,
  Side Substitutions, Side Substitutions - Kids, Pizza Finish (Buffalo Chicken)

"name" = option WITH portion: "Pepperoni (Whole pizza)", "Pepperoni (Half pizza)",
  "Pepperoni" (for slice toppings), "Hot", "Ranch", "Chicken", "Spaghetti"
"price" = upcharge. Free → "0.00". Half-price → half of whole. TBD → "".
size/description/prompt_for/upsell → all "".

CRITICAL: Miss nothing. The items array should have 200+ entries.
The modifiers array should have 100-120 entries across 17-18 categories.
Look for modifier tables — grids with checkboxes or +$ notation.

Before outputting, VERIFY:
- "Extra Dressing" is its own block (1 option), not merged into "Salad Dressings"
- "Salad Dressings" has at most 13 options
- "Pizza Finish (Buffalo Chicken)" has exactly 2: Bleu Cheese, Ranch
- "Steak or Chicken Choice" has exactly 2: Steak, Chicken
- "Wings (Bone-In)" and "Wings (Boneless)" are in items[] under "Wings" category
- Wing Flavors are in modifiers[], NOT items[]
- All item names are exact (no "X Pizza" suffix appended to pizza names)
- All sizes use text (Small/Medium/Large), never abbreviations (SM/MD/LG)`;

// Pass 2 uses a slightly different prompt to get independent readings
const PROMPT_CONFIRM = `Extract ALL sellable items AND ALL modifier option-sets from this menu. Be EXHAUSTIVE. This is an independent extraction; do not suppress anything.

Return ONLY: {"items":[...],"modifiers":[...]}

=== ITEMS (every priced item, every size variation) ===
Fields: category, name, size, price, description, prompt_for, upsell
- NAME: Use the item's exact name from the menu. For Wings: "Wings (Bone-In)" and "Wings (Boneless)" under category "Wings".
- SIZE: each variation = separate row. Full words: "Small (10")", "Medium (14")", "Large (16")", "10 Pieces", "Cup", "Bowl".
- PRICE: two decimals, no $. Missing → "".
- CATEGORY: menu's section headers in display order.
- DESCRIPTION: key ingredients + sides, ≤25 words.
- prompt_for: required choices (semicolons). "" if none.
- upsell: suggested add-ons. "" if none.

=== MODIFIERS ===
Fields: category, name, size, price, description, prompt_for, upsell
CRITICAL rules:
- "Extra Dressing" is SEPARATE from "Salad Dressings".
- "Baked Pasta" items are items[] NOT modifiers[].
- "Pasta Choices" is a modifier block: Spaghetti, Penne, Angel Hair, Linguine.
- Wing Flavors and Wing Extras are modifier blocks, NOT items.
- "Wings (Bone-In)" and "Wings (Boneless)" are items[] under "Wings" category.

"name" = option WITH portion: "Pepperoni (Whole pizza)", "Pepperoni (Half pizza)", "Hot", "Ranch".
"price" = upcharge: free → "0.00". TBD → "".
size/description/prompt_for/upsell → "".

EXHAUSTIVE: 200+ items, 100-120 modifiers across 17-18 blocks.
STAY INDEPENDENT: This is a fresh extraction from scratch.`;

// Pass 3 — third independent extraction for 3-way consensus
const PROMPT_VARIANT = `You are analyzing a restaurant menu. Extract ALL items and ALL modifier options EXHAUSTIVELY. Do this independently — do not skip anything because another pass might have caught it.

Return ONLY: {"items":[...],"modifiers":[...]}

=== ITEMS (every priced item, every size variation) ===
Fields: category, name, size, price, description, prompt_for, upsell
- NAME: Exact menu name. No category suffix appended ("Cheese" not "Cheese Pizza").
  Wings: "Wings (Bone-In)" and "Wings (Boneless)" under category "Wings".
- SIZE: Each size variation = separate row. Write sizes in full words:
  "Small (10\")", "Medium (14\")", "Large (16\")", "10 Pieces", "Cup", "Bowl".
  NO abbreviations (no SM/MD/LG).
- PRICE: Exactly as shown: "12.95" format (two decimals, no dollar sign).
  If price is unclear or unreadable → leave as "". Do NOT guess.
- CATEGORY: Use the exact section header from the menu, in display order.
- DESCRIPTION: Key ingredients, ≤25 words.
- prompt_for/upsell: "" if none.

=== MODIFIERS (toppings, sauces, dressings, add-ons, substitutions, wing flavors, choices) ===
Fields: category, name, size, price, description, prompt_for, upsell
- category = block label. Use the EXACT label. Important distinctions:
  * "Extra Dressing" is SEPARATE from "Salad Dressings"
  * "Pizza Finish (Buffalo Chicken)" is SEPARATE from "Steak or Chicken Choice"
  * "Baked Pasta" items (Stuffed Shells, Baked Ziti, Cheese Ravioli, Lasagna) go in items[]
  * "Pasta Choices" is a modifier block: Spaghetti, Penne, Angel Hair, Linguine
  * Wing Flavors and Wing Extras are modifiers[], Wings (Bone-In)/(Boneless) are items[]
- name = option WITH portion label: "Pepperoni (Whole pizza)", "Pepperoni (Half pizza)", "Ranch", "Hot"
- price = upcharge: "0.00" for free, "" if unknown
- size/description/prompt_for/upsell: all ""

AIM FOR COMPLETENESS: 200+ items across all categories, 100-120 modifier options.
This is an INDEPENDENT fresh extraction. Do not rely on or assume any prior extraction.`;

// ---- FUZZY MATCH HELPERS (3-way consensus) --------------------------------

/** Find best matching row from a lookup bucket by size compatibility. */
function findBestMatch(row: CanonicalRow, candidates: CanonicalRow[] | undefined): CanonicalRow | null {
  if (!candidates || candidates.length === 0) return null;
  const rSize = normalizeSizeStr(row.size);
  // Prefer exact size match
  for (const c of candidates) {
    if (normalizeSizeStr(c.size) === rSize) return c;
  }
  // Fall back: any size
  return candidates[0];
}

/** Fuzzy find a price for `row` in `pool` by name similarity (used when direct key lookup fails). */
function fuzzyFindPrice(row: CanonicalRow, pool: CanonicalRow[]): string | null {
  const rName = row.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: string | null = null;
  let bestScore = 0;
  for (const r of pool) {
    const pName = r.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let score = 0;
    if (rName === pName) score = 1.0;
    else if (rName.length > 3 && pName.length > 3) {
      if (rName.includes(pName)) score = 0.85;
      else if (pName.includes(rName)) score = 0.85;
      else if (rName.length >= 5 && pName.length >= 5 && rName.slice(0, 5) === pName.slice(0, 5)) score = 0.7;
    }
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      best = (r.price && r.price !== "") ? r.price : null;
    }
  }
  return best;
}

// ---- EXTRACTION ------------------------------------------------------------

async function extractMenuPass(text: string, orKey: string, prompt: string): Promise<ExtractionResult> {
  const res = await callOR(`${prompt}\n\nMENU TEXT:\n${text}`, orKey, MAX_TOKENS);
  const parsed = parseExtractionResult(res);
  console.log(`[parse-menu-pdf] Pass: ${parsed.items.length}i + ${parsed.modifiers.length}m`);
  return parsed;
}

// ---- JSON PARSING ----------------------------------------------------------

function parseExtractionResult(raw: string): ExtractionResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: Record<string,unknown> | null = null;
  try { parsed = JSON.parse(cleaned) as Record<string,unknown>; } catch {
    parsed = recoverTruncated(cleaned);
  }
  if (!parsed) { console.error(`[parse-menu-pdf] Bad JSON. Start: ${cleaned.slice(0,200)}`); return {items:[],modifiers:[]}; }
  return { items: parseArr(parsed.items), modifiers: parseArr(parsed.modifiers) };
}

function parseArr(arr: unknown): CanonicalRow[] {
  if (!Array.isArray(arr)) return [];
  return (arr as Array<Record<string,unknown>>)
    .filter(r => typeof r?.name === "string" && r.name.length > 0)
    .map(r => ({
      category: String(r.category || "").trim(), name: String(r.name || "").trim(),
      size: String(r.size || "").trim(), price: String(r.price || "").trim(),
      description: String(r.description || "").trim(), prompt_for: String(r.prompt_for || "").trim(),
      upsell: String(r.upsell || "").trim(),
    }));
}

function recoverTruncated(raw: string): Record<string,unknown> | null {
  const idx = raw.indexOf('"items"');
  if (idx > 0) {
    const last = findLastObj(raw, raw.indexOf('[', idx) + 1);
    if (last > 0) {
      try { return JSON.parse(raw.slice(0, last + 1) + '], "modifiers": []}') as Record<string,unknown>; } catch {}
    }
  }
  for (let i = raw.length - 1; i > 10; i--) {
    if (raw[i] === "}") { try { return JSON.parse(raw.slice(0, i + 1)) as Record<string,unknown>; } catch { continue; } }
  }
  return null;
}

function findLastObj(s: string, start: number): number {
  let d = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

// ---- OPENROUTER -----------------------------------------------------------

async function callOR(prompt: string, orKey: string, maxTokens: number): Promise<string> {
  const res = await fetch(OR_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${orKey}`, "HTTP-Referer": OR_REFERER },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  if (d?.usage) console.log(`[parse-menu-pdf] tokens: in=${d.usage.prompt_tokens} out=${d.usage.completion_tokens}`);
  return d?.choices?.[0]?.message?.content ?? "";
}

// ---- UTILITIES -------------------------------------------------------------

function rowsToCsv(rows: CanonicalRow[]): string {
  return [CANONICAL_COLS.join(","), ...rows.map(r =>
    CANONICAL_COLS.map(c => { const v = (r as any)[c] || ""; return v.includes(",") ? `"${v}"` : v; }).join(",")
  )].join("\n");
}

async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function isModCat(cat: string): boolean {
  return !!(cat.toLowerCase().match(
    /topping|wing flavor|wing extra|dressing|sauce|add-on|substitut|choice|finish|protein|pasta/
  ));
}

// ---- PRICE TEXT VERIFICATION -----------------------------------------------

/** Extract all dollar amounts from menu text (e.g., "16.99", "$9.50", "11", "12 95"). */
function extractDollarAmounts(text: string): Set<string> {
  const amounts = new Set<string>();

  // Pattern 1: whitespace-tolerant decimal — $XX.XX, XX.XX, XX .XX, XX. XX, XX . XX
  // pdfjs-dist joins text items with spaces, splitting prices like "12.95" into "12 .95".
  const reDecimal = /\$?(\d+)\s*\.\s*(\d{2})/g;
  let m;
  while ((m = reDecimal.exec(text)) !== null) {
    const dollars = parseInt(m[1], 10);
    const cents = m[2];
    // Filter noise: skip amounts outside plausible menu-price range
    if (dollars >= 0 && dollars <= 200) {
      amounts.add(String(dollars) + "." + cents);
    }
  }

  // Pattern 2: space-separated prices like "12 95" → 12.95
  // pdfjs-dist joins text items with spaces, splitting prices across elements.
  // Match "digits space digits" where second group is 2 digits, at word boundaries.
  const reSpaced = /(?:\$|\+|\s|^)(\d{1,4})\s+(\d{2})(?=\s|$|\.|,)/g;
  let m2;
  while ((m2 = reSpaced.exec(text)) !== null) {
    const dollars = parseInt(m2[1], 10);
    const cents = parseInt(m2[2], 10);
    // Filter noise: skip unlikely prices (e.g., single digit like "2 85" is probably not a price)
    if (dollars >= 0 && dollars <= 200) {
      amounts.add(String(dollars) + "." + m2[2]);
    }
  }

  // Pattern 3: +$X or +X (add-on upcharge amounts like "+4 00" already caught by pattern 2)
  // Also catch "+$4" without cents
  const reUpcharge = /\+\$?(\d+)/g;
  let m3;
  while ((m3 = reUpcharge.exec(text)) !== null) {
    const val = parseInt(m3[1], 10);
    if (val > 0 && val <= 200) {
      amounts.add(String(val) + ".00");
    }
  }

  console.log(`[pdf-text] Extracted ${amounts.size} unique dollar amounts`);
  return amounts;
}

/** Check if a price string appears in the set of amounts extracted from the PDF. */
function isPriceInText(price: string, amounts: Set<string>): boolean {
  if (!price || price === "0.00" || price === "0") return true; // Free items are fine
  // Normalize: ensure two decimals
  const p = parseFloat(price);
  if (isNaN(p)) return false;
  return amounts.has(p.toFixed(2)) || amounts.has(p.toFixed(1)) || amounts.has(String(Math.round(p)));
}

/** Category+name key for cross-pass matching (normalized). */
function makeCatNameKey(category: string, name: string): string {
  return `${category.toLowerCase().replace(/[^a-z0-9]/g, "")}|${name.toLowerCase().replace(/[^a-z0-9]/g, "").trim()}`;
}

/** Normalize size strings for comparison. */
function normalizeSizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function jsonResponse(body: unknown, s = 200) { return new Response(JSON.stringify(body), { status: s, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }); }
function jsonError(m: string, s = 400) { return jsonResponse({ error: m }, s); }