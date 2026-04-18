/**
 * SprintAI onboard-tenant Edge Function
 * Scrapes a website, chunks content, generates embeddings, stores in knowledge_base
 * 
 * POST /functions/v1/onboard-tenant
 * Body: { tenant_id: string, website_url: string, force?: boolean }
 * 
 * v2: Added boilerplate stripping, cross-page dedup by content hash, semantic content extraction
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

const OPENAI_API_URL = "https://api.openai.com/v1";
const EMBEDDING_MODEL = "text-embedding-3-small";
const JINA_READER_URL = "https://r.jina.ai/";
const CHUNK_SIZE = 500; // approximate tokens per chunk
const CHUNK_OVERLAP = 50;
const BATCH_SIZE = 20; // embeddings per API call

interface OnboardRequest {
  tenant_id: string;
  website_url: string;
  force?: boolean; // re-scrape even if already onboarded
}

interface ContentChunk {
  content: string;
  source: "website_scrape" | "faq" | "menu";
  metadata: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  let body: OnboardRequest;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const { tenant_id, website_url, force = false } = body;

  if (!tenant_id || !website_url) {
    return jsonError("tenant_id and website_url are required");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // Check if tenant exists
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id, name, onboarding_status")
    .eq("id", tenant_id)
    .single();

  if (tenantError || !tenant) {
    return jsonError(`Tenant not found: ${tenant_id}`, 404);
  }

  if (tenant.onboarding_status === "complete" && !force) {
    return jsonResponse({ message: "Already onboarded. Use force=true to re-scrape." });
  }

  console.log(`[onboard-tenant] Starting onboarding for tenant ${tenant_id}: ${website_url}`);

  // Mark as scraping
  await supabase
    .from("tenants")
    .update({ onboarding_status: "scraping", website_url })
    .eq("id", tenant_id);

  try {
    // ── 1. Scrape website ──
    const pages = await scrapeWebsite(website_url);
    console.log(`[onboard-tenant] Scraped ${pages.length} pages for ${tenant_id}`);

    if (pages.length === 0) {
      throw new Error("No content could be scraped from the website");
    }

    // ── 2. Chunk content (with boilerplate stripping) ──
    const chunks: ContentChunk[] = [];
    for (const page of pages) {
      // Strip boilerplate from each page before chunking
      const cleanContent = stripBoilerplate(page.content);
      if (cleanContent.length < 100) {
        console.log(`[onboard-tenant] Skipping page (no meaningful content after strip): ${page.url}`);
        continue;
      }
      const pageChunks = chunkText(cleanContent, page.url, page.title);
      chunks.push(...pageChunks);
    }
    console.log(`[onboard-tenant] Generated ${chunks.length} chunks for ${tenant_id}`);

    // ── 3. Remove old knowledge base entries (if force re-scrape) ──
    if (force) {
      await supabase
        .from("knowledge_base")
        .delete()
        .eq("tenant_id", tenant_id)
        .eq("source", "website_scrape");
      console.log(`[onboard-tenant] Cleared old entries for ${tenant_id}`);
    }

    // ── 4. Generate embeddings in batches (with cross-page dedup) ──
    await supabase
      .from("tenants")
      .update({ onboarding_status: "embedding" })
      .eq("id", tenant_id);

    const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    const { totalInserted, totalSkipped } = await embedAndStore(supabase, openaiKey, tenant_id, chunks);

    // ── 5. Update tenant config with scraped business info ──
    const businessInfo = extractBusinessInfo(pages);
    if (Object.keys(businessInfo).length > 0) {
      const { data: currentTenant } = await supabase
        .from("tenants")
        .select("config")
        .eq("id", tenant_id)
        .single();

      const existingConfig = (currentTenant?.config as Record<string, unknown>) ?? {};
      const mergedConfig = { ...existingConfig, ...businessInfo };

      await supabase
        .from("tenants")
        .update({ config: mergedConfig })
        .eq("id", tenant_id);
    }

    // ── 6. Mark complete ──
    await supabase
      .from("tenants")
      .update({ onboarding_status: "complete" })
      .eq("id", tenant_id);

    console.log(`[onboard-tenant] Complete for ${tenant_id}. Inserted ${totalInserted} chunks (${totalSkipped} duplicates skipped).`);

    return jsonResponse({
      success: true,
      tenant_id,
      pages_scraped: pages.length,
      chunks_generated: chunks.length,
      embeddings_stored: totalInserted,
      duplicates_skipped: totalSkipped,
      business_info: businessInfo,
    });

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[onboard-tenant] Error for ${tenant_id}:`, errorMsg);

    await supabase
      .from("tenants")
      .update({ onboarding_status: "failed", onboarding_error: errorMsg })
      .eq("id", tenant_id);

    return jsonError(`Onboarding failed: ${errorMsg}`, 500);
  }
});

// ─── Boilerplate Stripping ────────────────────────────────────────────────────

/**
 * Patterns that identify junk content lines to drop entirely.
 * Covers: accessibility plugins, cookie banners, reCAPTCHA notices,
 * "Skip to content" links, social share buttons, etc.
 */
