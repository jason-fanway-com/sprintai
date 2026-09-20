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

// 2026-09-19 PO dispatch (Commit 2, size-token normalization): a shop's raw
// import data can spell the identical physical size several different ways
// — 14", 14in, 14-inch all mean the same dimension. Canonicalizes any of
// the three SQUISHED (no-space) spellings, wherever they occur in a term,
// to one written form ("14 inch") before normaliseTerm's own punctuation
// strip runs. The already-spaced "14 inch" form is deliberately untouched
// (already tokenizes to "14"+"inch" as separate words, already matched by
// resolve-item.ts's own SIZE_DIGIT_TOKENS) — this only closes the gap for
// the concatenated/hyphenated spellings, and requires NO space between the
// digits and the unit word, so it can never misfire on unrelated text like
// "10 in a box" (a real, plausible shop description, not a size).
const SIZE_SUFFIX_RE = /(\d+)(?:"|-in(?:ch(?:es)?)?\b|in(?:ch(?:es)?)?\b)/gi;

export function canonicalizeSizeTokens(text: string): string {
  return text.replace(SIZE_SUFFIX_RE, (_m, digits: string) => `${digits} inch`);
}

// 2026-09-19 PO dispatch (Commit 2, apostrophe lexicon gap, real Vito's
// "Grandma's" pizza): normaliseTerm below always strips an apostrophe
// entirely ("Grandma's" -> "grandmas") — that has always been the ONLY
// form ever stored. resolve-item.ts's own normalize() turns a CUSTOMER's
// literal apostrophe into a SPACE instead ("grandma's" -> "grandma s", two
// words), which can never word-align against the single stored word
// "grandmas". Live: "grandma's medium 14"" and "medium grandma's" both came
// back completely unresolved; only "grandmas" (typed with no apostrophe at
// all) worked.
//
// General fix, general rule (not a one-off entry for Grandma's): whenever a
// raw string contains an apostrophe (straight ' or the curly ’ iOS
// autocorrect produces), emit the existing stripped form PLUS an as-typed
// and a curly-quote variant. Whichever way resolve-item.ts's own
// normalize() ends up splitting the STORED term at match time, it now does
// so identically to however it splits the customer's own apostrophe — same
// mechanism, applied to both sides, zero changes needed in resolve-item.ts
// itself. A term with no apostrophe at all is completely unaffected: the
// one row it always produced, unchanged.
const ANY_APOSTROPHE_RE = /['’]/;
const CURLY_APOSTROPHE = "’";

function normaliseTermKeepingApostrophe(raw: string, apostrophe: string): string {
  return canonicalizeSizeTokens(raw)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.,"()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/'/g, apostrophe);
}

export function normaliseTermVariants(raw: string): string[] {
  const stripped = normaliseTerm(raw);
  if (!ANY_APOSTROPHE_RE.test(raw)) return [stripped];
  const straight = normaliseTermKeepingApostrophe(raw, "'");
  const curly = normaliseTermKeepingApostrophe(raw, CURLY_APOSTROPHE);
  return [...new Set([stripped, straight, curly])];
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
  return canonicalizeSizeTokens(raw)
    .toLowerCase()
    .replace(/[.,'’"()]/g, "")
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
// Rule 2 helper — an item's BARE pre-qualification name ("Cheesesteak" for
// "Cheesesteak Sandwich"), or null if display_name carries no qualification
// to strip.
//
// 2026-09-18 PO dispatch: reads product_key's own "<category-slug>:
// <base-slug>" second segment rather than guessing from display_name by
// regex-stripping a trailing category noun. product_key's base segment is
// computed by normalize.ts straight from the raw import name (stripped only
// of a folded-size suffix) BEFORE either reason display_name can gain a
// category-noun suffix ever runs — a folded/sized product states its
// category noun unconditionally, regardless of any real collision (real
// Vito's shape: "14\"/16\"/Personal Chicken Parmesan Stromboli" all carry
// "Stromboli" even though nothing else in that category collided with
// them), and a plain cross-category collision on the PRE-qualification name
// triggers normalize.ts's own separate duplicate-name pass. Both leave the
// exact same footprint on product_key's base segment: it stays the bare
// dish name throughout, for every item genuinely descended from it,
// regardless of which of the two mechanisms (or both) fired.
//
// A regex guess against display_name's suffix (the prior approach) both
// false-positived on an item whose real name simply happens to end in a
// word that is also a category noun ("Zio's Salad" in category "Salads"
// looked "qualified" down to "Zio's" — which then collided with a genuine,
// unrelated entree actually named "Zio's" — even though "Zio's Salad" was
// never qualified from anything; that's just its name) and false-negatived
// on sized items (a leading size word like "14\"" was never stripped, so
// "14\" Chicken Parmesan Stromboli" never looked related to the unsized
// "Chicken Parmesan Entree"/"Chicken Parmesan Sandwich" it actually is).
// product_key's base segment has neither failure mode: it is exactly the
// dish's own pre-qualification identity, independent of guesswork on the
// qualified display_name text.
// Data fix (a), 2026-09-19: see this constant's use in itemLexiconTerms
// below. Same "^pizza" convention buildDerivedRows' own
// DERIVED_PIZZA_CATEGORY_RE already uses for the same reason — a shop's
// category is sometimes "Pizzas", "Pizza Specialty", etc., never assumed
// to be the exact literal string "Pizza".
const PIZZA_CATEGORY_RE = /^pizza/i;
const CHEESE_BASE_NAME_RE = /^cheese$/i;
const CHEESE_PIZZA_ALIASES = ["plain", "plain cheese", "regular"];

// Strips a trailing " - <size_label>" suffix from a raw item name the same
// way rawApostropheBareName below does, generalized to any base name (not
// just an apostrophe-carrying one) — falls back to the generic "trailing
// ' - anything'" strip when size_label isn't set or doesn't match, same
// shape derivedFamilyKey (this file's own pizza-topping-compose section)
// already uses for an unrelated purpose.
function baseNameBeforeSize(name: string, sizeLabel: string | null | undefined): string {
  if (sizeLabel) {
    const escaped = sizeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = name.match(new RegExp(`^(.*?)\\s*-\\s*${escaped}$`, "i"));
    if (m) return m[1].trim();
  }
  return name.replace(/\s*-\s*[^-]*$/, "").trim();
}

function bareProductName(item: CompileItem): string | null {
  if (!item.product_key) return null;
  const colonIdx = item.product_key.indexOf(":");
  const baseSlug = colonIdx === -1 ? item.product_key : item.product_key.slice(colonIdx + 1);
  if (!baseSlug) return null;
  const bare = normaliseTerm(baseSlug.replace(/-/g, " "));
  if (!bare) return null;
  const displayName = (item.display_name ?? item.name).trim();
  if (bare === normaliseTerm(displayName)) return null;
  return bare;
}

// 2026-09-19 PO dispatch (Commit 2, apostrophe lexicon gap): bareProductName
// above is always apostrophe-free — its input (product_key's own slug) has
// already had punctuation stripped upstream (normalize.ts's slugify), long
// before an apostrophe variant could ever be preserved. A sized row's raw
// `name` ("Grandma's - Medium (14\")") still carries the real apostrophe —
// this recovers the same bare base FROM that raw name (mirroring
// normalize.ts's own stripSizeSuffix shape: "<base> - <size_label>"), so an
// apostrophe-preserving bare term can be emitted for every member of a
// sized family, the same way bareName already is for the stripped form.
// Null whenever the item isn't sized this way, or its base has no
// apostrophe to preserve in the first place (the overwhelmingly common
// case — this only ever adds rows for a name shaped like Grandma's).
function rawApostropheBareName(item: CompileItem): string | null {
  if (!item.size_label) return null;
  const escaped = item.size_label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = item.name.match(new RegExp(`^(.*?)\\s*-\\s*${escaped}$`, "i"));
  if (!m) return null;
  const base = m[1].trim();
  return ANY_APOSTROPHE_RE.test(base) ? base : null;
}

// PO dispatch (2026-09-19, derived-rows-missing-category-terms P0): exported
// so compile-menu/index.ts can reconstruct a stated item's PRE-surface-form
// lexicon terms (rule 1/2/6 + the Cheese-pizza aliases) when it runs
// deriveLexiconSurfaceForms a second time over derived rows below — the
// exact same terms compileItem() already computes for the internal call
// inside compileMenu(), never a second, reinvented copy of this rule set.
export function itemLexiconTerms(item: CompileItem): LexiconTerm[] {
  const terms: LexiconTerm[] = [];
  const displayName = (item.display_name ?? item.name).trim();
  if (!displayName) return terms;

  // Rule 1: display_name itself. See normaliseTermVariants's own header —
  // this now emits an as-typed/curly-quote sibling alongside the stripped
  // form whenever displayName actually contains an apostrophe.
  for (const term of normaliseTermVariants(displayName)) {
    terms.push({ term, target_type: "item", target_id: item.id, provenance: "stated" });
  }

  // Rule 2: an item's bare pre-qualification name as a second term — if
  // display_name was qualified ("Cheesesteak Sandwich"), also index the
  // bare form ("Cheesesteak") so a customer who doesn't say the qualifier
  // still resolves.
  //
  // 2026-09-18 PO dispatch: always emitted for an UNSIZED item, even when it
  // collides with another item's bare name (real Vito's items literally
  // named "Cheesesteak Sandwich" / "Cheesesteak Panini" / "Cheesesteak
  // Roll" / "Cheesesteak Flatbread" all share the bare name "Cheesesteak").
  // The old version of this rule dropped a shared bare name for every
  // claimant instead of emitting it — which left the bare word "cheesesteak"
  // free for an unrelated derived candidate ("Garlic Cheesesteak" ->
  // trailing-run "cheesesteak") to claim uncontested, so a customer saying
  // just "cheesesteak" got Garlic every time, never any of the four real
  // Cheesesteak items. Emitting the term for every claimant instead makes
  // resolveItem's own longest-match tie correctly ambiguous among the real
  // candidates, so DECIDE narrows ("sandwich, panini, roll, or flatbread?")
  // instead of either dropping the word or handing it to the wrong item.
  // Same principle the 2026-09-15 dispatch already applied to derived
  // candidates ("burger", "fries") — no tiebreak, no ranking, every
  // claimant keeps its own row.
  //
  // 2026-09-18 PO decision (item 1, second pass — supersedes BOTH the
  // original ≥2-unsized-siblings rule AND this same day's own first
  // attempt at fixing it, which required ≥1 unsized sibling): "EVERY
  // size-folded family gets its bare base key as a term for every member,
  // namesake or not; with a namesake, the namesake is included too."
  //
  // The ≥1 version regressed 12 of Vito's 29 size-folded families that
  // have NO unsized sibling at all — calzone, alfredo, cheese (Pizza),
  // white (Pizza), and others are sized-only, so ≥1 could never be met,
  // and this file's OWN 2026-09-18 retirement fix (item 3, same day)
  // correctly retired the stale 'derived' rows that used to paper over
  // the gap — removing the safety net at the same moment the new rule
  // needed it. Net effect, live: "calzone"/"a 14-inch calzone" went from
  // "which size?" to "Sorry, I didn't catch that" (conversations 45b0f2e4,
  // 0a8b4ffa) — a real customer-facing regression, not just a count drop.
  //
  // The fix: drop the sibling-count condition entirely. A sized item
  // ALWAYS gets its own bare base-key term, unconditionally — an unsized
  // namesake (Bruschetta the Appetizer, Chicken Bacon Ranch the Flatbread)
  // needs no special-case inclusion because Rule 1 already emits that
  // exact term for it (its own display name already IS the bare form);
  // when no namesake exists (calzone, alfredo), the sized family still
  // gets the term because nothing here required one in the first place.
  // Bare "bruschetta"/"calzone" both resolve ambiguous either way;
  // resolve-item.ts's own narrowing (category/size in the span) picks the
  // one meant, same principle as item 1's first pass, just without the
  // now-removed gate that only worked for HALF of Vito's real families.
  const bareName = bareProductName(item);
  if (bareName) {
    terms.push({ term: bareName, target_type: "item", target_id: item.id, provenance: "stated" });
  }
  // See rawApostropheBareName's own header: bareName above is always
  // apostrophe-free by construction (product_key was already slugged
  // upstream) — this recovers an as-typed/curly-quote bare term straight
  // from the row's own raw name for a sized family whose base actually has
  // one ("Grandma's"), so every size sibling carries it and resolve-item.ts's
  // existing size-narrowing (already tied across the family) can pick the
  // right one the same way it already does for the size WORD.
  const rawBare = rawApostropheBareName(item);
  if (rawBare) {
    for (const term of normaliseTermVariants(rawBare)) {
      terms.push({ term, target_type: "item", target_id: item.id, provenance: "stated" });
    }
  }

  // Rule 2b (size-qualified bare name), 2026-09-19 PO dispatch (compiler
  // priority item 2, real live fixtures: "a personal calzone and some crazy
  // fries" and "a Medium Gyro with half sausage and half mushrooms" both
  // came back "Sorry, I didn't catch that" — the model's own proposed
  // item_span was exactly "personal calzone"/"Medium Gyro" and neither
  // string was ever a lexicon term at all, active or otherwise, under the
  // CURRENT rule set). Rule 2's bareName above always drops the size
  // entirely ("calzone", "gyro"); Rule 1's full display_name always carries
  // the shop's category-disambiguation suffix ("Personal Calzone Stromboli",
  // "Medium Gyro Pizza") that a customer never says. trailingWordRuns below
  // only ever drops LEADING words (keeps the trailing category noun) — it
  // has no path to the reverse ("drop the trailing category noun, keep the
  // leading size word"). No rule anywhere produced "<size> <bare name>"
  // before this. General, not item-specific: every sized item that has a
  // Rule-2 bare name gets one more stated term pairing its own size word
  // with that bare name — the size word via derivedSizeWord (the same
  // leading-word extraction buildDerivedRows already uses for pizza-family
  // derivation below), so "Medium (14\")" contributes "medium", not the
  // parenthetical dimension.
  if (bareName && item.size_label) {
    const sizeWord = derivedSizeWord(item.size_label);
    for (const term of normaliseTermVariants(`${sizeWord} ${bareName}`)) {
      terms.push({ term, target_type: "item", target_id: item.id, provenance: "stated" });
    }
  }

  // Data fix (a), 2026-09-19: "plain"/"plain cheese"/"regular" are standard
  // customer aliases for the Cheese pizza at ANY pizzeria, not a term any
  // shop's own menu data ever states literally — general rule, not
  // name-specific, so it fires for whichever row's own base name (before a
  // trailing " - <size>" suffix, when sized) is exactly "Cheese" within any
  // Pizza-category item, for every shop. A sized family gets the alias on
  // every size row, the same way bareName above does — resolve-item.ts's
  // existing size/category narrowing already knows how to pick the one
  // meant when a size word rides along ("plain large").
  if (item.category && PIZZA_CATEGORY_RE.test(item.category)) {
    const baseName = baseNameBeforeSize(item.name, item.size_label);
    if (CHEESE_BASE_NAME_RE.test(baseName)) {
      for (const alias of CHEESE_PIZZA_ALIASES) {
        terms.push({ term: normaliseTerm(alias), target_type: "item", target_id: item.id, provenance: "derived" });
      }
    }
  }

  // Rule 6: "X or Y" slot choices → their own names, as choice targets.
  for (const g of item.groups) {
    if (g.kind !== "slot") continue;
    for (const c of g.choices) {
      const cName = choiceDisplay(c).trim();
      if (!cName) continue;
      for (const term of normaliseTermVariants(cName)) {
        terms.push({ term, target_type: "choice", target_id: c.id, provenance: "stated" });
      }
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
// §6.2 step 4/5 partial — mechanically DERIVED surface-form variants of
// each item's own lexicon term: space-collapsed ("cheese burger" ->
// "cheeseburger"), plural ("burger" -> "burgers"), plural of the collapsed
// form ("cheese burger" -> "cheeseburgers"), and trailing word-runs / head
// nouns ("10 pieces wings boneless" -> "wings boneless", "boneless"). Real
// 2026-09-14 bug: Vito's had "cheese burger" ($8.49) and "bacon cheeseburger"
// ($10.99) but no term for the bare word "cheeseburger" a customer actually
// types, so it fell through to whichever OTHER term happened to contain that
// substring and resolved to the wrong, dearer item on 11/17 live calls. Per
// the PO's ruling, this is compiler-generated data anticipating real
// customer phrasing, not a one-off fix for this one item — so it runs for
// every active item term, every menu, every shop.
//
// Collision handling (2026-09-15 PO dispatch, superseding the same-day
// drop-on-collision rule this comment used to describe): a candidate that
// collides with an EXISTING rule 1/2 item term is still excluded outright —
// a derived guess never shadows a real, stated item name for the same (or a
// more specific) target. But a candidate that collides with ONE OR MORE
// OTHER DERIVED candidates (this same pass, proposed by a different item) —
// OR with a rule 3 category term — OR with a rule 6 choice term — is no
// longer dropped for every claimant. It is KEPT, once per claimant, so
// resolve-item.ts's ambiguous-match path (two-or-more targets tie at the
// longest match → ASK naming the candidates) has data to route on. Real
// Vito's incident: dropping `burger` (7 items) and `fries` (10 items)
// entirely left resolveItem with nothing to return but `unresolved` for
// those words, which DECIDE turns into a flat "didn't catch that" dead end
// — even though the ambiguous-routing ASK was already implemented and
// correct, just unreachable with an empty lexicon. Real Zio's incident
// (same PO dispatch): category "Pizza" carries stated rule-3 terms
// "pizza"/"pizzas", and that alone silently withheld the item-level term
// "pizza" for every pizza item menu-wide — but resolve-item.ts never reads
// category-type rows, so "pizza" typed at a pizzeria hit the same dead end.
// A category term is coarser than an item term, never a genuine claimant
// for the same customer word, so it must not block a derived item
// candidate the way a real item term does; the category row and the new
// item row(s) coexist. Extended 2026-09-15 (choice-collision dispatch, same
// day): Zio's/NJB/Vito's each have dozens of head nouns suppressed this
// same way by a rule 6 choice term ("pasta", "bagel", "rye"/"wheat"/
// "white") — resolve-item.ts also never reads choice-type rows for item
// resolution, and turn-engine-runner.ts's ANSWER step (the `slot` case)
// resolves an open choice question directly against the raw customer text
// BEFORE PROPOSE/DECIDE ever consult the lexicon, so a choice term keeping
// its normal priority is structurally guaranteed regardless of whether the
// derived item candidate also exists — the lexicon is only reachable once
// ANSWER has already failed to resolve the turn. So a rule 6 choice term,
// like a rule 3 category term, must not block a derived item candidate;
// the choice row and the new item row(s) coexist too. Jason's standing
// direction: when the bot is unsure, it asks, naming the candidates — it
// never silently drops or guesses. No tiebreak, no ranking: every claimant
// keeps its own row.
//
// Two levels, one candidate pool per level, same uniqueness rule throughout:
//   level 1 — collapse, plural-of-stated, plural-of-collapsed, computed
//     straight off each item's own stated (rule 1/2) term.
//   level 2 — trailing word-runs (every proper suffix), computed off BOTH
//     the stated terms AND whatever level 1 just kept — so "cheese burgers"
//     (a level-1 plural) contributes the head noun "burgers", not just
//     "cheese burger" contributing "burger". Level 1's survivors become part
//     of "the existing lexicon" before level 2's gate runs, so a level-2
//     candidate that collides with a level-1 survivor is dropped too.
// ============================================================
function collapseSpaces(term: string): string {
  return term.replace(/\s+/g, "");
}

// Whole-term pluralization — deliberately separate from pluralizeWord
// (single-word, "+s only", used by categoryLexiconTerms for the category
// noun and whose existing behaviour must not change here). Returns null
// when the term already ends in "s": an already-plural source term
// ("curly fries", "meatballs") must never be pluralized — not generated
// then dropped by collision, but never generated at all, so a naive
// "meatballses"/"sausages"/"spinaches" never becomes prompt noise.
function pluralizeSurfaceForm(term: string): string | null {
  if (/s$/i.test(term)) return null;
  if (/(?:x|z|ch|sh)$/i.test(term)) return `${term}es`;
  return `${term}s`;
}

interface SurfaceFormCandidate {
  term: string;
  itemId: string;
}

// One candidate pool, one exclusion gate (never a uniqueness gate): propose
// every (term, itemId) pair `generate` produces off `source`, skip anything
// already in `excluded` (a real stated rule 1/2 item term — the caller's
// `existing` set deliberately omits rule 3 category terms and rule 6
// choice terms, neither of which may block a derived item candidate), then
// emit one row
// per DISTINCT (term, itemId) pair that survives — regardless of how many
// other item ids also claim the same term. A term claimed by N items yields
// N rows, not zero and not one. Order of `source`/`out` doesn't affect which
// candidates survive — every caller's final result still goes through
// dedupeLexicon before being merged into an item's lexicon_terms, so output
// order is deterministic regardless.
function gateSurfaceFormCandidates(
  source: SurfaceFormCandidate[],
  excluded: Set<string>,
  generate: (term: string) => string[],
): SurfaceFormCandidate[] {
  const claimants = new Map<string, Set<string>>(); // term -> distinct item ids proposing it

  for (const { term, itemId } of source) {
    for (const candidate of generate(term)) {
      if (excluded.has(candidate)) continue;
      const set = claimants.get(candidate) ?? new Set<string>();
      set.add(itemId);
      claimants.set(candidate, set);
    }
  }

  const out: SurfaceFormCandidate[] = [];
  for (const [term, itemIds] of claimants) {
    for (const itemId of itemIds) out.push({ term, itemId });
  }
  return out;
}

// A trailing standalone count ("chicken fingers 3") stripped back to the
// dish name ("chicken fingers"). The source is a portion count the importer
// carried as "Chicken Fingers (3)" — normaliseTerm's punctuation strip
// removes the parens but leaves the digit as a bare trailing word, so
// without this the compiler treats "3" as part of the dish's name and a
// customer who says "chicken fingers" (no count) never matches (2026-09-18
// PO dispatch).
function stripTrailingCount(term: string): string[] {
  const m = term.match(/^(.+)\s\d+$/);
  return m ? [m[1]] : [];
}

// Level 1: collapse, plural-of-stated, plural-of-collapsed, strip-trailing-
// count — all off the term as stated, one gate.
function level1SurfaceForms(term: string): string[] {
  const forms: string[] = [];
  const collapsed = collapseSpaces(term);
  if (collapsed !== term) {
    forms.push(collapsed);
    const pluralCollapsed = pluralizeSurfaceForm(collapsed);
    if (pluralCollapsed && pluralCollapsed !== collapsed) forms.push(pluralCollapsed);
  }
  const plural = pluralizeSurfaceForm(term);
  if (plural && plural !== term) forms.push(plural);
  forms.push(...stripTrailingCount(term));
  return forms;
}

// Level 2: every proper trailing word-run (head noun) of a multi-word term —
// "10 pieces wings boneless" -> "pieces wings boneless", "wings boneless",
// "boneless". A single-word term has no proper trailing run shorter than
// itself, so it contributes nothing.
//
// Round 2 addendum item A, 2026-09-19 (live, Vito's): a bare-digit run
// ("3") is excluded. stripTrailingCount above already turns "Chicken
// Fingers (3)" -> "chicken fingers 3" -> "chicken fingers", the correct
// bare-name term — but the SAME "chicken fingers 3" string also feeds this
// function (via statedItemTerms in deriveLexiconSurfaceForms), whose plain
// trailing-run logic has no idea "3" came from a portion count rather than
// a real word, and happily emits "3" as its own one-word term. Every item
// on the shop carrying a "(3)" portion suffix then claims that same bare
// digit ("3 small pizzas" live-matched Chicken Fingers (3), Nonas
// Meatballs (3) and Pierogies (3) at once) — and a customer's bare
// quantity ("3", "5", "6"...) is never a dish name. A run that is nothing
// but digits is dropped outright, regardless of position; a run that
// merely CONTAINS a digit alongside real words ("wings 6") is unaffected.
function trailingWordRuns(term: string): string[] {
  const words = term.split(" ");
  const runs: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const run = words.slice(i).join(" ");
    if (/^\d+$/.test(run)) continue;
    runs.push(run);
  }
  return runs;
}

// 2026-09-18 PO decision (item 2, real Vito's "sauce"/"onions"/"fries"
// collisions): a generic head noun after "with"/"w/"/"and"/"on"/"in" is
// never what a dish IS — it's what the dish comes with. "Pasta with Clam
// Sauce" trailing-runs down to the bare word "sauce" today, with no
// competing claimant, so it silently won a customer's "with ranch and BBQ
// sauce" and added a $21.95 pasta (conv 32, 15:34 run). Cutting the term
// at the FIRST such preposition — before it ever reaches level 1/2
// derivation below — means "sauce"/"clam sauce" are never candidates at
// all, for this or any other item shaped the same way ("Sauteed Pierogies
// with onions" no longer derives "onions"; "Chicken Fingers (5) with
// french fries" no longer derives "fries", which today competes with the
// shop's own real fries items). Only affects DERIVATION input — the
// item's own Rule 1 (full stated name) and Rule 2 (bare form) terms are
// built straight from the untouched original name, never this truncated
// copy. `\s+` on both sides requires the preposition to be its own word,
// so "Onion Rings" (no leading space before "on") is never affected.
const PREPOSITIONAL_TAIL_RE = /\s+(?:with|w\/|and|on|in)\s+.*$/i;

function stripPrepositionalTail(term: string): string {
  return term.replace(PREPOSITIONAL_TAIL_RE, "");
}

// PO dispatch (2026-09-19, derived-rows-missing-category-terms P0): the
// input is structural (`{ item_id, lexicon_terms }`), not literally
// `CompiledItem[]` — so this same function, unchanged, can run a SECOND time
// in compile-menu/index.ts over derived rows (shaped the same way once their
// real persisted id is known — see resolveDerivedLexiconTerms) without a
// second, derived-only copy of this rule. compileMenu()'s own internal call
// below is completely unaffected (CompiledItem already has exactly these two
// fields); the second call site is index.ts's own concern, not this file's.
export function deriveLexiconSurfaceForms(compiledItems: Array<{ item_id: string; lexicon_terms: LexiconTerm[] }>): LexiconTerm[] {
  // The shop's lexicon as it exists before this pass, restricted to rule 1/2
  // ITEM terms only. A candidate matching one of these already "exists as a
  // term" (own item) or would create a cross-target ambiguity against a
  // real item target — either way, don't add it. Rule 3 category terms and
  // rule 6 choice terms are deliberately NOT in this set (2026-09-15 PO
  // dispatch, category first then choice same day): both are coarser/
  // structurally-prioritized targets, never a genuine claimant for the same
  // customer word the way another item's own name is, so neither may block
  // a derived item candidate — see the collision-handling comment above for
  // the live Zio's 'pizza' incident and the choice-collision extension.
  //
  // 2026-09-18 PO dispatch: since itemLexiconTerms now always emits an
  // item's Rule-2 stripped/qualified bare name (never suppressed for
  // collisions — see that function), every qualified item's bare name is
  // already in `compiledItems`' own lexicon_terms by the time this runs, so
  // it lands in `existing` for free. That's what keeps a derived candidate
  // ("cheesesteak" off the trailing run of "garlic cheesesteak") from ever
  // shadowing the real bare name of the items it was qualified away from
  // ("Cheesesteak Sandwich"/"Panini"/"Roll") — the exclusion set here is
  // stated terms PLUS every item's own unqualified bare name, and both are
  // now the same set.
  const existing = new Set<string>();
  // Every item's own real stated term, itemId included and UNTRUNCATED —
  // used below (freeze-queue item 2) to recover a trailing portion count a
  // prepositional-tail cut would otherwise carry off with it.
  const rawStatedTerms: SurfaceFormCandidate[] = [];
  for (const c of compiledItems) {
    for (const t of c.lexicon_terms) {
      if (t.target_type !== "item") continue;
      existing.add(t.term);
      rawStatedTerms.push({ term: t.term, itemId: t.target_id });
    }
  }

  // stripPrepositionalTail: derivation input only (this array feeds level
  // 1/2 below) — `existing` above already captured every item's real
  // stated terms in full, untruncated form.
  const statedItemTerms: SurfaceFormCandidate[] = rawStatedTerms.map(({ term, itemId }) => ({
    term: stripPrepositionalTail(term),
    itemId,
  }));

  const level1 = gateSurfaceFormCandidates(statedItemTerms, existing, level1SurfaceForms);

  const existingAfterLevel1 = new Set(existing);
  for (const c of level1) existingAfterLevel1.add(c.term);

  const level2Source = [...statedItemTerms, ...level1];
  const level2 = gateSurfaceFormCandidates(level2Source, existingAfterLevel1, trailingWordRuns);

  // Freeze-queue item 2, 2026-09-19 (real Vito's "Sauteed Pierogies With
  // Onions (5)"): level1SurfaceForms' own stripTrailingCount already strips
  // a trailing portion count for a name shaped "<dish> (<count>)" — but it
  // only ever sees `statedItemTerms`, which has ALREADY had a prepositional
  // tail cut off by stripPrepositionalTail above. For a name shaped "<dish>
  // with <tail> (<count>)" the count digit sits AFTER that tail, so the cut
  // removes the tail AND the digit together ("sauteed pierogies with onions
  // 5" -> "sauteed pierogies"), and stripTrailingCount never sees a trailing
  // digit to strip — the count-stripped, preposition-INTACT bare name
  // ("sauteed pierogies with onions") was never derived at all. Live: a
  // customer asking for it by name twice got charged for "Pierogies (3)"
  // instead (sim #21, run 20260919-094006).
  //
  // Computed straight off each item's untouched, pre-tail-strip stated term
  // (`rawStatedTerms`), and only when a prepositional tail actually exists
  // to strip — when it doesn't, this is the exact same string
  // level1SurfaceForms already derives via its own stripTrailingCount call
  // above, so skipping it here avoids proposing the identical candidate
  // twice. Same exclusion-only gate as level 1 (a real stated item term
  // blocks it; another derived candidate for a different item does not —
  // both are kept, ambiguous, no tiebreak, same as "chicken fingers (5)" vs
  // "(3)" today).
  const prepositionalCountStripped: SurfaceFormCandidate[] = [];
  for (const { term, itemId } of rawStatedTerms) {
    if (stripPrepositionalTail(term) === term) continue;
    for (const stripped of stripTrailingCount(term)) {
      prepositionalCountStripped.push({ term: stripped, itemId });
    }
  }
  const countStrippedBareNames = gateSurfaceFormCandidates(prepositionalCountStripped, existing, t => [t]);

  return [...level1, ...level2, ...countStrippedBareNames].map(({ term, itemId }) => ({
    term,
    target_type: "item" as const,
    target_id: itemId,
    provenance: "derived" as const,
  }));
}

// ============================================================
// Category-qualified fallback term (freeze-queue item 6, part A, 2026-09-19
// PO dispatch): an item whose stated name has NO term anywhere that
// resolves uniquely to it — even after every pass above — gets one more
// term: its own stated name plus its category noun ("bruschetta" +
// "Appetizers" -> "bruschetta appetizer").
//
// Real Vito's shape this covers: an unsized item (Bruschetta the Appetizer,
// House the Salad) whose bare display name is identical to a SIZED pizza
// family's own bare product-key term in an unrelated category — and per
// itemLexiconTerms' Rule 2 comment above, a sized family emits that bare
// term unconditionally, on every size row, regardless of collisions. The
// unsized item's own Rule 1 term (its full display name, which for these
// items IS the bare word) then has 4 owners — itself plus every pizza
// size — and every derived surface form of that same word inherits the
// identical collision, so invariant 4 ("every orderable item has ≥1 term
// resolving uniquely to it") fails with no rescue anywhere upstream.
//
// Deliberately narrow: only fires for an item that has already exhausted
// every earlier pass and still has zero unique terms, and only qualifies a
// STATED (rule 1/2) term — never a derived surface form — so the new term
// reads like a real customer phrase ("bruschetta appetizer", "house
// salad"), not a truncated fragment ("ranch flatbread"). Never touches an
// item that already resolves fine, and never removes the plain colliding
// term for anyone — a customer who says just "bruschetta" is still
// ambiguous across the pizza sizes and the appetizer, exactly as before;
// this only adds the ONE additional phrase that lets a customer who does
// say "appetizer"/"salad" resolve unambiguously.
function deriveCategoryQualifiedFallbackTerms(
  items: CompileItem[],
  compiledItems: CompiledItem[],
): LexiconTerm[] {
  const categoryById = new Map(items.map(i => [i.id, i.category]));

  const termOwners = new Map<string, Set<string>>();
  for (const c of compiledItems) {
    for (const t of c.lexicon_terms) {
      if (t.target_type !== "item") continue;
      const owners = termOwners.get(t.term) ?? new Set<string>();
      owners.add(t.target_id);
      termOwners.set(t.term, owners);
    }
  }
  const existingTerms = new Set(termOwners.keys());

  const out: LexiconTerm[] = [];
  for (const c of compiledItems) {
    if (c.bot_state !== "orderable") continue;
    const hasUniqueTerm = c.lexicon_terms.some(
      t => t.target_type === "item" && termOwners.get(t.term)?.size === 1,
    );
    if (hasUniqueTerm) continue;

    const category = categoryById.get(c.item_id);
    if (!category) continue;
    const noun = categoryNoun(category);
    if (!noun) continue;

    for (const t of c.lexicon_terms) {
      if (t.target_type !== "item" || t.provenance !== "stated") continue;
      if ((termOwners.get(t.term)?.size ?? 0) <= 1) continue;
      const qualified = `${t.term} ${noun}`;
      if (existingTerms.has(qualified)) continue; // never shadow a real, distinct term
      out.push({ term: qualified, target_type: "item", target_id: c.item_id, provenance: "derived" });
    }
  }
  return out;
}

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
): CompiledItem {
  const { bot_state, bot_state_reason } = computeBotState(item, questions);
  // A non-orderable row (display_only, blocked, stale, ...) is not a
  // sellable item — it must never contribute a lexicon term a customer's
  // wording can resolve to, or the resolver offers it as a candidate for
  // something that can't actually be ordered (real incident: Vito's
  // "Ranch [Pizza Finish]", bot_state display_only, price $0.00, tied a
  // customer's "ranch" against the real "Grilled Chicken Bacon & Ranch"
  // wrap with no way to break the tie toward something orderable).
  const lexiconTerms = bot_state === "orderable" ? itemLexiconTerms(item) : [];
  return {
    item_id: item.id,
    bot_state,
    bot_state_reason,
    ask_plan: buildAskPlan(item, compiledAt),
    lexicon_terms: lexiconTerms,
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

// PO dispatch (2026-09-19, dangling-lexicon-terms P0, required fix item 4):
// a hard, compile-time invariant that fails LOUDLY the moment any active
// item-type lexicon term's target_id doesn't correspond to a real menu_items
// id for this shop — the exact defect class resolveDerivedLexiconTerms above
// closes for derived rows specifically, but this invariant is deliberately
// general (any provenance, any source) so the same failure mode can never
// hide again the way it did here for months. Not part of
// computeMenuInvariants itself: that function only ever sees the regular
// (non-derived) items array, while this needs the FULL set of terms this
// compile is about to write (regular + category + derived, post-rewrite) and
// the full set of real ids they're allowed to point at — both of which only
// exist in the caller (compile-menu/index.ts) after derived rows are
// upserted. Same MenuInvariantResult shape as invariants 1-8 so the caller
// appends this as invariant 9 in the same list, not a separate side-channel.
export function computeDanglingLexiconTermInvariant(
  terms: LexiconTerm[],
  validItemIds: Set<string>,
): MenuInvariantResult {
  const dangling = terms.filter(t => t.target_type === "item" && !validItemIds.has(t.target_id));
  const count = dangling.length;
  return {
    invariant: 9,
    description: `${count} dangling lexicon term${count === 1 ? "" : "s"} — every active item-type lexicon term's target_id must resolve to a real menu_items id for this shop`,
    pass: count === 0,
    violations: dangling.map(t => `"${t.term}" -> ${t.target_id}`),
  };
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

// A group's slot_key is only populated by archetypes.ts's bind_to_list_named
// classification, which runs against extractedGroups during initial menu
// import. A group the OWNER creates later (admin dashboard "add a modifier
// group") never goes through that classifier, so slot_key stays null even
// when the group is plainly named "Toppings" — this is what left Vito's
// pizza toppings group (`slot_key: null`, `name: "Toppings"`, owner_edited)
// invisible to D1 (2026-09-19 PO dispatch). Fall back to the SAME name
// pattern archetypes.ts already uses for this slot (`/topping/i`) whenever
// slot_key hasn't been classified, rather than requiring a recompile of the
// whole classification pipeline just to unblock derived rows.
const DERIVED_TOPPINGS_NAME_RE = /topping/i;

function isToppingsGroup(g: CompileGroup): boolean {
  if (g.kind !== "modifier") return false;
  if (g.slot_key === "toppings") return true;
  return g.slot_key == null && DERIVED_TOPPINGS_NAME_RE.test(g.name);
}

// Compile-time single-topping derivation is deliberately narrow: a real
// toppings group pairs every topping with BOTH a "(Half pizza)" and a
// "(Whole pizza)" choice, both marked composable (Vito's 2026-09-19: all 32
// choices across 16 toppings have not_composable=false) — deriving one row
// per composable choice would spawn a "Bacon (Half pizza) Pizza" beside
// "Bacon (Whole pizza) Pizza", and a full derived pizza for every one of the
// 16 toppings (Steak, Gyro Meat, Roasted Peppers, ...), not just the ones a
// customer actually orders by name. Per the PO dispatch, only this fixed,
// code-defined list of commonly-ordered single toppings gets a derived
// whole-pizza row; every other topping combination stays reachable only
// through the base pizza + topping modifier flow. NOT per-shop configurable.
const STANDARD_SINGLE_TOPPING_ALIASES: Record<string, string> = {
  "pepperoni": "pepperoni",
  "pepperonis": "pepperoni",
  "sausage": "sausage",
  "sausages": "sausage",
  "mushroom": "mushroom",
  "mushrooms": "mushroom",
  "onion": "onion",
  "onions": "onion",
  "green pepper": "green pepper",
  "green peppers": "green pepper",
  "extra cheese": "extra cheese",
};
const STANDARD_SINGLE_TOPPING_ORDER = ["pepperoni", "sausage", "mushroom", "onion", "green pepper", "extra cheese"];

// Strips a trailing "(Whole pizza)" / "(Half pizza)" portion qualifier, case-
// and spacing-insensitive, from a topping choice's display text.
const TOPPING_PORTION_RE = /\s*\(\s*(whole|half)(?:\s*pizza)?\s*\)\s*$/i;

function toppingPortion(display: string): "whole" | "half" | null {
  const m = display.match(TOPPING_PORTION_RE);
  return m ? (m[1].toLowerCase() as "whole" | "half") : null;
}

// "Pepperoni (Whole pizza)" -> "Pepperoni"; a choice with no portion
// qualifier at all (shops that don't split half/whole) passes through
// unchanged.
function toppingCleanDisplay(display: string): string {
  return display.replace(TOPPING_PORTION_RE, "").trim();
}

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

// 2026-09-19 PO dispatch (D1 audit): buildDerivedRows silently returning zero
// rows for a shop that plainly HAS a base-pizza-plus-toppings shape (Vito's,
// before the isToppingsGroup slot_key fallback above) went unnoticed until
// someone happened to ask "why didn't derived rows happen?" — nothing in the
// compile report distinguished that from "this shop genuinely sells no
// pizza" (Not Just Bagels, 0 rows, correctly — it has no Pizza-category items
// at all). `diagnostics`, when passed, is filled with a human-readable
// reason naming the actual rejecting condition and the family/item involved,
// but ONLY when zero rows resulted AND there was a real pizza-category,
// base-name-matching item to explain — never fired for a shop with no pizza
// category at all, so this is a genuine anomaly signal, not noise on every
// non-pizza shop. Left null on any run that produces at least one row.
export interface DerivedRowsDiagnostic {
  warning: string | null;
}

export function buildDerivedRows(
  items: CompileItem[],
  compiled: Map<string, CompiledItem>,
  derivedOverrides: Map<string, Record<string, unknown>>,
  compiledAt: string,
  opts?: { basePattern?: RegExp; capPerSize?: number; diagnostics?: DerivedRowsDiagnostic },
): DerivedMenuRow[] {
  const baseRe = opts?.basePattern ?? DERIVED_BASE_PIZZA_RE;
  const cap = opts?.capPerSize ?? DERIVED_DEFAULT_CAP;
  const warn = (msg: string) => { if (opts?.diagnostics) opts.diagnostics.warning = msg; };

  // Step 1: Find pizza base candidates — active, pizza category, name matches
  // base regex, has at least one toppings modifier group with choices, and
  // is itself orderable. Staged (not one combined filter) so a zero-row
  // outcome can name the EXACT stage nothing survived, instead of just "no
  // candidates" — see DerivedRowsDiagnostic's own header.
  const pizzaCategoryItems = items.filter(item =>
    item.active && !!item.category && DERIVED_PIZZA_CATEGORY_RE.test(item.category));
  if (pizzaCategoryItems.length === 0) return []; // shop has no pizza category at all — not an anomaly, nothing to warn about

  const baseNameItems = pizzaCategoryItems.filter(item => baseRe.test(item.name));
  if (baseNameItems.length === 0) {
    warn(`${pizzaCategoryItems.length} active Pizza-category item(s) exist (e.g. "${pizzaCategoryItems[0].name}"), but none match the base-pizza name pattern (cheese/plain/neapolitan/regular/traditional) — no base family to derive toppings onto`);
    return [];
  }

  const withToppingsGroup = baseNameItems.filter(item =>
    item.groups.some(g => isToppingsGroup(g) && g.choices.length > 0));
  if (withToppingsGroup.length === 0) {
    warn(`${baseNameItems.length} base-pizza-named item(s) exist (e.g. "${baseNameItems[0].name}"), but none has a toppings/modifier group buildDerivedRows recognizes (isToppingsGroup: slot_key === "toppings", or an unclassified group whose name matches /topping/i) — check the group's slot_key and name on "${baseNameItems[0].name}"`);
    return [];
  }

  const candidates = withToppingsGroup.filter(item => compiled.get(item.id)?.bot_state === "orderable");
  if (candidates.length === 0) {
    warn(`${withToppingsGroup.length} base-pizza item(s) with a real toppings group exist (e.g. "${withToppingsGroup[0].name}"), but none is bot_state "orderable" (blocked by an unanswered owner question, or display_only) — derived rows inherit the base item's own orderable state`);
    return [];
  }

  // Step 2: Group candidates by family key (name stripped of size suffix).
  const families = new Map<string, CompileItem[]>();
  for (const c of candidates) {
    const key = derivedFamilyKey(c.name);
    const list = families.get(key) ?? [];
    list.push(c);
    families.set(key, list);
  }

  // Step 3: Pick the family with the most size variants. When multiple families
  // tie on count, break ties by name priority (plain > cheese > neapolitan >
  // regular > traditional), then by cheapest item. Genuine tie after all
  // tiebreakers → skip (missing beats wrong — wrong base is worse than no rows).
  let maxCount = 0;
  for (const members of families.values()) {
    if (members.length > maxCount) maxCount = members.length;
  }
  let tiedFamilies = [...families.values()].filter(m => m.length === maxCount);

  if (tiedFamilies.length > 1) {
    const PRIORITY = [/\bplain\b/i, /\bcheese\b/i, /\bneapolitan\b/i, /\bregular\b/i, /\btraditional\b/i];
    const familyPriority = (members: CompileItem[]) => {
      const key = derivedFamilyKey(members[0].name);
      for (let i = 0; i < PRIORITY.length; i++) {
        if (PRIORITY[i].test(key)) return i;
      }
      return PRIORITY.length;
    };
    const minPri = Math.min(...tiedFamilies.map(familyPriority));
    tiedFamilies = tiedFamilies.filter(m => familyPriority(m) === minPri);
  }

  if (tiedFamilies.length > 1) {
    const minPrice = (members: CompileItem[]) =>
      Math.min(...members.map(m => m.price_cents ?? Infinity));
    const lowestPrice = Math.min(...tiedFamilies.map(minPrice));
    tiedFamilies = tiedFamilies.filter(m => minPrice(m) === lowestPrice);
  }

  if (tiedFamilies.length !== 1) {
    warn(`${tiedFamilies.length} base-pizza families tied on size-variant count, name priority, AND lowest price (e.g. "${tiedFamilies[0][0].name}" vs "${tiedFamilies[1][0].name}") — genuinely ambiguous which is the real base family, so none was picked (missing beats wrong)`);
    return [];
  }
  const bestFamily = tiedFamilies[0];

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
    const toppingsGroup = baseItem.groups.find(isToppingsGroup);
    if (!toppingsGroup) continue;

    // Pick, per standard topping, the single composable choice to derive
    // from: the "(Whole pizza)" variant when the shop distinguishes half vs
    // whole, else a choice with no portion qualifier at all. A "(Half
    // pizza)"-only choice never backs a whole-pizza derived row — see
    // STANDARD_SINGLE_TOPPING_ALIASES above for why this list is short.
    const selected = new Map<string, CompileChoice>();
    for (const choice of toppingsGroup.choices) {
      if (choice.not_composable) continue;
      const rawDisplay = (choice.display_name?.trim() || choice.name).trim();
      const canonical = STANDARD_SINGLE_TOPPING_ALIASES[toppingCleanDisplay(rawDisplay).toLowerCase()];
      if (!canonical) continue;
      const portion = toppingPortion(rawDisplay);
      if (portion === "half") continue;
      const existing = selected.get(canonical);
      if (!existing) {
        selected.set(canonical, choice);
        continue;
      }
      const existingPortion = toppingPortion((existing.display_name?.trim() || existing.name).trim());
      if (existingPortion !== "whole" && portion === "whole") selected.set(canonical, choice);
    }
    const composableChoices = STANDARD_SINGLE_TOPPING_ORDER
      .filter(k => selected.has(k))
      .map(k => selected.get(k)!)
      .slice(0, cap);

    for (const choice of composableChoices) {
      const rawDisplay = (choice.display_name?.trim() || choice.name).trim();
      const choiceDisplay = toppingCleanDisplay(rawDisplay);
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

      // Lexicon: three entries per derived row in ITEM position — "{choice}
      // pizza", "{choice} pie", and the bare choice term — plus a fourth,
      // "{size} {choice} pizza", when this row has a size. The bare and
      // unqualified terms tie across every size of the same topping (menu_
      // items.size_label is intentionally left null for derived rows, see
      // compile-menu/index.ts), so a customer who names the size up front
      // ("the large pepperoni pizza") needs a term that resolves straight to
      // THIS size's entity_key without depending on that narrowing signal.
      // A display_only derived row (isInferred above) is not sellable —
      // same rule compileItem() applies to stated rows: no lexicon term is
      // ever generated for a non-orderable row, so it can't surface as a
      // resolver candidate.
      const choiceLower = choiceDisplay.toLowerCase();
      const lexiconTerms = isInferred ? [] : dedupeLexicon([
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
        ...(sizeWord
          ? [{
              term: normaliseTerm(`${sizeWord.toLowerCase()} ${choiceLower} pizza`),
              target_type: "item" as LexiconTargetType,
              target_id: entityKey,
              provenance,
            }]
          : []),
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

  // A real base family with a real toppings group was found and survived
  // every stage above, yet still produced zero rows — the only remaining
  // cause is that none of the toppings group's own choice names match the
  // fixed STANDARD_SINGLE_TOPPING_ALIASES list at all (a shop whose
  // vocabulary is entirely different toppings, or names them in a way
  // toppingCleanDisplay/the alias map doesn't recognize).
  if (rows.length === 0) {
    const sampleGroup = bestFamily[0].groups.find(isToppingsGroup);
    const sampleChoiceNames = (sampleGroup?.choices ?? [])
      .map(c => toppingCleanDisplay((c.display_name?.trim() || c.name).trim()))
      .slice(0, 8);
    warn(`base family "${bestFamily[0].name}" and its toppings group "${sampleGroup?.name ?? "?"}" were found, but none of its ${sampleGroup?.choices.length ?? 0} choice name(s) (e.g. ${sampleChoiceNames.map(n => `"${n}"`).join(", ")}) match the fixed standard-topping list (pepperoni/sausage/mushroom/onion/green pepper/extra cheese)`);
  }

  return rows;
}

// PO dispatch (2026-09-19, dangling-lexicon-terms P0): a DerivedMenuRow's own
// lexicon_terms (above) carry target_id: entity_key — a synthetic string like
// "derived:pizza|cheese|large (16\")#pepperoni#large 16 inch", never a real
// menu_items.id. That's correct for buildDerivedRows itself (pure, no DB
// access, doesn't know the row's eventual id) but entity_key must NEVER reach
// the lexicon table as target_id: resolveItem finds the term and returns
// that entity_key as menu_item_id, and every caller then looks it up against
// the real menu (real UUIDs) and finds nothing — "a feature that produces
// rows and writes pointers that nothing can follow" (PO's framing). Every
// derived row this project ever compiled did exactly this — the terms
// existed, the rows existed, but nothing could walk from one to the other.
//
// The caller (compile-menu/index.ts) upserts each DerivedMenuRow into
// menu_items FIRST, learns its real persisted id (existing row's id on
// update, the inserted row's returned id on insert), and passes that back
// here as idByEntityKey. A row whose insert/update failed carries no id in
// that map and is dropped entirely here — writing a lexicon term for a row
// that isn't actually in menu_items would just be a new flavor of the same
// dangling-pointer bug this closes.
export function resolveDerivedLexiconTerms(
  derivedRows: DerivedMenuRow[],
  idByEntityKey: Map<string, string>,
): LexiconTerm[] {
  return derivedRows.flatMap(row => {
    const realId = idByEntityKey.get(row.entity_key);
    if (!realId) return [];
    return row.lexicon_terms.map(t => ({ ...t, target_id: realId }));
  });
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

  // Additive surface-form variants (space-collapsed + plural) — computed
  // once the base rule 1/2/3/6 terms above are final, then merged back into
  // each owning item's own lexicon_terms (mutating the CompiledItem objects
  // compiledMap already references, so invariant 4 below sees them too).
  const surfaceForms = deriveLexiconSurfaceForms(compiledItems);
  if (surfaceForms.length > 0) {
    const byItem = new Map<string, LexiconTerm[]>();
    for (const t of surfaceForms) {
      const list = byItem.get(t.target_id) ?? [];
      list.push(t);
      byItem.set(t.target_id, list);
    }
    for (const c of compiledItems) {
      const extra = byItem.get(c.item_id);
      if (extra) c.lexicon_terms = dedupeLexicon([...c.lexicon_terms, ...extra]);
    }
  }

  // Category-qualified fallback — computed after surface forms are merged
  // in, so it only fires for an item genuinely still without a unique term
  // (see deriveCategoryQualifiedFallbackTerms' own header).
  const categoryFallbackTerms = deriveCategoryQualifiedFallbackTerms(items, compiledItems);
  if (categoryFallbackTerms.length > 0) {
    const byItem = new Map<string, LexiconTerm[]>();
    for (const t of categoryFallbackTerms) {
      const list = byItem.get(t.target_id) ?? [];
      list.push(t);
      byItem.set(t.target_id, list);
    }
    for (const c of compiledItems) {
      const extra = byItem.get(c.item_id);
      if (extra) c.lexicon_terms = dedupeLexicon([...c.lexicon_terms, ...extra]);
    }
  }

  const invariants = computeMenuInvariants(items, compiledMap, acknowledgedDisplayOnly);

  return { items: compiledItems, categoryLexicon, invariants };
}
