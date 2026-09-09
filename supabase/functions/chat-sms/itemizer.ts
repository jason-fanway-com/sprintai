// Item 2 (2026-09-09, module extraction): deterministic itemized-receipt
// rendering pulled out of index.ts verbatim. Pure string building over an
// already-known cart — no Supabase, no LLM, no I/O.

import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import { renderMoneyFooterLines } from "./money-footer-20260909.ts";

export interface ItemizedCartLine {
  type?: "bundle";
  name: string;
  price_cents: number;
  complete?: boolean; // bundle lines only
  selections?: Array<{ flavor: string; quantity: number }>; // bundle lines only
  quantity?: number;
  modifiers?: string[];
  options?: Record<string, string[]>;
}

/**
 * Right-pads `label`, right-aligns `amount`, to a fixed total width — a
 * plain-text receipt column, no box-drawing characters (reads correctly in
 * an SMS). Falls back to a single space when the label alone already fills
 * the width, so a long item name never throws on a negative repeat count.
 */
export function padReceiptLine(label: string, amount: string, width = 38): string {
  const gap = Math.max(1, width - label.length - amount.length);
  return `${label}${" ".repeat(gap)}${amount}`;
}

/**
 * Deterministic itemized recap — a full plain-text receipt (line items with
 * their own price, chosen options, subtotal, service fee, and total), not
 * just a count and a total. This is the structural defense against the
 * double-charge class (2026-09-06, Jason: "Luca only caught a $37 error
 * because he happened to read a number") — the model never states these
 * figures itself.
 */
export function renderItemizedRecap(cart: ItemizedCartLine[], deliveryFeeCents?: number, driverTipCents?: number): string {
  const lines: string[] = [];
  let subtotal = 0;
  for (const i of cart) {
    if (i.type === "bundle") {
      if (!i.complete) continue; // an incomplete bundle has no settled price yet
      subtotal += i.price_cents;
      const detail = (i.selections ?? []).map(s => `${s.quantity}x ${s.flavor}`).join(", ");
      lines.push(padReceiptLine(`${i.name}${detail ? ` (${detail})` : ""}`, `$${(i.price_cents / 100).toFixed(2)}`));
      continue;
    }
    const lineTotal = i.price_cents * (i.quantity || 1);
    subtotal += lineTotal;
    const qtyPrefix = (i.quantity || 1) > 1 ? `${i.quantity}x ` : "";
    const detail = (i.modifiers?.length ?? 0) > 0
      ? i.modifiers!.join(", ")
      : (i.options ? Object.entries(i.options).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ") : "");
    lines.push(padReceiptLine(`${qtyPrefix}${i.name}${detail ? ` (${detail})` : ""}`, `$${(lineTotal / 100).toFixed(2)}`));
  }
  const totalCents = subtotal + SERVICE_FEE_CENTS + (deliveryFeeCents ?? 0) + (driverTipCents ?? 0);
  lines.push(padReceiptLine("Subtotal", `$${(subtotal / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Service fee", `$${(SERVICE_FEE_CENTS / 100).toFixed(2)}`));
  if (deliveryFeeCents) lines.push(padReceiptLine("Delivery fee", `$${(deliveryFeeCents / 100).toFixed(2)}`));
  if (driverTipCents) lines.push(padReceiptLine("Driver tip", `$${(driverTipCents / 100).toFixed(2)}`));
  lines.push(padReceiptLine("Total", `$${(totalCents / 100).toFixed(2)}`));
  return lines.join("\n");
}

/**
 * Render the authoritative money/status footer from Ledger truth.
 * The LLM owns the conversational framing; the Ledger owns the numbers.
 * This is appended to every non-checkout reply that has cart items.
 *
 * STEP 2 FIX (2026-09-09, P0): this used to fold the fee into a single
 * "N items — $X.XX total" line on every turn after the first, with the
 * subtotal/fee breakdown shown only once (`showFeeBreakdown`, gated on
 * `order_carts.fee_disclosed_at`) to cut repeat noise. That fold is defect
 * class (c) from the Zio's incident write-up: a customer who only ever sees
 * a bare total on turns 2+ has no independent number to check it against.
 * Every turn with cart items now renders the same three labelled lines --
 * Subtotal, Service fee (+ Delivery/Tip when present), Total -- code-owned,
 * never folded. `showFeeBreakdown` is kept as a parameter for call-site
 * stability but no longer suppresses anything; `fee_disclosed_at` still
 * gets written by callers, it just no longer gates what's shown.
 */
export function renderLedgerFooter(
  cart: ItemizedCartLine[],
  phase: string,
  deliveryFeeCents?: number,
  driverTipCents?: number,
  showFeeBreakdown = true,
): string {
  void showFeeBreakdown;
  return renderMoneyFooterLines(cart, SERVICE_FEE_CENTS, deliveryFeeCents, driverTipCents);
}
