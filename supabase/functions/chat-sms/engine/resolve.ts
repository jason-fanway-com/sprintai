// resolve.ts — words to menu rows. Longest match over the compiled lexicon,
// 0 / 1 / many, and "many" narrows by facet against the stored candidate set.
// Never a tiebreak, never cheapest, never a default the customer did not say.
import { contentWords, findWordRun, impliedCount, isDigits, isWordSubset, leadingCount, optionWords, sameWords, singular, splitList, STOPWORDS, words } from "./normalize.ts";
import type { Menu, MenuGroup, MenuItem } from "./menu.ts";
import { itemsInCategory } from "./menu.ts";
import type { Line } from "./form.ts";


const STOP_FOR_LEFTOVER = new Set(["a", "an", "the", "of", "with", "and", "please", "some", "order", "side", "one", "two", "three", "for", "me", "get", "want", "like", "id", "i", "can", "have", "to", "my", "on", "it", "that", "just", "thanks", "thank", "you", "pls", "plz", "pizza", "pizzas"]);

export type SpanResolution =
  | { kind: "item"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

export function resolveSpan(span: string, menu: Menu): SpanResolution {
  const sw = words(span);
  if (sw.length === 0) return { kind: "none" };
  const swSing = sw.map(singular);
  let bestLen = 0;
  const ids = new Set<string>();
  for (const t of menu.itemTerms) {
    if (bestLen && t.words.length < bestLen) break;
    if (findWordRun(sw, t.words) < 0 && findWordRun(swSing, t.wordsSing) < 0) continue;
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
    // exact word subsets first; else stems ("chicken parm sandwich" against "chicken parmesan sandwich")
    const exact = new Set<string>(), stems = new Set<string>(), contentSing = content.map(singular);
    for (const t of menu.itemTerms) {
      if (isWordSubset(content, t.words)) exact.add(t.target_id);
      else if (contentSing.every((w) => wordMatches(w, new Set(t.wordsSing)))) stems.add(t.target_id);
    }
    const partial = exact.size > 0 ? exact : stems;
    if (partial.size === 1) return { kind: "item", id: [...partial][0] };
    if (partial.size > 1) return { kind: "ambiguous", ids: [...partial].sort() };
  }
  return { kind: "none" };
}

/** A customer word names a menu word when equal, or when it is a stem of at least four letters ("parm"). */
function wordMatches(w: string, pool: Set<string>): boolean { return pool.has(w) || (w.length >= 4 && [...pool].some((p) => p.startsWith(w))); }

/** Filter candidates by a customer span: word subset of the display name, or its size facet. */
export function narrow(candidateIds: string[], span: string, menu: Menu): string[] {
  const sw = words(span).map(singular);
  if (sw.length === 0) return candidateIds;
  const pool = (id: string): Set<string> => {
    const it = menu.items.get(id)!;
    const set = new Set<string>([...it.words, ...words(it.name), ...words(it.facets.kind ?? ""), ...(menu.termWordsByItem.get(id) ?? []), ...words(it.category ?? "")].map(singular));
    if (it.facets.size) set.add(it.facets.size);
    return set;
  };
  const keep = candidateIds.filter((id) => menu.items.has(id) && sw.every((w) => pool(id).has(w)));
  if (keep.length > 0) return keep;
  // stems the customer typed ("parm" for parmesan, "hawaii" for hawaiian): each word must equal
  // or begin a candidate's word. Several candidates may survive; that is a narrowing, not a pick.
  const stems = candidateIds.filter((id) => menu.items.has(id) && sw.every((w) => wordMatches(w, pool(id))));
  return stems;
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
  const ow = optionWords(span);
  const sw = (ow.length ? ow : words(span)).map(singular);
  if (sw.length === 0) return { kind: "none" };
  const pool0 = within ? group.choices.filter((c) => within.includes(c.id)) : group.choices;
  const pool = pool0.map((c) => ({ ...c, words: c.words.map(singular) }));
  const exact = pool.filter((c) => sameWords(c.words, sw));
  if (exact.length === 1) return { kind: "one", choice_id: exact[0].id };
  // "steak" among Steak (Half), Steak (Whole), Chicken Steak (Half/Whole): the choices whose
  // name, minus placement words, IS the span come first; then whole beats half
  const core = (c: { words: string[] }) => c.words.filter((w) => !PLACEMENT.has(w));
  const coreExact = pool.filter((c) => sameWords(core(c), sw.filter((w) => !PLACEMENT.has(w))));
  if (coreExact.length === 1) return { kind: "one", choice_id: coreExact[0].id };
  if (coreExact.length > 1) {
    if (sw.includes("half")) { const h = coreExact.filter((c) => c.words.includes("half")); if (h.length === 1) return { kind: "one", choice_id: h[0].id }; }
    const w = coreExact.filter((c) => c.words.includes("whole")); if (w.length === 1 && !sw.includes("half")) return { kind: "one", choice_id: w[0].id };
    return { kind: "many", choice_ids: coreExact.map((c) => c.id) };
  }
  const subset = pool.filter((c) => isWordSubset(sw, c.words));
  if (subset.length === 1) return { kind: "one", choice_id: subset[0].id };
  if (subset.length > 1) {
    // "Bacon (Half pizza)" vs "Bacon (Whole pizza)": a topping named without "half" goes on the whole pizza
    const whole = subset.filter((c) => c.words.includes("whole"));
    const others = subset.filter((c) => !c.words.includes("whole") && !c.words.includes("half"));
    if (whole.length === 1 && others.length === 0 && !sw.includes("half")) return { kind: "one", choice_id: whole[0].id };
    return { kind: "many", choice_ids: subset.map((c) => c.id) };
  }
  // the span may contain the choice ("with extra cheese please")
  const contained = pool.filter((c) => findWordRun(sw, c.words) >= 0);
  if (contained.length === 1) return { kind: "one", choice_id: contained[0].id };
  if (contained.length > 1) return { kind: "many", choice_ids: contained.map((c) => c.id) };
  return { kind: "none" };
}

function requiredGroupOpen(line: Line, item: MenuItem): MenuGroup | null {
  for (const g of item.groups) {
    if (g.kind !== "slot" || line.choices[g.id]) continue;
    // the compiler decided these are not questions: one possible choice, or a shop default
    if (g.choices.length === 1) { line.choices[g.id] = g.choices[0].id; continue; }
    if (g.ask_mode === "apply_default" && g.default_choice_id && g.choices.some((c) => c.id === g.default_choice_id)) { line.choices[g.id] = g.default_choice_id; continue; }
    return g;
  }
  return null;
}

/** Cheese base + Pepperoni -> the Pepperoni Pizza row, only when that row can still carry every other pick; else the base keeps them all, priced. */
function applyCanon(line: Line, menu: Menu): void {
  const holds = (id: string, picked: string[]) => picked.every((c) => menu.items.get(id)!.groups.some((g) => g.choices.some((x) => x.id === c)));
  while (line.item_id) {
    const mod = line.modifiers.find((m) => {
      const d = menu.canon.get(`${line.item_id}|${m}`);
      return !!d && menu.items.has(d) && holds(d, [...line.modifiers.filter((x) => x !== m), ...Object.values(line.choices)]);
    });
    if (!mod) return;
    line.item_id = menu.canon.get(`${line.item_id}|${mod}`)!;
    line.modifiers = line.modifiers.filter((m) => m !== mod);
  }
}

const PLACEMENT = new Set(["half", "whole", "pizza", "side", "left", "right"]);
const SIZE_ONLY = new Set(["small", "medium", "large", "xlarge", "personal", "regular"]);
function normalizeUnit(u: string): string { return words(u)[0] ?? u; }

let menuTermWords: Map<string, Set<string>> = new Map();

/** "6 plain, 6 everything" or "plain" against a bundle's flavor list. */
function applyBundleSpan(line: Line, item: MenuItem, span: string): boolean {
  const b = item.bundle!;
  const unit = normalizeUnit(b.unit);
  const group: MenuGroup = { id: "bundle", name: b.unit, kind: "slot", max_select: b.count, ask_mode: "ask", default_choice_id: null,
    choices: b.choices.map((c) => ({ ...c, words: c.words.filter((w) => w !== unit && w !== unit + "s") })) };
  const sel = (line.selections ??= {});
  const total = () => Object.values(sel).reduce((a, n) => a + n, 0);
  let consumed = false;
  for (const part of splitList(span)) {
    const { count, rest } = leadingCount(part);
    if (!rest) continue;
    const m = matchChoice(rest, group);
    if (m.kind !== "one") continue;
    const remaining = Math.max(0, b.count - total());
    const n = Math.min(count ?? remaining, remaining);
    if (n <= 0) continue;
    sel[m.choice_id] = (sel[m.choice_id] ?? 0) + n;
    consumed = true;
  }
  return consumed;
}

/** Apply one held span to a bound line. Returns true when it was consumed as a priced choice. */
function applyHeldSpan(line: Line, item: MenuItem, span: string, mayNote = true): boolean {
  if (item.bundle) return applyBundleSpan(line, item, span) || isWordSubset(words(span), item.words);
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
  const own = new Set([...item.words, ...words(item.name), ...words(item.facets.kind ?? ""), ...(menuTermWords.get(item.id) ?? [])]);
  if (sw.every((w) => own.has(w) || own.has(singular(w)))) return true; // restating the item name or size
  if (sw.every((w) => SIZE_ONLY.has(w))) return false; // a size on an item that has no sizes: not an instruction
  if (mayNote) line.notes.push(text);
  return false;
}

/**
 * Bind a line as far as the data allows. Idempotent. Mutates the line.
 * Returns the item it ended on, if any.
 */
export function bindLine(line: Line, menu: Menu): void {
  menuTermWords = menu.termWordsByItem;
  // An unresolved line whose customer gave a replacement span: swap the span.
  if (line.item_id === null && line.status.kind === "unresolved" && (line.answers?.length ?? 0) > 0) {
    const first = line.answers![0];
    if (resolveSpan(line.span, menu).kind === "none" && resolveSpan(first, menu).kind !== "none") { line.span = line.answers!.shift()!; }
  }
  if (line.item_id === null) {
    let cands: string[];
    if (line.status.kind === "ambiguous") cands = line.status.candidates;
    else {
      const r = resolveSpan(line.span, menu);
      if (r.kind === "none") { line.status = { kind: "unresolved" }; return; }
      cands = r.kind === "item" ? [r.id] : r.ids;
    }
    // several bundles ("half dozen" vs "one dozen"): the span's own count, or the picks' total, decides
    if (cands.length > 1 && cands.every((id) => menu.items.get(id)?.bundle)) {
      let n = impliedCount(line.span);
      if (n === null) {
        const picks = line.held.flatMap((h) => splitList(h)).map((p) => leadingCount(p).count ?? 0).reduce((a, b) => a + b, 0);
        if (picks > 0) n = picks;
      }
      const hit = cands.find((id) => menu.items.get(id)!.bundle!.count === n);
      if (hit) cands = [hit];
    }
    // the span's own words narrow first ("everything bagels" over the bagel category)
    if (cands.length > 1) {
      for (const w of contentWords(line.span)) {
        const n = narrow(cands, w, menu);
        if (n.length >= 1 && n.length < cands.length) cands = n;
      }
    }
    // answers to "which kind?" narrow and are then spent; one that narrows nothing is dropped, never noted
    for (const a of line.answers ?? []) {
      if (cands.length === 1) break;
      const n = isDigits(a) ? (cands[parseInt(a, 10) - 1] ? [cands[parseInt(a, 10) - 1]] : []) : narrow(cands, a, menu);
      if (n.length >= 1 && n.length < cands.length) cands = n;
    }
    line.answers = [];
    // one option span naming several toppings ("half pepperoni half mushroom", "pepperoni and
    // mushrooms") becomes one span per topping, each keeping its own placement word
    if (cands.length > 1) line.held = line.held.flatMap((h) => h.startsWith("-") ? [h] : segmentTopics(h, cands, menu));
    // "half pepperoni half mushroom" over derived single-topping rows: two spans that narrow to
    // different rows describe toppings on the shared base pizza, not two kinds
    if (cands.length > 1) {
      const topicOf = (h: string) => words(h).filter((w) => !PLACEMENT.has(w)).join(" ");
      const props = line.held.filter((h) => !h.startsWith("-")).map((h) => ({ h, half: words(h).includes("half"), n: narrow(cands, topicOf(h), menu) })).filter((x) => x.n.length > 0 && x.n.length < cands.length);
      let inter = cands; for (const x of props) inter = inter.filter((id) => x.n.includes(id));
      const sizeProps = props.filter((x) => words(x.h).length === 1 && SIZE_ONLY.has(words(x.h)[0]));
      const topicProps = props.filter((x) => !sizeProps.includes(x));
      // two toppings that point at different derived rows, or any "half" topping: the base pizza plus modifiers
      if (topicProps.length >= 1 && (inter.length === 0 || topicProps.some((x) => x.half))) {
        let pool = cands; for (const x of sizeProps) pool = pool.filter((id) => x.n.includes(id));
        const baseOf = (id: string) => menu.items.get(id)?.derived_from?.base_item_id ?? id;
        const baseHits = new Map<string, number>();
        for (const x of topicProps) for (const b of new Set(x.n.filter((id) => pool.includes(id)).map(baseOf))) baseHits.set(b, (baseHits.get(b) ?? 0) + 1);
        const common = [...baseHits.entries()].filter(([b, n]) => n === topicProps.length && menu.items.has(b)).map(([b]) => b);
        // one base: resolved. Several (the same pizza in three sizes): the size question follows.
        if (common.length >= 1) {
          cands = common;
          line.held = line.held.filter((h) => !sizeProps.some((x) => x.h === h)); // size is implied by the base row
        }
      }
    }
    // narrow with every held span that narrows; keep the rest for options
    const rest: string[] = [];
    for (const h of line.held) {
      if (h.startsWith("-") || cands.length === 1) { rest.push(h); continue; }
      const n = isDigits(h) && line.status.kind === "ambiguous"
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
  // "20 wings" against a 10-piece row is two orders, not twenty
  if (item.piece_count && !line.pieces_applied && line.qty >= item.piece_count && line.qty % item.piece_count === 0) {
    line.qty = line.qty / item.piece_count;
  }
  line.pieces_applied = true;
  const held = line.held; line.held = [];
  // words in the item span that are not the item's own name ("chicken noodle cups", "house personal calzone")
  if (!line.span_consumed) {
    line.span_consumed = true;
    const own = new Set([...item.words, ...words(item.name), ...words(item.facets.kind ?? ""), ...(menu.termWordsByItem.get(item.id) ?? [])]);
    const leftover = words(line.span).filter((w) => !own.has(w) && !own.has(singular(w)) && !STOP_FOR_LEFTOVER.has(w));
    // words the customer used to NAME the item ("parm", "large") may pick options but are never kitchen notes
    if (leftover.length > 0) applyHeldSpan(line, item, leftover.join(" "), false);
  }
  for (const h of held) applyHeldSpan(line, item, h);
  applyCanon(line, menu);
  item = menu.items.get(line.item_id!)!;
  if (item.bundle) {
    const picked = Object.values(line.selections ?? {}).reduce((a, n) => a + n, 0);
    if (picked < item.bundle.count) { line.status = { kind: "needs_picks", remaining: item.bundle.count - picked }; return; }
    line.status = { kind: "complete" }; return;
  }
  const open = requiredGroupOpen(line, item);
  if (open) { line.status = { kind: "needs_slot", group_id: open.id }; return; }
  const pendingModifierGroup = Object.keys(line.slot_candidates).find((gid) => item.groups.some((g) => g.id === gid));
  if (pendingModifierGroup) { line.status = { kind: "needs_slot", group_id: pendingModifierGroup }; return; }
  line.status = { kind: "complete" };
}

/** "half pepperoni half mushroom" / "pepperoni and mushrooms": when a held span as a whole narrows
 *  nothing but its parts do, return one span per part, each carrying the placement word before it. */
function segmentTopics(h: string, cands: string[], menu: Menu): string[] {
  const ws = words(h);
  const skip = (w: string) => STOPWORDS.has(w) || PLACEMENT.has(w);
  const isPlacement = (w: string) => w === "half" || w === "whole";
  const topic = ws.filter((w) => !skip(w));
  if (topic.length < 2 || narrow(cands, topic.join(" "), menu).length > 0) return [h]; // one topping, maybe multi-word
  const out: string[] = []; let placement = "";
  for (let i = 0; i < ws.length; i++) {
    if (isPlacement(ws[i])) { placement = ws[i]; continue; }
    if (skip(ws[i])) continue;
    for (let j = ws.length; j > i; j--) {
      const slice = ws.slice(i, j); if (slice.some(isPlacement)) continue;
      const run = slice.filter((x) => !skip(x)).join(" "), n = narrow(cands, run, menu);
      if (n.length > 0 && n.length < cands.length) { out.push(placement ? `${placement} ${run}` : run); i = j - 1; break; }
    }
  }
  return out.length >= 2 ? out : [h];
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
  if (line.status.kind === "needs_picks" && line.item_id) {
    const b = menu.items.get(line.item_id)!.bundle!;
    const unit = normalizeUnit(b.unit);
    const group: MenuGroup = { id: "bundle", name: b.unit, kind: "slot", max_select: b.count, ask_mode: "ask", default_choice_id: null, choices: b.choices.map((c) => ({ ...c, words: c.words.filter((w) => w !== unit && w !== unit + "s") })) };
    return splitList(span).some((p) => matchChoice(leadingCount(p).rest, group).kind !== "none");
  }
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
