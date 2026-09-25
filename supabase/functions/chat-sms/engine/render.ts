// render.ts — ReplyPlan to text. The only consumer of templates.ts.
import type { DeclineCode, Fulfillment, OpenQuestion, OrderForm } from "./form.ts";
import type { Menu, MenuItem } from "./menu.ts";
import { dollars, type PricedLine, type Totals } from "./price.ts";
import { GROUP_PROMPTS, groupPrompt, orList, sortSizes, T, title, type Voice } from "./templates.ts";
import { contentWords, singular, words, sameWord } from "./normalize.ts";

export type Ack =
  | { kind: "line_added"; line: PricedLine } | { kind: "line_changed"; line: PricedLine } | { kind: "line_removed"; name: string } | { kind: "fulfillment"; value: Fulfillment }
  | { kind: "address"; text: string } | { kind: "tip"; cents: number } | { kind: "noted"; notes: string[] } | { kind: "line_progress"; name: string; picks: string[] }
  | { kind: "pending"; items: Array<{ qty: number; span: string }> } | { kind: "gotcha" };

export type Decline = { code: DeclineCode | "dropped_line" | "address_to_pickup" | "tip_zero" | "checkout_failed"; span?: string };

export type Info =
  | { kind: "cart"; totals: Totals } | { kind: "item"; item: MenuItem; unit_cents: number; sizes?: Array<{ name: string; cents: number }>; price: boolean; answer?: boolean }
  | { kind: "cart_has"; qty: number; name: string } | { kind: "cart_lacks"; name: string }
  | { kind: "list"; names: string[] } | { kind: "categories"; names: string[] } | { kind: "not_found"; about: string }
  | { kind: "human" } | { kind: "cancelled" } | { kind: "started_over" } | { kind: "unclear" };

export type Question =
  | { kind: "open"; open: OpenQuestion; count: number; heard?: string }
  | { kind: "readback"; totals: Totals; count: number }
  | { kind: "handoff"; totals: Totals; url: string | null };

export interface ReplyPlan {
  greeting: boolean;
  /** validated conversational sentence, shown before everything else */
  talk?: string | null;
  acks: Ack[];
  declines: Decline[];
  info: Info | null;
  question: Question | null;
}

function lineRow(l: PricedLine, withMoney = false): string { // a person names the item; the price waits for the summary or a question
  return T.ackLine(l.qty, l.item.display_name, withMoney ? dollars(l.total_cents) : null, [...l.choice_names, ...l.modifier_names, ...l.picks]);
}

function receiptRows(t: Totals): string[] { return t.lines.map((l) => lineRow(l, true)); }

function moneyLine(t: Totals): string {
  const parts = [`Subtotal ${dollars(t.subtotal_cents)}`];
  if (t.delivery_fee_cents) parts.push(`Delivery ${dollars(t.delivery_fee_cents)}`);
  if (t.tax_cents) parts.push(`Tax ${dollars(t.tax_cents)}`);
  if (t.tip_cents) parts.push(`Tip ${dollars(t.tip_cents)}`);
  if (t.service_fee_cents) parts.push(`Fee ${dollars(t.service_fee_cents)}`);
  parts.push(`Total ${dollars(t.total_cents)}`);
  return T.moneyLine(parts);
}


