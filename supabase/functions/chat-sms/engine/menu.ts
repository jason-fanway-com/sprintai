// menu.ts — the engine's read-only view of a compiled menu, and the adapter
// that builds it from the rows the compiler already writes (menu_items.ask_plan,
// lexicon). Facets are derived from item names here until the compiler emits
// them as columns; that regex runs over MENU NAMES, never customer text.

import { findWordRun, normalize, singular, words } from "./normalize.ts";

export interface MenuChoice { id: string; name: string; delta_cents: number; words: string[] }
export interface MenuGroup { id: string; name: string; kind: "slot" | "modifier"; max_select: number; choices: MenuChoice[]; /** compiler's ask mode: ask | apply_default | auto_single | offer_once | on_request */ ask_mode: string; default_choice_id: string | null }
export interface Facets { kind: string | null; size: string | null }
export interface BundleDef { count: number; unit: string; choices: MenuChoice[] }
export interface MenuItem { id: string; name: string; display_name: string; description: string | null; category: string | null; base_cents: number; groups: MenuGroup[]; facets: Facets; orderable: boolean; derived_from: { base_item_id: string; choice_ids: string[] } | null; words: string[]; /** "Garlic Knots (6)", "Wings Bone-In - 10 Pieces": how many units one order holds */ piece_count: number | null; /** a fixed-price assortment: `count` picks from `choices` ("one dozen bagels") */ bundle: BundleDef | null; /** words this item is what people normally mean by ("cheesesteak"), confirmed before the others are offered */ primary_for: string[]; /** items this one already comes with ("with French Fries") */ includes: string[] }
export interface LexiconEntry { term: string; target_type: "item" | "choice" | "category" | string; target_id: string }
export interface IndexedTerm { words: string[]; wordsSing: string[]; target_id: string; target_type: string }

export interface Menu { version: string; items: Map<string, MenuItem>; /** item terms, longest first */ itemTerms: IndexedTerm[]; categoryTerms: IndexedTerm[]; /** `${base_item_id}|${choice_id}` -> derived item id */ canon: Map<string, string>; /** every lexicon word that names an item, by item id (for "what's left over in the span") */ termWordsByItem: Map<string, Set<string>>; /** every word of every item or category term: the spelling universe a typo is measured against */ vocab: Set<string>; shop: ShopConfig; /** item ids sold out (86) today */ sold_out?: Set<string> }

export interface ShopConfig { shop_id: string; name: string; delivery_enabled: boolean; delivery_fee_cents: number; tax_rate_bps: number; service_fee_cents: number; phone_display: string | null; /** field order for asking; data, not code */ ask_order: Array<"fulfillment" | "address" | "items" | "tip" | "confirm"> }

// ── Raw row shapes (what the DB / existing loaders hand us) ─────────────────
export interface RawAskPlanStep { group_id: string; slot_key: string | null; kind: "slot" | "modifier"; ask_mode?: string; prompt_template?: string; choices: Array<{ id: string; display: string; price_delta_cents: number }> }
export interface RawMenuItem { id: string; name: string; display_name?: string | null; description?: string | null; category?: string | null; price_cents: number; bot_state?: string | null; size_label?: string | null; is_derived?: boolean | null; derived_from?: { base_item_id: string; choice_ids: string[] } | null; ask_plan?: { base_price_cents?: number; display_name?: string; steps?: RawAskPlanStep[]; compiled_at?: string } | null; meta?: { bundle?: { count: number; category: string; unit?: string }; primary_for?: string[]; includes?: string[] } | null; option_groups?: Array<{ id: string; name: string; max_select?: number | null; default_choice_id?: string | null }> | null }

