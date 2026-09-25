import { asksPrice, EACH, isQuestion } from "./vocab.ts";
// turn.ts — one conversational turn as a pure function.
//   (form, menu, message, moves) -> (form', ledger, plan, reply)
import { apply, normalizeMoveBatch, type LedgerEntry, type Line, type LineMatcher, type Move, type OpenQuestion, type OrderForm, type LineRef } from "./form.ts";
import type { Menu } from "./menu.ts";
import { reconcile, scan } from "./crossread.ts";
import { bindLine, lineMatchesSpan, matchChoice, narrow, resolveSpan, spanAnswersLine, lineNamedBySpan } from "./resolve.ts";
import { escalate, next, questionKey } from "./next.ts";
import { priceLine, totals, unitCents } from "./price.ts";
import { render, type Ack, type Decline, type Info, type Question, type ReplyPlan } from "./render.ts";
import type { Voice } from "./templates.ts";
import { itemsInCategory } from "./menu.ts";
import { contentWords, leadingCount, splitList, words, findWordRun, isWordSubset, sameWord, STOPWORDS, SIZE_WORDS } from "./normalize.ts";

export interface TurnInput {
  form: OrderForm;
  menu: Menu;
  message: string;
  moves: Move[];
  greet?: boolean;
  checkoutUrl?: string | null;
  /** the moves came from the closed vocabulary: the whole message was the answer, nothing in it is an item */
  closed?: boolean;
  /** typed answers from judge.ts; the core turns probabilities into decisions with JUDGE, nowhere else */
  judgments?: { omission_asked_p?: Record<string, number> };
}
export const JUDGE = { enabled: false, omission_ask_at: 0.5 }; // off by Jason 2026-09-23: small gain, extra dependency; evidence in docs/specs/2026-09-23-jev-phase0-eval.md
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
  const batch = normalizeMoveBatch(input.moves, lineQuestionOpen).filter((m) => { // the model never talks about menu items: "We have chicken cheesesteak, but..." is the engine's to say or not
    const bad = m.kind === "talk" && scan(m.text, menu).hits.length > 0; if (bad) ledger.push({ turn: t, event: "talk_dropped_menu_words", data: { text: (m as { text: string }).text } }); return !bad;
  }), rec = reconcile(input.message, batch, menu, askedSpans);
  if (rec.unaccounted.length && !input.closed) ledger.push({ turn: t, event: "unaccounted_words", data: { words: rec.unaccounted } }); // the floor's gauge: customer words no move or mention placed
  ledger.push({ turn: t, event: "model_moves", data: { moves: batch } }); // what the model said, before any of our reading of it
  for (const r of rec.rejected) ledger.push({ turn: t, event: "rejected_span_not_in_message", data: r });

  // 2. a new-item move that really answers the open line question becomes an answer
  const moves: Move[] = [];
  const hits = scan(input.message, menu).hits; const mw = words(input.message); const usedHits = new Set<unknown>();
  const upgradeSpan = (m: Move & { kind: "add_line" }): Move & { kind: "add_line" } => {
    // "bagel" + ["plain cream cheese"] when the message contains the unique term
    // "bagel with plain cream cheese": the longer term names the item
    const sw = words(m.item_span), ow = m.option_spans.flatMap((o) => words(o)), fits = hits.filter((x) => !usedHits.has(x) && x.item_ids.length === 1 && x.termWords.length > sw.length && sw.every((w) => x.termWords.includes(w)));
    const h = fits.find((x) => ow.length > 0 && ow.every((w) => x.termWords.includes(w))) ?? fits.find((x) => !x.termWords.some((w) => SIZE_WORDS.has(w) && ow.some((o) => SIZE_WORDS.has(o) && o !== w))); // "taco pizza"+["small"] -> the "small taco pizza" mention; never "large jacks special" for the add that said medium
    const standsAlone = (from: number): boolean => { const i = findWordRun(mw, sw, from); return i >= 0 && ((h && (i + sw.length <= h.start || i >= h.end)) || standsAlone(i + 1)); };
    if (!h || standsAlone(0)) return m; // "a cheesesteak, chicken cheesesteak salad": the bare cheesesteak is its own item
    usedHits.add(h);
    // an option is part of the longer name only if the customer did not ALSO say it elsewhere ("chicken bacon ranch ... and bacon")
    const options = m.option_spans.filter((o) => findWordRun(mw, words(o), h.end) >= 0 || (h.start > 0 && findWordRun(mw.slice(0, h.start), words(o)) >= 0) || !words(o).every((w) => h.termWords.includes(w)));
    ledger.push({ turn: t, event: "span_upgraded", data: { from: m.item_span, to: h.termWords.join(" ") } });
    return { ...m, item_span: h.termWords.join(" "), option_spans: options };
  };
  const open = form0.open, focus = open && "line_id" in open ? form0.lines.find((l) => l.line_id === open.line_id) : undefined; let splitFocus = false;
  const focusRemoved = !!focus && batch.some((x) => x.kind === "remove_line" && ("line_id" in x.ref ? x.ref.line_id === focus.line_id : "span" in x.ref && lineMatchesSpan(focus, x.ref.span, menu)));
  // a rejected add whose item word was invented ("pizza") but whose option words, or the item span's own
  // verbatim words ("plain" out of "plain pizza"), answer the open line question keeps that answer
  if (focus) for (const r of rec.rejected) {
    if (r.move.kind !== "add_line") continue;
    const itemVerbatim = words(r.move.item_span).filter((w) => mw.includes(w)).join(" ");
    const o = [itemVerbatim, ...r.move.option_spans].find((o) => words(o).length > 0 && words(o).every((w) => mw.includes(w)) && spanAnswersLine(focus, o, menu));
    if (o) { rec.accepted.push({ kind: "answer_option", value_span: o }); ledger.push({ turn: t, event: "salvaged_answer_from_rejected_add", data: { span: o } }); }
  }
  // "one plain one pepperoni", "white, white, rye" as one string: cut at the count words, one piece per option, identical pieces merged
  const countedPieces = (text: string) => splitList(text).flatMap((p) => { const out: string[][] = [[]]; for (const w of words(p)) { if (out[out.length - 1].length && leadingCount(w + " x").count !== null) out.push([]); out[out.length - 1].push(w); } return out.filter((x) => x.length).map((x) => x.join(" ")); })
    .map((p) => { const lc = leadingCount(p); return { span: lc.rest || p, qty: lc.count ?? 1 }; }).reduce<Array<{ span: string; qty: number }>>((acc, p) => { const same = acc.find((q) => q.span === p.span); if (same) same.qty += p.qty; else acc.push(p); return acc; }, []);
  // "3 turkey hoagies" + "one white, one rye, one wheat": counted options for the asked slot split the line, one per option
  const openG = focus?.item_id && open?.kind === "line_slot" && focus.qty > 1 ? menu.items.get(focus.item_id)!.groups.find((g) => g.id === open.group_id) : undefined;
  if (openG) { // read from the message itself: the model sends this as "qty 2" + a second add, or as one string, or not at all
    const all = countedPieces(input.message), pieces = all.filter((p) => matchChoice(p.span, openG).kind === "one");
    if (pieces.length >= 2 && all.length - pieces.length <= 1 && pieces.reduce((n, p) => n + p.qty, 0) === focus!.qty) {
      const aboutFocus = (m: Move) => (m.kind === "answer_option" && (m.line_id === undefined || m.line_id === focus!.line_id)) || ((m.kind === "change_line" || m.kind === "add_line") && lineMatchesSpan(focus!, m.kind === "add_line" ? m.item_span : "span" in m.ref ? m.ref.span : "", menu)) || (m.kind === "change_line" && "line_id" in m.ref && m.ref.line_id === focus!.line_id);
      const keep = rec.accepted.filter((m) => !aboutFocus(m)); rec.accepted.length = 0; rec.accepted.push(...keep, { kind: "split_line", line_id: focus!.line_id, parts: pieces.map((p) => ({ span: focus!.span, qty: p.qty, held: [p.span] })) });
      rec.rejected.length = 0; splitFocus = true; const om = rec.omissions.filter((o) => !pieces.some((p) => p.span === o.span)); rec.omissions.length = 0; rec.omissions.push(...om); // "white" here is a bread, not a White Pizza
      ledger.push({ turn: t, event: "counted_slot_answers_split", data: { parts: pieces } });
    }
  }
  // "one of each except sweet potato" -> seven adds of "fries", one kind each: "fries" is not in the message, but every kind is a candidate of the line we asked about: a split, not inventions
  if (focus && focus.status.kind === "ambiguous") {
    const cands = focus.status.candidates, one = (text: string) => narrow(cands, text, menu).length === 1;
    const tokens = (text: string) => (({ count, rest }) => one(rest || text) ? [{ span: rest || text, qty: count ?? 1 }] : null)(leadingCount(text)) ?? countedPieces(text);
    // each add or answer naming exactly one kind of the asked-about line is a part ("fries"+["crazy"], "crazy fries", the answer "Bacon Cheese", "one plain one pepperoni")
    const partsOf = (m: Move) => m.kind === "add_line" ? (one([m.item_span, ...m.option_spans].join(" ")) && (lineMatchesSpan(focus, m.item_span, menu) || cands.some((id) => lineMatchesSpan({ ...focus, item_id: id }, m.item_span, menu))) ? [{ span: [m.item_span, ...m.option_spans].join(" "), qty: Math.max(1, m.qty) }] : [])
      : m.kind === "answer_option" && (m.line_id === undefined || m.line_id === focus.line_id) ? tokens(m.value_span).filter((p) => one(p.span)) : [];
    let parts = batch.flatMap(partsOf);
    // "one of each (except sweet potato)": every kind, minus the ones the message names
    const each = EACH.some((e) => findWordRun(mw, words(e)) >= 0);
    if (each) {
      const label = (id: string) => menu.items.get(id)?.facets.kind ?? menu.items.get(id)?.display_name ?? id;
      const kinds = [...new Set(cands.map(label))], shared = words(kinds[0]).filter((w) => kinds.every((k) => words(k).includes(w)));
      parts = kinds.filter((k) => !words(k).filter((w) => !shared.includes(w)).every((w) => mw.includes(w))).map((k) => ({ span: k, qty: 1 }));
    } else for (const o of rec.omissions) if (one(o.span) && !parts.some((p) => narrow(cands, p.span, menu)[0] === narrow(cands, o.span, menu)[0] || findWordRun(mw, [...words(p.span), ...words(o.span)]) >= 0 || findWordRun(mw, [...words(o.span), ...words(p.span)]) >= 0)) parts.push({ span: o.span, qty: o.qty }); // a kind the model left out ("one plain, ..."); "turkey sandwich" is one mention, not turkey plus a sandwich
    const pos = (span: string) => { const i = mw.indexOf(words(span).find((w) => !STOPWORDS.has(w)) ?? ""); return i < 0 ? 999 : i; }; // lines in the order the customer said them
    parts = parts.reduce<typeof parts>((acc, p) => { const same = acc.find((q) => narrow(cands, q.span, menu)[0] === narrow(cands, p.span, menu)[0]); if (same) same.qty += p.qty; else acc.push({ ...p }); return acc; }, []); // "cheesesteak sandwich for both of em": one answer said twice is one answer, not two lines
    parts.sort((x, y) => pos(x.span) - pos(y.span));
    if (parts.length >= 2 || (parts.length === 1 && focus.qty > 1 && parts[0].qty === focus.qty)) {
      const aboutFocus = (m: Move) => (m.kind === "add_line" && lineMatchesSpan(focus, m.item_span, menu)) || ((m.kind === "change_line" || m.kind === "remove_line") && ("line_id" in m.ref ? m.ref.line_id === focus.line_id : "span" in m.ref && lineMatchesSpan(focus, m.ref.span, menu)));
      // the parts replace the model's own adds, changes and removal of that line; an answer for it that named no kind becomes an add, so it is asked about, never lost
      const keep = rec.accepted.filter((m) => partsOf(m).length === 0 && !aboutFocus(m) && !(each && m.kind === "answer_option" && (m.line_id === undefined || m.line_id === focus.line_id))).map((m) => m.kind === "answer_option" && (m.line_id === undefined || m.line_id === focus.line_id) ? { kind: "add_line" as const, item_span: m.value_span, qty: 1, option_spans: [] } : m);
      rec.accepted.length = 0; rec.accepted.push(...keep, { kind: "split_line", line_id: focus.line_id, parts });
      ledger.push({ turn: t, event: "kind_adds_are_a_split", data: { line_id: focus.line_id, parts } });
      splitFocus = true; const om = rec.omissions.filter((o) => !one(o.span)); rec.omissions.length = 0; rec.omissions.push(...om); // the kinds were spoken for
    }
  }
  // uncovered customer words that answer the open line question are answers, not omissions
  if (focus && !splitFocus) {
    const keep: typeof rec.omissions = [];
    for (const om of rec.omissions) {
      // "yo i said chicken cheesesteak sandwich" against a list that missed it: a whole item name sharing a word with the line is the line, not a second order
      const names = (focus.status.kind === "ambiguous" || focus.status.kind === "unresolved") && !batch.some((m) => m.kind === "add_line") && om.item_ids.length === 1 && !(focus.status.kind === "ambiguous" && focus.status.candidates.includes(om.item_ids[0])) && contentWords(om.span).some((w) => contentWords(focus.span).some((f) => sameWord(w, f)));
      if ((names || spanAnswersLine(focus, om.span, menu)) && !rec.accepted.some((m) => m.kind === "answer_option" && words(m.value_span).join(" ") === om.span)) {
        rec.accepted.push({ kind: "answer_option", value_span: om.span });
        ledger.push({ turn: t, event: names ? "mention_names_the_line" : "uncovered_word_answers_question", data: { span: om.span } });
      } else keep.push(om);
    }
    rec.omissions.length = 0; rec.omissions.push(...keep);
  }
  if (input.closed) rec.omissions.length = 0;
  // the judge read each uncovered mention: below the threshold the customer was not ordering it, so no question
  const jp = input.judgments?.omission_asked_p;
  if (jp) {
    const keep = rec.omissions.filter((om) => { const v = jp[om.span]; if (v !== undefined && v < JUDGE.omission_ask_at) { ledger.push({ turn: t, event: "omission_dropped_by_judge", data: { span: om.span, p: v } }); return false; } return true; });
    rec.omissions.length = 0; rec.omissions.push(...keep);
  }
  for (const m0 of rec.accepted) {
    // "make the large a medium" sent as remove:[large] alone: the other size word in the message is the size wanted
    const sizes = m0.kind === "change_line" && !m0.add_option_spans?.some((o) => words(o).some((w) => SIZE_WORDS.has(w))) && m0.remove_option_spans?.some((o) => words(o).some((w) => SIZE_WORDS.has(w))) ? [...new Set(mw.filter((w) => SIZE_WORDS.has(w) && !m0.remove_option_spans!.some((o) => words(o).includes(w))))] : [];
    const m: Move = m0.kind === "add_line" ? upgradeSpan(m0) : m0.kind === "change_line" && sizes.length === 1 ? { ...m0, add_option_spans: [...(m0.add_option_spans ?? []), sizes[0]] } : m0;
    if (m.kind === "remove_line") { // "take one off" a line of three lowers it to two; the whole line goes only when nothing counts fewer
      const ref = m.ref, tgt = "line_id" in ref ? form0.lines.find((l) => l.line_id === ref.line_id) : "span" in ref ? form0.lines.find((l) => lineMatchesSpan(l, ref.span, menu)) : undefined, n = mw.map((w) => leadingCount(`${w} x`).count).find((c) => c !== null && c > 0);
      if (tgt?.item_id && tgt.qty > 1 && n && n < tgt.qty && !batch.some((x) => x.kind === "add_line")) { moves.push({ kind: "change_line", ref: { line_id: tgt.line_id }, qty: tgt.qty - n, add_option_spans: [], remove_option_spans: [] }); ledger.push({ turn: t, event: "remove_some", data: { line_id: tgt.line_id, count: n } }); continue; }
    }
    if (m.kind === "answer_option" && m.line_id !== undefined) { // "white bread for both chicken parms" pointed at the cheesesteak: the words name the line
      const named = form0.lines.filter((l) => l.item_id && l.status.kind !== "complete" && contentWords(m.value_span).some((w) => menu.items.get(l.item_id!)!.words.some((iw) => sameWord(iw, w) || (w.length >= 4 && iw.startsWith(w)))));
      if (named.length === 1 && named[0].line_id !== m.line_id) { ledger.push({ turn: t, event: "answer_rerouted_to_named_line", data: { span: m.value_span, from: m.line_id, line_id: named[0].line_id } }); moves.push({ ...m, line_id: named[0].line_id }); continue; }
    }
      // "3 thin sicilians. one pepperoni, one sausage, one plain": options each preceded by a count that adds up to the quantity are one line each
    if (m.kind === "add_line" && m.qty >= 2 && m.option_spans.length >= 2) {
      const counts = m.option_spans.map((o) => { const i = findWordRun(mw, words(o)); return i > 0 ? leadingCount(mw[i - 1] + " x").count : null; });
      if (counts.every((c) => c !== null) && counts.reduce((a, c) => a + (c ?? 0), 0) === m.qty) {
        for (const [i, o] of m.option_spans.entries()) moves.push({ ...m, qty: counts[i]!, option_spans: [o] });
        ledger.push({ turn: t, event: "counted_options_split", data: { span: m.item_span, parts: m.option_spans.map((o, i) => ({ span: o, qty: counts[i] })) } });
        continue;
      }
    }
    // an "item" answering the line we asked about is an answer; one answering ANOTHER pending line's question ("boneless" while we ask about the garlic bread) is routed there
    const span = m.kind === "add_line" ? m.item_span : m.kind === "answer_option" ? m.value_span : null;
    if (span && focus && !(m.kind === "add_line" && focusRemoved)) { // "scratch that. 2 chicken parms and a cheesesteak": adds beside the removal are new lines, not answers to the line going away
      const replacesUnresolved = m.kind === "add_line" && focus.status.kind === "unresolved" && resolveSpan(span, menu).kind !== "none";
      const target = spanAnswersLine(focus, span, menu) ? focus
        : form0.lines.find((l) => l.line_id !== focus.line_id && l.status.kind !== "complete" && spanAnswersLine(l, span, menu)) ?? (replacesUnresolved ? focus : undefined);
      if (target && (m.kind === "add_line" || target !== focus)) {
        const line_id = target === focus ? undefined : target.line_id;
        moves.push({ kind: "answer_option", value_span: span, line_id });
        if (m.kind === "add_line") for (const o of m.option_spans ?? []) moves.push({ kind: "answer_option", value_span: o, line_id });
        ledger.push({ turn: t, event: target === focus ? "add_reclassified_as_answer" : "answer_routed_to_line", data: { span, line_id: target.line_id } });
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

  const targetOf = (ref: LineRef) => "line_id" in ref ? form0.lines.find((l) => l.line_id === ref.line_id) : "span" in ref ? form0.lines.find((l) => lineMatchesSpan(l, ref.span, menu)) : form0.lines.length === 1 ? form0.lines[0] : undefined;
  // 2. a change_line that changes nothing is the model pointing at a line: beside an add in the same
  // batch ("actually pepperoni not cheese") that is a replacement; on its own it is nothing
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    if (m.kind !== "change_line" || m.qty != null || m.add_option_spans?.length || m.remove_option_spans?.length) continue;
    const target = targetOf(m.ref);
    if (target && moves.some((x) => x.kind === "add_line")) {
      moves.splice(i, 1, { kind: "remove_line", ref: { line_id: target.line_id } });
      ledger.push({ turn: t, event: "empty_change_beside_add_is_swap", data: { line_id: target.line_id } });
    } else moves.splice(i, 1);
  }

  // 2a. "make the coke a diet": an option word that names a different item is a swap, not a note
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.kind !== "change_line" || !m.add_option_spans?.length) continue;
    const target = targetOf(m.ref);
    if (!target?.item_id) continue;
    const cur = menu.items.get(target.item_id);
    for (const o of m.add_option_spans) {
      const r = resolveSpan(`${o} ${cur?.display_name ?? target.span}`, menu);
      if (r.kind === "item" && r.id !== target.item_id) {
        moves.splice(i, 1, { kind: "remove_line", ref: { line_id: target.line_id } }, { kind: "add_line", item_span: menu.items.get(r.id)!.display_name, qty: m.qty ?? target.qty, option_spans: [] });
        ledger.push({ turn: t, event: "option_names_other_item_swap", data: { from: target.item_id, to: r.id, option: o } });
        i++;
        break;
      }
    }
  }

  // 3. apply
  const matcher: LineMatcher = Object.assign((line: Line, span: string) => lineMatchesSpan(line, span, menu), { named: (line: Line, span: string) => lineNamedBySpan(line, span, menu) });
  const res = apply(form0, moves, matcher);
  const form = res.form;
  ledger.push(...res.ledger);

  // 4. bind every line as far as the data allows
  const before = new Map(input.form.lines.map((l) => [l.line_id, JSON.stringify(l)]));
  for (const l of form.lines) bindLine(l, menu);
  // identical lines merge: "add two more hot dogs" is 3 × Hot Dog on one ticket row, not two rows
  for (let i = 0; i < form.lines.length; i++) for (let j = form.lines.length - 1; j > i; j--) {
    const a = form.lines[i], b = form.lines[j], same = (l: Line) => JSON.stringify([l.item_id, l.choices, l.modifiers, l.notes, l.selections ?? null]);
    if (a.item_id && a.status.kind === "complete" && b.status.kind === "complete" && same(a) === same(b)) { a.qty += b.qty; form.lines.splice(j, 1); res.touched.push(a.line_id); ledger.push({ turn: t, event: "lines_merged", data: { into: a.line_id, from: b.line_id } }); }
  }
  for (const l of form.lines) if (before.get(l.line_id) !== JSON.stringify(l) && !res.touched.includes(l.line_id)) res.touched.push(l.line_id);

  // 5. omissions: an item the second reader saw and the first did not act on. In a conversation-only message a lone uncounted word ("my house") is not an order; a multi-word name or a counted mention is.
  const remarkOnly = moves.length > 0 && moves.every((m) => m.kind === "talk" || m.kind === "ask_menu" || m.kind === "control"), strong = (om: { span: string; qty: number }) => om.qty > 1 || contentWords(om.span).length >= 2;
  const refSpans = moves.flatMap((m) => (m.kind === "remove_line" || m.kind === "change_line") && "span" in m.ref ? [words(m.ref.span)] : []);
  const cartWords = form.lines.flatMap((l) => l.item_id ? menu.items.get(l.item_id)!.words : []), asking = isQuestion(input.message) && !res.askMenu && !input.closed;
  let cartAnswer: Info | null = null; // "did you add a hot dog?": answer from the cart; if it is not there, offer it
  const askedItem = typeof res.askMenu === "string" && isQuestion(input.message) ? menuInfo(res.askMenu, menu, false) : null; // "do you have hot dogs?": the next question is "want one?"
  if (askedItem?.kind === "item" && !form.lines.some((l) => l.item_id === askedItem.item.id) && !form.omissions.some((o) => o.span === words(askedItem.item.display_name).join(" "))) form.omissions.push({ span: words(askedItem.item.display_name).join(" "), qty: 1, declined: false, offer: true });
  for (const om of rec.omissions) {
    if (refSpans.some((r) => isWordSubset(words(om.span), r) || isWordSubset(r, words(om.span)))) continue; // "scratch the soup": removed, not forgotten
    if (remarkOnly && !rec.omissions.some(strong)) { ledger.push({ turn: t, event: "omission_ignored_in_remark", data: { span: om.span } }); continue; }
    const onOrder = form.lines.find((l) => l.item_id && lineNamedBySpan(l, om.span, menu));
    if (asking && om.item_ids.length === 1 && !cartAnswer) { cartAnswer = onOrder ? { kind: "cart_has", qty: onOrder.qty, name: menu.items.get(onOrder.item_id!)!.display_name } : { kind: "cart_lacks", name: menu.items.get(om.item_ids[0])!.display_name }; if (!onOrder) form.omissions.push({ span: om.span, qty: om.qty, declined: false, offer: true }); ledger.push({ turn: t, event: "cart_question_answered", data: { span: om.span, has: !!onOrder } }); continue; }
    if (contentWords(om.span).every((w) => cartWords.some((cw) => sameWord(cw, w)))) { ledger.push({ turn: t, event: "omission_restates_cart", data: { span: om.span } }); continue; } // "just the chicken and pizza": the lines already there
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
  const stripNotes = (f: OrderForm) => JSON.stringify({ ...f, lines: f.lines.map((l) => ({ ...l, notes: [], held: [] })), open: null, asked: null, turn_no: 0 });
  const progress = res.ledger.some(isProgress) && stripNotes(form) !== stripNotes(input.form);
  // a remark, a menu question or a cart read-back is a conversation, not a customer who is stuck
  const conversational = res.talk !== null || res.askMenu !== undefined || res.showCart;
  let q: OpenQuestion | null = next(form, menu, res.refAsk);
  let key = questionKey(q);
  let count = key !== null && key === form.asked.key && !progress ? (conversational ? form.asked.count : form.asked.count + 1) : 0;
  form.open = q; form.asked = { key, count };
  const declines: Decline[] = res.declines.map((d) => ({ code: d.code, span: d.span }));
  const note = escalate(form, menu);
  if (note) {
    ledger.push({ turn: t, event: "escalated", data: note }); const [code, span] = note.split(":");
    if (code === "dropped_line" || code === "address_to_pickup" || code === "tip_zero") declines.push({ code, span: code === "dropped_line" ? span : undefined });
    q = next(form, menu, null); key = questionKey(q); count = 0; form.open = q; form.asked = { key, count };
  }
  if (q && "line_id" in q) {
    const l = form.lines.find((x) => x.line_id === q.line_id);
    const same = input.form.open && "line_id" in input.form.open && input.form.open.line_id === q.line_id;
    if (l) l.asks = same ? (l.asks ?? 0) + 1 : (l.asks ?? 0);
  }
  if (q?.kind === "items" && form.items_done && form.lines.every((l) => l.status.kind !== "complete")) { form.items_done = false; form.confirmed = false; form.status = "open"; }
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
    else if (!newIds.has(id) && id !== focusId && l.item_id && before.get(id)) { // "ranch" landed on the salad while we were asking about the fries: say so
      const was = (JSON.parse(before.get(id)!) as Line).choices, it = menu.items.get(l.item_id)!, picks = it.groups.flatMap((g) => g.choices.filter((c) => c.id === l.choices[g.id] && was[g.id] !== c.id).map((c) => c.name));
      if (picks.length) acks.push({ kind: "line_progress", name: it.display_name, picks });
    }
    const prevNotes = before.get(id) ? (JSON.parse(before.get(id)!) as { notes: string[] }).notes.length : 0;
    if (l.notes.length > prevNotes) notes.push(...l.notes.slice(prevNotes));
  }
  if (notes.length) acks.push({ kind: "noted", notes });
  // lines taken this turn that still need a question: say so, so the customer knows they were heard
  const pending = form.lines.filter((l) => newIds.has(l.line_id) && l.status.kind !== "complete" && l.line_id !== focusId);
  const agg = new Map<string, number>(); for (const l of pending) { const k = l.item_id ? menu.items.get(l.item_id)!.display_name : l.span; agg.set(k, (agg.get(k) ?? 0) + l.qty); } // resolved lines by name; "fries and fries" -> "3 fries"
  if (pending.length) acks.push({ kind: "pending", items: [...agg].map(([span, qty]) => ({ qty, span })) });
  for (const r of res.removed) {
    const it = r.item_id ? menu.items.get(r.item_id) : null, taught = !it && batch.find((m) => m.kind === "add_line");
    if (it) acks.push({ kind: "line_removed", name: it.display_name });
    else if (taught && taught.kind === "add_line") { acks.push({ kind: "gotcha" }); ledger.push({ turn: t, event: "taught_term", data: { span: r.span, means: taught.item_span, item_id: form.lines.find((l) => newIds.has(l.line_id) && l.item_id && lineMatchesSpan(l, taught.item_span, menu))?.item_id ?? null } }); } // "oh sorry, glizzies means hot dog": a replacement, and a word to remember
    else declines.push({ code: "dropped_line", span: r.span });
  }

  let info: Info | null = null;
  if (res.showCart) info = { kind: "cart", totals: totals(form, menu) };
  // "what do you have?" during a kind question: the re-asked question lists the choices itself
  if (cartAnswer) info = cartAnswer;
  const aboutFocus = (about: string) => { const r = resolveSpan(about, menu), fid = focus?.item_id; return r.kind === "none" || (!!fid && (r.kind === "item" ? r.id === fid : r.ids.includes(fid))); }; // "what flavors u got?", "what wings do you have?" while we ask the wings' flavor: the flavors
  if (res.askMenu !== undefined) info = res.askMenu === null && input.form.open?.kind === "line_ambiguous" ? null : (res.askMenu === null || (input.form.open?.kind === "line_slot" && aboutFocus(res.askMenu))) && input.form.open && "line_id" in input.form.open ? questionOptions(input.form, menu) : menuInfo(res.askMenu, menu, asksPrice(input.message));
  if (info?.kind === "item" && isQuestion(input.message)) info = { ...info, answer: true }; // "Yes, we do."
  if (res.control?.what === "human") info = { kind: "human" };
  if (res.control?.what === "cancel") info = { kind: "cancelled" };
  if (res.control?.what === "start_over") info = { kind: "started_over" };
  const askedSomethingNew = q !== null && questionKey(q) !== questionKey(input.form.open);
  if (res.control?.what === "unclear" && !progress && !askedSomethingNew && !res.talk) info = info ?? { kind: "unclear" }; // an answer we found ourselves ("yes, 1 × Hot Dog is on your order") beats the model's shrug
  if (moves.length === 0 && rec.rejected.length === 0 && !progress && count > 0) info = info ?? { kind: "unclear" };

  let question: Question | null = null;
  if (form.status === "abandoned") question = null;
  else if (handoff) question = { kind: "handoff", totals: totals(form, menu), url: input.checkoutUrl ?? null };
  else if (q?.kind === "confirm") question = { kind: "readback", totals: totals(form, menu), count };
  else if (q) question = { kind: "open", open: q, count, heard: count > 0 && !conversational && !input.closed ? words(input.message).join(" ") : undefined };

  // a first-contact greeting only when nothing else was said and we are asking the opener
  const plan: ReplyPlan = {
    greeting: !!input.greet || (res.control?.what === "greeting" && form.turn_no === 1),
    talk: res.talk,
    acks, declines, info, question,
  };
  const reply = render(plan, form, menu, voice);
  if (plan.question?.kind === "readback") form.said_robot = true;
  return { form, ledger, plan, reply, handoff, progress };
}

