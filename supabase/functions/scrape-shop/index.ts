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
// Source priority ladder (docs/specs/2026-09-05-menu-source-priority.md):
// rung 1 own site (html + own-domain PDF, above) already has its own budget.
// Rungs 3 (Google listing) and 4 (aggregator) are LAST RESORTS and each cost
// a Places lookup and/or another Firecrawl scrape + LLM call — bound the total
// so a shop that fails every rung can't run the function past its timeout.
const LADDER_FALLBACK_ELAPSED_BUDGET_MS = 130_000;
const GOOGLE_PLACES_DETAILS_BASE = "https://places.googleapis.com/v1/places";
// Menu prompt asks for up to 300 items; 8000 tokens truncates real menus mid-JSON.
// 300 items x ~45 tokens ~= 13.5k, so 16k covers the prompt's own contract with headroom.
// Deliberately NOT the model's 64k ceiling: this fetch blocks the edge function's wall
// clock, and a 64k generation can outlive it — the run then dies mid-flight and every
// crawled page is thrown away. finish_reason=length is logged if 16k ever binds.
const MENU_MAX_TOKENS = 16_000;
// Hard bound so a stalled upstream can never eat the whole function budget; on abort the
// catch below returns null and the caller records "partial" instead of dying silently.
const LLM_TIMEOUT_MS = 90_000;
// Menu extraction generates far more output than hours/context (up to 300 items at
// MENU_MAX_TOKENS=16k). Measured 2026-09-05 on a real 150-item menu (biaggiopizza.com):
// the model needed ~121s to finish, so LLM_TIMEOUT_MS=90s was aborting the fetch mid-generation
// and returning null — reported as "no_priced_items" for a menu that was fully extractable.
// That's a timeout bug, not a missing-menu result; give this call more room.
const MENU_LLM_TIMEOUT_MS = 170_000;

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

/** Extract PDF hrefs directly out of homepage HTML. Firecrawl /map only
 *  surfaces links it chooses to crawl, which misses off-domain CDN-hosted
 *  PDFs (e.g. a Webflow asset host) and can miss relative hrefs entirely —
 *  both observed on real shop sites. Anchor parsing catches what /map drops. */
function extractPdfLinksFromHtml(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    if (!/\.pdf(\?|$)/i.test(href)) continue;
    try {
      links.push(new URL(href, baseUrl).href);
    } catch {
      // skip unparseable hrefs
    }
  }
  return links;
}

/** Rung 4 (LAST RESORT) — known off-domain ordering platforms. Measured
 *  2026-09-05 (docs/specs/2026-09-05-menu-source-priority.md): Slice returns a
 *  usable priced menu; Toast/ChowNow return zero items because their storefront
 *  is a JS app our static scrape can't read (a rendering scraper is out of
 *  scope here). Marketplaces (DoorDash/UberEats/GrubHub) are deliberately
 *  excluded — they mark up restaurant prices, unlike the direct-order/POS
 *  platforms below where the restaurant sets the price. */
const AGGREGATOR_DOMAINS: Array<{ pattern: RegExp; platform: string; label: string }> = [
  { pattern: /slicelife\.com|slice\.com/i, platform: "slice",   label: "Slice" },
  { pattern: /toasttab\.com/i,             platform: "toast",   label: "Toast" },
  { pattern: /chownow\.com/i,              platform: "chownow", label: "ChowNow" },
  { pattern: /order\.online/i,             platform: "order_online", label: "your ordering site" },
  { pattern: /orderowner\.com|\bowner\.com/i, platform: "owner", label: "your ordering site" },
];

function findAggregatorMatch(url: string): { platform: string; label: string } | null {
  for (const { pattern, platform, label } of AGGREGATOR_DOMAINS) {
    if (pattern.test(url)) return { platform, label };
  }
  return null;
}

