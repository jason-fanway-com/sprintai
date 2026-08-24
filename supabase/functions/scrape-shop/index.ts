/**
 * SprintAI scrape-shop Edge Function
 * Uses Firecrawl /map + /scrape to discover and extract site content,
 * then summarizes via Claude Sonnet. Saves result to shops.shop_context.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CLAUDE_API   = "https://api.anthropic.com/v1/messages";
const SONNET_MODEL = "claude-sonnet-4-6";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";
const MAX_PAGES = 8;
const MAX_COMBINED_CHARS = 60_000;

/** Extract JSON-LD structured data from raw HTML */
function extractStructuredData(html: string): string {
  const blocks: string[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      blocks.push(JSON.stringify(parsed, null, 2));
    } catch {
      // skip malformed JSON-LD
    }
  }
  // Also extract footer text (often contains address, hours)
  const footerRe = /<footer[^>]*>([\s\S]*?)<\/footer>/gi;
  let footerMatch;
  while ((footerMatch = footerRe.exec(html)) !== null) {
    const text = footerMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 10) blocks.push(`Footer text: ${text.substring(0, 1000)}`);
  }
  return blocks.join("\n\n");
}

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

/** Discover all pages on the domain via Firecrawl /map */
async function discoverPages(url: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${FIRECRAWL_BASE}/map`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firecrawl /map failed (${res.status}): ${errText}`);
  }

  const data: { success: boolean; links?: string[] } = await res.json();
  if (!data.success || !data.links) return [url];
  return data.links;
}

/** Filter discovered URLs to the most useful content pages */
function prioritizePages(links: string[], baseUrl: string): string[] {
  // Skip PDFs, sitemaps, assets, cookie/privacy pages
  const skip = /\.(pdf|xml|jpg|png|gif|svg|css|js)(\?|$)|sitemap|cookie-policy|privacy-policy|wp-content\/uploads/i;
  const contentPages = links.filter(l => !skip.test(l));

  // Prioritize: homepage, menu pages, story/about, contact, then everything else
  const priority = [
    (u: string) => u === baseUrl || u === baseUrl + "/",
    (u: string) => /menu|food|drink|order/i.test(u),
    (u: string) => /story|about|history/i.test(u),
    (u: string) => /contact|location|hours/i.test(u),
    (u: string) => /catering|event/i.test(u),
  ];

  const sorted: string[] = [];
  const used = new Set<string>();

  for (const pred of priority) {
    for (const link of contentPages) {
      if (!used.has(link) && pred(link)) {
        sorted.push(link);
        used.add(link);
      }
    }
  }

  // Add remaining pages
  for (const link of contentPages) {
    if (!used.has(link)) {
      sorted.push(link);
      used.add(link);
    }
  }

  return sorted.slice(0, MAX_PAGES);
}

/** Scrape a single page via Firecrawl /scrape (synchronous, fast) */
async function scrapePage(url: string, apiKey: string, includeRaw = false): Promise<{ markdown: string; structured: string }> {
  try {
    const formats = includeRaw ? ["markdown", "rawHtml"] : ["markdown"];
    const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ url, formats }),
    });

    if (!res.ok) return { markdown: "", structured: "" };

    const data: { success: boolean; data?: { markdown?: string; rawHtml?: string } } = await res.json();
    const markdown = data.data?.markdown ?? "";
    const structured = includeRaw && data.data?.rawHtml ? extractStructuredData(data.data.rawHtml) : "";
    return { markdown, structured };
  } catch {
    return { markdown: "", structured: "" };
  }
}

const CONTEXT_PROMPT = `You are extracting useful context about a restaurant from their website. Summarize the following into a concise paragraph (under 500 words) that an AI ordering assistant would need to answer customer questions. Include: owner names, how long they have been in business, location details (address, cross streets, parking), hours if mentioned, whether they do catering, any dietary accommodations (gluten-free, vegan options), notable menu specialties, history/story, seating (indoor/outdoor/counter), and any policies (cash only, minimum order, delivery radius). Only include facts explicitly stated on the website. Do not invent information.`;

