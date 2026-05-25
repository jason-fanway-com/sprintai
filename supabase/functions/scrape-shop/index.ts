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
const MAX_COMBINED_CHARS = 50_000;

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
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    .from("shops").select("id, website_url").eq("id", shop_id).single();

  if (shopErr || !shop)  return jsonResponse({ error: "Shop not found" }, 404);
  if (!shop.website_url) return jsonResponse({ error: "Shop has no website_url set" }, 400);

  const firecrawlKey = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
  if (!firecrawlKey) return jsonResponse({ error: "FIRECRAWL_API_KEY not configured" }, 500);

  // Step 1: Discover pages via /map
  let pages: string[];
  try {
    const allLinks = await discoverPages(shop.website_url, firecrawlKey);
    pages = prioritizePages(allLinks, shop.website_url.replace(/\/$/, ""));
    console.log(`[scrape-shop] Discovered ${allLinks.length} links, scraping top ${pages.length}`);
  } catch (err) {
    console.error("[scrape-shop] Firecrawl /map error:", err);
    // Fallback: just scrape the homepage
    pages = [shop.website_url];
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
    return jsonResponse({ error: "No readable text found on website" }, 422);
  }

  console.log(`[scrape-shop] Scraped ${results.length} pages, ${combinedText.length} chars total`);

  // Step 3: Summarize with Claude Sonnet
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) return jsonResponse({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  let claudeRes: Response;
  try {
    claudeRes = await fetch(CLAUDE_API, {
      method:  "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      SONNET_MODEL,
        max_tokens: 1024,
        messages: [
          { role: "user", content: `${CONTEXT_PROMPT}\n\n${combinedText}` },
        ],
      }),
    });
  } catch (err) {
    console.error("[scrape-shop] Claude API fetch error:", err);
    return jsonResponse({ error: "Failed to reach Claude API" }, 500);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error("[scrape-shop] Claude API error:", claudeRes.status, errText);
    return jsonResponse({ error: "Failed to summarize content" }, 500);
  }

  const claudeData: { content: Array<{ type: string; text?: string }> } = await claudeRes.json();
  const context = claudeData.content.find(b => b.type === "text")?.text?.trim() ?? "";

  if (!context) return jsonResponse({ error: "No summary generated" }, 500);

  const { error: updateErr } = await supabase
    .from("shops").update({ shop_context: context }).eq("id", shop_id);

  if (updateErr) {
    console.error("[scrape-shop] Failed to save context:", updateErr);
    return jsonResponse({ error: "Failed to save context to database" }, 500);
  }

  return jsonResponse({
    ok: true,
    pages_discovered: pages.length,
    pages_scraped: results.length,
    context,
  });
});