const lineAndItem = (form: OrderForm, menu: Menu, id: number) => { const l = form.lines.find((x) => x.line_id === id); return [l, l?.item_id ? menu.items.get(l.item_id) ?? null : null] as const; };
export function renderQuestion(q: OpenQuestion, count: number, form: OrderForm, menu: Menu, heard?: string): string {
  const missed = (what: string) => heard && count > 0 ? `${T.missed(heard, what)} ` : ""; // second time round, say what we heard and could not read
  switch (q.kind) {
    case "fulfillment": return T.fulfillment(count);
    case "address": return T.address(count);
    case "items": return form.lines.length === 0 ? T.itemsEmpty(count) : T.itemsMore(count);
    case "tip": return T.tip(count);
    case "confirm": return T.confirmAsk(count);
    case "omission": return q.spans.every((sp) => form.omissions.find((x) => x.span === sp)?.offer) ? T.offer(q.spans.length) : T.omission(q.spans.map((sp) => { const o = form.omissions.find((x) => x.span === sp); return o && o.qty > 1 ? `${o.qty} ${sp}` : sp; }));
    case "line_unresolved": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      return T.lineUnresolved(l?.span ?? "that", count);
    }
    case "line_ambiguous": {
      const l = form.lines.find((x) => x.line_id === q.line_id);
      if (!l || l.status.kind !== "ambiguous") return T.unclear();
      const cands = l.status.candidates.map((id) => menu.items.get(id)!).filter(Boolean);
      const facet = count >= 2 ? "list" : q.facet;
      const asked = Math.max(count, l.asks ?? 0);
      const listAll = () => T.whichOne(cands.slice(0, 8).map((c) => c.display_name)) + (cands.length > 8 ? `\n${T.whichOneMore(8, cands.length)}` : "");
      if (facet === "kind") {
        const byKind = new Map<string, MenuItem>();
        for (const c of cands) { const k = c.facets.kind ?? c.display_name; if (!byKind.has(k)) byKind.set(k, c); }
        const kindsRaw = [...byKind.keys()];
        const lastWords = kindsRaw.map((k) => k.split(" ").slice(-1)[0]);
        const sharedTail = lastWords.every((w) => w === lastWords[0]) && kindsRaw.every((k) => k.split(" ").length > 1) ? lastWords[0] : null;
        const spanNoun = contentWords(l.span).slice(-1)[0] ?? words(l.span).slice(-1)[0] ?? "one";
        const nounFits = sharedTail !== null || cands.every((c) => c.words.includes(spanNoun) || c.words.includes(spanNoun + "s") || c.words.includes(singular(spanNoun)));
        if (!nounFits) return listAll();
        // prefer the customer's own words for the noun when every candidate carries them ("chicken pizza", not "chicken")
        const spanShared = contentWords(l.span).filter((w) => cands.every((c) => c.words.includes(w) || c.words.includes(singular(w)) || (c.facets.kind ?? "").split(" ").includes(w)));
        const noun = spanShared.length ? spanShared.join(" ") : (sharedTail ?? spanNoun);
        const label = (k: string) => {
          const parts = k.split(" ");
          if (parts.length > 1 && sameWord(parts[parts.length - 1], noun)) return parts.slice(0, -1).join(" ");
          if (sameWord(k, noun)) { const cat = byKind.get(k)?.category; return cat ? `${k} (${cat})` : k; }
          return k;
        };
        const kinds = [...new Set(kindsRaw.map(label))];
        return missed("one of those") + T.whatKind(noun, asked, kinds);
      }
      if (facet === "size") {
        const sizes = sortSizes([...new Set(cands.map((c) => c.facets.size).filter((s): s is string => !!s))]);
        const sizeWords = new Set(sizes);
        const nameNoSize = cands[0].display_name.split(" ").filter((w) => !sizeWords.has(w.toLowerCase())).join(" ");
        return T.whatSize(nameNoSize || title(cands[0].facets.kind ?? l.span), sizes);
      }
      return listAll();
    }
    case "line_slot": {
      const [l, item] = lineAndItem(form, menu, q.line_id);
      const g = item?.groups.find((x) => x.id === q.group_id);
      if (!l || !item || !g) return T.unclear();
      const within = l.slot_candidates[g.id], choices = (within ? g.choices.filter((c) => within.includes(c.id)) : g.choices).map((c) => c.name);
      return missed(`the ${g.name.toLowerCase()}`) + T.slot(item.display_name, groupPrompt(g.name), choices, count);
    }
    case "line_picks": {
      const [l, item] = lineAndItem(form, menu, q.line_id);
      if (!l || !item?.bundle) return T.unclear();
      const unit = item.bundle.unit.toLowerCase();
      const strip = (n: string) => { const l = n.toLowerCase(); for (const suf of [` ${unit}s`, ` ${unit}`]) if (l.endsWith(suf)) return n.slice(0, n.length - suf.length); return n; };
      const flavors = item.bundle.choices.map((c) => strip(c.name));
      return T.picks(item.display_name, q.remaining, item.bundle.count, item.bundle.unit, flavors, count);
    }
    case "line_ref": {
      const names = q.candidates.map((id) => { const [l, it] = lineAndItem(form, menu, id); return it ? `${l!.qty} × ${it.display_name}` : (l?.span ?? "?"); });
      return T.lineRef(names);
    }
  }
}

