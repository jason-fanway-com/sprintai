// price.ts — the only arithmetic over money in the engine. Integer cents.
import type { Line, OrderForm } from "./form.ts";
import type { Menu, MenuItem } from "./menu.ts";

export interface PricedLine {
  line_id: number;
  item: MenuItem;
  qty: number;
  unit_cents: number;
  total_cents: number;
  choice_names: string[];
  modifier_names: string[];
  notes: string[];
}

export interface Totals {
  lines: PricedLine[];
  subtotal_cents: number;
  delivery_fee_cents: number;
  service_fee_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
}

export function unitCents(line: Line, item: MenuItem): number {
  let cents = item.base_cents;
  for (const g of item.groups) {
    const chosen = line.choices[g.id];
    if (chosen) { const c = g.choices.find((x) => x.id === chosen); if (c) cents += c.delta_cents; }
    for (const modId of line.modifiers) { const c = g.choices.find((x) => x.id === modId); if (c) cents += c.delta_cents; }
  }
  return cents;
}

export function priceLine(line: Line, menu: Menu): PricedLine | null {
  if (line.status.kind !== "complete" || !line.item_id) return null;
  const item = menu.items.get(line.item_id);
  if (!item) return null;
  const unit = unitCents(line, item);
  const choice_names: string[] = [];
  const modifier_names: string[] = [];
  for (const g of item.groups) {
    const chosen = line.choices[g.id];
    if (chosen) { const c = g.choices.find((x) => x.id === chosen); if (c) choice_names.push(c.name); }
    for (const modId of line.modifiers) { const c = g.choices.find((x) => x.id === modId); if (c) modifier_names.push(c.name); }
  }
  return { line_id: line.line_id, item, qty: line.qty, unit_cents: unit, total_cents: unit * line.qty, choice_names, modifier_names, notes: line.notes };
}

export function totals(form: OrderForm, menu: Menu): Totals {
  const lines = form.lines.map((l) => priceLine(l, menu)).filter((x): x is PricedLine => x !== null);
  const subtotal_cents = lines.reduce((s, l) => s + l.total_cents, 0);
  const delivery_fee_cents = form.fulfillment === "delivery" ? menu.shop.delivery_fee_cents : 0;
  const service_fee_cents = lines.length > 0 ? menu.shop.service_fee_cents : 0;
  const tax_cents = Math.round((subtotal_cents * menu.shop.tax_rate_bps) / 10000);
  let tip_cents = 0;
  if (form.tip) tip_cents = form.tip.kind === "percent" ? Math.round((subtotal_cents * form.tip.value) / 100) : form.tip.value;
  const total_cents = subtotal_cents + delivery_fee_cents + service_fee_cents + tax_cents + tip_cents;
  return { lines, subtotal_cents, delivery_fee_cents, service_fee_cents, tax_cents, tip_cents, total_cents };
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
