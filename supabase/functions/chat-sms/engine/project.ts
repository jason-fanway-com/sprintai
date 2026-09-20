// project.ts — projection of the form onto the legacy cart_json line shape so
// tickets, dashboards and the checkout module keep reading what they read today.
import type { OrderForm } from "./form.ts";
import type { Menu } from "./menu.ts";
import { priceLine } from "./price.ts";

export interface CartJsonLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  modifiers: string[];
  options?: Record<string, string[]>;
  ask_plan_selections?: Record<string, string | string[]>;
  line_key: string;
}

export function toCartJson(form: OrderForm, menu: Menu): CartJsonLine[] {
  const out: CartJsonLine[] = [];
  for (const line of form.lines) {
    const priced = priceLine(line, menu);
    if (!priced) continue;
    const options: Record<string, string[]> = {};
    const selections: Record<string, string | string[]> = {};
    for (const g of priced.item.groups) {
      const chosen = line.choices[g.id];
      if (chosen) {
        const c = g.choices.find((x) => x.id === chosen);
        if (c) { options[g.name] = [c.name]; selections[g.id] = c.id; }
      }
      const mods = line.modifiers.filter((m) => g.choices.some((c) => c.id === m));
      if (mods.length) { options[g.name] = [...(options[g.name] ?? []), ...mods.map((m) => g.choices.find((c) => c.id === m)!.name)]; selections[g.id] = mods; }
    }
    out.push({
      menu_item_id: priced.item.id,
      name: priced.item.display_name,
      quantity: line.qty,
      price_cents: priced.unit_cents,
      modifiers: [...priced.modifier_names, ...line.notes],
      ...(Object.keys(options).length ? { options } : {}),
      ...(Object.keys(selections).length ? { ask_plan_selections: selections } : {}),
      line_key: `L${line.line_id}`,
    });
  }
  return out;
}