const HOURS_PROMPT = `Extract the restaurant's weekly hours from the following website content. Return ONLY a JSON object with day keys (mon, tue, wed, thu, fri, sat, sun). Each day is an object with "closed" (boolean), "open" (HH:MM 24h format), and "close" (HH:MM 24h format).

Rules:
- If a day is explicitly listed as closed or no hours are mentioned for it, set closed:true.
- Convert all times to 24-hour format (e.g. "10:00 AM" → "10:00", "10:00 PM" → "22:00").
- If hours are given as a single range for all 7 days (e.g. "open seven days a week, 10 AM to 10 PM"), apply that range to all 7 days with closed:false.
- If no hours can be found at all, return all days as closed:true.
- Never guess or invent hours. Only use explicitly stated information.
- Return valid JSON only, no other text.`;

const MENU_EXTRACT_PROMPT = `Extract the restaurant's menu items from the following website content. Return ONLY a JSON object with an "items" array. Each item has: "name" (string, required), "price_cents" (integer, price in cents — e.g. $14.99 = 1499), "category" (string), and "description" (string).

Rules:
- Only include items with a clear, explicitly-stated price. Never guess a price.
- If a price range is given (e.g. "$12-$18"), skip that item.
- Standardize category names (Pizza, Appetizers, Salads, Pasta, Desserts, Drinks, etc.).
- Include ALL menu items with a stated price — do not stop early. Restaurants often have 100+ items; capture every one. Hard cap at most 300 items.
- Return valid JSON only, no other text.`;

/** Extract structured open hours via OpenRouter (Phase 5).
 *  Returns a flat-object shape: { mon: { closed, open, close }, ... }. */
async function extractOpenHours(
  combinedText: string,
  openRouterKey: string,
  anthropicKey: string
): Promise<Record<string, { closed: boolean; open: string; close: string }> | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openRouterKey ? "anthropic/claude-sonnet-4-6" : "claude-sonnet-4-6",
        max_tokens: 512,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: HOURS_PROMPT + "\n\n" + combinedText.substring(0, 40_000) }],
      }),
    });
    if (!res.ok) {
      console.error("[scrape-shop] LLM hours extraction failed:", res.status);
      return null;
    }
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content ?? "").trim();
    return JSON.parse(raw) as Record<string, { closed: boolean; open: string; close: string }>;
  } catch (err) {
    console.error("[scrape-shop] LLM hours extraction error:", err);
    return null;
  }
}

/** Extract menu items via OpenRouter (Phase 5b).
 *  Returns an array of { name, price_cents, category, description }. */