const JUNK_LINE_PATTERNS: RegExp[] = [
  /skip to (content|main|navigation)/i,
  /sogo[- ]?(logo|accessibility)/i,
  /recaptcha/i,
  /this site is protected by recaptcha/i,
  /google\s+privacy policy.*terms of service/i,
  /cookie\s*(consent|policy|banner|notice|settings)/i,
  /accessibility\s*(settings|widget|tool|menu)/i,
  /enable\s+accessibility/i,
  /wcag\s*(2\.\d)?/i,
  // Lines that are ONLY an image markdown with no surrounding text
  /^\s*!\[image\s+\d+[:\s][^\]]*\]\([^)]+\)\s*$/i,
  // Social media share/follow lines
  /^(follow|share|like|tweet|pin)\s+(us\s+)?(on\s+)?(facebook|twitter|instagram|linkedin|youtube|tiktok)/i,
  // Lines that are purely nav/social icon links with no text
  /^\s*\[?\s*(facebook|twitter|instagram|linkedin|youtube|yelp|tiktok|pinterest)\s*\]?\s*(\([^)]*\))?\s*$/i,
];

/**
 * Footer markers — everything from the first match onwards is dropped.
 */
const FOOTER_MARKERS: RegExp[] = [
  /©\s*(copyright\s*)?\d{4}/i,
  /all rights reserved/i,
  /privacy policy.*terms of service/i,
  /terms of service.*privacy policy/i,
  /site map/i,
  /powered by wordpress/i,
];

/**
 * Navigation/header markers — lines matching these near the top of the page
 * are stripped. We stop stripping once we hit a heading or substantive content.
 */
const NAV_LINE_PATTERNS: RegExp[] = [
  /^\s*\[skip to/i,
  /^\s*\*\s+\[home\]/i,
  /^\s*\*\s+\[about\]/i,
  /^\s*\*\s+\[contact\]/i,
  /^\s*\*\s+\[menu\]/i,
  /^\s*\*\s+\[services\]/i,
  /^\s*\*\s+\[order\]/i,
  /^\s*\*\s+\[gallery\]/i,
  /^\s*\*\s+\[blog\]/i,
  /^\s*\*\s+\[careers\]/i,
  /^\s*\*\s+\[faq\]/i,
  /^\s*\*\s+\[location/i,
  /^\s*\*\s+\[hours/i,
  /^\s*\[logo\]/i,
  /^\s*\[navigation\]/i,
];

/**
 * Remove navigation header, footer, and plugin junk from a page's markdown content.
 * Strategy:
 * 1. Drop lines matching junk patterns
 * 2. Truncate at first footer marker
 * 3. If page has a clear nav block at top (bullet list of page links), skip it
 */
function stripBoilerplate(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let footerReached = false;
  let navBlockEnded = false; // track when we've passed the top nav section
  let linesWithContent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Once footer is reached, stop processing
    if (footerReached) break;

    // Check for footer markers
    if (FOOTER_MARKERS.some((rx) => rx.test(line))) {
      footerReached = true;
      break;
    }

    // Check for explicit junk lines (accessibility plugins, reCAPTCHA, etc.)
    if (JUNK_LINE_PATTERNS.some((rx) => rx.test(line))) {
      continue;
    }

    // Skip nav block lines at the top of the page (before first real content)
    // "Nav block" = bullet list of links before the first heading or paragraph
    if (!navBlockEnded) {
      if (NAV_LINE_PATTERNS.some((rx) => rx.test(line))) {
        continue;
      }
      // Once we see a heading or non-trivial line, nav block is done
      if (/^#{1,3}\s/.test(line) || (line.trim().length > 40 && !/^\s*\*\s*\[/.test(line))) {
        navBlockEnded = true;
      }
    }

    // Drop pure image lines (logo/icon with no surrounding text context)
    // Only drop if the line is SOLELY the image markdown
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line) && line.trim().startsWith("![")) {
      // Keep if it appears to have meaningful alt text (not just "Image N: ...")
      const altMatch = line.match(/!\[([^\]]*)\]/);
      const altText = altMatch ? altMatch[1] : "";
      if (/^image\s+\d+/i.test(altText) || altText.trim() === "") {
        continue;
      }
    }

    result.push(line);
    if (line.trim().length > 20) linesWithContent++;
  }

  // Clean up: remove consecutive blank lines, trim
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Scraping ────────────────────────────────────────────────────────────────

