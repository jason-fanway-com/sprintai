/**
 * compile-menu — the compiler (docs/specs/2026-09-07-conversation-ready-menu-design.md
 * §3 stage 7, §11 item 4).
 *
 * Pure, deterministic transform: snapshot ⊕ overrides ⊕ learned → per-item
 * `ask_plan` + `bot_state` + lexicon rows. No I/O here — the edge function
 * (compile-menu/index.ts) does all DB reads/writes and calls into this
 * module, same split as normalize.ts / menu-entity-key.ts so this is
 * unit-testable without spinning up Supabase.
 *
 * Idempotent by construction: compileItem/compileMenu are pure functions of
 * their arguments. The only field that varies run-to-run is `compiled_at`,
 * which the CALLER stamps on (passed in, not generated here) — every other
 * field is byte-identical for identical input, including lexicon term order
 * (sorted) and step order (canonical, see CANONICAL_SLOT_ORDER below).
 *
 * Phase 0 scope, per §11 item 4:
 *   - Overrides may be an empty set (item 7's trigger ships tomorrow) — the
 *     compiler must still run correctly; empty overrides is the identity
 *     case (compiled output = snapshot alone, transformed).
 *   - Lexicon generation is RULES ONLY: §6.2 steps 1 (display_name), 2
 *     (stripped/qualified item name as a second term), 3 (category noun,
 *     singular + plural), and 6 ("X or Y" slot choice names). Steps 4
 *     (folded product/size terms) and 5 (every-choice + abbreviations, plus
 *     the LLM pass) are explicitly out of scope for this compiler — P1.
 */

import { inferCategory, type InferItemInput, type ExtractedGroup, type OwnerQuestionDraft, type ArchetypeKey } from "./archetypes.ts";

export type Provenance = "stated" | "inferred" | "owner_confirmed" | "learned" | "defaulted";
export type GroupKind = "slot" | "modifier";
export type AskMode = "ask" | "apply_default" | "auto_single" | "offer_once" | "on_request";
export type BotState = "orderable" | "blocked" | "display_only" | "stale";
export type LexiconTargetType = "item" | "choice" | "category" | "product";
export type OverrideEntityType = "item" | "group" | "choice" | "set" | "set_choice";

export const COMPILER_VERSION = 1;

export interface CompileChoice {
  id: string;
  name: string;
  display_name: string | null;
  price_cents: number;
  is_default: boolean;
  provenance: Provenance;
}

export interface CompileGroup {
  id: string;
  name: string;
  kind: GroupKind;
  slot_key: string | null;
  min_select: number;
  max_select: number;
  kitchen_critical: boolean;
  price_critical: boolean;
  default_choice_id: string | null;
  // Pre-set by the infer step (item 3) for modifier groups bound to a found
  // list (offer_once vs on_request per archetype). Null when infer hasn't
  // classified this group yet, or for slot groups (the compiler always
  // derives slot ask_mode itself from choice cardinality + default).
  ask_mode: AskMode | null;
  provenance: Provenance;
  display_order: number;
  choices: CompileChoice[];
}

export type QuestionStatus = "pending" | "asked" | "answered" | "dismissed" | "expired";
export type QuestionScopeType = "category" | "item" | "set" | "group" | "choice";

export interface PendingQuestion {
  scope_type: QuestionScopeType;
  scope_id: string; // category name, item id, or group/choice id depending on scope_type
  slot_key: string | null;
  blocking: boolean;
  status: QuestionStatus;
  question_text: string;
}

export interface CompileItem {
  id: string;
  name: string;
  display_name: string | null;
  category: string | null;
  price_cents: number | null;
  active: boolean;
  price_provenance: Provenance;
  product_key: string | null;
  missing_from_source_since: string | null; // ISO timestamp or null
  groups: CompileGroup[];
}

export interface CompiledStep {
  group_id: string;
  slot_key: string | null;
  kind: GroupKind;
  ask_mode: AskMode;
  prompt_template: string;
  choices: { id: string; display: string; price_delta_cents: number }[];
}

export interface AskPlan {
  compiled_at: string;
  compiler_version: number;
  display_name: string;
  base_price_cents: number;
  steps: CompiledStep[];
  recap_template: string;
  ticket_template: string;
}