function menuInfo(about: string | null, menu: Menu, price: boolean): Info {
  if (about) {
    const r = resolveSpan(about, menu);
    if (r.kind === "item") {
      const item = menu.items.get(r.id)!;
      const fake = { line_id: 0, span: about, item_id: item.id, qty: 1, choices: {}, modifiers: [], held: [], notes: [], slot_candidates: {}, status: { kind: "complete" as const } };
      return { kind: "item", item, unit_cents: unitCents(fake, item), price };
    }
    if (r.kind === "ambiguous") {
      const its = r.ids.map((id) => menu.items.get(id)!);
      const kinds = new Set(its.map((i) => i.facets.kind ?? i.display_name));
      if (kinds.size === 1 && its.every((i) => i.facets.size)) { // one pizza in three sizes: describe it once, list the sizes
        const first = its.find((i) => i.description) ?? its[0];
        return { kind: "item", item: first, unit_cents: first.base_cents, sizes: its.map((i) => ({ name: i.facets.size!, cents: i.base_cents })), price };
      }
      return { kind: "list", names: its.map((i) => i.display_name) };
    }
    const cat = itemsInCategory(menu, about);
    if (cat.length) return { kind: "list", names: cat.map((i) => i.display_name) };
    return { kind: "not_found", about };
  }
  const cats = [...new Set([...menu.items.values()].filter((i) => i.orderable && i.category).map((i) => i.category!))];
  return { kind: "categories", names: cats.slice(0, 12) };
}

/** "what are the options?" while a line question is open lists that question's choices. */
function questionOptions(form: OrderForm, menu: Menu): Info {
  const open = form.open!;
  const l = "line_id" in open ? form.lines.find((x) => x.line_id === open.line_id) : undefined;
  if (!l) return menuInfo(null, menu, false);
  if (l.status.kind === "ambiguous") return { kind: "list", names: l.status.candidates.map((id) => menu.items.get(id)?.display_name ?? id) };
  const item = l.item_id ? menu.items.get(l.item_id) : null;
  if (item && l.status.kind === "needs_slot") { const g = item.groups.find((x) => x.id === (l.status as { group_id: string }).group_id); if (g) return { kind: "list", names: g.choices.map((c) => c.name) }; }
  if (item?.bundle) return { kind: "list", names: item.bundle.choices.map((c) => c.name) };
  return menuInfo(null, menu, false);
}