/** White-label trap (docs/specs/2026-09-05-menu-source-priority.md, item D):
 *  familypizzeriamenu.com and biaggiopizza.com/menu both serve a *custom* domain whose
 *  page assets are actually rendered by an aggregator's platform underneath — "the
 *  restaurant's own site" wearing the aggregator as a costume. findAggregatorMatch()
 *  only catches the overt case (URL literally on slicelife.com/toasttab.com/etc.); this
 *  catches the disguised case by looking for the platform's asset/CDN signature in the
 *  page content itself. Only meaningful when the domain isn't already an overt
 *  aggregator domain — that's not a costume, it's not hiding anything. */
const WHITE_LABEL_BACKEND_SIGNATURES: Array<{ pattern: RegExp; platform: string }> = [
  { pattern: /pluto-images\.|static-content\.owner\.com|powered by owner/i, platform: "owner" },
  { pattern: /slicelife\.com|powered by slice/i, platform: "slice" },
  { pattern: /toasttab\.com/i, platform: "toast" },
  { pattern: /chownow\.com/i, platform: "chownow" },
];

function detectWhiteLabelBackend(combinedText: string, ownWebsiteUrl: string): string | null {
  if (findAggregatorMatch(ownWebsiteUrl)) return null;
  for (const { pattern, platform } of WHITE_LABEL_BACKEND_SIGNATURES) {
    if (pattern.test(combinedText)) return platform;
  }
  return null;
}

/** Extract off-domain "Order Online" links to known aggregator platforms out
 *  of homepage HTML — same anchor-scan approach as extractPdfLinksFromHtml,
 *  since Firecrawl /map only surfaces links it chooses to crawl. */