const SIZE_WORDS = new Set(["small", "medium", "large", "xlarge", "personal", "sheet", "cup", "bowl", "half", "whole", "regular"]);
const NAME_SIZE_RE = /^(.*?)\s*[-–(]\s*(small|medium|large|x-?large|extra large|personal|sheet|cup|bowl|regular)\b.*$/i;

const LEADING_SIZE_RE = /^(small|medium|large|x-?large|extra large|personal|sheet|regular|cup|bowl|pint|quart)\b\s*(?:\d+\s*(?:''|"|”)?\s*)?(.+)$/i;

const NAME_PIECES_RE = /^(.*?)\s*[-–(]\s*\d+\s*(?:pieces?|pcs?|ct|count)\b.*$/i;
const PIECES_RE = /\((\d+)\)|\b(\d+)\s*(?:pieces?|pcs?|ct|count|wings)\b/i;
export function pieceCountFromName(name: string): number | null {
  const m = PIECES_RE.exec(name), n = m ? parseInt(m[1] ?? m[2], 10) : NaN;
  return n >= 2 && n <= 100 ? n : null;
}

export function facetsFromName(name: string, sizeLabel?: string | null): Facets {
  const m = NAME_SIZE_RE.exec(name), lead = LEADING_SIZE_RE.exec(name), pieces = NAME_PIECES_RE.exec(name);
  if (m) return { kind: normalize(m[1]) || null, size: words(m[2])[0] ?? null };
  if (lead) return { kind: normalize(lead[2]) || null, size: words(lead[1])[0] ?? null };
  if (pieces) return { kind: normalize(pieces[1]) || null, size: null };
  const label = sizeLabel ? words(sizeLabel)[0] : null;
  if (label && SIZE_WORDS.has(label)) {
    const kindWords = words(name).filter((w) => w !== label);
    return { kind: kindWords.join(" ") || null, size: label };
  }
  return { kind: normalize(name) || null, size: null };
}

export function buildMenu(input: {
  version: string;
  items: RawMenuItem[];
  lexicon: LexiconEntry[];
  shop: ShopConfig;
}): Menu {
  const items = new Map<string, MenuItem>();
  for (const r of input.items) {
    const groupNames = new Map<string, { name: string; max: number; def: string | null }>();
    for (const g of r.option_groups ?? []) groupNames.set(g.id, { name: g.name, max: g.max_select ?? 1, def: g.default_choice_id ?? null });
    const steps = r.ask_plan?.steps ?? [];
    const groups: MenuGroup[] = steps.map((s) => {
      const meta = groupNames.get(s.group_id);
      const fallbackName = s.slot_key ?? (s.prompt_template ? s.prompt_template.replace(/\.ask$/, "") : "option");
      return {
        id: s.group_id,
        name: meta?.name ?? fallbackName,
        kind: s.kind,
        max_select: s.kind === "modifier" ? Math.max(meta?.max ?? 99, 1) : 1,
        choices: s.choices.map((c) => ({ id: c.id, name: c.display, delta_cents: c.price_delta_cents, words: words(c.display) })),
        ask_mode: s.ask_mode ?? "ask",
        default_choice_id: meta?.def ?? null,
      };
    });
    const display = r.display_name ?? r.ask_plan?.display_name ?? r.name;
    items.set(r.id, {
      id: r.id,
      name: r.name,
      display_name: display, description: r.description?.trim() || null, primary_for: (r.meta?.primary_for ?? []).map((t) => words(t).join(" ")), includes: r.meta?.includes ?? [],
      category: r.category ?? null,
      base_cents: r.ask_plan?.base_price_cents ?? r.price_cents,
      groups,
      facets: facetsFromName(r.name, r.size_label),
      orderable: (r.bot_state ?? "orderable") === "orderable",
      derived_from: r.derived_from ?? null,
      words: words(display),
      bundle: null,
      piece_count: pieceCountFromName(r.name) ?? pieceCountFromName(display),
    });
  }

  const itemTerms: IndexedTerm[] = [];
  const categoryTerms: IndexedTerm[] = [];
  for (const e of input.lexicon) {
    const w = words(e.term);
    if (w.length === 0) continue;
    if (e.target_type === "item") {
      const it = items.get(e.target_id), alts = it?.display_name.split(" / ").map((x) => words(x)) ?? [];
      if (!it || !it.orderable || (alts.length > 1 && findWordRun(w, [...alts[0], alts[1][0]]) >= 0)) continue; // a compiled "cheesesteak chicken cheesesteak salad" is the slash name read as one run
      itemTerms.push({ words: w, wordsSing: w.map(singular), target_id: e.target_id, target_type: "item" });
    } else if (e.target_type === "category") {
      categoryTerms.push({ words: w, wordsSing: w.map(singular), target_id: e.target_id, target_type: "category" });
    }
  }
  // an item's own display name is always a term, so a lexicon gap never makes it unorderable (NJB's Chicken Salad Sandwich had none);
  // "Cheesesteak / Chicken Cheesesteak Salad" names two things ("cheesesteak salad", "chicken cheesesteak salad"), never one five-word run; "Topping/Sauce/Filling" is one phrase
  const have = new Set(itemTerms.map((t) => `${t.target_id}|${t.words.join(" ")}`));
  const names = (it: MenuItem): string[][] => { const p = it.display_name.split(" / ").map((x) => words(x)).filter((w) => w.length > 0); if (p.length < 2) return [it.words]; const last = p[p.length - 1], k = last.lastIndexOf(p[0][p[0].length - 1]); return p.map((w, i) => i === p.length - 1 ? w : [...w, ...last.slice(k >= 0 ? k + 1 : 1)]); };
  for (const it of items.values()) if (it.orderable) for (const w of names(it)) if (w.length > 0 && !have.has(`${it.id}|${w.join(" ")}`)) itemTerms.push({ words: w, wordsSing: w.map(singular), target_id: it.id, target_type: "item" });
  itemTerms.sort((a, b) => b.words.length - a.words.length);
  categoryTerms.sort((a, b) => b.words.length - a.words.length);

  // bundles: choices are the orderable items of the named category, excluding other bundles
  for (const r of input.items) {
    const b = r.meta?.bundle;
    if (!b || !b.count) continue;
    const it = items.get(r.id)!;
    const flavors = [...items.values()].filter((x) => x.orderable && x.id !== r.id && !x.name.toLowerCase().includes("dozen") && x.category && normalize(x.category) === normalize(b.category) && !(input.items.find((y) => y.id === x.id)?.meta?.bundle));
    it.bundle = { count: b.count, unit: b.unit ?? "item", choices: flavors.map((f) => ({ id: f.id, name: f.display_name, delta_cents: 0, words: f.words })) };
    // customers say "a dozen bagels", "half a dozen", "12 bagels": give the bundle those terms
    const unit = normalize(b.unit ?? "item");
    const plural = unit.endsWith("s") ? unit : unit + "s";
    const extra: string[] = [`${b.count} ${plural}`, `${b.count} ${unit}`];
    if (b.count === 12) extra.push("dozen", "a dozen", `dozen ${plural}`, `a dozen ${plural}`, `one dozen ${plural}`, "one dozen");
    if (b.count === 6) extra.push("half dozen", "half a dozen", `half dozen ${plural}`, `half a dozen ${plural}`, `six ${plural}`);
    for (const t of extra) { const w = words(t); if (w.length) itemTerms.push({ words: w, wordsSing: w.map(singular), target_id: r.id, target_type: "item" }); }
  }
  itemTerms.sort((a, b) => b.words.length - a.words.length);

  const canon = new Map<string, string>();
  for (const it of items.values()) {
    if (it.derived_from && it.orderable && it.derived_from.choice_ids.length === 1) {
      canon.set(`${it.derived_from.base_item_id}|${it.derived_from.choice_ids[0]}`, it.id);
    }
  }
  const termWordsByItem = new Map<string, Set<string>>();
  for (const t of itemTerms) { const set = termWordsByItem.get(t.target_id) ?? new Set<string>(); for (const w of t.words) set.add(w); termWordsByItem.set(t.target_id, set); }
  const vocab = new Set([...[...itemTerms, ...categoryTerms].flatMap((t) => t.words), ...[...items.values()].flatMap((i) => i.groups.flatMap((g) => g.choices.flatMap((c) => c.words)))]); // option words too: "fries" that is only a burger swap is a word, not a typo for "fried"
  return { version: input.version, items, itemTerms, categoryTerms, canon, termWordsByItem, vocab, shop: input.shop };
}

export function itemsInCategory(menu: Menu, category: string): MenuItem[] {
  const c = normalize(category);
  const out: MenuItem[] = [];
  for (const it of menu.items.values()) {
    if (!it.orderable) continue;
    if (it.category && normalize(it.category) === c) out.push(it);
  }
  if (out.length === 0) {
    const noun = c.replace(/s$/, "");
    for (const it of menu.items.values()) {
      if (it.orderable && it.words.some((w) => w === noun || w === noun + "s")) out.push(it);
    }
  }
  return out;
}