export interface LexiconTerm {
  term: string;
  target_type: LexiconTargetType;
  target_id: string;
  provenance: Provenance;
}

export interface CompiledItem {
  item_id: string;
  bot_state: BotState;
  bot_state_reason: string | null;
  ask_plan: AskPlan;
  lexicon_terms: LexiconTerm[];
}

export interface OverrideRow {
  entity_type: OverrideEntityType;
  entity_key: string;
  field: string;
  value: unknown;
  created_at: string;
}

// ============================================================
// §2.2 / Appendix A — canonical ask order:
// size → protein/variant → temp → bread/bagel → sauce/dressing/flavor → side
// → (offer_once modifiers last).
// ============================================================
const SLOT_RANK: Record<string, number> = {
  size: 0,
  count: 0,
  protein: 1,
  variant: 1,
  choice: 1, // pre-infer normalize.ts placeholder slot_key
  temp: 2,
  egg_style: 2,
  bread: 3,
  bagel: 3,
  wrap: 3,
  dressing: 4,
  sauce: 4,
  flavor: 4,
  spread: 4,
  pasta: 4,
  side: 5,
  toast: 5,
};
const UNKNOWN_SLOT_RANK = 5.5;
const MODIFIER_RANK = 100;

function groupRank(g: CompileGroup): number {
  if (g.kind === "modifier") return MODIFIER_RANK;
  if (g.slot_key && g.slot_key in SLOT_RANK) return SLOT_RANK[g.slot_key];
  return UNKNOWN_SLOT_RANK;
}

function sortGroupsCanonical(groups: CompileGroup[]): CompileGroup[] {
  return [...groups].sort((a, b) => {
    const rankDiff = groupRank(a) - groupRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return a.id.localeCompare(b.id);
  });
}