function extractAggregatorLinksFromHtml(html: string, baseUrl: string): Array<{ url: string; platform: string; label: string }> {
  const found: Array<{ url: string; platform: string; label: string }> = [];
  const seenPlatforms = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const agg = findAggregatorMatch(href);
    if (!agg || seenPlatforms.has(agg.platform)) continue;
    try {
      found.push({ url: new URL(href, baseUrl).href, ...agg });
      seenPlatforms.add(agg.platform);
    } catch {
      // skip unparseable hrefs
    }
  }
  return found;
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
async function scrapePage(url: string, apiKey: string, includeRaw = false): Promise<{ markdown: string; structured: string; pdfLinks: string[]; aggregatorLinks: Array<{ url: string; platform: string; label: string }> }> {
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

    if (!res.ok) return { markdown: "", structured: "", pdfLinks: [], aggregatorLinks: [] };

    const data: { success: boolean; data?: { markdown?: string; rawHtml?: string } } = await res.json();
    const markdown = data.data?.markdown ?? "";
    const structured = includeRaw && data.data?.rawHtml ? extractStructuredData(data.data.rawHtml) : "";
    const pdfLinks = includeRaw && data.data?.rawHtml ? extractPdfLinksFromHtml(data.data.rawHtml, url) : [];
    const aggregatorLinks = includeRaw && data.data?.rawHtml ? extractAggregatorLinksFromHtml(data.data.rawHtml, url) : [];
    return { markdown, structured, pdfLinks, aggregatorLinks };
  } catch {
    return { markdown: "", structured: "", pdfLinks: [], aggregatorLinks: [] };
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
      signal: AbortSignal.timeout(MENU_LLM_TIMEOUT_MS),
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
  // Rung 1: this PDF was found on the restaurant's OWN domain during the site
  // crawl, not uploaded by the owner — tag it 'website' so it's told apart
  // from a manual owner upload (which still defaults to 'pdf' in parse-menu-pdf).
  form.append("source", "website");
  form.append("source_ref", pdfUrl);

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

type RungLog = { rung: number; source: string; result: string; platform?: string; url?: string; items?: number; backend?: string };

/** Insert LLM-extracted items with explicit provenance (rung 3 or 4). Shared
 *  by the Google-listing and aggregator rungs below — both scrape an off-domain
 *  page and hand its markdown to the same extractMenuItems() the html rung uses. */
async function insertProvenancedItems(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  menuId: string,
  items: Array<{ name: string; price_cents: number; category: string; description: string }>,
  source: "google" | "aggregator",
  sourceRef: string,
  flagForOwnerReview: boolean,
  flagReason?: string,
): Promise<{ inserted: number; error?: string }> {
  const rows = items.map((it, idx) => ({
    menu_id: menuId,
    name: it.name,
    price_cents: it.price_cents || 0,
    category: it.category || "",
    description: it.description || "",
    display_order: idx,
    active: true,
    is_available: true,
    owner_edited: false,
    source,
    source_ref: sourceRef,
    ...(flagForOwnerReview ? { confidence_score: 0.5, flag_review: true, flag_reason: flagReason } : {}),
  }));
  const { error } = await supabase.from("menu_items").insert(rows);
  if (error) return { inserted: 0, error: error.message };
  return { inserted: rows.length };
}

/** Rung 3 (Google listing) — a stub, not a full crawl (spec's own assessment:
 *  "not close to buildable today"). The Places API exposes no structured menu,
 *  only a `websiteUri`. This only does anything when that URL is (a) present,
 *  (b) not the same domain rung 1 already tried, and (c) not itself an
 *  aggregator link — in which case it's handed to rung 4 instead of double
 *  counting. One cheap single-page scrape, no multi-page crawl. */
async function tryGoogleListingRung(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  shop: { google_place_id?: string | null; website_url: string },
  menuId: string,
  googleApiKey: string,
  firecrawlKey: string,
  openRouterKey: string,
  anthropicKey: string,
): Promise<{ success: boolean; itemCount: number; url?: string; rungLog: RungLog; deferredAggregator?: { url: string; platform: string; label: string } }> {
  if (!shop.google_place_id) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "no_place_id" } };
  }
  if (!googleApiKey) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "google_api_key_not_configured" } };
  }

  let websiteUri = "";
  try {
    const res = await fetch(`${GOOGLE_PLACES_DETAILS_BASE}/${shop.google_place_id}`, {
      headers: { "X-Goog-Api-Key": googleApiKey, "X-Goog-FieldMask": "websiteUri" },
    });
    if (!res.ok) {
      return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: `places_lookup_failed_${res.status}` } };
    }
    const data = await res.json();
    websiteUri = data?.websiteUri ?? "";
  } catch (err) {
    console.error("[scrape-shop] Google Places details error:", err);
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "places_lookup_error" } };
  }

  if (!websiteUri) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "no_menu_available" } };
  }

  const normalize = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (shop.website_url && normalize(websiteUri) === normalize(shop.website_url)) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "same_as_website", url: websiteUri } };
  }

  const agg = findAggregatorMatch(websiteUri);
  if (agg) {
    return {
      success: false, itemCount: 0,
      rungLog: { rung: 3, source: "google", result: "aggregator_link_deferred_to_rung4", url: websiteUri, platform: agg.platform },
      deferredAggregator: { url: websiteUri, ...agg },
    };
  }

  const { markdown } = await scrapePage(websiteUri, firecrawlKey, false);
  if (!markdown.trim()) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "no_content", url: websiteUri } };
  }
  const items = await extractMenuItems(markdown.substring(0, MAX_COMBINED_CHARS), openRouterKey, anthropicKey);
  if (!items || items.length === 0) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: "no_priced_items", url: websiteUri } };
  }

  const { inserted, error } = await insertProvenancedItems(supabase, menuId, items, "google", websiteUri, false);
  if (error) {
    return { success: false, itemCount: 0, rungLog: { rung: 3, source: "google", result: `insert_failed: ${error}`, url: websiteUri } };
  }
  return { success: true, itemCount: inserted, url: websiteUri, rungLog: { rung: 3, source: "google", result: "ok", url: websiteUri, items: inserted } };
}

/** Rung 4 (LAST RESORT) — follow an off-domain "Order Online" link to a known
 *  direct-order platform. Every item lands flagged for owner review: an
 *  aggregator's price is not known to be the restaurant's own price (that's
 *  the whole reason this rung is last), so it must never look as trusted as a
 *  rung-1 import. Toast/ChowNow are expected to return 0 items here — their
 *  storefront is a JS app a static scrape can't read; that's an honest
 *  no_priced_items result, not a bug in this function. */
