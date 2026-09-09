// Item 2 (2026-09-09, module extraction): pure money-computation and
// money-text helpers pulled out of index.ts verbatim. No Supabase, no LLM,
// no I/O — deterministic arithmetic and regex over already-known numbers.
//
// computeCartSubtotalCents replaces THREE hand-copied reduce() blocks that
// had drifted into separate spots in index.ts (saveCart, runOrderingLoop's
// correctionApplied short-circuit, and renderItemizedRecap's own inline
// accumulation) — same formula every time, now one tested source of truth.
// A fourth copy already lives in money-footer-20260909.ts's
// renderMoneyFooterLines (pre-existing, untouched here — out of scope for
// this extraction, not worth destabilizing a P0-adjacent file to dedupe
// further).

export interface PricedCartLine {
  type?: string;
  price_cents: number;
  quantity?: number;
  complete?: boolean; // bundle lines only
}

/** Sum of all cart line totals — an incomplete bundle contributes $0. */
export function computeCartSubtotalCents(cart: PricedCartLine[]): number {
  return cart.reduce((s, i) => {
    if (i.type === "bundle") {
      return s + (i.complete ? i.price_cents : 0);
    }
    return s + (i.price_cents * (i.quantity || 1));
  }, 0);
}

// Guard 1 helper: detects dollar amounts quoted when the cart is empty.
// Only fires when cart is empty; a non-empty cart quoting its total is fine.
export function claimsTotal(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    /\$\d+\.?\d*\s*(?:total|plus|each|comes to|would be|will be|is|cost|for that|covers)/i.test(norm) ||
    /(?:total|subtotal|comes to|that'?s|that is|cost|price)\s*(?:\$|of\s*\$)\s*\d+/i.test(norm) ||
    /(?:comes to|totals?|brings? your|your total|order total|that'?ll be|that will be)\s*\$?\s*\d+/i.test(norm)
  );
}

// Helper: extract dollar amounts from text (returns array of cents)
export function extractDollarCents(text: string): number[] {
  const matches = text.matchAll(/\$(\d+(?:\.\d{2})?)/g);
  const cents: number[] = [];
  for (const m of matches) {
    cents.push(Math.round(parseFloat(m[1]) * 100));
  }
  return cents;
}

/**
 * BUG-2 FIX (2026-09-04): render the " — $X.XX total" fragment ONLY when the
 * total is real. Previously guards interpolated the total unconditionally and a
 * later stripLlmMoneyLines() pass removed the dollar amount, leaving a dangling
 * dash and a stray period: "1x French Fries — . What else can I add".
 * Missing / non-finite / <= 0 totals now yield an empty fragment, so the
 * sentence reads "Your cart: 1x French Fries. What else can I add?".
 */
export function cartTotalFragment(totalCents: number | null | undefined): string {
  if (totalCents === null || totalCents === undefined) return "";
  if (!Number.isFinite(totalCents) || totalCents <= 0) return "";
  return ` — $${(totalCents / 100).toFixed(2)} total`;
}
