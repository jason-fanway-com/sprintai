/**
 * SprintAI scrape-shop Edge Function
 * Uses Firecrawl /map + /scrape to discover and extract site content,
 * then summarizes via Claude Sonnet. Saves result to shops.shop_context.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { parseLlmJson } from "../_shared/llm-json.ts";

const CLAUDE_API   = "https://api.anthropic.com/v1/messages";
const SONNET_MODEL = "claude-sonnet-4-6";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";
const MAX_PAGES = 8;
const MAX_COMBINED_CHARS = 60_000;
// PDF menu fallback: only tried when the HTML pass got zero priced items, and
// only against a small, bounded set of candidates — this is a cost/timeout
// guard, not a quality cap (parse-menu-pdf itself does the real extraction).
const MAX_PDF_CANDIDATES = 2;
const MAX_PDF_FILE_BYTES = 15 * 1024 * 1024;
const PDF_FETCH_TIMEOUT_MS = 20_000;
const PDF_PARSE_TIMEOUT_MS = 90_000;
// The HTML pass (map + scrape + 3 LLM calls) alone has been observed taking
// 100s+ on slow sites. A PDF attempt on top of that risks the whole function
// timing out and losing the honest HTML-side partial along with it. Only
// spend the time if there's real budget left; otherwise skip straight to the
// honest partial that's already computed.
const PDF_FALLBACK_ELAPSED_BUDGET_MS = 100_000;
// Firecrawl 429 backoff: an unpaced batch of crawls can trip Firecrawl's rate
// limit and cascade every remaining page to a false "no readable text" partial.
// Retry with exponential backoff before giving up.
const FIRECRAWL_MAX_RETRIES = 3;
// Menu prompt asks for up to 300 items; 8000 tokens truncates real menus mid-JSON.
// 300 items x ~45 tokens ~= 13.5k, so 16k covers the prompt's own contract with headroom.
// Deliberately NOT the model's 64k ceiling: this fetch blocks the edge function's wall
// clock, and a 64k generation can outlive it — the run then dies mid-flight and every
// crawled page is thrown away. finish_reason=length is logged if 16k ever binds.
const MENU_MAX_TOKENS = 16_000;
// Hard bound so a stalled upstream can never eat the whole function budget; on abort the
// catch below returns null and the caller records "partial" instead of dying silently.
const LLM_TIMEOUT_MS = 90_000;

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

/** Fetch with exponential backoff on Firecrawl 429s. Any other status (incl.
 *  other errors) is returned as-is for the caller to handle. */
