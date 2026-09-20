// render.ts — ReplyPlan to text. The only consumer of templates.ts.
import type { DeclineCode, Fulfillment, OpenQuestion, OrderForm } from "./form.ts";
import type { Menu, MenuItem } from "./menu.ts";
import { dollars, type PricedLine, type Totals } from "./price.ts";
import { GROUP_PROMPTS, groupPrompt, orList, sortSizes, T, title, type Voice } from "./templates.ts";
import { contentWords, singular, words } from "./normalize.ts";

export type Ack =
  | { kind: "line_added"; line: PricedLine }
  | { kind: "line_changed"; line: PricedLine }
  | { kind: "line_removed"; name: string }
  | { kind: "fulfillment"; value: Fulfillment }
  | { kind: "address"; text: string }
  | { kind: "tip"; cents: number }
  | { kind: "noted"; notes: string[] };

export type Decline = { code: DeclineCode | "dropped_line" | "address_to_pickup" | "tip_zero" | "checkout_failed"; span?: string };

export type Info =
  | { kind: "cart"; totals: Totals }
  | { kind: "item"; item: MenuItem; unit_cents: number }
  | { kind: "list"; names: string[] }
  | { kind: "categories"; names: string[] }
  | { kind: "human" }
  | { kind: "cancelled" }
  | { kind: "started_over" }
  | { kind: "unclear" };

export type Question =
  | { kind: "open"; open: OpenQuestion; count: number }
  | { kind: "readback"; totals: Totals; count: number }
  | { kind: "handoff"; totals: Totals; url: string | null };

export interface ReplyPlan {
  greeting: boolean;
  acks: Ack[];
  declines: Decline[];
  info: Info | null;
  question: Question | null;
}

function lineRow(l: PricedLine): string {
  return T.ackLine(l.qty, l.item.display_name, dollars(l.total_cents), [...l.choice_names, ...l.modifier_names, ...l.picks]);
}

function receiptRows(t: Totals): string[] { return t.lines.map((l) => `${lineRow(l)}`); }

function moneyLine(t: Totals): string {
  const parts = [`Subtotal ${dollars(t.subtotal_cents)}`];
  if (t.delivery_fee_cents) parts.push(`Delivery ${dollars(t.delivery_fee_cents)}`);
  if (t.tax_cents) parts.push(`Tax ${dollars(t.tax_cents)}`);
  if (t.tip_cents) parts.push(`Tip ${dollars(t.tip_cents)}`);
  if (t.service_fee_cents) parts.push(`Fee ${dollars(t.service_fee_cents)}`);
  parts.push(`Total ${dollars(t.total_cents)}`);
  return T.moneyLine(parts);
}


export function renderQuestion(q: OpenQuestion, count: number, form: OrderForm, menu: Menu): string {
  switch (q.kind) {
    case "fulfillment": return T.fulfillment(count);
    case "address": return T.address(count);
    case "items": return form.lines.length === 0 ? T.itemsEmpty(count) : T.itemsMore(count);
    case "tip": return T.tip(count);
    case "confirm": return T.confirmAsk(count);
    case "omission": return T.omission(q.spans.map((sp) => { const o = form.omissions.find((x) => x.span === sp); return o && o.qty > 1 ? `${o.qty} ${sp}` : sp; }));
    case "line_unresolved": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      return T.lineUnresolved(l?.span ?? "that", count);
    }
    case "line_ambiguous": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      if (!l || l.status.kind !== "ambiguous") return T.unclear();
      const cands = l.status.candidates.map((id) => menu.items.get(id)!).filter(Boolean);
      const facet = count >= 2 ? "list" : q.facet;
      if (facet === "kind") {
        const byKind = new Map<string, MenuItem>();
        for (const c of cands) { const k = c.facets.kind ?? c.display_name; if (!byKind.has(k)) byKind.set(k, c); }
        const kindsRaw = [...byKind.keys()];
        const lastWords = kindsRaw.map((k) => k.split(" ").slice(-1)[0]);
        const sharedTail = lastWords.every((w) => w === lastWords[0]) && kindsRaw.every((k) => k.split(" ").length > 1) ? lastWords[0] : null;
        const spanNoun = contentWords(l.span).slice(-1)[0] ?? words(l.span).slice(-1)[0] ?? "one";
        const nounFits = sharedTail !== null || cands.every((c) => c.words.includes(spanNoun) || c.words.includes(spanNoun + "s") || c.words.includes(singular(spanNoun)));
        if (!nounFits) {
          const names = cands.slice(0, 8).map((c) => c.display_name);
          return T.whichOne(names) + (cands.length > 8 ? `\n${T.whichOneMore(8, cands.length)}` : "");
        }
        const noun = sharedTail ?? spanNoun;
        const label = (k: string) => {
          const parts = k.split(" ");
          if (parts.length > 1 && (parts[parts.length - 1] === noun || parts[parts.length - 1] === noun + "s")) return parts.slice(0, -1).join(" ");
          if (k === noun || k === noun + "s") { const cat = byKind.get(k)?.category; return cat ? `${k} (${cat})` : k; }
          return k;
        };
        const kinds = [...new Set(kindsRaw.map(label))];
        return T.whatKind(noun, count, kinds.slice(0, 8));
      }
      if (facet === "size") {
        const sizes = sortSizes([...new Set(cands.map((c) => c.facets.size).filter((s): s is string => !!s))]);
        const sizeWords = new Set(sizes);
        const nameNoSize = cands[0].display_name.split(" ").filter((w) => !sizeWords.has(w.toLowerCase())).join(" ");
        return T.whatSize(nameNoSize || title(cands[0].facets.kind ?? l.span), sizes);
      }
      const names = cands.slice(0, 8).map((c) => c.display_name);
      return T.whichOne(names) + (cands.length > 8 ? `\n${T.whichOneMore(8, cands.length)}` : "");
    }
    case "line_slot": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      const item = l?.item_id ? menu.items.get(l.item_id) : null;
      const g = item?.groups.find((x) => x.id === q.group_id);
      if (!l || !item || !g) return T.unclear();
      const within = l.slot_candidates[g.id];
      const choices = (within ? g.choices.filter((c) => within.includes(c.id)) : g.choices).map((c) => c.name);
      return T.slot(item.display_name, groupPrompt(g.name), choices, count);
    }
    case "line_picks": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      const item = l?.item_id ? menu.items.get(l.item_id) : null;
      if (!l || !item?.bundle) return T.unclear();
      const unit = item.bundle.unit.toLowerCase();
      const strip = (n: string) => { const l = n.toLowerCase(); for (const suf of [` ${unit}s`, ` ${unit}`]) if (l.endsWith(suf)) return n.slice(0, n.length - suf.length); return n; };
      const flavors = item.bundle.choices.map((c) => strip(c.name));
      return T.picks(item.display_name, q.remaining, item.bundle.count, item.bundle.unit, flavors, count);
    }
    case "line_ref": {
      const names = q.candidates.map((id) => {
        const l = form.lines.find((x) => x.line_id === id);
        const it = l?.item_id ? menu.items.get(l.item_id) : null;
        return it ? `${l!.qty} × ${it.display_name}` : (l?.span ?? "?");
      });
      return T.lineRef(names);
    }
  }
}

