// STEP 2 (2026-09-09, P0 -- Zio's incident): the per-turn money footer used
// to fold the fee into a single "N items — $X.XX total" line on every turn
// after the first, with the subtotal/fee breakdown shown only once (gated on
// `order_carts.fee_disclosed_at`) to cut repeat noise. That fold is defect
// class (c) from the incident write-up: a customer who only ever sees a bare
// total on turns 2+ has no independent number to check it against.
//
// Every turn with cart items now renders the same three labelled lines --
// Subtotal, Service fee (+ Delivery/Tip when present), Total -- code-owned,
// never folded. Extracted into its own importable module (same reason
// GUARD 9/13 were, see their headers) so a test exercises the exact renderer
// index.ts calls, not a hand-copied mirror.

export interface MoneyFooterCartLine {
  type?:        "bundle";
  price_cents:  number;
  quantity?:    number;
  complete?:    boolean; // bundle lines only
}

export function renderMoneyFooterLines(
  cart:              MoneyFooterCartLine[],
  feeCents:          number,
  deliveryFeeCents?: number,
  driverTipCents?:   number,
): string {
  if (cart.length === 0) return "";

  const subtotal = cart.reduce((s, i) => {
    if (i.type === "bundle") {
      return s + (i.complete ? i.price_cents : 0);
    }
    return s + (i.price_cents * (i.quantity || 1));
  }, 0);

  const totalCents = subtotal + feeCents + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0);

  const lines: string[] = [];
  lines.push(`Subtotal: $${(subtotal / 100).toFixed(2)}`);
  lines.push(`Service fee: $${(feeCents / 100).toFixed(2)}`);
  if (deliveryFeeCents) lines.push(`Delivery fee: $${(deliveryFeeCents / 100).toFixed(2)}`);
  if (driverTipCents) lines.push(`Driver tip: $${(driverTipCents / 100).toFixed(2)}`);
  lines.push(`Total: $${(totalCents / 100).toFixed(2)}`);

  return lines.join("\n");
}