async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= FIRECRAWL_MAX_RETRIES) return res;
    const retryAfterHeader = res.headers.get("Retry-After");
    const delayMs = retryAfterHeader && !isNaN(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : 1000 * 2 ** attempt; // 1s, 2s, 4s
    console.warn(`[scrape-shop] Firecrawl 429 on attempt ${attempt + 1}/${FIRECRAWL_MAX_RETRIES}, retrying in ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
    attempt++;
  }
}

/** Discover all pages on the domain via Firecrawl /map */
async function discoverPages(url: string, apiKey: string): Promise<string[]> {
  const res = await fetchWithBackoff(`${FIRECRAWL_BASE}/map`, {
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

/** Pick candidate menu PDFs out of the raw discovered links (before the
 *  content-page filter drops them). URL text is all Firecrawl /map gives us —
 *  no anchor text — so ranking is URL-pattern-based, same signal `prioritizePages`
 *  already uses for HTML menu pages. */
function findMenuPdfCandidates(links: string[]): string[] {
  const pdfLinks = links.filter(l => /\.pdf(\?|$)/i.test(l));
  const menuLike = /menu|food|dinner|lunch|takeout/i;
  return pdfLinks
    .map((url, idx) => ({ url, score: menuLike.test(url) ? 1 : 0, idx }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map(x => x.url);
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
    const res = await fetchWithBackoff(`${FIRECRAWL_BASE}/scrape`, {
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
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[scrape-shop] LLM hours extraction failed:", res.status);
      return null;
    }
    const data = await res.json();
    if (data?.choices?.[0]?.finish_reason === "length") {
      console.error("[scrape-shop] LLM hours extraction truncated (finish_reason=length)");
    }
    const raw = data?.choices?.[0]?.message?.content ?? "";
    return parseLlmJson<Record<string, { closed: boolean; open: string; close: string }>>(raw);
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
        max_tokens: MENU_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: MENU_EXTRACT_PROMPT + "\n\n" + combinedText.substring(0, 55_000) }],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[scrape-shop] LLM menu extraction failed:", res.status);
      return null;
    }
    const data = await res.json();
    if (data?.choices?.[0]?.finish_reason === "length") {
      console.error("[scrape-shop] LLM menu extraction truncated (finish_reason=length) — raising max_tokens further may be needed");
    }
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseLlmJson<{ items?: unknown }>(raw);
    return Array.isArray(parsed?.items) ? parsed.items as Array<{ name: string; price_cents: number; category: string; description: string }> : null;
  } catch (err) {
    console.error("[scrape-shop] LLM menu extraction error:", err);
    return null;
  }
}

/** Fetch a candidate menu PDF and hand it to parse-menu-pdf, which does the
 *  real extraction (triple-extract consensus) and persists items itself.
 *  Never trust parse-menu-pdf's self-reported counts for the honesty
 *  invariant — it can "succeed" with every price flagged/unconfirmed — so
 *  this re-checks the DB directly for priced item rows before reporting back. */
async function routeMenuPdf(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  pdfUrl: string,
  shopId: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<{ itemCount: number; error?: string }> {
  let pdfRes: Response;
  try {
    pdfRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { itemCount: 0, error: `PDF fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!pdfRes.ok) return { itemCount: 0, error: `PDF fetch failed: ${pdfRes.status}` };

  const contentLength = pdfRes.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PDF_FILE_BYTES) {
    return { itemCount: 0, error: "PDF exceeds 15MB cap (content-length)" };
  }

  const bytes = await pdfRes.arrayBuffer();
  if (bytes.byteLength > MAX_PDF_FILE_BYTES) {
    return { itemCount: 0, error: "PDF exceeds 15MB cap" };
  }
  if (bytes.byteLength === 0) {
    return { itemCount: 0, error: "PDF fetch returned 0 bytes" };
  }

  const form = new FormData();
  form.append("shop_id", shopId);
  form.append("file", new Blob([bytes], { type: "application/pdf" }), "menu.pdf");

  let parseRes: Response;
  try {
    parseRes = await fetch(`${supabaseUrl}/functions/v1/parse-menu-pdf`, {
      method: "POST",
      headers: {
        "apikey":        serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(PDF_PARSE_TIMEOUT_MS),
    });
  } catch (err) {
    return { itemCount: 0, error: `parse-menu-pdf call error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!parseRes.ok) {
    const text = await parseRes.text();
    return { itemCount: 0, error: `parse-menu-pdf ${parseRes.status}: ${text.slice(0, 200)}` };
  }

  const { data: menuRow } = await supabase
    .from("menus").select("id").eq("shop_id", shopId).maybeSingle();
  if (!menuRow) return { itemCount: 0, error: "parse-menu-pdf did not leave a menu row behind" };

  const { count } = await supabase
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("menu_id", menuRow.id)
    .eq("row_type", "item")
    .not("price_cents", "is", null);

  return { itemCount: count ?? 0 };
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405);

  let body: { shop_id?: string; force?: boolean };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { shop_id, force } = body;
  if (!shop_id) return jsonResponse({ error: "shop_id is required" }, 400);

  const supabaseUrl     = Deno.env.get("SUPABASE_URL")              ?? "";
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: shop, error: shopErr } = await supabase
    .from("shops").select("id, website_url, crawl_status, updated_at").eq("id", shop_id).single();

  if (shopErr || !shop)  return jsonResponse({ error: "Shop not found" }, 404);
  if (!shop.website_url) return jsonResponse({ error: "Shop has no website_url set" }, 400);

  // Idempotency: never double-crawl. If already done, skip. If pending/running
  // and the shop was updated in the last 10 minutes, skip — another invocation
  // is either working or just finished setting it.
  // "partial" is a terminal state too: the site was read and simply had no menu to find.
  // Without this, every re-invocation re-runs a full Firecrawl map + scrape + two LLM
  // calls on a site we already know has no machine-readable menu — unbounded spend for a
  // result that will not change. An explicit `force` (admin retry button) still re-crawls.
  if (!force && (shop.crawl_status === "done" || shop.crawl_status === "partial")) {
    console.log(`[scrape-shop] Shop ${shop_id} already crawled (${shop.crawl_status}) — skipping`);
    return jsonResponse({ ok: true, skipped: true, reason: "already_crawled", crawl_status: shop.crawl_status });
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
  let pdfCandidates: string[] = [];
  try {
    const allLinks = await discoverPages(shop.website_url, firecrawlKey);
    pages = prioritizePages(allLinks, shop.website_url.replace(/\/$/, ""));
    pdfCandidates = findMenuPdfCandidates(allLinks).slice(0, MAX_PDF_CANDIDATES);
    console.log(`[scrape-shop] Discovered ${allLinks.length} links, scraping top ${pages.length}, ${pdfCandidates.length} PDF candidate(s)`);
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

  // Phase 5b: Auto-populate menu items (idempotent: only if menu is empty).
  // Resolved BEFORE the status update so crawl_status reflects what actually landed,
  // not just that the HTTP round-trip completed (the "false success" bug).
  let menuInserted = 0;
  let menuHasUsableItems = false; // true if the shop ends this run with >=1 menu item

  // Resolve the shop's existing menu FIRST, unconditionally. A shop that already has
  // items (owner-entered, or from a prior run / extract-menu-items) is not "partial"
  // just because this run's extraction came back empty — telling that owner to "add
  // your items below" when they already did is the same lie in the other direction.
  const { data: menuData } = await supabase
    .from("menus").select("id").eq("shop_id", shop_id).maybeSingle();
  let existingCount = 0;
  if (menuData) {
    const { count } = await supabase
      .from("menu_items").select("id", { count: "exact", head: true }).eq("menu_id", menuData.id);
    existingCount = count ?? 0;
    if (existingCount > 0) menuHasUsableItems = true;
  } else {
    console.error("[scrape-shop] No menu row found for shop", shop_id);
  }

  if (menuItemsRaw && menuItemsRaw.length > 0) {
    if (menuData) {
      if (existingCount === 0) {
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
          menuHasUsableItems = true;
        }
      }
    }
  }

  // PDF menu fallback: the HTML pass got nothing usable, the shop still has no
  // menu of its own, and we discovered candidate menu PDFs during page discovery
  // (dropped from the HTML crawl by `prioritizePages` by design). Hand the file
  // to parse-menu-pdf, which already does real PDF extraction — never reimplement
  // that here. Bounded to MAX_PDF_CANDIDATES tries; stop at the first one that
  // actually lands priced rows. A slow/failing PDF attempt must never cost us the
  // honest HTML-side partial result already computed above.
  if (!menuHasUsableItems && menuData && pdfCandidates.length > 0) {
    for (const pdfUrl of pdfCandidates) {
      if (Date.now() - startedAt > PDF_FALLBACK_ELAPSED_BUDGET_MS) {
        console.warn(`[scrape-shop] Skipping remaining PDF candidate(s) — elapsed time budget exceeded, keeping honest partial`);
        break;
      }
      try {
        const result = await routeMenuPdf(supabase, pdfUrl, shop_id, supabaseUrl, serviceRoleKey);
        if (result.itemCount > 0) {
          menuInserted = result.itemCount;
          menuHasUsableItems = true;
          console.log(`[scrape-shop] PDF menu route succeeded: ${pdfUrl} -> ${result.itemCount} priced item(s)`);
          break;
        }
        console.log(`[scrape-shop] PDF menu route yielded 0 priced items: ${pdfUrl}${result.error ? ` (${result.error})` : ""}`);
      } catch (err) {
        console.error(`[scrape-shop] PDF menu route error for ${pdfUrl}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const crawlStatus = menuHasUsableItems ? "done" : "partial";
  const crawlError = menuHasUsableItems
    ? null
    : "We read your website but couldn't find a menu with prices. Add your items below and we'll take it from there.";

  const updatePayload: Record<string, unknown> = {
    shop_context: context,
    about: context,
    crawl_status: crawlStatus,
    crawl_error: crawlError,
    menu_links: menuLinkUrls,
  };
  if (openHours) updatePayload.open_hours = openHours;

  const { error: updateErr } = await supabase
    .from("shops").update(updatePayload).eq("id", shop_id);

  if (updateErr) {
    console.error("[scrape-shop] Failed to save context:", updateErr);
    return jsonResponse({ error: "Failed to save context to database" }, 500);
  }

  return jsonResponse({
    ok: true,
    crawl_status: crawlStatus,
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
