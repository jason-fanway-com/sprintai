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

import { inferCategory, buildCategoryCandidateGroups, type InferItemInput, type ExtractedGroup, type OwnerQuestionDraft, type ArchetypeKey, type CategoryPriceItem } from "./archetypes.ts";

export type Provenance = "stated" | "inferred" | "owner_confirmed" | "learned" | "defaulted" | "derived";
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
  // When true, this choice is excluded from compile-time derived row generation
  // (e.g. "Extra Cheese", "Half and Half"). Defaults to false when absent.
  not_composable?: boolean;
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
  // §5.2's own exclusions list (archetypes.ts's inferCategory, one entry
  // per raw item.name that already resolved to not_applicable/default/
  // stated/advisory for THIS question's specific slot). Populated from the
  // owner_questions row's `proposal.exclusions` column. Required by
  // findBlockingQuestion below — without it, a single item.9 stated-
  // provenance gap ("items_affected": 1 on the DB row) blanket-blocks every
  // OTHER item in the category too, since a category-scoped question
  // otherwise has no way to say which items it actually still applies to
  // (2026-09-07 regression: Zio's Burgers/temp and Wraps/bread both dropped
  // to items_affected:1 once the stated-provenance gate landed, but 17
  // items stayed bot_state='blocked' menu-wide because this field didn't
  // exist yet to let the 5-of-6 Burgers and 9-of-10 Wraps items opt out).
  exclusions: string[];
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
  // Optional — present when the compiler reads them from the DB row. Used by
  // buildDerivedRows to construct stable entity keys that survive re-imports.
  import_key?: string | null;
  size_label?: string | null;
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

