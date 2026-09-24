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
  picks: string[];
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

/** Every choice the line carries that its item's groups can price: slot picks first, then modifiers. */
function picked(line: Line, item: MenuItem): Array<{ name: string; delta_cents: number; modifier: boolean }> {
  return item.groups.flatMap((g) => [
    ...g.choices.filter((c) => c.id === line.choices[g.id]).map((c) => ({ ...c, modifier: false })),
    ...line.modifiers.flatMap((id) => g.choices.filter((c) => c.id === id)).map((c) => ({ ...c, modifier: true })),
  ]);
}

export function unitCents(line: Line, item: MenuItem): number {
  return picked(line, item).reduce((s, c) => s + c.delta_cents, item.base_cents);
}

export function priceLine(line: Line, menu: Menu): PricedLine | null {
  if (line.status.kind !== "complete" || !line.item_id) return null;
  const item = menu.items.get(line.item_id);
  if (!item) return null;
  const unit = unitCents(line, item), picks0 = picked(line, item);
  const choice_names = [...new Set(picks0.filter((c) => !c.modifier).map((c) => c.name))]; // a gyro's two identical slots read once
  const modifier_names = [...new Set(picks0.filter((c) => c.modifier).map((c) => c.name))];
  const picks: string[] = [];
  if (item.bundle && line.selections) for (const [cid, n] of Object.entries(line.selections)) { const c = item.bundle.choices.find((x) => x.id === cid); if (c) picks.push(`${n} ${c.name}`); }
  return { line_id: line.line_id, item, qty: line.qty, unit_cents: unit, total_cents: unit * line.qty, choice_names, modifier_names, picks, notes: line.notes };
}

export function totals(form: OrderForm, menu: Menu): Totals {
  const lines = form.lines.map((l) => priceLine(l, menu)).filter((x): x is PricedLine => x !== null);
  const subtotal_cents = lines.reduce((s, l) => s + l.total_cents, 0);
  const delivery_fee_cents = form.fulfillment === "delivery" ? menu.shop.delivery_fee_cents : 0;
  const service_fee_cents = lines.length > 0 ? menu.shop.service_fee_cents : 0;
  const tax_cents = Math.round((subtotal_cents * menu.shop.tax_rate_bps) / 10000);
  const tip_cents = !form.tip ? 0 : form.tip.kind === "percent" ? Math.round((subtotal_cents * form.tip.value) / 100) : form.tip.value;
  const total_cents = subtotal_cents + delivery_fee_cents + service_fee_cents + tax_cents + tip_cents;
  return { lines, subtotal_cents, delivery_fee_cents, service_fee_cents, tax_cents, tip_cents, total_cents };
}

export function dollars(cents: number): string { return `$${(cents / 100).toFixed(2)}`; }