interface ScrapedPage {
  url: string;
  title: string;
  content: string;
}

// Binary/non-text extensions to skip
const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".mp4", ".mp3", ".avi", ".mov",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".css", ".js", ".xml",
]);

// Common fallback paths to try if not discovered via crawl
const FALLBACK_PATHS = ["/about", "/services", "/contact", "/faq", "/pricing", "/menu"];

/** Extract internal links from Jina markdown content */
function extractLinks(content: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const discovered = new Set<string>();

  // Match markdown links: [text](url)
  const mdLinkRegex = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLinkRegex.exec(content)) !== null) {
    const href = match[1].trim().split(" ")[0]; // strip optional title
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname === base.hostname) {
        resolved.hash = "";
        resolved.search = "";
        discovered.add(resolved.href);
      }
    } catch {
      // Not a valid URL, skip
    }
  }

  // Also match bare URLs in text (http:// or https:// form)
  const bareUrlRegex = /https?:\/\/([^\s\)\"\'<>]+)/g;
  while ((match = bareUrlRegex.exec(content)) !== null) {
    const href = match[0].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    try {
      const resolved = new URL(href);
      if (resolved.hostname === base.hostname) {
        resolved.hash = "";
        resolved.search = "";
        discovered.add(resolved.href);
      }
    } catch {
      // skip
    }
  }

  // Filter out binary/skip extensions
  return Array.from(discovered).filter((url) => {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.substring(pathname.lastIndexOf("."));
    return !SKIP_EXTENSIONS.has(ext);
  });
}