// Every group produces a step: slots are always asked/applied in some form,
// and modifiers — regardless of offer_once vs on_request — must be present
// so ask-plan-engine.ts's resolveAskPlan can reactively match a modifier the
// customer names in the same message as the item (bug 4, 2026-09-07: "large
// buffalo chicken pizza with pepperoni" silently dropped the topping because
// an unset ask_mode defaulted to on_request, which used to be excluded from
// ask_plan.steps entirely — not just unasked-proactively, but UNMATCHABLE,
// since resolveAskPlan only ever walks askPlan.steps). ask_mode still governs
// whether a modifier is ever proactively offered (offer_once, not yet built
// — see ask-plan-engine.ts's header) vs strictly reactive (on_request); both
// are equally eligible to be matched when mentioned, per §2.2's own
// "reactive-only" wording for on_request — this just makes that wording true.
export function buildAskPlan(item: CompileItem, compiledAt: string): AskPlan {
  const orderedGroups = sortGroupsCanonical(item.groups);
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
    if (q.scope_type === "category") return item.category != null && q.scope_id === item.category && !q.exclusions.includes(item.name);
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
// Rule 2 helper — the stripped/qualified alias this item's display name
// would produce ("Pepperoni Stromboli" in category Stromboli -> "pepperoni"),
// or null if there's nothing to strip. Shared between the menu-wide
// collision pre-passes in compileMenu (primaryTermOwners, rule2TermOwners)
// and the actual per-item emission below so "what Rule 2 computes" can never
// drift between the two call sites.
function rule2CandidateTerm(item: CompileItem): string | null {
  const displayName = (item.display_name ?? item.name).trim();
  if (!displayName || !item.category) return null;
  const noun = categoryNoun(item.category);
  if (!noun) return null;
  const suffixRe = new RegExp(`\\s+${noun}s?$`, "i");
  if (!suffixRe.test(displayName)) return null;
  const stripped = displayName.replace(suffixRe, "").trim();
  if (!stripped || stripped.toLowerCase() === displayName.toLowerCase()) return null;
  return normaliseTerm(stripped);
}

function itemLexiconTerms(
  item: CompileItem,
  primaryTermOwners?: Map<string, string>,
  rule2TermOwners?: Map<string, Set<string>>,
): LexiconTerm[] {
  const terms: LexiconTerm[] = [];
  const displayName = (item.display_name ?? item.name).trim();
  if (!displayName) return terms;

  // Rule 1: display_name itself.
  terms.push({ term: normaliseTerm(displayName), target_type: "item", target_id: item.id, provenance: "stated" });

  // Rule 2: stripped/qualified item name as a second term — if the
  // display_name was qualified with its trailing category noun ("Chicken
  // Caesar Salad"), also index the unqualified form ("Chicken Caesar") so a
  // customer who doesn't say the category word still resolves.
  //
  // Guard A: skip this alias when the stripped form is already another
  // item's OWN primary name (e.g. "Zio's Salad" stripping to "Zio's" would
  // otherwise collide with a real, distinct entree literally named "Zio's";
  // "Shrimp Parmigiana Sub" stripping to "Shrimp Parmigiana" collides with
  // the real Seafood entree of that name). A convenience alias must never
  // shadow a genuine, differently-owned item — real data surfaced 4 such
  // cases.
  //
  // Guard B (2026-09-08, PO dispatch): skip this alias when TWO OR MORE
  // DIFFERENT items independently strip to the SAME term via this same Rule
  // 2 — e.g. Zio's "Pepperoni Stromboli" and "Pepperoni Calzone" both strip
  // their category noun to "pepperoni", and nothing in the upsert
  // (`onConflict: menu_id,term,target_type,target_id`) dedupes two DIFFERENT
  // target_ids under the identical term — so `lexicon` ends up with two
  // active `term='pepperoni', target_type='item'` rows pointing at two
  // different products, a coin-flip for whichever reader picks one. Guard A
  // alone doesn't catch this because neither alias collides with a Rule-1
  // primary name — they only collide with EACH OTHER. Same principle as
  // Guard A, applied symmetrically: an ambiguous alias must not be written
  // for ANY of its claimants, not just skipped for the loser of an arbitrary
  // order.
  if (item.category) {
    const strippedTerm = rule2CandidateTerm(item);
    if (strippedTerm) {
      const owner = primaryTermOwners?.get(strippedTerm);
      const claimants = rule2TermOwners?.get(strippedTerm);
      const ambiguousAcrossItems = !!claimants && claimants.size > 1;
      if ((!owner || owner === item.id) && !ambiguousAcrossItems) {
        terms.push({ term: strippedTerm, target_type: "item", target_id: item.id, provenance: "stated" });
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
export function compileItem(
  item: CompileItem,
  questions: PendingQuestion[],
  compiledAt: string,
  primaryTermOwners?: Map<string, string>,
  rule2TermOwners?: Map<string, Set<string>>,
): CompiledItem {
  const { bot_state, bot_state_reason } = computeBotState(item, questions);
  return {
    item_id: item.id,
    bot_state,
    bot_state_reason,
    ask_plan: buildAskPlan(item, compiledAt),
    lexicon_terms: itemLexiconTerms(item, primaryTermOwners, rule2TermOwners),
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
  // 2026-09-08, real NJB two-choice-clause fix — see InferItemInput's own
  // field of the same name in archetypes.ts for the full rationale.
  sideSlotChoices: string[] | null;
  priceCents: number;
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

  // §5's "shared list" concept, recognized post-hoc: any category in this
  // menu can itself be the choice list for another category's slot (e.g.
  // NJB's "Bagels" category IS the bagel_type list for "Bagel With ..."
  // items) — real shared-list structure the importer already produced,
  // just not shaped as an option_group. See archetypes.ts's
  // buildCategoryCandidateGroups for the price-delta rule.
  const priceItemsByCategory = new Map<string, CategoryPriceItem[]>();
  for (const [category, categoryItems] of byCategory) {
    priceItemsByCategory.set(category, categoryItems.map(i => ({ name: i.name, priceCents: i.priceCents })));
  }
  const categoryCandidates = buildCategoryCandidateGroups(priceItemsByCategory);

  const summaries: CategoryQuestionSummary[] = [];
  for (const [category, categoryItems] of byCategory) {
    const otherCategoryCandidates = [...categoryCandidates.values()].filter(g => g.name !== category);
    const inferInputs: InferItemInput[] = categoryItems.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      productKey: item.productKey,
      siblingCount: item.productKey ? productKeyCounts.get(item.productKey) ?? 1 : 1,
      nameSlotChoices: item.nameSlotChoices,
      descriptionSlotChoices: item.descriptionSlotChoices,
      sideSlotChoices: item.sideSlotChoices,
      extractedGroups: item.extractedGroups,
      categoryCandidateGroups: otherCategoryCandidates,
    }));
    const result = inferCategory(category, inferInputs);
    summaries.push({ category, archetype: result.archetype, itemCount: result.itemCount, questions: result.questions });
  }

  return summaries.sort((a, b) => a.category.localeCompare(b.category));
}

// ============================================================
// Refresh — keeps existing `owner_questions` rows in sync with a fresh
// infer computation (2026-09-08, real incident: NJB's normalize.ts parser
// fix changed what buildOwnerQuestionSummaries produces, but the existing
// insert-if-not-exists step can only ADD a brand-new (scope_type, scope_id,
// slot_key) key — it has no way to notice that a key's items_affected
// shrank, or that a key stopped being produced at all, so 4 rows sat stale
// in front of a real restaurant owner until someone caught it by hand).
// Pure, like everything else in this file — writes nothing; the caller
// (a script or index.ts) executes the returned update/delete list.
//
// THE ONE INVARIANT THIS MUST NEVER BREAK: a row whose status isn't
// 'pending' (answered, dismissed, asked, expired) carries a REAL owner
// action and is never touched by either path, full stop — regardless of
// what a fresh computation says about its key. This is what makes refresh
// safe to run repeatedly and safe to run after an owner has started
// answering: it can only ever change a question nobody has acted on yet.
// ============================================================

export interface ExistingOwnerQuestionRow {
  id: string;
  scope_type: QuestionScopeType;
  scope_id: string;
  slot_key: string | null;
  status: QuestionStatus;
  question_text: string;
  items_affected: number;
  priority: number;
  blocking: boolean;
  proposal: OwnerQuestionDraft["proposal"] | null;
}

export interface OwnerQuestionUpdate {
  id: string;
  question_text: string;
  items_affected: number;
  priority: number;
  blocking: boolean;
  proposal: OwnerQuestionDraft["proposal"];
}

export interface OwnerQuestionRefreshPlan {
  toUpdate: OwnerQuestionUpdate[];
  toDelete: { id: string }[];
}

function ownerQuestionKey(scope_type: string, scope_id: string, slot_key: string | null): string {
  return `${scope_type}|${scope_id}|${slot_key ?? ""}`;
}

// A plain JSON.stringify comparison on `proposal` is order-sensitive on
// object keys, but a Postgres JSONB column does NOT preserve the original
// JS key insertion order on round-trip (real bug, caught dry-running this
// against live NJB data: every row came back "changed" even when
// semantically identical, because the DB returned `{source, choices,
// exclusions}` for a value inserted as `{choices, source, exclusions}`).
// Object keys are sorted recursively before comparing; array ELEMENT order
// still matters (exclusions/choices are meaningfully ordered lists, not
// sets) — only key order within an object is order-independent.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Same key shape buildOwnerQuestionSummaries/the insert step already use
// (scope_type, scope_id, slot_key) — a fresh draft and an existing row
// "are the same question" iff this key matches, regardless of anything
// else about their content.
export function planOwnerQuestionsRefresh(
  existingRows: ExistingOwnerQuestionRow[],
  freshDrafts: OwnerQuestionDraft[],
): OwnerQuestionRefreshPlan {
  const freshByKey = new Map(freshDrafts.map(d => [ownerQuestionKey(d.scope_type, d.scope_id, d.slot_key), d]));
  const toUpdate: OwnerQuestionUpdate[] = [];
  const toDelete: { id: string }[] = [];

  for (const row of existingRows) {
    // Case 3 (the invariant): anything not still 'pending' is untouched by
    // either path below, unconditionally — checked first, before the key is
    // even looked up, so there's no path through this function that reads a
    // non-pending row's content and acts on it.
    if (row.status !== "pending") continue;

    const fresh = freshByKey.get(ownerQuestionKey(row.scope_type, row.scope_id, row.slot_key));

    if (!fresh) {
      // Case 2: this key no longer exists in a fresh computation at all
      // (e.g. the source text now answers it, or it's no longer kitchen/
      // price-critical) — remove it rather than leave an unnecessary ask.
      toDelete.push({ id: row.id });
      continue;
    }

    // Case 1: still a real question at this key, but its content may have
    // drifted (items_affected shrank/grew, the rendered question text or
    // proposal changed, priority/blocking recomputed differently). Only
    // queued when something actually differs, so a no-op refresh run
    // produces an empty plan rather than rewriting every row every time.
    const changed = row.question_text !== fresh.question_text
      || row.items_affected !== fresh.items_affected
      || row.priority !== fresh.priority
      || row.blocking !== fresh.blocking
      || canonicalJson(row.proposal) !== canonicalJson(fresh.proposal);
    if (changed) {
      toUpdate.push({
        id: row.id,
        question_text: fresh.question_text,
        items_affected: fresh.items_affected,
        priority: fresh.priority,
        blocking: fresh.blocking,
        proposal: fresh.proposal,
      });
    }
  }

  return { toUpdate, toDelete };
}

// ============================================================
// D1 — Compile-time derived rows (§11 item 4, stream D1).
//
// Emits one DerivedMenuRow per (base pizza × composable topping choice),
// for each distinct size variant. Pure, deterministic — same contract as
// compileItem/compileMenu above: no I/O, no randomness, identical input
// produces identical output.
//
// Base-pizza selection: picks the dominant "family" (name-prefix group with
// the most size variants). Ties return an empty list — missing beats wrong.
// Within the chosen family, each distinct size_label maps to the lowest-
// priced item (in case two items share a size label, which is rare).
//
// Owner overrides: a derivedOverrides Map<entityKey, Record<field,value>>
// is pre-computed by the caller (index.ts) from menu_overrides rows whose
// entity_key starts with "derived:". When an override exists for a row's
// entity_key, provenance is flipped to "owner_confirmed" and derived_from
// is preserved unchanged (the override changes what the kitchen sees, not
// how the ticket resolves to base + topping).
// ============================================================

export interface DerivedFrom {
  base_item_id: string;
  choice_ids: string[]; // Phase 0: single-element (one topping)
}

export interface DerivedMenuRow {
  entity_key: string;     // "derived:<base_import_key>#<choice_key>#<size_key>"
  name: string;           // "{Choice} Pizza - {size_label}"
  display_name: string;   // "{size_word} {choice} pizza"
  category: string | null;
  price_cents: number;    // base + delta
  product_key: string;    // "pizza:{choice_key}"
  is_derived: true;
  derived_from: DerivedFrom;
  provenance: "derived" | "owner_confirmed";
  active: boolean;
  bot_state: BotState;
  bot_state_reason: string | null;
  ask_plan: AskPlan;
  lexicon_terms: LexiconTerm[];
}

// Same base-pizza regexp as pizza-topping-compose.ts's BASE_PIZZA_NAME_RE,
// extended to also match "neapolitan", "regular", and "traditional" —
// handles shops that name their plain pizza by style rather than the word
// "cheese". Word-boundary (\b) so "cheeseburger" or "extra cheese" don't
// match on a substring.
const DERIVED_BASE_PIZZA_RE = /\b(cheese|plain|neapolitan|regular|traditional)\b/i;
const DERIVED_PIZZA_CATEGORY_RE = /^pizza/i;
const DERIVED_DEFAULT_CAP = 40;

// Size-word regexp used to extract the leading size from a size_label like
// "Small 14''" → "Small". Falls back to the full label when no known word
// leads it.
const DERIVED_SIZE_WORD_RE =
  /^(Small|Medium|Large|Family|Personal|Jumbo|Mini|XL|X-Large|Regular)\b/i;

function derivedSizeWord(sizeLabel: string): string {
  const m = sizeLabel.match(DERIVED_SIZE_WORD_RE);
  return m ? m[1] : sizeLabel;
}

// Strip the trailing " - {anything}" size suffix from a name to get the
// family key: "Neapolitan Cheese Pizza - Large 18''" → "neapolitan cheese pizza".
function derivedFamilyKey(name: string): string {
  return name.replace(/\s*-\s*[^-]*$/, "").trim().toLowerCase();
}

export function buildDerivedRows(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
  derivedOverrides: Map<string, Record<string, unknown>>,
  compiledAt: string,
  opts?: { basePattern?: RegExp; capPerSize?: number },
): DerivedMenuRow[] {
  const baseRe = opts?.basePattern ?? DERIVED_BASE_PIZZA_RE;
  const cap = opts?.capPerSize ?? DERIVED_DEFAULT_CAP;

  // Step 1: Find pizza base candidates — active, pizza category, name matches
  // base regex, has at least one toppings modifier group with choices.
  const candidates = items.filter(item => {
    if (!item.active) return false;
    if (!item.category || !DERIVED_PIZZA_CATEGORY_RE.test(item.category)) return false;
    if (!baseRe.test(item.name)) return false;
    if (!item.groups.some(g => g.kind === "modifier" && g.slot_key === "toppings" && g.choices.length > 0)) return false;
    // Orderable check — derived rows inherit the base item's state
    if (compiled.get(item.id)?.bot_state !== "orderable") return false;
    return true;
  });

  if (candidates.length === 0) return [];

  // Step 2: Group candidates by family key (name stripped of size suffix).
  const families = new Map<string, CompileItem[]>();
  for (const c of candidates) {
    const key = derivedFamilyKey(c.name);
    const list = families.get(key) ?? [];
    list.push(c);
    families.set(key, list);
  }

  // Step 3: Pick the family with the most size variants. Genuine tie → skip
  // (missing beats wrong — a wrong base is worse than no derived rows).
  let bestFamily: CompileItem[] | null = null;
  let bestCount = -1;
  let tied = false;
  for (const members of families.values()) {
    if (members.length > bestCount) {
      bestFamily = members;
      bestCount = members.length;
      tied = false;
    } else if (members.length === bestCount) {
      tied = true;
    }
  }
  if (tied || !bestFamily) return [];

  // Step 4: Group family members by their size_label (null → '__no_size__').
  // Lowest-priced item wins when multiple items share the same size label.
  const bySize = new Map<string, CompileItem>();
  for (const member of bestFamily) {
    const sizeKey = member.size_label ? normaliseTerm(member.size_label) : "__no_size__";
    const existing = bySize.get(sizeKey);
    if (!existing || (member.price_cents ?? Infinity) < (existing.price_cents ?? Infinity)) {
      bySize.set(sizeKey, member);
    }
  }

  // Step 5: For each (base item, composable choice), emit a DerivedMenuRow.
  const rows: DerivedMenuRow[] = [];

  for (const [sizeKey, baseItem] of bySize) {
    const toppingsGroup = baseItem.groups.find(
      g => g.kind === "modifier" && g.slot_key === "toppings",
    );
    if (!toppingsGroup) continue;

    // Filter composable choices, then apply cap.
    const composableChoices = toppingsGroup.choices
      .filter(c => !c.not_composable)
      .slice(0, cap);

    for (const choice of composableChoices) {
      const choiceDisplay = (choice.display_name?.trim() || choice.name).trim();
      const choiceKey = normaliseTerm(choiceDisplay);
      const baseKey = baseItem.import_key ?? `id:${baseItem.id}`;
      const entityKey = `derived:${baseKey}#${choiceKey}#${sizeKey}`;

      // Name / display_name
      const sizeLabel = sizeKey === "__no_size__" ? null : baseItem.size_label;
      const name = sizeLabel
        ? `${choiceDisplay} Pizza - ${sizeLabel}`
        : `${choiceDisplay} Pizza`;
      const sizeWord = sizeLabel ? derivedSizeWord(sizeLabel) : null;
      const displayName = sizeWord
        ? `${sizeWord} ${choiceDisplay} Pizza`
        : `${choiceDisplay} Pizza`;

      // Price: base + topping delta
      const priceCents = (baseItem.price_cents ?? 0) + choice.price_cents;

      // Override lookup (last-write-wins already applied by the caller)
      const overrideFields = derivedOverrides.get(entityKey);
      const provenance: "derived" | "owner_confirmed" = overrideFields
        ? "owner_confirmed"
        : "derived";
      const finalDisplayName =
        (overrideFields?.display_name as string | undefined) ?? displayName;
      const finalPriceCents =
        (overrideFields?.price_cents as number | undefined) ?? priceCents;

      // Bot state: never orderable if the topping choice itself is inferred —
      // the kitchen can't reliably price a topping we invented.
      const isInferred = choice.provenance === "inferred";
      const botState: BotState = isInferred ? "display_only" : "orderable";
      const botStateReason = isInferred
        ? "composing topping choice has inferred provenance"
        : null;

      // Ask plan: no interactive steps — base + topping are both pre-baked.
      // ticket_template renders the BASE item's name + topping so the kitchen
      // ticket reads the canonical item name, not the derived label.
      const baseName = baseItem.name; // raw source name (kitchen-facing)
      const askPlan: AskPlan = {
        compiled_at: compiledAt,
        compiler_version: COMPILER_VERSION,
        display_name: finalDisplayName,
        base_price_cents: finalPriceCents,
        steps: [],
        recap_template: "{qty} {display_name}",
        ticket_template: `${baseName}\n  + ${choiceDisplay} x{qty}`,
      };

      // Lexicon: three entries per derived row, all in ITEM position.
      // "{choice} pizza", "{choice} pie", and the bare choice term.
      const choiceLower = choiceDisplay.toLowerCase();
      const lexiconTerms = dedupeLexicon([
        {
          term: normaliseTerm(`${choiceLower} pizza`),
          target_type: "item" as LexiconTargetType,
          target_id: entityKey,
          provenance,
        },
        {
          term: normaliseTerm(`${choiceLower} pie`),
          target_type: "item" as LexiconTargetType,
          target_id: entityKey,
          provenance,
        },
        {
          term: normaliseTerm(choiceLower),
          target_type: "item" as LexiconTargetType,
          target_id: entityKey,
          provenance,
        },
      ]);

      rows.push({
        entity_key: entityKey,
        name,
        display_name: finalDisplayName,
        category: baseItem.category,
        price_cents: finalPriceCents,
        product_key: `pizza:${choiceKey}`,
        is_derived: true,
        derived_from: { base_item_id: baseItem.id, choice_ids: [choice.id] },
        provenance,
        active: !isInferred,
        bot_state: botState,
        bot_state_reason: botStateReason,
        ask_plan: askPlan,
        lexicon_terms: lexiconTerms,
      });
    }
  }

  return rows;
}

export function compileMenu(
  items: CompileItem[],
  allQuestions: PendingQuestion[],
  compiledAt: string,
  acknowledgedDisplayOnly: boolean,
): { items: CompiledItem[]; categoryLexicon: LexiconTerm[]; invariants: MenuInvariantResult[] } {
  // Menu-wide map of each item's own Rule-1 (primary, unqualified) term to
  // its id — lets itemLexiconTerms suppress a Rule-2 alias that would
  // otherwise collide with a different item's real name (see itemLexiconTerms).
  const primaryTermOwners = new Map<string, string>();
  for (const i of items) {
    const displayName = (i.display_name ?? i.name).trim();
    if (displayName) primaryTermOwners.set(normaliseTerm(displayName), i.id);
  }

  // Menu-wide map of each Rule-2 stripped alias to every DISTINCT item id
  // that would independently produce it (e.g. both "Pepperoni Stromboli" and
  // "Pepperoni Calzone" strip to "pepperoni") — lets itemLexiconTerms drop an
  // alias claimed by more than one item instead of silently writing two
  // active rows under the same term (see itemLexiconTerms Guard B).
  const rule2TermOwners = new Map<string, Set<string>>();
  for (const i of items) {
    const t = rule2CandidateTerm(i);
    if (!t) continue;
    if (!rule2TermOwners.has(t)) rule2TermOwners.set(t, new Set());
    rule2TermOwners.get(t)!.add(i.id);
  }

  // Every item gets the FULL candidate list — findBlockingQuestion (inside
  // compileItem) does the scope matching per item (by item id, category, or
  // one of the item's own group/choice ids), so there is no need to
  // pre-partition questions by item here.
  const compiledItems = items.map(i => compileItem(i, allQuestions, compiledAt, primaryTermOwners, rule2TermOwners));
  const compiledMap = new Map(compiledItems.map(c => [c.item_id, c]));

  const categories = new Set(items.map(i => i.category).filter((c): c is string => !!c));
  const categoryLexicon = dedupeLexicon([...categories].flatMap(categoryLexiconTerms));

  const invariants = computeMenuInvariants(items, compiledMap, acknowledgedDisplayOnly);

  return { items: compiledItems, categoryLexicon, invariants };
}