async function extractMenuItems(
  combinedText: string,
  openRouterKey: string,
  anthropicKey: string
): Promise<Array<{ name: string; price_cents: number; category: string; description: string }> | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openRouterKey ? "anthropic/claude-sonnet-4-6" : "claude-sonnet-4-6",
        max_tokens: 8_000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: MENU_EXTRACT_PROMPT + "\n\n" + combinedText.substring(0, 55_000) }],
      }),
    });
    if (!res.ok) {
      console.error("[scrape-shop] LLM menu extraction failed:", res.status);
      return null;
    }
    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? parsed.items : null;
  } catch (err) {
    console.error("[scrape-shop] LLM menu extraction error:", err);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405);

  let body: { shop_id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { shop_id } = body;
  if (!shop_id) return jsonResponse({ error: "shop_id is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const { data: shop, error: shopErr } = await supabase
    .from("shops").select("id, website_url, crawl_status, updated_at").eq("id", shop_id).single();

  if (shopErr || !shop)  return jsonResponse({ error: "Shop not found" }, 404);
  if (!shop.website_url) return jsonResponse({ error: "Shop has no website_url set" }, 400);

  // Idempotency: never double-crawl. If already done, skip. If pending/running
  // and the shop was updated in the last 10 minutes, skip — another invocation
  // is either working or just finished setting it.
  if (shop.crawl_status === "done") {
    console.log(`[scrape-shop] Shop ${shop_id} already crawled — skipping`);
    return jsonResponse({ ok: true, skipped: true, reason: "already_crawled" });
  }
  if (shop.crawl_status === "running") {
    const updatedMs = new Date(shop.updated_at ?? 0).getTime();
    if (Date.now() - updatedMs < 10 * 60_000) {
      console.log(`[scrape-shop] Shop ${shop_id} is already being crawled — skipping`);
      return jsonResponse({ ok: true, skipped: true, reason: "crawl_in_progress" });
    }
  }
  if (shop.crawl_status === "pending") {
    const updatedMs = new Date(shop.updated_at ?? 0).getTime();
    if (Date.now() - updatedMs < 10 * 60_000) {
      console.log(`[scrape-shop] Shop ${shop_id} pending (set ${Math.round((Date.now() - updatedMs) / 1000)}s ago) — allowing, may be stale`);
    }
  }

  // Mark running so concurrent invocations bail out.
  await supabase.from("shops").update({ crawl_status: "running" }).eq("id", shop_id);

  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!firecrawlKey) return jsonResponse({ error: "FIRECRAWL_API_KEY not configured" }, 500);

  try {
  let pages: string[];
  try {
    const allLinks = await discoverPages(shop.website_url, firecrawlKey);
    pages = prioritizePages(allLinks, shop.website_url.replace(/\/$/, ""));
    console.log(`[scrape-shop] Discovered ${allLinks.length} links, scraping top ${pages.length}`);
  } catch (err) {
    console.error("[scrape-shop] Firecrawl /map error:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await supabase.from("shops").update({
      crawl_status: "failed",
      crawl_error: ("Map failed: " + errMsg).substring(0, 1024),
    }).eq("id", shop_id);
    return jsonResponse({ error: "Firecrawl /map failed" }, 500);
  }

  // Step 2: Scrape each page via /scrape (synchronous, ~0.5s each)
  // Request rawHtml for homepage to extract structured data (JSON-LD, footer)
  const results: string[] = [];
  let structuredContext = "";
  for (let i = 0; i < pages.length; i++) {
    const pageUrl = pages[i];
    const includeRaw = i === 0; // only homepage for structured data
    const { markdown, structured } = await scrapePage(pageUrl, firecrawlKey, includeRaw);
    if (markdown.trim()) results.push(`## Source: ${pageUrl}\n\n${markdown}`);
    if (structured) structuredContext = structured;
  }

  // Prepend structured data so the summarizer sees address, hours, etc.
  if (structuredContext) {
    results.unshift(`## Structured Data (JSON-LD + Footer)\n\n${structuredContext}`);
  }

  const combinedText = results.join("\n\n---\n\n").substring(0, MAX_COMBINED_CHARS);

  if (!combinedText.trim()) {
    await supabase.from("shops").update({ crawl_status: "failed", crawl_error: "No readable text found on website" }).eq("id", shop_id);
    return jsonResponse({ error: "No readable text found on website" }, 422);
  }

  console.log(`[scrape-shop] Scraped ${results.length} pages, ${combinedText.length} chars total`);

  // Step 3: Summarize. Prefer OpenRouter (same working path as chat-sms /
  // parse-menu-pdf); fall back to Anthropic direct only if OpenRouter is unset.
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  const anthropicKey  = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!openRouterKey && !anthropicKey) {
    return jsonResponse({ error: "No LLM key configured (OPENROUTER_API_KEY / ANTHROPIC_API_KEY)" }, 500);
  }

  const prompt = `${CONTEXT_PROMPT}\n\n${combinedText}`;
  let context = "";
  let llmErr = "";

  try {
    if (openRouterKey) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          model:      "anthropic/claude-sonnet-4-6",
          max_tokens: 1024,
          messages:   [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        llmErr = `OpenRouter error: ${res.status} ${(await res.text()).slice(0, 200)}`;
      } else {
        const data = await res.json();
        context = (data?.choices?.[0]?.message?.content ?? "").trim();
      }
    } else {
      const res = await fetch(CLAUDE_API, {
        method:  "POST",
        headers: {
          "x-api-key":         anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        body: JSON.stringify({
          model:      SONNET_MODEL,
          max_tokens: 1024,
          messages:   [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        llmErr = `Claude API error: ${res.status}`;
      } else {
        const data: { content: Array<{ type: string; text?: string }> } = await res.json();
        context = (data.content.find(b => b.type === "text")?.text ?? "").trim();
      }
    }
  } catch (err) {
    llmErr = `LLM fetch error: ${(err as Error).message}`;
  }

  if (!context) {
    const detail = llmErr || "No summary generated";
    console.error("[scrape-shop] summarize failed:", detail);
    await supabase.from("shops").update({ crawl_status: "failed", crawl_error: detail }).eq("id", shop_id);
    return jsonResponse({ error: "Failed to summarize content" }, 500);
  }

  // Extract structured hours (Phase 5) and menu items (Phase 5b) via LLM
  const openHours = await extractOpenHours(combinedText, openRouterKey, anthropicKey);
  const menuLinkUrls = pages.filter(u => /menu|food|drink|order/i.test(u));
  const menuItemsRaw = await extractMenuItems(combinedText, openRouterKey, anthropicKey);

  const updatePayload: Record<string, unknown> = {
    shop_context: context,
    about: context,
    crawl_status: "done",
    menu_links: menuLinkUrls,
  };
  if (openHours) updatePayload.open_hours = openHours;

  const { error: updateErr } = await supabase
    .from("shops").update(updatePayload).eq("id", shop_id);

  if (updateErr) {
    console.error("[scrape-shop] Failed to save context:", updateErr);
    return jsonResponse({ error: "Failed to save context to database" }, 500);
  }

  // Phase 5b: Auto-populate menu items (idempotent: only if menu is empty)
  let menuInserted = 0;
  if (menuItemsRaw && menuItemsRaw.length > 0) {
    // Get the shop's menu_id
    const { data: menuData } = await supabase
      .from("menus").select("id").eq("shop_id", shop_id).maybeSingle();
    
    if (menuData) {
      // Check if menu already has items (idempotent: never overwrite owner-edited)
      const { count } = await supabase
        .from("menu_items").select("id", { count: "exact", head: true }).eq("menu_id", menuData.id);
      
      if (!count || count === 0) {
        const rows = menuItemsRaw.map((it, idx) => ({
          menu_id: menuData.id,
          name: it.name,
          price_cents: it.price_cents || 0,
          category: it.category || "",
          description: it.description || "",
          display_order: idx,
          active: true,
          is_available: true,
          owner_edited: false,
        }));
        
        const { error: insertErr } = await supabase.from("menu_items").insert(rows);
        if (insertErr) {
          console.error("[scrape-shop] Menu insert failed:", insertErr);
        } else {
          menuInserted = rows.length;
        }
      }
    }
  }

  return jsonResponse({
    ok: true,
    pages_discovered: pages.length,
    pages_scraped: results.length,
    context,
    open_hours: openHours,
    menu_links: menuLinkUrls,
    menu_items_extracted: menuItemsRaw?.length ?? 0,
    menu_items_inserted: menuInserted,
  });
  } catch (err) {
    console.error("[scrape-shop] Unhandled crawl error:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await supabase.from("shops").update({
      crawl_status: "failed",
      crawl_error: errMsg.substring(0, 1024),
    }).eq("id", shop_id);
    return jsonResponse({ error: "Crawl failed: " + errMsg }, 500);
  }
});