/** Scrape a website using Jina Reader API — crawls discovered links, not hardcoded paths */
async function scrapeWebsite(websiteUrl: string): Promise<ScrapedPage[]> {
  const pages: ScrapedPage[] = [];

  // Normalize URL
  const baseUrl = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;

  const MAX_PAGES = 25;
  const scraped = new Set<string>(); // normalized URLs already attempted
  const queue: string[] = [baseUrl];

  // Helper: normalize for dedup (strip trailing slash, lowercase host)
  const normalize = (u: string): string => {
    try {
      const parsed = new URL(u);
      parsed.hostname = parsed.hostname.toLowerCase();
      if (parsed.pathname !== "/") {
        parsed.pathname = parsed.pathname.replace(/\/$/, "");
      }
      return parsed.href;
    } catch {
      return u;
    }
  };

  console.log(`[onboard-tenant] Starting crawl from ${baseUrl}`);

  // Scrape homepage first and extract links from it
  scraped.add(normalize(baseUrl));
  const homepage = await scrapePageWithJina(baseUrl);
  await sleep(500);

  if (homepage && homepage.content.length > 100) {
    pages.push(homepage);

    // Discover internal links from homepage
    const discovered = extractLinks(homepage.content, baseUrl);
    console.log(`[onboard-tenant] Discovered ${discovered.length} internal links from homepage`);

    for (const link of discovered) {
      const norm = normalize(link);
      if (!scraped.has(norm)) {
        queue.push(link);
      }
    }
  }

  // Add fallback paths (skip ones already queued or scraped)
  for (const path of FALLBACK_PATHS) {
    const fallbackUrl = `${baseUrl}${path}`;
    const norm = normalize(fallbackUrl);
    if (!scraped.has(norm) && !queue.some((q) => normalize(q) === norm)) {
      queue.push(fallbackUrl);
    }
  }

  console.log(`[onboard-tenant] Queue has ${queue.length} pages to crawl (max ${MAX_PAGES})`);

  // Crawl queued pages
  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    const norm = normalize(url);

    if (scraped.has(norm)) continue;
    scraped.add(norm);

    // Skip binary extensions
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.substring(pathname.lastIndexOf("."));
    if (SKIP_EXTENSIONS.has(ext)) {
      console.log(`[onboard-tenant] Skipping binary URL: ${url}`);
      continue;
    }

    try {
      const page = await scrapePageWithJina(url);
      if (page && page.content.length > 100) {
        pages.push(page);
        console.log(`[onboard-tenant] Scraped [${pages.length}/${MAX_PAGES}]: ${url}`);
      } else {
        console.log(`[onboard-tenant] Skipped (thin content): ${url}`);
      }
    } catch (err) {
      console.log(`[onboard-tenant] Skipping ${url}: ${err}`);
    }

    await sleep(500);
  }

  console.log(`[onboard-tenant] Crawl complete. Scraped ${scraped.size} URLs, got content from ${pages.length} pages.`);

  // Deduplicate pages by raw content fingerprint (first 200 chars) 
  // This handles redirect chains or identical pages served under different URLs
  const seen = new Set<string>();
  return pages.filter((p) => {
    const hash = p.content.substring(0, 200);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/** Scrape a single page using Jina Reader */
async function scrapePageWithJina(url: string): Promise<ScrapedPage | null> {
  const jinaUrl = `${JINA_READER_URL}${url}`;

  const res = await fetch(jinaUrl, {
    headers: {
      "Accept": "text/plain",
      "X-Return-Format": "markdown",
      "X-No-Cache": "true",
    },
    signal: AbortSignal.timeout(15000), // 15s timeout per page
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Jina fetch failed: ${res.status} for ${url}`);
  }

  const text = await res.text();

  // Parse Jina header block: "Title: ...\nURL Source: ...\n\n<content>"
  const lines = text.split("\n");
  let title = "Page";
  let contentStart = 0;

  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].startsWith("Title:")) {
      title = lines[i].replace("Title:", "").trim();
    }
    // Content starts after the blank line following the header block
    if (lines[i].trim() === "" && i > 0 && contentStart === 0) {
      contentStart = i + 1;
    }
  }

  const content = lines.slice(contentStart).join("\n").trim();

  if (content.length < 50) return null;

  return { url, title, content };
}

// ─── Chunking ────────────────────────────────────────────────────────────────

/** Split text into overlapping chunks of approximately CHUNK_SIZE tokens */
function chunkText(text: string, url: string, title: string): ContentChunk[] {
  // Rough token estimate: 1 token ≈ 4 chars
  const chunkChars = CHUNK_SIZE * 4;
  const overlapChars = CHUNK_OVERLAP * 4;

  const chunks: ContentChunk[] = [];

  // Split by paragraphs first (preserve semantic boundaries)
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);

  let currentChunk = "";
  let chunkIndex = 0;

  for (const para of paragraphs) {
    // If adding this paragraph would exceed chunk size, save current chunk
    if (currentChunk.length + para.length > chunkChars && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        source: "website_scrape",
        metadata: {
          url,
          title,
          chunk_index: chunkIndex,
        },
      });
      chunkIndex++;

      // Keep overlap from end of current chunk
      const overlapText = currentChunk.slice(-overlapChars);
      currentChunk = overlapText + "\n\n" + para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }

  // Save last chunk
  if (currentChunk.trim().length > 50) {
    chunks.push({
      content: currentChunk.trim(),
      source: "website_scrape",
      metadata: {
        url,
        title,
        chunk_index: chunkIndex,
      },
    });
  }

  return chunks;
}

// ─── Content Hash ─────────────────────────────────────────────────────────────

/**
 * Simple deterministic hash of a string for dedup.
 * Uses djb2 algorithm — fast and good enough for chunk dedup.
 */
function contentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── Embedding + Storage ─────────────────────────────────────────────────────

/** Generate embeddings in batches and store in Supabase — deduplicates by content hash */
async function embedAndStore(
  supabase: ReturnType<typeof createClient>,
  openaiKey: string,
  tenantId: string,
  chunks: ContentChunk[]
): Promise<{ totalInserted: number; totalSkipped: number }> {
  let totalInserted = 0;
  let totalSkipped = 0;

  // ── Build a set of existing content hashes for this tenant (website_scrape source) ──
  // This prevents duplicate chunks when the same boilerplate appears on multiple pages
  const existingHashes = new Set<string>();
  const { data: existingRows } = await supabase
    .from("knowledge_base")
    .select("metadata")
    .eq("tenant_id", tenantId)
    .eq("source", "website_scrape");

  if (existingRows) {
    for (const row of existingRows) {
      const meta = row.metadata as Record<string, unknown>;
      if (meta?.content_hash) {
        existingHashes.add(meta.content_hash as string);
      }
    }
  }

  // ── Deduplicate chunks within this batch by content hash ──
  const dedupedChunks: ContentChunk[] = [];
  const seenHashes = new Set<string>(existingHashes);

  for (const chunk of chunks) {
    // Normalize whitespace for hashing so minor formatting differences don't create dupes
    const normalized = chunk.content.replace(/\s+/g, " ").trim();
    const hash = contentHash(normalized);

    if (seenHashes.has(hash)) {
      totalSkipped++;
      console.log(`[onboard-tenant] Dedup skip: hash=${hash} (first 60 chars: ${normalized.substring(0, 60)})`);
      continue;
    }

    seenHashes.add(hash);
    // Attach the hash to metadata for future dedup checks
    chunk.metadata.content_hash = hash;
    dedupedChunks.push(chunk);
  }

  console.log(`[onboard-tenant] After dedup: ${dedupedChunks.length} unique chunks (${totalSkipped} duplicates dropped)`);

  // ── Embed and store deduped chunks in batches ──
  for (let i = 0; i < dedupedChunks.length; i += BATCH_SIZE) {
    const batch = dedupedChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    // Generate embeddings
    const embeddings = await generateEmbeddings(openaiKey, texts);

    if (embeddings.length !== batch.length) {
      console.error(`[onboard-tenant] Embedding count mismatch: expected ${batch.length}, got ${embeddings.length}`);
      continue;
    }

    // Prepare rows for insertion
    const rows = batch.map((chunk, idx) => ({
      tenant_id: tenantId,
      content: chunk.content,
      embedding: JSON.stringify(embeddings[idx]), // Supabase expects vector as JSON array
      source: chunk.source,
      metadata: chunk.metadata,
    }));

    const { error } = await supabase.from("knowledge_base").insert(rows);
    if (error) {
      console.error(`[onboard-tenant] Insert error for batch ${i}:`, error);
    } else {
      totalInserted += batch.length;
    }

    // Rate limit OpenAI
    await sleep(200);

    console.log(`[onboard-tenant] Processed ${Math.min(i + BATCH_SIZE, dedupedChunks.length)}/${dedupedChunks.length} chunks`);
  }

  return { totalInserted, totalSkipped };
}

/** Generate embeddings via OpenAI */
async function generateEmbeddings(apiKey: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OPENAI_API_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI embeddings error: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  return data.data.map((item: { embedding: number[] }) => item.embedding);
}

// ─── Business Info Extraction ─────────────────────────────────────────────────

/** Extract key business info from scraped pages */
function extractBusinessInfo(pages: ScrapedPage[]): Record<string, string> {
  const allText = pages.map((p) => p.content).join("\n");
  const info: Record<string, string> = {};

  // Extract hours patterns
  const hoursMatch = allText.match(
    /(?:hours?|open|schedule)[:\s]+([^\n.]{10,100}(?:am|pm|[0-9]+:[0-9]+)[^\n.]{0,80})/i
  );
  if (hoursMatch) {
    info.hours = hoursMatch[1].trim().substring(0, 200);
  }

  // Extract address patterns
  const addressMatch = allText.match(
    /(\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)[,\s]+[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5})/i
  );
  if (addressMatch) {
    info.address = addressMatch[1].trim();
  }

  // Extract phone
  const phoneMatch = allText.match(/(\+?1?\s*[-.]?\s*\(?\d{3}\)?\s*[-.]?\s*\d{3}\s*[-.]?\s*\d{4})/);
  if (phoneMatch) {
    info.phone = phoneMatch[1].trim();
  }

  // Extract email
  const emailMatch = allText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) {
    info.email = emailMatch[1];
  }

  return info;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
