// form.ts — the order form (state), the moves that may change it, the ledger,
// and the pure reducer `apply`. Code owns everything in here. No text matching.

import { contentWords, optionKey, validTalk, isWordSubset, words, isDigits, leadingCount } from "./normalize.ts";

export type Fulfillment = "pickup" | "delivery";

export interface Address {
  text: string;
  formatted: string | null;
  validated: boolean;
  zone_ok: boolean;
  /** read_as: the geocoder read the street differently from what was typed ("w union st" -> "Union St"): say so, take a correction. delivery_quote_*: a courier shop's quote for this address (runner); a new address carries its own */
  read_as?: boolean; delivery_quote_cents?: number; delivery_quote_id?: string; /** the courier that priced it ("uber"); the pay-link line names it */ delivery_courier?: string;
}

export type Tip = { kind: "percent"; value: number } | { kind: "cents"; value: number };

export type LineStatus =
  | { kind: "unresolved" }
  | { kind: "ambiguous"; candidates: string[]; facet: "kind" | "size" | "list" | null }
  | { kind: "needs_slot"; group_id: string }
  | { kind: "needs_picks"; remaining: number }
  | { kind: "complete" };

export interface Line {
  line_id: number;
  span: string;
  item_id: string | null;
  qty: number;
  /** required slot group_id -> choice_id */
  choices: Record<string, string>;
  /** modifier choice ids (priced add-ons) */
  modifiers: string[];
  /** option spans waiting to be applied (before the item binds) */
  held: string[];
  /** unpriced kitchen note; each entry was a span we could not price */
  notes: string[];
  /** when a slot answer matched several choices: group_id -> the matching choice ids */
  slot_candidates: Record<string, string[]>;
  /** set once the span's leftover words have been applied as options */
  span_consumed?: boolean;
  /** bundle picks: choice_id -> count */
  selections?: Record<string, number>;
  /** answers to "which kind?" questions: used to narrow, dropped if they match nothing */
  answers?: string[];
  /** how many times a question about this line has been asked */
  asks?: number;
  /** piece-count quantity normalization already done */
  pieces_applied?: boolean;
  status: LineStatus;
}

export type OpenQuestion =
  | { kind: "fulfillment" }
  | { kind: "address" }
  | { kind: "items" }
  | { kind: "tip" }
  | { kind: "confirm" }
  | { kind: "line_unresolved"; line_id: number }
  | { kind: "line_ambiguous"; line_id: number; facet: "kind" | "size" | "list" }
  | { kind: "line_slot"; line_id: number; group_id: string }
  | { kind: "line_picks"; line_id: number; remaining: number }
  | { kind: "omission"; spans: string[] }
  | { kind: "line_ref"; candidates: number[]; pending: Move };

export type OrderStatus = "open" | "confirming" | "awaiting_payment" | "paid" | "abandoned";

export interface OrderForm {
  v: 1;
  shop_id: string;
  menu_version: string | null;
  status: OrderStatus;
  fulfillment: Fulfillment | null;
  address: Address | null;
  tip: Tip | null;
  items_done: boolean;
  confirmed: boolean;
  lines: Line[];
  next_line_id: number;
  open: OpenQuestion | null;
  /** how many consecutive turns the same question has been open without progress */
  asked: { key: string | null; count: number };
  omissions: Array<{ span: string; qty: number; declined: boolean; offer?: boolean; side_of?: string }>; // offer: we answered "do you have X?" and asked "want one?"
  said_robot?: boolean; // the "I'm a robot" line is said once per conversation
  relink?: boolean; // a pay link existed and the order changed: send the updated order and a fresh link together, no second YES
  turn_no: number;
  /** set by the runner when a checkout session exists for the confirmed form */
  checkout_session_id: string | null;
  checkout_url?: string | null; // the pay link once created, so a later message re-sends it instead of a failure line
}

export function newForm(shop_id: string, menu_version: string | null): OrderForm {
  return {
    v: 1, shop_id, menu_version, status: "open",
    fulfillment: null, address: null, tip: null, items_done: false, confirmed: false,
    lines: [], next_line_id: 1, open: null, asked: { key: null, count: 0 },
    omissions: [], turn_no: 0, checkout_session_id: null,
  };
}

// ── Moves: the only way the form changes ────────────────────────────────────
export type LineRef =
  | { line_id: number }
  | { ordinal: number }
  | { span: string }
  | { last: true };

