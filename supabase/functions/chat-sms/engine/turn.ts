// turn.ts — one conversational turn as a pure function.
//   (form, menu, message, moves) -> (form', ledger, plan, reply)
import { apply, normalizeMoveBatch, type LedgerEntry, type Move, type OpenQuestion, type OrderForm } from "./form.ts";
import type { Menu } from "./menu.ts";
import { reconcile, scan } from "./crossread.ts";
import { bindLine, lineMatchesSpan, resolveSpan, spanAnswersLine } from "./resolve.ts";
import { escalate, next, questionKey } from "./next.ts";
import { priceLine, totals, unitCents } from "./price.ts";
import { render, type Ack, type Decline, type Info, type Question, type ReplyPlan } from "./render.ts";
import type { Voice } from "./templates.ts";
import { itemsInCategory } from "./menu.ts";
import { contentWords, words } from "./normalize.ts";

export interface TurnInput {
  form: OrderForm;
  menu: Menu;
  message: string;
  moves: Move[];
  greet?: boolean;
  checkoutUrl?: string | null;
}
export interface TurnOutput {
  form: OrderForm;
  ledger: LedgerEntry[];
  plan: ReplyPlan;
  reply: string;
  /** true when the form is confirmed and a payment link should be created */
  handoff: boolean;
  progress: boolean;
}

function isProgress(e: LedgerEntry): boolean {
  if (e.event === "yes_no_without_question" || e.event === "answer_option_unmatched") return false;
  if (e.event === "control") { const w = (e.data as { what: string }).what; return w !== "unclear" && w !== "greeting"; }
  if (e.event === "answer") { const d = e.data as { accepted?: boolean }; return d.accepted !== false; }
  return true;
}

