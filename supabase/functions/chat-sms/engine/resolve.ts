// resolve.ts — words to menu rows. Longest match over the compiled lexicon,
// 0 / 1 / many, and "many" narrows by facet against the stored candidate set.
// Never a tiebreak, never cheapest, never a default the customer did not say.
import { contentWords, findWordRun, isDigits, isWordSubset, sameWords, words } from "./normalize.ts";
import type { Menu, MenuGroup, MenuItem } from "./menu.ts";
import { itemsInCategory } from "./menu.ts";
import type { Line } from "./form.ts";


export type SpanResolution =
  | { kind: "item"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

export function resolveSpan(span: string, menu: Menu): SpanResolution {
  const sw = words(span);
  if (sw.length === 0) return { kind: "none" };
  let bestLen = 0;
  const ids = new Set<string>();
  for (const t of menu.itemTerms) {
    if (bestLen && t.words.length < bestLen) break;
    if (findWordRun(sw, t.words) < 0) continue;
    if (t.words.length > bestLen) { bestLen = t.words.length; ids.clear(); }
    ids.add(t.target_id);
  }
  if (ids.size === 1) return { kind: "item", id: [...ids][0] };
  if (ids.size > 1) return { kind: "ambiguous", ids: [...ids].sort() };
  for (const t of menu.categoryTerms) {
    if (findWordRun(sw, t.words) < 0) continue;
    const members = itemsInCategory(menu, t.target_id).map((i) => i.id).sort();
    if (members.length === 1) return { kind: "item", id: members[0] };
    if (members.length > 1) return { kind: "ambiguous", ids: members };
  }
  // Partial: every content word of the span appears inside some item term
  // ("cheese" -> every item with a "cheese …" term). Deterministic, and it
  // yields a question, never a pick.
  const content = contentWords(span);
  if (content.length > 0) {
    const partial = new Set<string>();
    for (const t of menu.itemTerms) if (isWordSubset(content, t.words)) partial.add(t.target_id);
    if (partial.size === 1) return { kind: "item", id: [...partial][0] };
    if (partial.size > 1) return { kind: "ambiguous", ids: [...partial].sort() };
  }
  return { kind: "none" };
}

/** Filter candidates by a customer span: word subset of the display name, or its size facet. */
export function narrow(candidateIds: string[], span: string, menu: Menu): string[] {
  const sw = words(span);
  if (sw.length === 0) return candidateIds;
  const keep = candidateIds.filter((id) => {
    const it = menu.items.get(id);
    if (!it) return false;
    if (isWordSubset(sw, it.words)) return true;
    if (sw.length === 1 && it.facets.size === sw[0]) return true;
    if (it.facets.kind && isWordSubset(sw, words(it.facets.kind))) return true;
    return false;
  });
  return keep;
}

export function pickFacet(candidateIds: string[], menu: Menu): "kind" | "size" | "list" {
  const kinds = new Set<string>(); const sizes = new Set<string>();
  for (const id of candidateIds) {
    const it = menu.items.get(id); if (!it) continue;
    if (it.facets.kind) kinds.add(it.facets.kind);
    if (it.facets.size) sizes.add(it.facets.size);
  }
  if (kinds.size > 1) return "kind";
  if (sizes.size > 1) return "size";
  return "list";
}

export type ChoiceMatch = { kind: "one"; choice_id: string } | { kind: "many"; choice_ids: string[] } | { kind: "none" };

export function matchChoice(span: string, group: MenuGroup, within?: string[]): ChoiceMatch {
  const sw = words(span);
  if (sw.length === 0) return { kind: "none" };
  const pool = within ? group.choices.filter((c) => within.includes(c.id)) : group.choices;
  const exact = pool.filter((c) => sameWords(c.words, sw));
  if (exact.length === 1) return { kind: "one", choice_id: exact[0].id };
  const subset = pool.filter((c) => isWordSubset(sw, c.words));
  if (subset.length === 1) return { kind: "one", choice_id: subset[0].id };
  if (subset.length > 1) return { kind: "many", choice_ids: subset.map((c) => c.id) };
  // the span may contain the choice ("with extra cheese please")
  const contained = pool.filter((c) => findWordRun(sw, c.words) >= 0);
  if (contained.length === 1) return { kind: "one", choice_id: contained[0].id };
  if (contained.length > 1) return { kind: "many", choice_ids: contained.map((c) => c.id) };
  return { kind: "none" };
}

function requiredGroupOpen(line: Line, item: MenuItem): MenuGroup | null {
  for (const g of item.groups) if (g.kind === "slot" && !line.choices[g.id]) return g;
  return null;
}

function applyCanon(line: Line, menu: Menu): void {
  let changed = true;
  while (changed && line.item_id) {
    changed = false;
    for (const mod of [...line.modifiers]) {
      const derived = menu.canon.get(`${line.item_id}|${mod}`);
      if (derived && menu.items.has(derived)) {
        line.item_id = derived;
        line.modifiers = line.modifiers.filter((m) => m !== mod);
        line.choices = {};
        changed = true;
        break;
      }
    }
  }
}

/** Apply one held span to a bound line. Returns true when it was consumed as a priced choice. */
function applyHeldSpan(line: Line, item: MenuItem, span: string): boolean {
  const removing = span.startsWith("-");
  const text = removing ? span.slice(1) : span;
  if (removing) {
    for (const g of item.groups) {
      const m = matchChoice(text, g);
      if (m.kind === "one" && line.modifiers.includes(m.choice_id)) { line.modifiers = line.modifiers.filter((x) => x !== m.choice_id); return true; }
    }
    line.notes.push(`no ${text}`);
    return false;
  }
  // 1. a slot we are currently asking about, restricted to its candidates
  for (const g of item.groups) {
    if (g.kind !== "slot") continue;
    const within = line.slot_candidates[g.id];
    const m = matchChoice(text, g, within);
    if (m.kind === "one") { line.choices[g.id] = m.choice_id; delete line.slot_candidates[g.id]; return true; }
    if (m.kind === "many") { line.slot_candidates[g.id] = m.choice_ids; return true; }
  }
  // 2. a modifier
  for (const g of item.groups) {
    if (g.kind !== "modifier") continue;
    const m = matchChoice(text, g);
    if (m.kind === "one") { if (!line.modifiers.includes(m.choice_id)) line.modifiers.push(m.choice_id); return true; }
    if (m.kind === "many") { line.slot_candidates[g.id] = m.choice_ids; return true; }
  }
  // 3. a size word that is already the item's own size (derived rows carry size in the name)
  const sw = words(text);
  if (sw.length === 1 && item.facets.size === sw[0]) return true;
  if (isWordSubset(sw, item.words)) return true; // restating the item name
  line.notes.push(text);
  return false;
}

/**
 * Bind a line as far as the data allows. Idempotent. Mutates the line.
 * Returns the item it ended on, if any.
 */
export function bindLine(line: Line, menu: Menu): void {
  // An unresolved line whose customer gave a replacement span: swap the span.
  if (line.item_id === null && line.status.kind === "unresolved" && line.held.length > 0 && !line.held[0].startsWith("-")) {
    const first = line.held[0];
    if (resolveSpan(line.span, menu).kind === "none" && resolveSpan(first, menu).kind !== "none") { line.span = line.held.shift()!; }
  }
  if (line.item_id === null) {
    let cands: string[];
    if (line.status.kind === "ambiguous") cands = line.status.candidates;
    else {
      const r = resolveSpan(line.span, menu);
      if (r.kind === "none") { line.status = { kind: "unresolved" }; return; }
      cands = r.kind === "item" ? [r.id] : r.ids;
    }
    // narrow with every held span that narrows; keep the rest for options
    const rest: string[] = [];
    for (const h of line.held) {
      if (h.startsWith("-")) { rest.push(h); continue; }
      const n = isDigits(h) && line.status.kind === "ambiguous" && line.status.facet === "list"
        ? (cands[parseInt(h, 10) - 1] ? [cands[parseInt(h, 10) - 1]] : [])
        : narrow(cands, h, menu);
      if (n.length >= 1 && n.length < cands.length) cands = n;
      else if (n.length === cands.length && cands.length === 1) { /* restates the item */ }
      else rest.push(h);
    }
    line.held = rest;
    if (cands.length === 0) { line.status = { kind: "unresolved" }; return; }
    if (cands.length > 1) { line.status = { kind: "ambiguous", candidates: cands, facet: pickFacet(cands, menu) }; return; }
    line.item_id = cands[0];
  }
  let item = menu.items.get(line.item_id)!;
  const held = line.held; line.held = [];
  for (const h of held) applyHeldSpan(line, item, h);
  applyCanon(line, menu);
  item = menu.items.get(line.item_id!)!;
  const open = requiredGroupOpen(line, item);
  if (open) { line.status = { kind: "needs_slot", group_id: open.id }; return; }
  const pendingModifierGroup = Object.keys(line.slot_candidates).find((gid) => item.groups.some((g) => g.id === gid));
  if (pendingModifierGroup) { line.status = { kind: "needs_slot", group_id: pendingModifierGroup }; return; }
  line.status = { kind: "complete" };
}

/** Does a customer span refer to this line? Used for "remove the knots", "make the pizza 2". */
export function lineMatchesSpan(line: Line, span: string, menu: Menu): boolean {
  const sw = words(span);
  if (sw.length === 0) return false;
  const item = line.item_id ? menu.items.get(line.item_id) : null;
  if (item && isWordSubset(sw, item.words)) return true;
  if (item && item.facets.kind && isWordSubset(sw, words(item.facets.kind))) return true;
  const lw = words(line.span);
  if (isWordSubset(sw, lw) || isWordSubset(lw, sw)) return true;
  if (item) {
    const r = resolveSpan(span, menu);
    if (r.kind === "item" && r.id === item.id) return true;
    if (r.kind === "ambiguous" && r.ids.includes(item.id)) return true;
  }
  return false;
}

/** Is the span a plausible answer to the line's open question (a choice or a facet), not a new item? */
export function spanAnswersLine(line: Line, span: string, menu: Menu): boolean {
  if (line.status.kind === "ambiguous") return narrow(line.status.candidates, span, menu).length < line.status.candidates.length && narrow(line.status.candidates, span, menu).length > 0;
  if (line.status.kind === "needs_slot" && line.item_id) {
    const item = menu.items.get(line.item_id)!;
    const gid = line.status.group_id;
    const g = item.groups.find((x) => x.id === gid);
    if (!g) return false;
    return matchChoice(span, g, line.slot_candidates[g.id]).kind !== "none";
  }
  return false;
}