// ============================================================
// Normalisation helpers (lexicon terms). Same behaviour as menu-entity-
// key.ts's normaliseEntityTerm — lowercase, drop punctuation that doesn't
// change meaning, collapse whitespace. Deliberately does NOT accent-fold,
// for the same reason that module gives: lexicon terms are matched against
// raw customer text, so folding here without folding the customer's input
// too would just move the mismatch rather than fix it.
// ============================================================
function normaliseTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeWord(word: string): string {
  if (word.length > 4 && /ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ches|shes|xes|ses|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

function pluralizeWord(singular: string): string {
  if (/s$/i.test(singular)) return singular;
  return `${singular}s`;
}

function categoryNoun(category: string): string {
  const cleaned = category.replace(/\([^)]*\)/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return singularizeWord(words[words.length - 1].toLowerCase());
}

// ============================================================
// Slot ask_mode derivation (compiler-owned for slot groups, per §2.2).
// ============================================================
function deriveAskMode(g: CompileGroup): AskMode {
  if (g.kind === "modifier") return g.ask_mode ?? "on_request";
  const n = g.choices.length;
  if (n === 1) return "auto_single";
  if (n > 1 && g.default_choice_id) return "apply_default";
  return "ask";
}

function promptTemplateFor(g: CompileGroup, askMode: AskMode): string {
  const key = g.slot_key ?? (normaliseTerm(g.name).replace(/\s+/g, "_") || "group");
  return `${key}.${askMode}`;
}

function choiceDisplay(c: CompileChoice): string {
  return c.display_name && c.display_name.trim() ? c.display_name : c.name;
}

function buildStep(g: CompileGroup): CompiledStep {
  const askMode = deriveAskMode(g);
  return {
    group_id: g.id,
    slot_key: g.slot_key,
    kind: g.kind,
    ask_mode: askMode,
    prompt_template: promptTemplateFor(g, askMode),
    choices: g.choices
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(c => ({ id: c.id, display: choiceDisplay(c), price_delta_cents: c.price_cents })),
  };
}

// A group produces a proactive step iff it's a slot (always asked/applied in
// some form) or a modifier explicitly flagged offer_once (§2.2: modifiers
// are "never asked proactively... except a single offer_once open question").
// on_request modifiers are reactive-only and never appear in ask_plan.steps.
function stepEligible(g: CompileGroup): boolean {
  if (g.kind === "slot") return true;
  return deriveAskMode(g) === "offer_once";
}

export function buildAskPlan(item: CompileItem, compiledAt: string): AskPlan {
  const orderedGroups = sortGroupsCanonical(item.groups).filter(stepEligible);
  return {
    compiled_at: compiledAt,
    compiler_version: COMPILER_VERSION,
    display_name: item.display_name ?? item.name,
    base_price_cents: item.price_cents ?? 0,
    steps: orderedGroups.map(buildStep),
    recap_template: "{qty} {display_name}{, with {modifiers}}",
    ticket_template: "{name}{\n  + {choice.display} x{qty}}",
  };
}

// ============================================================
// §8.1 bot_state — per item, in priority order.
// ============================================================
function findBlockingQuestion(item: CompileItem, questions: PendingQuestion[]): PendingQuestion | null {
  const hits = questions.filter(q => {
    if (!q.blocking) return false;
    if (q.scope_type === "item") return q.scope_id === item.id;
    if (q.scope_type === "category") return item.category != null && q.scope_id === item.category;
    if (q.scope_type === "group") return item.groups.some(g => g.id === q.scope_id);
    if (q.scope_type === "choice") return item.groups.some(g => g.choices.some(c => c.id === q.scope_id));
    return false;
  });
  // pending beats dismissed beats anything else, so "still waiting on an
  // answer" is reported over a stale dismissed row for the same scope.
  return (
    hits.find(q => q.status === "pending") ??
    hits.find(q => q.status === "dismissed") ??
    hits[0] ??
    null
  );
}

function computeBotState(
  item: CompileItem,
  questions: PendingQuestion[],
): { bot_state: BotState; bot_state_reason: string | null } {
  if (!item.active) {
    return { bot_state: "display_only", bot_state_reason: "item inactive" };
  }
  if (item.price_cents == null || item.price_cents <= 0) {
    return { bot_state: "display_only", bot_state_reason: "source lacks a price" };
  }
  if (!["stated", "owner_confirmed"].includes(item.price_provenance)) {
    return { bot_state: "display_only", bot_state_reason: `price provenance ${item.price_provenance}, unconfirmed` };
  }
  if (!item.display_name || !item.display_name.trim()) {
    return { bot_state: "blocked", bot_state_reason: "missing display_name" };
  }

  const blocker = findBlockingQuestion(item, questions);
  if (blocker && blocker.status === "pending") {
    return {
      bot_state: "blocked",
      bot_state_reason: `slot ${blocker.slot_key ?? blocker.scope_type} pending owner question: ${blocker.question_text}`,
    };
  }
  if (blocker && blocker.status === "dismissed") {
    return {
      bot_state: "display_only",
      bot_state_reason: `slot ${blocker.slot_key ?? blocker.scope_type} owner declined to answer`,
    };
  }

  for (const g of sortGroupsCanonical(item.groups)) {
    if (g.kind !== "slot") continue;
    if (g.choices.length === 0) {
      return { bot_state: "blocked", bot_state_reason: `slot ${g.slot_key ?? g.name} has zero active choices` };
    }
    if (g.min_select < 1 || g.min_select > g.max_select) {
      return { bot_state: "blocked", bot_state_reason: `slot ${g.slot_key ?? g.name} has invalid min/max_select` };
    }
    if ((g.kitchen_critical || g.price_critical) && !["stated", "owner_confirmed"].includes(g.provenance)) {
      return {
        bot_state: "blocked",
        bot_state_reason: `slot ${g.slot_key ?? g.name} ${g.provenance}, unconfirmed`,
      };
    }
    for (const c of g.choices) {
      if (c.price_cents == null) {
        return { bot_state: "blocked", bot_state_reason: `choice ${c.display_name ?? c.name} in slot ${g.slot_key ?? g.name} has no price` };
      }
      if (!["stated", "owner_confirmed"].includes(c.provenance)) {
        return {
          bot_state: "blocked",
          bot_state_reason: `choice ${c.display_name ?? c.name} in slot ${g.slot_key ?? g.name} is ${c.provenance}, unconfirmed`,
        };
      }
    }
    if (g.default_choice_id && !g.choices.some(c => c.id === g.default_choice_id)) {
      return { bot_state: "blocked", bot_state_reason: `slot ${g.slot_key ?? g.name} default_choice_id does not reference an active choice` };
    }
  }

  if (item.missing_from_source_since) {
    const ageMs = Date.parse(item.missing_from_source_since);
    if (!Number.isNaN(ageMs)) {
      const days = (Date.now() - ageMs) / 86_400_000;
      if (days > 14) {
        return { bot_state: "stale", bot_state_reason: `missing from source since ${item.missing_from_source_since}` };
      }
    }
  }

  return { bot_state: "orderable", bot_state_reason: null };
}

// ============================================================
// §6.2 lexicon generation — rules 1, 2, 3, 6 only (P0 scope, see header).
// ============================================================
function itemLexiconTerms(item: CompileItem): LexiconTerm[] {
  const terms: LexiconTerm[] = [];
  const displayName = (item.display_name ?? item.name).trim();
  if (!displayName) return terms;

  // Rule 1: display_name itself.
  terms.push({ term: normaliseTerm(displayName), target_type: "item", target_id: item.id, provenance: "stated" });

  // Rule 2: stripped/qualified item name as a second term — if the
  // display_name was qualified with its trailing category noun ("Chicken
  // Caesar Salad"), also index the unqualified form ("Chicken Caesar") so a
  // customer who doesn't say the category word still resolves.
  if (item.category) {
    const noun = categoryNoun(item.category);
    if (noun) {
      const suffixRe = new RegExp(`\\s+${noun}s?$`, "i");
      if (suffixRe.test(displayName)) {
        const stripped = displayName.replace(suffixRe, "").trim();
        if (stripped && stripped.toLowerCase() !== displayName.toLowerCase()) {
          terms.push({ term: normaliseTerm(stripped), target_type: "item", target_id: item.id, provenance: "stated" });
        }
      }
    }
  }

  // Rule 6: "X or Y" slot choices → their own names, as choice targets.
  for (const g of item.groups) {
    if (g.kind !== "slot") continue;
    for (const c of g.choices) {
      const cName = choiceDisplay(c).trim();
      if (!cName) continue;
      terms.push({ term: normaliseTerm(cName), target_type: "choice", target_id: c.id, provenance: "stated" });
    }
  }

  return terms;
}

// Rule 3: category noun singular + plural → category target. Computed once
// per distinct category across the whole menu by the caller (compileMenu),
// not per item, since it's the same two terms for every item in it.
export function categoryLexiconTerms(category: string): LexiconTerm[] {
  const noun = categoryNoun(category);
  if (!noun) return [];
  const singular = noun.toLowerCase();
  const plural = pluralizeWord(singular);
  const terms: LexiconTerm[] = [{ term: normaliseTerm(singular), target_type: "category", target_id: category, provenance: "stated" }];
  if (plural !== singular) {
    terms.push({ term: normaliseTerm(plural), target_type: "category", target_id: category, provenance: "stated" });
  }
  return terms;
}

function dedupeLexicon(terms: LexiconTerm[]): LexiconTerm[] {
  const seen = new Set<string>();
  const out: LexiconTerm[] = [];
  for (const t of terms) {
    const key = `${t.target_type} ${t.target_id} ${t.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) =>
    a.term === b.term
      ? a.target_type === b.target_type
        ? a.target_id.localeCompare(b.target_id)
        : a.target_type.localeCompare(b.target_type)
      : a.term.localeCompare(b.term),
  );
}

// §8.2 invariant 4: every orderable item needs ≥1 active lexicon term that
// resolves UNIQUELY to it (or its product). A term is unique here iff no
// other item's rule-generated terms also produced it pointing at a
// different item — checked at the whole-menu level in computeMenuInvariants,
// not per item, since uniqueness is inherently a cross-item property.

// ============================================================
// Overrides — snapshot ⊕ overrides, applied before compiling. Empty
// overrides is the identity case (§11 item 4 P0 requirement): with no rows,
// applyOverrides returns its input unchanged.
// ============================================================
export function applyOverrides(
  item: CompileItem,
  itemEntityKey: string,
  groupEntityKeys: Map<string, string>, // group.id -> entity_key
  choiceEntityKeys: Map<string, string>, // choice.id -> entity_key
  overrides: OverrideRow[],
): CompileItem {
  if (overrides.length === 0) return item;

  const byKey = new Map<string, OverrideRow[]>();
  for (const o of overrides) {
    const k = `${o.entity_type} ${o.entity_key}`;
    const list = byKey.get(k);
    if (list) list.push(o); else byKey.set(k, [o]);
  }
  const lastWriteWins = (rows: OverrideRow[] | undefined): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    if (!rows) return out;
    for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      out.set(r.field, r.value);
    }
    return out;
  };

  const itemFields = lastWriteWins(byKey.get(`item ${itemEntityKey}`));
  if (itemFields.has("*")) return { ...item, active: false };

  const next: CompileItem = { ...item };
  if (itemFields.has("display_name")) next.display_name = itemFields.get("display_name") as string;
  if (itemFields.has("price_cents")) next.price_cents = itemFields.get("price_cents") as number;
  if (itemFields.has("active")) next.active = itemFields.get("active") as boolean;

  next.groups = item.groups
    .map(g => {
      const gKey = groupEntityKeys.get(g.id);
      const gFields = gKey ? lastWriteWins(byKey.get(`group ${gKey}`)) : new Map<string, unknown>();
      if (gFields.has("*")) return null;
      const nextGroup: CompileGroup = { ...g };
      if (gFields.has("default_choice_id")) nextGroup.default_choice_id = gFields.get("default_choice_id") as string;
      if (gFields.has("ask_mode")) nextGroup.ask_mode = gFields.get("ask_mode") as AskMode;

      nextGroup.choices = g.choices
        .map(c => {
          const cKey = choiceEntityKeys.get(c.id);
          const cFields = cKey ? lastWriteWins(byKey.get(`choice ${cKey}`)) : new Map<string, unknown>();
          if (cFields.has("*")) return null;
          const nextChoice: CompileChoice = { ...c };
          if (cFields.has("price_cents")) nextChoice.price_cents = cFields.get("price_cents") as number;
          if (cFields.has("display_name")) nextChoice.display_name = cFields.get("display_name") as string;
          return nextChoice;
        })
        .filter((c): c is CompileChoice => c !== null);
      return nextGroup;
    })
    .filter((g): g is CompileGroup => g !== null);

  return next;
}

// ============================================================
// Per-item + whole-menu compile.
// ============================================================
export function compileItem(item: CompileItem, questions: PendingQuestion[], compiledAt: string): CompiledItem {
  const { bot_state, bot_state_reason } = computeBotState(item, questions);
  return {
    item_id: item.id,
    bot_state,
    bot_state_reason,
    ask_plan: buildAskPlan(item, compiledAt),
    lexicon_terms: itemLexiconTerms(item),
  };
}

export interface MenuInvariantResult {
  invariant: number;
  description: string;
  pass: boolean;
  violations: string[]; // item ids / free-form detail, capped for reporting
}

export function computeMenuInvariants(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
  acknowledgedDisplayOnly: boolean,
): MenuInvariantResult[] {
  const activeItems = items.filter(i => i.active);
  const orderable = (id: string) => compiled.get(id)?.bot_state === "orderable";
  const blocked = (id: string) => compiled.get(id)?.bot_state === "blocked";

  const results: MenuInvariantResult[] = [];

  // 1. No item in an active category is blocked.
  const blockedItems = activeItems.filter(i => blocked(i.id));
  results.push({
    invariant: 1,
    description: "No item in an active category is blocked",
    pass: blockedItems.length === 0,
    violations: blockedItems.map(i => `${i.id} (${i.display_name ?? i.name})`),
  });

  // 2. Every orderable item has display_name + ask_plan + price_cents>0 +
  //    price_provenance in (stated, owner_confirmed).
  const badOrderable = activeItems.filter(i => {
    if (!orderable(i.id)) return false;
    const c = compiled.get(i.id)!;
    return !i.display_name || !c.ask_plan || !(i.price_cents && i.price_cents > 0) ||
      !["stated", "owner_confirmed"].includes(i.price_provenance);
  });
  results.push({
    invariant: 2,
    description: "Every orderable item has display_name, ask_plan, price_cents>0, confirmed price_provenance",
    pass: badOrderable.length === 0,
    violations: badOrderable.map(i => i.id),
  });

  // 3. No two orderable items share lower(display_name).
  const nameGroups = new Map<string, string[]>();
  for (const i of activeItems) {
    if (!orderable(i.id)) continue;
    const key = (i.display_name ?? i.name).toLowerCase();
    const list = nameGroups.get(key);
    if (list) list.push(i.id); else nameGroups.set(key, [i.id]);
  }
  const dupNames = [...nameGroups.entries()].filter(([, ids]) => ids.length > 1);
  results.push({
    invariant: 3,
    description: "No two orderable items share the same display_name",
    pass: dupNames.length === 0,
    violations: dupNames.map(([name, ids]) => `"${name}": ${ids.join(", ")}`),
  });

  // 4. Every orderable item has ≥1 active lexicon term resolving uniquely to it.
  const termOwners = new Map<string, Set<string>>(); // term -> set of item ids it points at (directly or via choice->group->item)
  for (const i of activeItems) {
    const c = compiled.get(i.id);
    if (!c) continue;
    for (const t of c.lexicon_terms) {
      if (t.target_type !== "item") continue;
      const owners = termOwners.get(t.term) ?? new Set<string>();
      owners.add(i.id);
      termOwners.set(t.term, owners);
    }
  }
  const noUniqueTerm = activeItems.filter(i => {
    if (!orderable(i.id)) return false;
    const c = compiled.get(i.id)!;
    return !c.lexicon_terms.some(t => t.target_type === "item" && termOwners.get(t.term)?.size === 1);
  });
  results.push({
    invariant: 4,
    description: "Every orderable item has ≥1 active lexicon term resolving uniquely to it",
    pass: noUniqueTerm.length === 0,
    violations: noUniqueTerm.map(i => i.id),
  });

  // 5. Every group on an orderable item: slot ⇒ min_select≥1, min≤max, ≥1
  //    active choice, every choice provenance confirmed + priced.
  const badGroups: string[] = [];
  for (const i of activeItems) {
    if (!orderable(i.id)) continue;
    for (const g of i.groups) {
      const problems: string[] = [];
      if (g.kind === "slot" && g.min_select < 1) problems.push("slot min_select<1");
      if (g.min_select > g.max_select) problems.push("min>max");
      if (g.choices.length === 0) problems.push("no active choices");
      for (const c of g.choices) {
        if (!["stated", "owner_confirmed"].includes(c.provenance)) problems.push(`choice ${c.id} unconfirmed`);
        if (c.price_cents == null) problems.push(`choice ${c.id} unpriced`);
      }
      if (problems.length > 0) badGroups.push(`${i.id}/${g.id}: ${problems.join("; ")}`);
    }
  }
  results.push({
    invariant: 5,
    description: "Every group on an orderable item satisfies slot/min/max/choice/provenance rules",
    pass: badGroups.length === 0,
    violations: badGroups,
  });

  // 6. Every default_choice_id references an active choice in its own group.
  const badDefaults: string[] = [];
  for (const i of activeItems) {
    for (const g of i.groups) {
      if (g.default_choice_id && !g.choices.some(c => c.id === g.default_choice_id)) {
        badDefaults.push(`${i.id}/${g.id}`);
      }
    }
  }
  results.push({
    invariant: 6,
    description: "Every default_choice_id references an active choice in its own group",
    pass: badDefaults.length === 0,
    violations: badDefaults,
  });

  // 7. No active `inferred` choice anywhere.
  const inferredChoices: string[] = [];
  for (const i of activeItems) {
    for (const g of i.groups) {
      for (const c of g.choices) {
        if (c.provenance === "inferred") inferredChoices.push(`${i.id}/${g.id}/${c.id}`);
      }
    }
  }
  results.push({
    invariant: 7,
    description: "No active choice has provenance 'inferred'",
    pass: inferredChoices.length === 0,
    violations: inferredChoices,
  });

  // 8. orderable/active ratio ≥ 0.9, OR owner acknowledged the display_only list.
  const ratio = activeItems.length === 0 ? 1 : activeItems.filter(i => orderable(i.id)).length / activeItems.length;
  results.push({
    invariant: 8,
    description: `orderable/active ratio ≥ 0.9 or owner-acknowledged (actual: ${(ratio * 100).toFixed(1)}%, acknowledged: ${acknowledgedDisplayOnly})`,
    pass: ratio >= 0.9 || acknowledgedDisplayOnly,
    violations: ratio >= 0.9 || acknowledgedDisplayOnly ? [] : [`ratio ${(ratio * 100).toFixed(1)}% < 90%, not acknowledged`],
  });

  return results;
}

// ============================================================
// §3 stage 5 "Infer" wiring (§11 item 3's own note: "item 4's compiler ...
// is the natural caller once it's landed"). Pure glue only: shapes real
// DB-shaped item rows into archetypes.ts's InferItemInput and fans
// inferCategory() out over every distinct category in the menu.
// archetypes.ts itself still writes nothing but plain OwnerQuestionDraft
// data (see its own file header); this function still writes nothing
// either — the caller (index.ts) is the one that INSERTs into
// owner_questions, same read/pure vs write/I-O split as everything else
// in this module.
// ============================================================
export interface InferSourceItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  productKey: string | null;
  extractedGroups: ExtractedGroup[];
  nameSlotChoices: string[] | null;
  descriptionSlotChoices: string[] | null;
}

export interface CategoryQuestionSummary {
  category: string;
  archetype: ArchetypeKey;
  itemCount: number;
  questions: OwnerQuestionDraft[];
}

// §5.1's "category or set first, item second" scoping means an item with
// no category has no scope to ask a question against. Excluded here, not
// an error — it simply contributes no questions, same as any other
// archetype outcome that resolves to `skip`.
export function buildOwnerQuestionSummaries(items: InferSourceItem[]): CategoryQuestionSummary[] {
  const byCategory = new Map<string, InferSourceItem[]>();
  for (const item of items) {
    if (!item.category || !item.category.trim()) continue;
    const list = byCategory.get(item.category);
    if (list) list.push(item); else byCategory.set(item.category, [item]);
  }

  // Sibling count is menu-wide, not per-category, by construction: a
  // product's folded size rows always share one product_key regardless of
  // which category holds them (§2.2, Appendix A "size stated by rows").
  const productKeyCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.productKey) continue;
    productKeyCounts.set(item.productKey, (productKeyCounts.get(item.productKey) ?? 0) + 1);
  }

  const summaries: CategoryQuestionSummary[] = [];
  for (const [category, categoryItems] of byCategory) {
    const inferInputs: InferItemInput[] = categoryItems.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      productKey: item.productKey,
      siblingCount: item.productKey ? productKeyCounts.get(item.productKey) ?? 1 : 1,
      nameSlotChoices: item.nameSlotChoices,
      descriptionSlotChoices: item.descriptionSlotChoices,
      extractedGroups: item.extractedGroups,
    }));
    const result = inferCategory(category, inferInputs);
    summaries.push({ category, archetype: result.archetype, itemCount: result.itemCount, questions: result.questions });
  }

  return summaries.sort((a, b) => a.category.localeCompare(b.category));
}

export function compileMenu(
  items: CompileItem[],
  allQuestions: PendingQuestion[],
  compiledAt: string,
  acknowledgedDisplayOnly: boolean,
): { items: CompiledItem[]; categoryLexicon: LexiconTerm[]; invariants: MenuInvariantResult[] } {
  // Every item gets the FULL candidate list — findBlockingQuestion (inside
  // compileItem) does the scope matching per item (by item id, category, or
  // one of the item's own group/choice ids), so there is no need to
  // pre-partition questions by item here.
  const compiledItems = items.map(i => compileItem(i, allQuestions, compiledAt));
  const compiledMap = new Map(compiledItems.map(c => [c.item_id, c]));

  const categories = new Set(items.map(i => i.category).filter((c): c is string => !!c));
  const categoryLexicon = dedupeLexicon([...categories].flatMap(categoryLexiconTerms));

  const invariants = computeMenuInvariants(items, compiledMap, acknowledgedDisplayOnly);

  return { items: compiledItems, categoryLexicon, invariants };
}
