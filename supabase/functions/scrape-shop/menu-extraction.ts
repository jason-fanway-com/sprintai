/** Pure, zero-side-effect helpers for extractMenuItems() in index.ts.
 *  Split out so this logic can be `deno test`ed directly — index.ts calls
 *  Deno.serve() at module scope, so it can't be imported by a test file
 *  without binding a real port (see RUNBOOK.md's safety-gate.ts precedent). */

export interface MenuItem {
  name: string;
  price_cents: number;
  category: string;
  description: string;
}

export interface MergedMenuResult {
  items: MenuItem[] | null;
  chunksTotal: number;
  chunksFailed: number;
  truncated: boolean;
}

/** Merges the per-chunk LLM extraction results extractMenuItems() gathers via
 *  Promise.all. A chunk that errored/timed out comes in as `null` — this used
 *  to be silently skipped (`if (!items) continue`), so a run could lose an
 *  entire chunk's items and still report `crawl_status: "done"`. Now every
 *  null is counted, and a merge that exceeds `maxItems` is flagged instead of
 *  being silently sliced away. */
export function mergeMenuChunkResults(
  chunkResults: Array<MenuItem[] | null>,
  maxItems: number,
): MergedMenuResult {
  const merged: MenuItem[] = [];
  const seen = new Set<string>();
  let chunksFailed = 0;
  for (const items of chunkResults) {
    if (!items) {
      chunksFailed++;
      continue;
    }
    for (const item of items) {
      const key = `${(item.name ?? "").trim().toLowerCase()}|${item.price_cents}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  const truncated = merged.length > maxItems;
  return {
    items: merged.length > 0 ? merged.slice(0, maxItems) : null,
    chunksTotal: chunkResults.length,
    chunksFailed,
    truncated,
  };
}

/** Whether the rung-1 website extraction that just landed usable menu items
 *  actually completed cleanly. Scoped to that one insert path (not the
 *  google/aggregator rungs, which run their own independent extractMenuItems()
 *  calls) — see docs/specs/2026-09-05-menu-source-priority.md for why each
 *  rung owns its own provenance. */
export function shouldFlagMenuExtractionIncomplete(
  hasUsableItems: boolean,
  chunksFailed: number,
  truncated: boolean,
): boolean {
  return hasUsableItems && (chunksFailed > 0 || truncated);
}

export function buildMenuExtractionNote(chunksFailed: number, chunksTotal: number, truncated: boolean): string {
  const parts: string[] = [];
  if (chunksFailed > 0) parts.push(`${chunksFailed}/${chunksTotal} extraction chunk(s) failed`);
  if (truncated) parts.push("merged item count exceeded the 300-item cap and was truncated");
  return parts.join("; ");
}
