// crossread.ts — the second reader. A deterministic lexicon scan of the customer
// message, reconciled against the model's moves. Disagreement becomes a question,
// never a silent add or a silent drop.
import { contentWords, findWordRun, leadingCount, sameWord, words } from "./normalize.ts";
import type { Menu } from "./menu.ts";
import type { Move } from "./form.ts";

export interface Hit { start: number; end: number; termWords: string[]; item_ids: string[] }
const NEGATION = new Set(["no", "not", "without", "hold", "skip", "minus", "nah", "nope", "except", "but", "besides"]);

/** Greedy longest-match, non-overlapping, item terms only. */
export function scan(message: string, menu: Menu): { words: string[]; hits: Hit[] } {
  const w = words(message);
  const hits: Hit[] = [];
  let i = 0;
  while (i < w.length) {
    let best: Hit | null = null;
    for (const t of menu.itemTerms) {
      if (best && t.words.length < best.termWords.length) break; // sorted longest first
      if (t.words.length > w.length - i) continue;
      if (contentWords(t.words.join(" ")).length === 0) continue; // "order", "side": not an item mention
      let ok = true;
      for (let j = 0; j < t.words.length; j++) if (w[i + j] !== t.words[j]) { ok = false; break; }
      if (!ok) continue;
      if (!best) best = { start: i, end: i + t.words.length, termWords: t.words, item_ids: [t.target_id] };
      else if (!best.item_ids.includes(t.target_id)) best.item_ids.push(t.target_id);
    }
    if (best) { hits.push(best); i = best.end; } else i++;
  }
  return { words: w, hits };
}

function spansOf(m: Move): string[] {
  switch (m.kind) {
    case "add_line": return [m.item_span, ...(m.option_spans ?? []), ...(m.note ? [m.note] : [])];
    case "change_line": return [...("span" in m.ref ? [m.ref.span] : []), ...(m.add_option_spans ?? []), ...(m.remove_option_spans ?? [])];
    case "remove_line": return "span" in m.ref ? [m.ref.span] : [];
    case "answer_option": return [m.value_span];
    case "ask_menu": return m.about_span ? [m.about_span] : [];
    case "split_line": return m.parts.map((p) => p.span);
    case "answer": return m.field === "address" ? [m.value.text] : [];
    default: return [];
  }
}

export interface Reconciled {
  /** moves whose spans were verbatim in the message */
  accepted: Move[];
  /** moves whose item_span is not in the message (invented) */
  rejected: Array<{ move: Move; span: string }>;
  /** lexicon hits no accepted move covers: candidates for "did you also want…?" */
  omissions: Array<{ span: string; item_ids: string[]; qty: number }>;
}

export function reconcile(message: string, moves: Move[], menu: Menu, alreadyAskedSpans: Set<string>): Reconciled {
  const { words: mw, hits } = scan(message, menu);
  const covered = new Array<boolean>(mw.length).fill(false);
  const accepted: Move[] = [];
  const rejected: Reconciled["rejected"] = [];

  const present = (s: string): boolean => {
    const sw = words(s);
    if (sw.length === 0) return true;
    const at = findWordRun(mw, sw, 0, sameWord);
    if (at >= 0) { for (let k = at; k < at + sw.length; k++) covered[k] = true; return true; }
    // tolerate light reordering: every word must still be in the message (plural drift allowed)
    const all = sw.every((x) => mw.some((m) => sameWord(m, x)));
    if (all) for (const x of sw) { const k = mw.findIndex((m) => sameWord(m, x)); if (k >= 0) covered[k] = true; }
    return all;
  };
  for (const m0 of moves) {
    let m: Move = m0;
    if (m.kind === "add_line") {
      if (!present(m.item_span)) { rejected.push({ move: m, span: m.item_span }); continue; }
      const kept = m.option_spans.filter(present);
      if (kept.length !== m.option_spans.length) m = { ...m, option_spans: kept };
    } else if (m.kind === "change_line") {
      const add = (m.add_option_spans ?? []).filter(present);
      const rem = (m.remove_option_spans ?? []).filter(present);
      if ("span" in m.ref) present(m.ref.span);
      m = { ...m, add_option_spans: add, remove_option_spans: rem };
    } else {
      for (const s of spansOf(m)) present(s);
    }
    accepted.push(m);
  }

  const omissions: Reconciled["omissions"] = [];
  for (const h of hits) {
    let anyCovered = false;
    for (let k = h.start; k < h.end; k++) if (covered[k]) { anyCovered = true; break; }
    if (anyCovered) continue;
    const span = mw.slice(h.start, h.end).join(" ");
    if (alreadyAskedSpans.has(span)) continue;
    if ((h.start > 0 && NEGATION.has(mw[h.start - 1])) || (h.start > 1 && NEGATION.has(mw[h.start - 2]))) continue; // "no wraps", "except the sweet potato": declined, not forgotten
    // a count word right before the mention ("2 large pepperoni pizzas") travels with it
    let qty = 1;
    for (let k = h.start - 1; k >= Math.max(0, h.start - 2); k--) {
      const lc = leadingCount(`${mw[k]} x`);
      if (lc.count && lc.count > 0) { qty = lc.count; break; }
    }
    omissions.push({ span, item_ids: h.item_ids, qty });
  }
  return { accepted, rejected, omissions };
}