export function render(plan: ReplyPlan, form: OrderForm, menu: Menu, voice: Voice): string {
  const parts: string[] = [];
  if (plan.greeting) parts.push(T.greeting(voice));
  if (plan.talk) parts.push(plan.talk);

  const added = plan.acks.filter((a): a is Ack & { kind: "line_added" } => a.kind === "line_added");
  const changed = plan.acks.filter((a): a is Ack & { kind: "line_changed" } => a.kind === "line_changed");
  const removed = plan.acks.filter((a): a is Ack & { kind: "line_removed" } => a.kind === "line_removed");
  const fieldAcks = plan.acks.flatMap((a) => a.kind === "fulfillment" ? [T.ackFulfillment(a.value)] : a.kind === "address" ? [T.ackAddress(a.text)] : a.kind === "tip" ? [T.ackTip(dollars(a.cents))] : []);
  if (fieldAcks.length) parts.push(fieldAcks.join(" "));
  if (added.length) parts.push(T.ackAdded(added.map((a) => lineRow(a.line))));
  if (changed.length) parts.push(T.ackUpdated(changed.map((a) => lineRow(a.line))));
  if (removed.length) parts.push(T.ackRemoved(removed.map((a) => a.name)));
  for (const a of plan.acks) {
    if (a.kind === "noted") parts.push(T.ackNoted(a.notes));
    if (a.kind === "line_progress") parts.push(T.ackProgress(a.picks, a.name));
    if (a.kind === "gotcha") parts.unshift(T.gotcha());
    if (a.kind === "pending") parts.push(T.ackPending(a.items.map((i) => (i.qty > 1 ? `${i.qty} ${i.span}` : i.span))));
  }

  const declineText: Partial<Record<Decline["code"], (span?: string) => string>> = {
    no_such_line: (sp) => T.noSuchLine(sp), nothing_to_remove: () => T.nothingToRemove(), address_not_found: (sp) => T.addressNotFound(sp ?? ""), address_out_of_zone: (sp) => T.addressOutOfZone(sp ?? "That address"),
    dropped_line: (sp) => T.droppedLine(sp ?? ""), address_to_pickup: () => T.addressToPickup(), tip_zero: () => T.tipZero(), tip_out_of_range: () => T.tipOutOfRange(), checkout_failed: () => T.checkoutFailed(),
  };
  for (const d of plan.declines) { const f = declineText[d.code]; if (f) parts.push(f(d.span)); }

  if (plan.info) {
    const i = plan.info;
    if (i.kind === "cart") {
      if (i.totals.lines.length === 0) parts.push(T.cartEmpty());
      else parts.push([T.cartHeader(), ...receiptRows(i.totals).map((r, k) => `${k + 1}) ${r}`), moneyLine(i.totals)].join("\n"));
    } else if (i.kind === "item") {
      const opts = i.item.groups.filter((g) => g.kind === "slot").map((g) => `${title(g.name)}: ${g.choices.map((c) => c.name).slice(0, 6).join(", ")}`);
      const sizes = i.sizes ? sortSizes(i.sizes.map((x) => x.name)) : null;
      const money = !i.price ? null : sizes ? sizes.map((n) => `${title(n)} ${dollars(i.sizes!.find((x) => x.name === n)!.cents)}`).join(", ") : dollars(i.unit_cents);
      if (sizes && !i.price) opts.unshift(`Sizes: ${sizes.map(title).join(", ")}`);
      parts.push((i.answer ? T.yesWeHave() + " " : "") + T.itemInfo(sizes ? title(i.item.facets.kind ?? i.item.display_name) : i.item.display_name, money, opts, i.item.description));
    } else if (i.kind === "cart_has") parts.push(T.cartHas(i.qty, i.name));
    else if (i.kind === "cart_lacks") { parts.push(T.cartLacks(i.name));
    } else if (i.kind === "list") parts.push(T.listInfo(i.names)); // the template caps long lists and says how many more
    else if (i.kind === "categories") parts.push(T.menuCategories(i.names));
    else if (i.kind === "not_found") parts.push(T.notOnMenu(i.about));
    else if (i.kind === "human") parts.push(T.human(voice));
    else if (i.kind === "cancelled") parts.push(T.cancelled());
    else if (i.kind === "started_over") parts.push(T.startedOver());
    else if (i.kind === "unclear") parts.push(T.unclear(plan.question?.kind === "open" ? plan.question.count : 0));
  }

  if (plan.question) {
    const q = plan.question;
    if (q.kind === "open") parts.push(renderQuestion(q.open, q.count, form, menu, q.heard));
    else if (q.kind === "readback") {
      parts.push([
        T.readbackHeader(form.fulfillment, form.address?.formatted ?? form.address?.text ?? null, !form.said_robot),
        ...receiptRows(q.totals).map((r, k) => `${k + 1}) ${r}`),
        moneyLine(q.totals),
        T.confirmAsk(q.count),
      ].join("\n"));
    } else if (q.kind === "handoff") {
      parts.push(`${T.handoff(q.url)} ${T.afterPay(form.fulfillment === "delivery")}`.trim());
    }
  }
  // short one-line parts read as one message ("Added 1 × Garlic Knots. Anything else?"); anything with a list keeps its own block
  const short = parts.every((x) => !x.includes("\n")) && parts.join(" ").length <= 220;
  return parts.join(short ? " " : "\n\n").trim();
}

export { GROUP_PROMPTS, orList };
