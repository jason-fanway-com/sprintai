/** Pure, zero-side-effect helpers for the rung-4 aggregator scrape in index.ts —
 *  split out so this logic can be `deno test`ed directly (same reason
 *  menu-extraction.ts exists; index.ts calls Deno.serve() at module scope).
 *
 *  Background: docs/specs/2026-09-05-menu-source-priority.md measured Toast and
 *  ChowNow both returning zero items from a plain Firecrawl scrape. Re-measured
 *  2026-09-08 (see that doc's addendum): ChowNow's storefront is a client-rendered
 *  SPA that hydrates its menu ~1-5s after the initial HTML — a plain Firecrawl
 *  scrape (no wait) catches the empty shell. Giving Firecrawl a `waitFor` window
 *  before it reads the page is enough; no headless-render infra of our own is
 *  needed. Toast is different: a direct fetch 403s at Cloudflare, and even a
 *  Firecrawl scrape with `waitFor` and Firecrawl's own enhanced-proxy retry still
 *  gets served a reCAPTCHA challenge instead of the menu. That's an active
 *  anti-bot wall, not a rendering gap — no `waitFor` value fixes it, so Toast
 *  intentionally gets none here. */

/** How long Firecrawl should wait for the page to hydrate before reading it,
 *  keyed by aggregator platform. 0 means "use Firecrawl's default (no extra
 *  wait)" — the cost/latency of an extra wait is only paid by platforms that
 *  are known to need it. */
const AGGREGATOR_RENDER_WAIT_MS: Record<string, number> = {
  chownow: 5000,
};

export function getAggregatorWaitForMs(platform: string): number {
  return AGGREGATOR_RENDER_WAIT_MS[platform] ?? 0;
}
