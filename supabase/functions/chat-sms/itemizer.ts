// Item 2 (2026-09-09, module extraction): deterministic itemized-receipt
// rendering pulled out of index.ts verbatim. Pure string building over an
// already-known cart — no Supabase, no LLM, no I/O.

import { SERVICE_FEE_CENTS } from "../_shared/connect.ts";
import { renderMoneyFooterLines } from "./money-footer-20260909.ts";

export interface ItemizedCartLine {
  type?: "bundle";
  menu_item_id?: string;
  name: string;
  price_cents: number;
  complete?: boolean; // bundle lines only
  selections?: Array<{ flavor: string; quantity: number }>; // bundle lines only
  quantity?: number;
  modifiers?: string[];
  options?: Record<string, string[]>;
}

// P0 (2026-09-09, item 2 — itemized recap): a cart line's `options`/
// `modifiers` are stored as bare display strings (e.g. "Extra Cheese") with
// no price attached — correct for every existing guard/matcher that does
// stem/substring comparison against them (embedding a price into the stored
// value would break all of that), but it means the recap could show an
// option's NAME without ever showing what it COST, which is exactly the
// "$4 upcharge silently omitted" defect class. This builds a lookup (menu
// item id -> lowercased display value -> its own price) from menu data the
// caller already has in scope, entirely separate from what's stored on the
// cart line, so renderItemizedRecap can annotate an option's real per-unit
// price without any cart-line schema change or write-path touch.
export interface MenuItemForPricing {
  id: string;
  option_groups?: Array<{ name: string; choices: Array<{ name: string; price_cents: number }> }> | null;
  modifiers_json?: Array<{ name: string; price_cents: number }> | null;
  ask_plan?: { steps: Array<{ choices: Array<{ display: string; price_delta_cents: number }> }> } | null;
}