export function turn(input: TurnInput): TurnOutput {
  const menu = input.menu;
  const voice: Voice = { shop_name: menu.shop.name, phone_display: menu.shop.phone_display };
  const form0: OrderForm = structuredClone(input.form);
  form0.turn_no += 1;
  const ledger: LedgerEntry[] = [];
  const t = form0.turn_no;

  // 1. cross-read: two readers of the same message
  const askedSpans = new Set(form0.omissions.map((o) => o.span));
  const lineQuestionOpen = !!(form0.open && "line_id" in form0.open);
  const rec = reconcile(input.message, normalizeMoveBatch(input.moves, lineQuestionOpen), menu, askedSpans);
  for (const r of rec.rejected) ledger.push({ turn: t, event: "rejected_span_not_in_message", data: r });

  // 2. a new-item move that really answers the open line question becomes an answer
  const moves: Move[] = [];
  const hits = scan(input.message, menu).hits;
  const upgradeSpan = (m: Move & { kind: "add_line" }): Move & { kind: "add_line" } => {
    // "bagel" + ["plain cream cheese"] when the message contains the unique term
    // "bagel with plain cream cheese": the longer term names the item
    const sw = words(m.item_span);
    const h = hits.find((x) => x.item_ids.length === 1 && x.termWords.length > sw.length && sw.every((w) => x.termWords.includes(w)));
    if (!h) return m;
    const covered = new Set(h.termWords);
    const options = m.option_spans.filter((o) => !words(o).every((w) => covered.has(w)));
    ledger.push({ turn: t, event: "span_upgraded", data: { from: m.item_span, to: h.termWords.join(" ") } });
    return { ...m, item_span: h.termWords.join(" "), option_spans: options };
  };
  const open = form0.open;
  const focus = open && "line_id" in open ? form0.lines.find((l) => l.line_id === open.line_id) : undefined;
  for (const m0 of rec.accepted) {
    const m = m0.kind === "add_line" ? upgradeSpan(m0) : m0;
    if (focus && m.kind === "add_line") {
      const answers = spanAnswersLine(focus, m.item_span, menu) ||
        (focus.status.kind === "unresolved" && resolveSpan(m.item_span, menu).kind !== "none");
      if (answers) {
        moves.push({ kind: "answer_option", value_span: m.item_span });
        for (const o of m.option_spans ?? []) moves.push({ kind: "answer_option", value_span: o });
        ledger.push({ turn: t, event: "add_reclassified_as_answer", data: { span: m.item_span } });
        continue;
      }
    }
    // "12 bagels" / "a dozen bagels" read as qty 12 of an ambiguous bagel: that is the dozen bundle
    if (m.kind === "add_line" && m.qty >= 2) {
      const r = resolveSpan(m.item_span, menu);
      const candIds = r.kind === "ambiguous" ? r.ids : r.kind === "item" ? [r.id] : [];
      const cats = new Set(candIds.map((id) => menu.items.get(id)?.category ?? ""));
      const bundle = [...menu.items.values()].find((it) => it.bundle && it.bundle.count === m.qty && it.category && cats.has(it.category) && (candIds.includes(it.id) || it.bundle.choices.some((c) => candIds.includes(c.id))));
      if (bundle) {
        moves.push({ ...m, item_span: bundle.display_name, qty: 1 });
        ledger.push({ turn: t, event: "qty_rewritten_to_bundle", data: { span: m.item_span, qty: m.qty, bundle: bundle.id } });
        continue;
      }
    }
    // an "item" with no item words in it ("large", "please") is not an item; never open a line for it
    if (m.kind === "add_line" && contentWords(m.item_span).length === 0) {
      ledger.push({ turn: t, event: "ignored_non_item_span", data: { span: m.item_span } });
      continue;
    }
    moves.push(m);
  }

  // 3. apply
  const matcher = (line: import("./form.ts").Line, span: string) => lineMatchesSpan(line, span, menu);
  const res = apply(form0, moves, matcher);
  const form = res.form;
  ledger.push(...res.ledger);

  // 4. bind every line as far as the data allows
  const before = new Map(input.form.lines.map((l) => [l.line_id, JSON.stringify(l)]));
  for (const l of form.lines) bindLine(l, menu);
  for (const l of form.lines) if (before.get(l.line_id) !== JSON.stringify(l) && !res.touched.includes(l.line_id)) res.touched.push(l.line_id);

  // 5. omissions: the second reader saw an item the first did not act on
  for (const om of rec.omissions) {
    const alreadyThere = form.lines.some((l) =>
      (l.item_id && om.item_ids.includes(l.item_id)) ||
      (l.status.kind === "ambiguous" && l.status.candidates.some((c) => om.item_ids.includes(c))) ||
      lineMatchesSpan(l, om.span, menu)
    );
    if (alreadyThere) continue;
    if (form.omissions.some((o) => o.span === om.span)) continue;
    form.omissions.push({ span: om.span, qty: om.qty, declined: false });
    ledger.push({ turn: t, event: "possible_omission", data: om });
  }

  // 6. progress and the next question
  if (form.fulfillment === null && !menu.shop.delivery_enabled) { form.fulfillment = "pickup"; ledger.push({ turn: t, event: "fulfillment_default_pickup" }); }
  const progress = res.ledger.some(isProgress);
  let q: OpenQuestion | null = next(form, menu, res.refAsk);
  let key = questionKey(q);
  let count = key !== null && key === form.asked.key && !progress ? form.asked.count + 1 : 0;
  form.open = q; form.asked = { key, count };
  const declines: Decline[] = res.declines.map((d) => ({ code: d.code, span: d.span }));
  const note = escalate(form, menu);
  if (note) {
    ledger.push({ turn: t, event: "escalated", data: note });
    const [code, span] = note.split(":");
    if (code === "dropped_line") declines.push({ code: "dropped_line", span });
    if (code === "address_to_pickup") declines.push({ code: "address_to_pickup" });
    if (code === "tip_zero") declines.push({ code: "tip_zero" });
    q = next(form, menu, null); key = questionKey(q); count = 0;
    form.open = q; form.asked = { key, count };
  }
  if (q?.kind === "confirm") form.status = "confirming";
  const handoff = q === null && form.confirmed && form.status === "awaiting_payment";

  // 7. the plan
  const acks: Ack[] = [];
  for (const e of res.ledger) {
    if (e.event === "answer") {
      const d = e.data as { field: string; value?: unknown; accepted?: boolean };
      if (d.field === "fulfillment") acks.push({ kind: "fulfillment", value: d.value as "pickup" | "delivery" });
      if (d.field === "address" && form.address?.validated && form.address.zone_ok) acks.push({ kind: "address", text: form.address.formatted ?? form.address.text });
      if (d.field === "tip" && d.accepted !== false && form.tip) acks.push({ kind: "tip", cents: totals(form, menu).tip_cents });
    }
  }
  const focusId = q && "line_id" in q ? q.line_id : null;
  const newIds = new Set(res.ledger.filter((e) => e.event === "add_line").map((e) => (e.data as { line_id: number }).line_id));
  const notes: string[] = [];
  for (const id of res.touched) {
    const l = form.lines.find((x) => x.line_id === id);
    if (!l) continue;
    const priced = priceLine(l, menu);
    const wasComplete = before.get(id) ? (JSON.parse(before.get(id)!) as { status: { kind: string } }).status.kind === "complete" : false;
    if (priced) acks.push({ kind: newIds.has(id) || !wasComplete ? "line_added" : "line_changed", line: priced });
    const prevNotes = before.get(id) ? (JSON.parse(before.get(id)!) as { notes: string[] }).notes.length : 0;
    if (l.notes.length > prevNotes) notes.push(...l.notes.slice(prevNotes));
  }
  if (notes.length) acks.push({ kind: "noted", notes });
  for (const r of res.removed) {
    const it = r.item_id ? menu.items.get(r.item_id) : null;
    acks.push({ kind: "line_removed", name: it?.display_name ?? r.span });
  }

  let info: Info | null = null;
  if (res.showCart) info = { kind: "cart", totals: totals(form, menu) };
  if (res.askMenu !== undefined) info = menuInfo(res.askMenu, menu, form);
  if (res.control?.what === "human") info = { kind: "human" };
  if (res.control?.what === "cancel") info = { kind: "cancelled" };
  if (res.control?.what === "start_over") info = { kind: "started_over" };
  const askedSomethingNew = q !== null && questionKey(q) !== questionKey(input.form.open);
  if (res.control?.what === "unclear" && !progress && !askedSomethingNew) info = { kind: "unclear" };
  if (moves.length === 0 && rec.rejected.length === 0 && !progress && count > 0) info = info ?? { kind: "unclear" };

  let question: Question | null = null;
  if (form.status === "abandoned") question = null;
  else if (handoff) question = { kind: "handoff", totals: totals(form, menu), url: input.checkoutUrl ?? null };
  else if (q?.kind === "confirm") question = { kind: "readback", totals: totals(form, menu), count };
  else if (q) question = { kind: "open", open: q, count };

  // a first-contact greeting only when nothing else was said and we are asking the opener
  const plan: ReplyPlan = {
    greeting: !!input.greet || (res.control?.what === "greeting" && form.turn_no === 1),
    acks, declines, info, question,
  };
  const reply = render(plan, form, menu, voice);
  return { form, ledger, plan, reply, handoff, progress };
}

function menuInfo(about: string | null, menu: Menu, _form: OrderForm): Info {
  if (about) {
    const r = resolveSpan(about, menu);
    if (r.kind === "item") {
      const item = menu.items.get(r.id)!;
      const fake = { line_id: 0, span: about, item_id: item.id, qty: 1, choices: {}, modifiers: [], held: [], notes: [], slot_candidates: {}, status: { kind: "complete" as const } };
      return { kind: "item", item, unit_cents: unitCents(fake, item) };
    }
    if (r.kind === "ambiguous") return { kind: "list", names: r.ids.map((id) => menu.items.get(id)!.display_name) };
    const cat = itemsInCategory(menu, about);
    if (cat.length) return { kind: "list", names: cat.map((i) => i.display_name) };
  }
  const cats = [...new Set([...menu.items.values()].filter((i) => i.orderable && i.category).map((i) => i.category!))];
  return { kind: "categories", names: cats.slice(0, 12) };
}