export type Move =
  | { kind: "answer"; field: "fulfillment"; value: Fulfillment }
  | { kind: "answer"; field: "address"; value: Address }
  | { kind: "answer"; field: "tip"; value: Tip }
  | { kind: "answer"; field: "items_done"; value: true }
  | { kind: "answer"; field: "confirmed"; value: boolean }
  | { kind: "add_line"; item_span: string; qty: number; option_spans: string[]; note?: string | null }
  | { kind: "change_line"; ref: LineRef; qty?: number | null; add_option_spans?: string[]; remove_option_spans?: string[] }
  | { kind: "remove_line"; ref: LineRef }
  | { kind: "answer_option"; value_span: string; line_id?: number }
  | { kind: "answer_yes" }
  | { kind: "answer_no" }
  | { kind: "split_line"; line_id: number; parts: Array<{ span: string; qty: number; held?: string[] }> }
  | { kind: "ask_menu"; about_span: string | null }
  | { kind: "talk"; text: string }
  | { kind: "control"; what: "cancel" | "start_over" | "human" | "greeting" | "unclear" | "show_cart" };

export interface LedgerEntry { turn: number; event: string; data?: unknown }

// ── Reducer ─────────────────────────────────────────────────────────────────
export interface ApplyResult {
  form: OrderForm;
  ledger: LedgerEntry[];
  /** lines created or changed this turn (for acknowledgement) */
  touched: number[];
  removed: Array<{ line_id: number; item_id: string | null; span: string }>;
  /** a move needing a "which one?" question */
  refAsk: { candidates: number[]; pending: Move } | null;
  /** moves that could not be applied and why (rendered as declines) */
  declines: Array<{ code: DeclineCode; span?: string }>;
  showCart: boolean;
  askMenu: string | null | undefined; // undefined = not asked, null = general
  control: Move & { kind: "control" } | null;
  /** a short conversational reply the model wrote for an off-order remark; validated before render */
  talk: string | null;
}

export type DeclineCode =
  | "no_such_line"
  | "nothing_to_remove"
  | "not_delivery_shop"
  | "address_not_found"
  | "address_out_of_zone"
  | "tip_out_of_range";

function newLine(form: OrderForm, span: string, qty: number, held: string[], extra: Partial<Line> = {}): Line { // a fresh, unresolved line with the next id; `extra` overrides fields (answers, notes, status)
  return { line_id: form.next_line_id++, span, item_id: null, qty: Math.max(1, qty), choices: {}, modifiers: [], held, notes: [], slot_candidates: {}, status: { kind: "unresolved" }, ...extra };
}