async function tryAggregatorRung(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  menuId: string,
  aggLink: { url: string; platform: string; label: string },
  firecrawlKey: string,
  openRouterKey: string,
  anthropicKey: string,
): Promise<{ success: boolean; itemCount: number; rungLog: RungLog }> {
  const { markdown } = await scrapePage(aggLink.url, firecrawlKey, false);
  if (!markdown.trim()) {
    return { success: false, itemCount: 0, rungLog: { rung: 4, source: "aggregator", platform: aggLink.platform, url: aggLink.url, result: "no_content" } };
  }

  const items = await extractMenuItems(markdown.substring(0, MAX_COMBINED_CHARS), openRouterKey, anthropicKey);
  if (!items || items.length === 0) {
    return { success: false, itemCount: 0, rungLog: { rung: 4, source: "aggregator", platform: aggLink.platform, url: aggLink.url, result: "no_priced_items" } };
  }

  const flagReason = `This price came from ${aggLink.label === "your ordering site" ? aggLink.label : aggLink.label + ", not from you"}. Ordering sites often list higher prices than what you charge directly — please check this against your actual price.`;
  const { inserted, error } = await insertProvenancedItems(supabase, menuId, items, "aggregator", aggLink.url, true, flagReason);
  if (error) {
    return { success: false, itemCount: 0, rungLog: { rung: 4, source: "aggregator", platform: aggLink.platform, url: aggLink.url, result: `insert_failed: ${error}` } };
  }
  return { success: true, itemCount: inserted, rungLog: { rung: 4, source: "aggregator", platform: aggLink.platform, url: aggLink.url, result: "ok", items: inserted } };
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
    .from("shops").select("id, website_url, crawl_status, updated_at, google_place_id").eq("id", shop_id).single();

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
    // Ranked but not yet sliced to MAX_PDF_CANDIDATES — homepage-HTML PDF links
    // (below) still need to be merged in before the final cut.
    pdfCandidates = findMenuPdfCandidates(allLinks);
    console.log(`[scrape-shop] Discovered ${allLinks.length} links, scraping top ${pages.length}, ${pdfCandidates.length} PDF candidate(s) from /map`);
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
  let homepagePdfLinks: string[] = [];
  let homepageAggregatorLinks: Array<{ url: string; platform: string; label: string }> = [];
  for (let i = 0; i < pages.length; i++) {
    const pageUrl = pages[i];
    const includeRaw = i === 0; // only homepage for structured data
    const { markdown, structured, pdfLinks, aggregatorLinks } = await scrapePage(pageUrl, firecrawlKey, includeRaw);
    if (markdown.trim()) results.push(`## Source: ${pageUrl}\n\n${markdown}`);
    if (structured) structuredContext = structured;
    if (pdfLinks.length) homepagePdfLinks = pdfLinks;
    if (aggregatorLinks.length) homepageAggregatorLinks = aggregatorLinks;
  }

  // Merge homepage-HTML PDF links (catches off-domain CDN hosts and relative
  // hrefs that Firecrawl /map misses) into the /map-derived candidates, then
  // re-rank and re-cut to MAX_PDF_CANDIDATES.
  if (homepagePdfLinks.length) {
    const merged = Array.from(new Set([...pdfCandidates, ...homepagePdfLinks]));
    pdfCandidates = findMenuPdfCandidates(merged);
    console.log(`[scrape-shop] Merged ${homepagePdfLinks.length} homepage-HTML PDF link(s), ${pdfCandidates.length} total PDF candidate(s)`);
  }
  pdfCandidates = pdfCandidates.slice(0, MAX_PDF_CANDIDATES);

  // Prepend structured data so the summarizer sees address, hours, etc.
  if (structuredContext) {
    results.unshift(`## Structured Data (JSON-LD + Footer)\n\n${structuredContext}`);
  }

  const combinedText = results.join("\n\n---\n\n").substring(0, MAX_COMBINED_CHARS);
  const websiteBackend = detectWhiteLabelBackend(combinedText, shop.website_url);

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

  // Ladder rung 1 (own site, HTML) + the ladder bookkeeping. rungsTried and
  // finalSource/finalSourceDetail stay empty unless this run is actually the
  // one deciding the menu's provenance (existingCount === 0) — a shop that
  // already has items keeps whatever provenance it already has.
  const rungsTried: RungLog[] = [];
  let finalSource: "website" | "google" | "aggregator" | null = null;
  let finalSourceRef: string | null = null;

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
          source: "website",
          source_ref: shop.website_url,
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

  // Source priority ladder — rungs 3 (Google listing) and 4 (aggregator), LAST
  // RESORTS, only run when rung 1 (website, above — HTML or own-domain PDF)
  // and rung 2 (owner upload — not something this function drives; logged as
  // "not_provided") produced nothing. Only meaningful when this run owns the
  // menu's provenance (existingCount === 0); an already-populated menu is left
  // alone. docs/specs/2026-09-05-menu-source-priority.md.
  if (menuData && existingCount === 0) {
    rungsTried.push({ rung: 1, source: "website", result: menuHasUsableItems ? "ok" : "no_priced_items", ...(menuHasUsableItems ? { items: menuInserted } : {}), ...(websiteBackend ? { backend: websiteBackend } : {}) });
    rungsTried.push({ rung: 2, source: "owner_upload", result: "not_provided" });

    if (menuHasUsableItems) {
      finalSource = "website";
      finalSourceRef = shop.website_url;
    }

    let deferredAggregator: { url: string; platform: string; label: string } | undefined;

    if (!menuHasUsableItems) {
      if (Date.now() - startedAt > LADDER_FALLBACK_ELAPSED_BUDGET_MS) {
        rungsTried.push({ rung: 3, source: "google", result: "skipped_elapsed_budget" });
      } else {
        const googleApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
        const googleResult = await tryGoogleListingRung(supabase, shop, menuData.id, googleApiKey, firecrawlKey, openRouterKey, anthropicKey);
        rungsTried.push(googleResult.rungLog);
        if (googleResult.success) {
          menuInserted = googleResult.itemCount;
          menuHasUsableItems = true;
          finalSource = "google";
          finalSourceRef = googleResult.url ?? null;
        } else {
          deferredAggregator = googleResult.deferredAggregator;
        }
      }
    }

    if (!menuHasUsableItems) {
      if (Date.now() - startedAt > LADDER_FALLBACK_ELAPSED_BUDGET_MS) {
        rungsTried.push({ rung: 4, source: "aggregator", result: "skipped_elapsed_budget" });
      } else {
        // Prefer a link actually found on the homepage; fall back to one the
        // Google listing pointed at only if the homepage didn't have one.
        const aggLink = homepageAggregatorLinks[0] ?? deferredAggregator;
        if (!aggLink) {
          rungsTried.push({ rung: 4, source: "aggregator", result: "no_aggregator_link_found" });
        } else {
          const aggResult = await tryAggregatorRung(supabase, menuData.id, aggLink, firecrawlKey, openRouterKey, anthropicKey);
          rungsTried.push(aggResult.rungLog);
          if (aggResult.success) {
            menuInserted = aggResult.itemCount;
            menuHasUsableItems = true;
            finalSource = "aggregator";
            finalSourceRef = aggLink.url;
          }
        }
      }
    }

    const menuUpdate: Record<string, unknown> = {
      source_detail: {
        rung: finalSource === "website" ? 1 : finalSource === "google" ? 3 : finalSource === "aggregator" ? 4 : null,
        platform: finalSource === "aggregator" ? findAggregatorMatch(finalSourceRef ?? "")?.platform ?? null : null,
        url: finalSourceRef,
        fetched_at: new Date().toISOString(),
        rungs_tried: rungsTried,
        // The DOMAIN can say "website" while the page is actually rendered by an
        // aggregator underneath (the white-label trap — see detectWhiteLabelBackend).
        // Recorded regardless of which rung ultimately won, so "source=website" never
        // reads as more independent than it actually is.
        on_domain_backend: websiteBackend,
      },
    };
    if (finalSource) menuUpdate.source = finalSource;
    const { error: menuUpdateErr } = await supabase.from("menus").update(menuUpdate).eq("id", menuData.id);
    if (menuUpdateErr) console.error("[scrape-shop] Failed to save menu source_detail:", menuUpdateErr);
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
    menu_source: finalSource,
    rungs_tried: rungsTried,
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