export function render(plan: ReplyPlan, form: OrderForm, menu: Menu, voice: Voice): string {
  const parts: string[] = [];
  if (plan.greeting) parts.push(T.greeting(voice));

  const added = plan.acks.filter((a): a is Ack & { kind: "line_added" } => a.kind === "line_added");
  const changed = plan.acks.filter((a): a is Ack & { kind: "line_changed" } => a.kind === "line_changed");
  const removed = plan.acks.filter((a): a is Ack & { kind: "line_removed" } => a.kind === "line_removed");
  const fieldAcks: string[] = [];
  for (const a of plan.acks) {
    if (a.kind === "fulfillment") fieldAcks.push(T.ackFulfillment(a.value));
    if (a.kind === "address") fieldAcks.push(T.ackAddress(a.text));
    if (a.kind === "tip") fieldAcks.push(T.ackTip(dollars(a.cents)));
  }
  if (fieldAcks.length) parts.push(fieldAcks.join(" "));
  if (added.length) parts.push(T.ackAdded(added.map((a) => lineRow(a.line))));
  if (changed.length) parts.push(T.ackUpdated(changed.map((a) => lineRow(a.line))));
  if (removed.length) parts.push(T.ackRemoved(removed.map((a) => a.name)));
  const noted = plan.acks.find((a): a is Ack & { kind: "noted" } => a.kind === "noted");
  if (noted) parts.push(T.ackNoted(noted.notes));

  for (const d of plan.declines) {
    switch (d.code) {
      case "no_such_line": parts.push(T.noSuchLine(d.span)); break;
      case "nothing_to_remove": parts.push(T.nothingToRemove()); break;
      case "address_not_found": parts.push(T.addressNotFound(d.span ?? "")); break;
      case "address_out_of_zone": parts.push(T.addressOutOfZone(d.span ?? "That address")); break;
      case "dropped_line": parts.push(T.droppedLine(d.span ?? "")); break;
      case "address_to_pickup": parts.push(T.addressToPickup()); break;
      case "tip_zero": parts.push(T.tipZero()); break;
      case "tip_out_of_range": parts.push(T.tipOutOfRange()); break;
      case "checkout_failed": parts.push(T.checkoutFailed()); break;
      case "not_delivery_shop": break;
    }
  }

  if (plan.info) {
    const i = plan.info;
    if (i.kind === "cart") {
      if (i.totals.lines.length === 0) parts.push(T.cartEmpty());
      else parts.push([T.cartHeader(), ...receiptRows(i.totals).map((r, k) => `${k + 1}) ${r}`), moneyLine(i.totals)].join("\n"));
    } else if (i.kind === "item") {
      const opts = i.item.groups.filter((g) => g.kind === "slot").map((g) => `${title(g.name)}: ${g.choices.map((c) => c.name).slice(0, 6).join(", ")}`);
      parts.push(T.itemInfo(i.item.display_name, dollars(i.unit_cents), opts));
    } else if (i.kind === "list") parts.push(T.listInfo(i.names.slice(0, 10)));
    else if (i.kind === "categories") parts.push(T.menuCategories(i.names));
    else if (i.kind === "human") parts.push(T.human(voice));
    else if (i.kind === "cancelled") parts.push(T.cancelled());
    else if (i.kind === "started_over") parts.push(T.startedOver());
    else if (i.kind === "unclear") parts.push(T.unclear());
  }

  if (plan.question) {
    const q = plan.question;
    if (q.kind === "open") parts.push(renderQuestion(q.open, q.count, form, menu));
    else if (q.kind === "readback") {
      parts.push([
        T.readbackHeader(form.fulfillment, form.address?.formatted ?? form.address?.text ?? null),
        ...receiptRows(q.totals).map((r, k) => `${k + 1}) ${r}`),
        moneyLine(q.totals),
        T.confirmAsk(q.count),
      ].join("\n"));
    } else if (q.kind === "handoff") {
      parts.push(`${T.handoff(q.url)} ${T.afterPay()}`.trim());
    }
  }
  return parts.join("\n\n").trim();
}

export { GROUP_PROMPTS, orList };