const REF_FILLER = new Set(["number", "num", "no", "option", "item", "line", "the", "pick", "choice"]);
/** "2", "number 2", "option 2": the numbered entry of the list we just showed; null otherwise */
function refDigit(span: string): number | null { const w = words(span).filter((x) => !REF_FILLER.has(x)); if (w.length !== 1) return null; if (isDigits(w[0])) return parseInt(w[0], 10); const lc = leadingCount(w[0] + " x"); return lc.count !== null && lc.count > 0 ? lc.count : null; }
export type LineMatcher = ((line: Line, span: string) => boolean) & { named?: (line: Line, span: string) => boolean };
export function apply(input: OrderForm, moves: Move[], lineSpanMatcher: LineMatcher): ApplyResult {
  const form: OrderForm = structuredClone(input);
  const ledger: LedgerEntry[] = [];
  const touched = new Set<number>();
  const removed: ApplyResult["removed"] = [];
  const declines: ApplyResult["declines"] = [];
  let refAsk: ApplyResult["refAsk"] = null;
  let showCart = false;
  let askMenu: string | null | undefined = undefined;
  let control: ApplyResult["control"] = null;
  let talk: string | null = null;
  const t = form.turn_no;

  const reopenIfConfirmed = () => {
    if (form.status === "confirming" || form.status === "awaiting_payment") {
      if (form.status === "awaiting_payment") form.relink = true;
      form.status = "open";
      form.confirmed = false;
      form.checkout_session_id = null;
      ledger.push({ turn: t, event: "reopened_after_confirm" });
    }
  };

  const resolveRef = (ref: LineRef): number[] => {
    const live = form.lines;
    if ("line_id" in ref) return live.some((l) => l.line_id === ref.line_id) ? [ref.line_id] : [];
    if ("ordinal" in ref) { const l = live[ref.ordinal - 1]; return l ? [l.line_id] : []; }
    if ("last" in ref) return live.length === 1 ? [live[0].line_id] : (live.length ? [live[live.length - 1].line_id] : []);
    const digit = refDigit(ref.span);
    if (digit !== null) { const i = digit - 1, pick = form.open?.kind === "line_ref" ? form.open.candidates[i] : live[i]?.line_id; return pick !== undefined && live.some((l) => l.line_id === pick) ? [pick] : []; } // "cancel the first one" against the list we just showed
    const overlap = live.filter((l) => lineSpanMatcher(l, ref.span)), named = overlap.filter((l) => lineSpanMatcher.named?.(l, ref.span));
    const hitLines = named.length > 0 ? named : overlap; // "cheesesteak salad" names the salad line; it only overlaps the pending "cheesesteak" line
    const hits = hitLines.map((l) => l.line_id);
    if (hits.length === 0 && contentWords(ref.span).length === 0) return live.length === 1 ? [live[0].line_id] : live.map((l) => l.line_id);
    return hitLines.length > 1 && hitLines.every((l) => JSON.stringify([l.item_id, l.choices, l.modifiers, l.notes]) === JSON.stringify([hitLines[0].item_id, hitLines[0].choices, hitLines[0].modifiers, hitLines[0].notes])) ? [hits[0]] : hits; // identical lines: no "which one"
  };

  const targetLine = (m: Move & { kind: "change_line" | "remove_line" }): Line | null => { // the one line a change/remove refers to; records a decline or a which-one question and returns null otherwise
    const ids = resolveRef(m.ref);
    const ref = m.ref, gone = "span" in ref && removed.some((r) => isWordSubset(words(ref.span), words(r.span))); // already gone this same message: nothing to say
    if (ids.length === 0) { if (!gone) declines.push({ code: "no_such_line", span: "span" in ref ? ref.span : undefined }); return null; }
    if (ids.length > 1) { refAsk = { candidates: ids, pending: m }; return null; }
    reopenIfConfirmed();
    return form.lines.find((l) => l.line_id === ids[0])!;
  };
  const nested = (batch: Move[], open: OrderForm["open"]) => { // apply a derived batch against the current form and fold its results into this one
    const sub = apply({ ...form, open }, batch, lineSpanMatcher);
    Object.assign(form, sub.form); sub.touched.forEach((x) => touched.add(x)); removed.push(...sub.removed); ledger.push(...sub.ledger);
  };
  for (const m of moves) {
    switch (m.kind) {
      case "answer": {
        if (m.field === "fulfillment") {
          if (form.fulfillment !== m.value) reopenIfConfirmed(); // pickup <-> delivery changes the fee
          form.fulfillment = m.value; if (m.value === "pickup") form.address = null;
          ledger.push({ turn: t, event: "answer", data: { field: "fulfillment", value: m.value } });
        } else if (m.field === "address") {
          const zipOf = (x?: string | null) => words(x ?? "").find((w) => w.length === 5 && isDigits(w));
          let value = m.value; const had = form.address?.formatted, said = zipOf(value.text), hadZip = zipOf(had);
          if (said && hadZip && said !== hadZip && value.validated && value.formatted === had) { value = { ...value, formatted: had!.replace(hadZip, said) }; ledger.push({ turn: t, event: "address_zip_corrected_by_customer", data: { from: hadZip, to: said } }); } // "its 18103 not 18104": their ZIP, our street
          const ok = value.validated && value.zone_ok;
          if (!value.validated) declines.push({ code: "address_not_found", span: value.text }); else if (!value.zone_ok) declines.push({ code: "address_out_of_zone", span: value.text });
          if (ok && value.delivery_quote_cents !== form.address?.delivery_quote_cents) reopenIfConfirmed(); form.address = { ...value }; if (ok && form.fulfillment === null) form.fulfillment = "delivery"; // a courier fee moving with the address changes the total
          ledger.push({ turn: t, event: "answer", data: { field: "address", value: value, accepted: ok } });
        } else if (m.field === "tip") {
          const v = m.value, bad = (v.kind === "percent" && (v.value < 0 || v.value > 100)) || (v.kind === "cents" && (v.value < 0 || v.value > 50000));
          if (bad) declines.push({ code: "tip_out_of_range" }); else { if (JSON.stringify(form.tip) !== JSON.stringify(v)) reopenIfConfirmed(); form.tip = v; } // a new tip after the link is a new total: the link must be remade
          ledger.push({ turn: t, event: "answer", data: { field: "tip", value: v, accepted: !bad } });
        } else if (m.field === "items_done") { form.items_done = true; ledger.push({ turn: t, event: "answer", data: { field: "items_done" } }); }
        else if (m.field === "confirmed") { form.confirmed = m.value; form.status = m.value ? "awaiting_payment" : "open"; ledger.push({ turn: t, event: "answer", data: { field: "confirmed", value: m.value } }); }
        break;
      }
      case "add_line": {
        const wasPlainOpen = form.status === "open" && !form.relink; // an order reopened by a change after the link is still "done"
        reopenIfConfirmed();
        const line = newLine(form, m.item_span, Math.floor(m.qty || 1), [...(m.option_spans ?? [])], { notes: m.note ? [m.note] : [] });
        form.lines.push(line);
        touched.add(line.line_id);
        if (wasPlainOpen && form.items_done) form.items_done = false;
        ledger.push({ turn: t, event: "add_line", data: { line_id: line.line_id, span: m.item_span, qty: line.qty, options: line.held } });
        break;
      }
      case "change_line": {
        const line = targetLine(m); if (!line) break;
        if (m.qty !== undefined && m.qty !== null) line.qty = Math.max(1, Math.floor(m.qty));
        if (m.add_option_spans?.length) { line.held.push(...m.add_option_spans); if (line.status.kind === "complete") line.status = { kind: "needs_slot", group_id: "" }; }
        if (m.remove_option_spans?.length) { line.held.push(...m.remove_option_spans.map((s) => `-${s}`)); if (line.status.kind === "complete") line.status = { kind: "needs_slot", group_id: "" }; }
        touched.add(line.line_id);
        ledger.push({ turn: t, event: "change_line", data: { line_id: line.line_id, qty: m.qty, add: m.add_option_spans, remove: m.remove_option_spans } });
        break;
      }
      case "remove_line": {
        if (form.lines.length === 0) { declines.push({ code: "nothing_to_remove" }); break; }
        const target = targetLine(m); if (!target) break;
        const [gone] = form.lines.splice(form.lines.indexOf(target), 1); removed.push({ line_id: gone.line_id, item_id: gone.item_id, span: gone.span }); ledger.push({ turn: t, event: "remove_line", data: { line_id: gone.line_id } });
        break;
      }
      case "answer_option": {
        const open = form.open;
        // the line we asked about, or the pending line the engine routed this answer to (m.line_id)
        const lid = m.line_id ?? (open && (open.kind === "line_slot" || open.kind === "line_ambiguous" || open.kind === "line_unresolved" || open.kind === "line_picks") ? open.line_id : undefined);
        const line = lid !== undefined ? form.lines.find((l) => l.line_id === lid) : undefined;
        if (line) {
          if (line.status.kind === "ambiguous" || line.status.kind === "unresolved") (line.answers ??= []).push(m.value_span); else line.held.push((line.status.kind === "needs_slot" ? "?" : "") + m.value_span); // "?": an answer to the slot we asked, never a kitchen note if unreadable
          touched.add(line.line_id);
          ledger.push({ turn: t, event: "answer_option", data: { line_id: line.line_id, span: m.value_span, routed: m.line_id !== undefined } });
        } else if (open && open.kind === "line_ref") { // a numbered pick for "which one do you mean?"
          const pick = open.candidates[parseInt(m.value_span, 10) - 1];
          if (pick !== undefined && (open.pending.kind === "change_line" || open.pending.kind === "remove_line")) nested([{ ...open.pending, ref: { line_id: pick } } as Move], null);
          else if (pick === undefined) ledger.push({ turn: t, event: "answer_option_unmatched", data: { span: m.value_span } });
        } else {
          // no line question open: treat as an add attempt of that span
          nested([{ kind: "add_line", item_span: m.value_span, qty: 1, option_spans: [] }], form.open);
        }
        break;
      }
      case "answer_yes":
      case "answer_no": {
        const open = form.open;
        const yes = m.kind === "answer_yes";
        if (open?.kind === "omission") {
          const asked = form.omissions.filter((o) => open.spans.includes(o.span));
          if (yes) { // skip anything this same message already added ("yes the tuna salad sandwich" + add_line tuna salad sandwich)
            const addedHere = (span: string) => moves.some((x) => x.kind === "add_line" && (isWordSubset(words(span), words(x.item_span)) || isWordSubset(words(x.item_span), words(span))));
            const fresh = asked.filter((o) => !addedHere(o.span));
            nested(fresh.map((o) => ({ kind: "add_line", item_span: o.span, qty: o.qty, option_spans: [] })), null);
          }
          for (const o of form.omissions) if (open.spans.includes(o.span)) o.declined = true; // asked once, never again
          ledger.push({ turn: t, event: yes ? "omission_accepted" : "omission_declined", data: { spans: open.spans } });
        } else if (open?.kind === "confirm") {
          if (yes) { form.confirmed = true; form.status = "awaiting_payment"; }
          else { form.confirmed = false; form.status = "open"; }
          ledger.push({ turn: t, event: "answer", data: { field: "confirmed", value: yes } });
        } else if (open?.kind === "items" && !yes) { form.items_done = true; ledger.push({ turn: t, event: "answer", data: { field: "items_done" } }); }
        else if (open?.kind === "tip" && !yes) { form.tip = { kind: "cents", value: 0 }; ledger.push({ turn: t, event: "answer", data: { field: "tip", value: form.tip } }); }
        else if (open?.kind !== "items") {
          ledger.push({ turn: t, event: "yes_no_without_question", data: { yes } });
        }
        break;
      }
      case "split_line": {
        const idx = form.lines.findIndex((l) => l.line_id === m.line_id);
        if (idx < 0 || m.parts.length === 0) break;
        const src = form.lines[idx];
        const cands = src.status.kind === "ambiguous" ? src.status.candidates : null;
        const newLines = m.parts.map((p) => newLine(form, src.span, p.qty, [...src.held.filter((h) => !h.startsWith("-")), ...(p.held ?? [])], // a resolved line splits by option and keeps its item
          src.item_id ? { item_id: src.item_id, choices: { ...src.choices }, status: { kind: "needs_slot", group_id: "" } } : { answers: [p.span], status: cands ? { kind: "ambiguous", candidates: cands, facet: null } : { kind: "unresolved" } }));
        form.lines.splice(idx, 1, ...newLines);
        for (const l of newLines) touched.add(l.line_id);
        ledger.push({ turn: t, event: "split_line", data: { from: src.line_id, parts: m.parts, into: newLines.map((l) => l.line_id) } });
        break;
      }
      case "talk": { talk = validTalk(m.text); ledger.push({ turn: t, event: talk ? "talk" : "talk_rejected", data: { text: m.text } }); break; } // defense in depth: the same gate the interpreter applies
      case "ask_menu": { askMenu = m.about_span; ledger.push({ turn: t, event: "ask_menu", data: { about: m.about_span } }); break; }
      case "control": {
        control = m;
        if (m.what === "cancel" || m.what === "start_over") { const keep = newForm(form.shop_id, form.menu_version); keep.turn_no = form.turn_no; if (m.what === "cancel") keep.status = "abandoned"; Object.assign(form, keep); }
        if (m.what === "show_cart") showCart = true;
        ledger.push({ turn: t, event: "control", data: { what: m.what } });
        break;
      }
    }
  }

  return { form, ledger, touched: [...touched], removed, refAsk, declines, showCart, askMenu, control, talk };
}