export function buildMenuPriceIndex(menu: MenuItemForPricing[]): Map<string, Map<string, number>> {
  const byMenuItemId = new Map<string, Map<string, number>>();
  for (const item of menu) {
    const idx = new Map<string, number>();
    for (const g of item.option_groups ?? []) for (const c of g.choices ?? []) idx.set(c.name.toLowerCase(), c.price_cents);
    for (const m of item.modifiers_json ?? []) idx.set(m.name.toLowerCase(), m.price_cents);
    for (const step of item.ask_plan?.steps ?? []) for (const c of step.choices ?? []) idx.set(c.display.toLowerCase(), c.price_delta_cents);
    byMenuItemId.set(item.id, idx);
  }
  return byMenuItemId;
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
 * Shared per-line formatting: item label (qty prefix, name, priced options/
 * modifiers) and its own amount, split so callers can either column-align it
 * (renderItemizedRecap, a multi-line receipt) or inline it into one sentence
 * (renderItemizedLine, a single-item confirmation).
 */
function renderItemizedLineParts(
  i: ItemizedCartLine,
  priceIndexByMenuItemId?: Map<string, Map<string, number>>,
): { label: string; amount: string } {
  const lineTotal = i.price_cents * (i.quantity || 1);
  const qtyPrefix = (i.quantity || 1) > 1 ? `${i.quantity}x ` : "";
  const optionPrices = i.menu_item_id ? priceIndexByMenuItemId?.get(i.menu_item_id) : undefined;
  const annotate = (value: string): string => {
    const p = optionPrices?.get(value.toLowerCase());
    return p && p > 0 ? `${value} (+$${(p / 100).toFixed(2)})` : value;
  };
  const detail = (i.modifiers?.length ?? 0) > 0
    ? i.modifiers!.map(annotate).join(", ")
    : (i.options ? Object.entries(i.options).map(([k, v]) => `${k}: ${v.map(annotate).join(", ")}`).join("; ") : "");
  return {
    label: `${qtyPrefix}${i.name}${detail ? ` (${detail})` : ""}`,
    amount: `$${(lineTotal / 100).toFixed(2)}`,
  };
}

/**
 * Single-item itemized line ("Large Cheese Pizza (Toppings: Pepperoni
 * (+$4.50)) $21.00") for callers rendering one line inline in a sentence
 * rather than a full multi-line receipt — e.g. action-confirmation.ts's
 * single-item add confirmation, when the added item carries options.
 */
export function renderItemizedLine(
  i: ItemizedCartLine,
  priceIndexByMenuItemId?: Map<string, Map<string, number>>,
): string {
  const { label, amount } = renderItemizedLineParts(i, priceIndexByMenuItemId);
  return `${label} ${amount}`;
}

/**
 * 2026-09-18 PO dispatch (confirm read-back): the per-item lines ALONE, no
 * subtotal/fee/total trailer, NOT column-padded — for a caller (turn-
 * engine.ts's confirm-step read-back) that needs a plain "qty name
 * (options) price" line per item, one after another, with the money
 * footer supplied separately by the caller's own existing, unchanged
 * footer call. Reuses renderItemizedLine (the existing, tested, single-
 * item sentence format) per line — additive, never a reformat of that
 * function or of renderItemizedRecap, both untouched with their own tests
 * unaffected.
 *
 * `includeOptions=false` drops the "(Toppings: Pepperoni)"-style detail
 * from every non-bundle line (quantity, name, and price stay) — the SMS-
 * length fallback the confirm read-back uses before ever splitting into
 * two messages. Never drops or truncates a line itself.
 */
export function renderItemizedLines(
  cart: ItemizedCartLine[],
  priceIndexByMenuItemId?: Map<string, Map<string, number>>,
  includeOptions = true,
): string {
  return cart.map(i => {
    if (i.type === "bundle") {
      const detail = includeOptions ? (i.selections ?? []).map(s => `${s.quantity}x ${s.flavor}`).join(", ") : "";
      const label = i.complete ? i.name : `${i.name} (selecting flavors)`;
      return `${label}${detail ? ` (${detail})` : ""} $${(i.price_cents / 100).toFixed(2)}`;
    }
    const source = includeOptions ? i : { ...i, options: undefined, modifiers: undefined };
    return renderItemizedLine(source, priceIndexByMenuItemId);
  }).join("\n");
}

/**
 * Deterministic itemized recap — a full plain-text receipt (line items with
 * their own price, chosen options, subtotal, service fee, and total), not
 * just a count and a total. This is the structural defense against the
 * double-charge class (2026-09-06, Jason: "Luca only caught a $37 error
 * because he happened to read a number") — the model never states these
 * figures itself.
 */
export function renderItemizedRecap(
  cart: ItemizedCartLine[],
  deliveryFeeCents?: number,
  driverTipCents?: number,
  // P0 (2026-09-09, item 2): menu_item_id -> lowercased option/modifier
  // display value -> its own price, from buildMenuPriceIndex. Optional and
  // additive — every existing caller that doesn't have menu data handy keeps
  // rendering exactly as before (option/modifier names shown, no per-option
  // price annotation), it just doesn't get this extra detail.
  priceIndexByMenuItemId?: Map<string, Map<string, number>>,
): string {
  const lines: string[] = [];
  let subtotal = 0;
  for (const i of cart) {
    if (i.type === "bundle") {
      // P0 (2026-09-09, NJB live defect): a bundle's price is fixed at
      // start_bundle time and doesn't depend on `complete` (flavor
      // selection) — skipping the line while incomplete quoted a $0.99
      // total for a cart holding a committed $15 bundle. Count and show it
      // from the moment it's added; flag it as still-in-progress instead.
      subtotal += i.price_cents;
      const detail = (i.selections ?? []).map(s => `${s.quantity}x ${s.flavor}`).join(", ");
      const label = i.complete ? i.name : `${i.name} (selecting flavors)`;
      lines.push(padReceiptLine(`${label}${detail ? ` (${detail})` : ""}`, `$${(i.price_cents / 100).toFixed(2)}`));
      continue;
    }
    const lineTotal = i.price_cents * (i.quantity || 1);
    subtotal += lineTotal;
    const { label, amount } = renderItemizedLineParts(i, priceIndexByMenuItemId);
    lines.push(padReceiptLine(label, amount));
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
