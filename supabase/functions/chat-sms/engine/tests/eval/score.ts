// score.ts — pure scoring of interpreter output against the answer key.
import { normalizeMoveBatch, type Move } from "../../form.ts";
import { words } from "../../normalize.ts";

export interface EvalCase {
  id: string;
  context: { open: unknown; lines: Array<{ line_id: number; name: string; qty: number }>; last_bot: string | null };
  message: string;
  expected: Move[];
  tags: string[];
  source: string;
}

export interface CaseScore {
  id: string;
  ok: boolean;                 // every metric perfect
  item_expected: number; item_found: number; item_invented: number;
  qty_wrong: number; options_expected: number; options_found: number;
  fields_expected: number; fields_right: number;
  kinds_expected: number; kinds_right: number;
  error?: string;
}

const wset = (s: string) => new Set(words(s));
function spanMatch(a: string, b: string): boolean {
  const A = wset(a), B = wset(b);
  if (A.size === 0 || B.size === 0) return false;
  const inter = [...A].filter((w) => B.has(w) || B.has(w + "s") || B.has(w.replace(/s$/, ""))).length;
  return inter === Math.min(A.size, B.size);
}

function fieldKey(m: Move): string | null {
  if (m.kind === "answer") {
    if (m.field === "fulfillment") return `fulfillment=${m.value}`;
    if (m.field === "address") return `address=${words(m.value.text).join(" ")}`;
    if (m.field === "tip") return `tip=${m.value.kind}:${m.value.value}`;
    if (m.field === "items_done") return "items_done";
    if (m.field === "confirmed") return `confirmed=${m.value}`;
  }
  if (m.kind === "answer_yes") return "yes";
  if (m.kind === "answer_no") return "no";
  if (m.kind === "answer_option") return `option=${words(m.value_span).join(" ")}`;
  if (m.kind === "control") return `control=${m.what}`;
  if (m.kind === "ask_menu") return `ask_menu`;
  if (m.kind === "remove_line") return `remove=${"span" in m.ref ? words(m.ref.span).join(" ") : "last"}`;
  if (m.kind === "change_line") return `change`;
  return null;
}

export function scoreCase(c: EvalCase, actualRaw: Move[] | null, error?: string): CaseScore {
  const lineQuestionOpen = !!(c.context.open && typeof c.context.open === "object" && "line_id" in (c.context.open as object));
  const actual = actualRaw ? normalizeMoveBatch(actualRaw, lineQuestionOpen) : null;
  const expAdds = c.expected.filter((m): m is Move & { kind: "add_line" } => m.kind === "add_line");
  const actAdds = (actual ?? []).filter((m): m is Move & { kind: "add_line" } => m.kind === "add_line");
  const used = new Set<number>();
  let found = 0, qtyWrong = 0, optExp = 0, optFound = 0;
  for (const e of expAdds) {
    optExp += e.option_spans.length;
    const k = actAdds.findIndex((a, i) => !used.has(i) && spanMatch(a.item_span, e.item_span));
    if (k < 0) continue;
    used.add(k); found++;
    const a = actAdds[k];
    if ((a.qty || 1) !== (e.qty || 1)) qtyWrong++;
    for (const o of e.option_spans) if (a.option_spans.some((x) => spanMatch(x, o))) optFound++;
  }
  const invented = actAdds.length - used.size;
  const expFields = c.expected.map(fieldKey).filter((x): x is string => !!x);
  const actFields = new Set((actual ?? []).map(fieldKey).filter((x): x is string => !!x));
  const fieldsRight = expFields.filter((f) => actFields.has(f) || [...actFields].some((a) => a.startsWith(f.split("=")[0] + "=") && spanMatch(a.split("=")[1] ?? "", f.split("=")[1] ?? "") && f.startsWith("option="))).length;
  const expKinds = c.expected.map((m) => m.kind);
  const actKinds = (actual ?? []).map((m) => m.kind);
  const kindsRight = expKinds.filter((k) => { const i = actKinds.indexOf(k); if (i >= 0) { actKinds.splice(i, 1); return true; } return false; }).length;
  const ok = !error && found === expAdds.length && invented === 0 && qtyWrong === 0 && optFound === optExp && fieldsRight === expFields.length && kindsRight === expKinds.length;
  return { id: c.id, ok, item_expected: expAdds.length, item_found: found, item_invented: invented, qty_wrong: qtyWrong, options_expected: optExp, options_found: optFound, fields_expected: expFields.length, fields_right: fieldsRight, kinds_expected: expKinds.length, kinds_right: kindsRight, error };
}

export interface Summary {
  cases: number; perfect: number; errors: number;
  item_recall: number; invented_rate: number; qty_accuracy: number; option_recall: number; field_accuracy: number;
  p50_ms: number; p95_ms: number;
}

export function summarize(scores: CaseScore[], ms: number[]): Summary {
  const sum = (f: (s: CaseScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const itemsExp = sum((s) => s.item_expected), itemsFound = sum((s) => s.item_found), invented = sum((s) => s.item_invented);
  const optExp = sum((s) => s.options_expected), optFound = sum((s) => s.options_found);
  const fExp = sum((s) => s.fields_expected), fRight = sum((s) => s.fields_right);
  const sorted = [...ms].sort((a, b) => a - b);
  const pct = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  return {
    cases: scores.length,
    perfect: scores.filter((s) => s.ok).length,
    errors: scores.filter((s) => s.error).length,
    item_recall: itemsExp ? itemsFound / itemsExp : 1,
    invented_rate: itemsExp ? invented / itemsExp : 0,
    qty_accuracy: itemsFound ? 1 - sum((s) => s.qty_wrong) / itemsFound : 1,
    option_recall: optExp ? optFound / optExp : 1,
    field_accuracy: fExp ? fRight / fExp : 1,
    p50_ms: pct(0.5), p95_ms: pct(0.95),
  };
}