/**
 * Shape-level normalization of one model batch, before any resolution:
 * - an answer_option with no item question open, following an add in the same
 *   batch, is that add's option ("bagel" + "wheat");
 * - a change_line on the last line carrying only option spans, in a batch that
 *   also adds a line, is an option on that add ("tuna hoagie ... add shrimp to that").
 * Typed data in, typed data out; no text inspection.
 */
export function normalizeMoveBatch(moves: Move[], lineQuestionOpen: boolean): Move[] {
  const out: Move[] = [];
  let lastAdd: (Move & { kind: "add_line" }) | null = null;
  // an "item" that another add in the same batch already lists as an option is that option, not a line
  const optionWords = new Set<string>();
  for (const m of moves) if (m.kind === "add_line") for (const o of m.option_spans) optionWords.add(optionKey(o));
  for (const m of moves) {
    if (m.kind === "add_line" && moves.filter((x) => x.kind === "add_line").length > 1 && optionWords.has(optionKey(m.item_span))) continue;
    if (m.kind === "add_line") { const copy = { ...m, option_spans: [...m.option_spans] }; out.push(copy); lastAdd = copy; continue; }
    if (m.kind === "answer_option" && lastAdd && !lineQuestionOpen) { lastAdd.option_spans.push(m.value_span); continue; }
    if (m.kind === "change_line" && lastAdd && "last" in m.ref && (m.qty === undefined || m.qty === null) && (m.add_option_spans?.length || m.remove_option_spans?.length)) {
      lastAdd.option_spans.push(...(m.add_option_spans ?? []), ...(m.remove_option_spans ?? []).map((s) => `-${s}`));
      continue;
    }
    out.push(m);
  }
  return out;
}
