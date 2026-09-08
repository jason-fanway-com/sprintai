// Phase 0 item 3 (docs/specs/2026-09-07-conversation-ready-menu-design.md,
// §3 stages 4-5 "Classify"/"Infer", §4.2 "The archetype library, in code",
// Appendix A "Archetype library v0", §11 item 3). Versioned data + pure
// functions, no LLM, no I/O — same testable-without-a-DB pattern as
// normalize.ts.
//
// THE INVARIANT THIS FILE MUST NEVER VIOLATE (§4.3 rule 1, P2 in §1):
// inference writes `owner_questions` rows, never a live `option_groups` /
// `option_choices` row. Nothing in this module touches those tables, and
// `inferCategory` below returns plain data — the caller (a later edge
// function) is the one that INSERTs into owner_questions. There is no
// function here, anywhere, that could be mistaken for writing a live group.
//
// SHAPE OF THE PROBLEM, per item per slot (§4.1, §5.1, Appendix A notes):
//   1. applies_when(item) false                -> not_applicable, no question
//   2. a real extracted list matches            -> stated (bind)     — no question
//   3. the item's own "X or Y" name-slot        -> stated (name)     — no question
//      (from normalize.ts) fits this slot
//   4. the item's own "choice of A or B"        -> stated (description) — no question
//      description-slot fits this slot
//   5. default_from_name matches the item name  -> default            — no question,
//                                                                        recorded as an
//                                                                        exclusion
//   5.5. item already has ANY platform-sourced -> advisory (no question, no
//        (provenance='stated') option_group,     owner tap) — see
//        just not one THIS slot bound to         hasStatedProvenanceGroup below
//   5.5b. item has real group(s), all of them   -> advisory (same as 5.5) —
//        a required singleton (1 choice) —        see hasOnlySingletonGroups
//        regardless of provenance tag              below
//   6. universal_choices exists                 -> proposed  (needs owner tap)
//   7. kitchen_critical || price_critical        -> needs_question (needs owner tap)
//   8. none of the above                         -> skip (Appendix A's "no slot, no
//                                                    question" case — pasta type on a
//                                                    place that doesn't say)
// Steps 6/7 are the only ones that ever contribute to an owner_questions row, one row
// per (category, slot_key), scoped per §5.1 "category first, item second". Step 5.5
// (added after real Zio's Slice data landed) exists because a platform feed like Slice
// publishes every required/optional group the restaurant actually offers online — if an
// item already has one or more such groups and this slot still isn't bound to one of
// them, archetype inference has no business inventing a question on top of live,
// restaurant-sourced data. That's guessing over a real answer, not caution (P3 "missing
// beats wrong" is about gaps in the data, not about second-guessing data that exists).
// Items with NO stated-provenance groups at all (no platform source, e.g. Not Just
// Bagels) are completely unaffected — steps 6/7 still apply to them exactly as before.
//
// `size` and `count` are special-cased outside this ladder entirely (Appendix B: "size
// stated by rows; toppings quoted" — no question ever). They're resolved from sibling
// rows sharing a product_key (already computed by normalize.ts), because a folded
// product's size rows already ARE the priced choices; asking would be redundant.

export const ARCHETYPE_LIBRARY_VERSION = 1;

export type ArchetypeKey =
  | "pizza" | "burger" | "steak" | "sandwich" | "salad" | "wings"
  | "pasta" | "bagel" | "eggs" | "platter" | "beverage" | "other";

export interface SlotRule {
  slot_key: string;
  kitchen_critical: boolean;
  price_critical: boolean;
  universal_choices?: string[];
  bind_to_list_named?: RegExp;
  applies_when?: (item: InferItemInput) => boolean;
  default_from_name?: RegExp;
  owner_question: string;
  order: number;
}

export interface ModifierRule {
  slot_key: string;
  bind_to_list_named?: RegExp;
  ask_mode: "offer_once" | "on_request";
  applies_when?: (item: InferItemInput) => boolean;
}

export interface Archetype {
  key: ArchetypeKey;
  match: RegExp[];
  slots: SlotRule[];
  modifiers: ModifierRule[];
}

// ---- Input shape the infer step consumes -----------------------------------
// One row per menu item, assembled by the caller from menu_items +
// option_groups (extractedGroups) + normalize.ts's output (product_key /
// siblingCount / nameSlotChoices / descriptionSlotChoices). Pure data, no DB
// handle — that's what makes classify/infer unit-testable without Supabase.

export interface ExtractedGroup {
  name: string;
  required: boolean;
  choiceNames: string[];
  // Parallel to choiceNames. cents, relative to that group's own baseline
  // (its most common price) — null/absent where the source doesn't state a
  // different price for that choice. Never invented: only populated when a
  // choice's own price_cents genuinely differs from the group's baseline.
  choicePriceDeltaCents?: (number | null)[];
  // Set only for category-derived candidates (buildCategoryCandidateGroups)
  // — the ArchetypeKey that category's OWN name/items classify to. Guards
  // findBoundGroup against a category matching a slot's bind pattern by
  // incidental substring only (e.g. Vito's "Stromboli Rolls" — a pizza-
  // family category — matching the sandwich archetype's /bread|roll/i
  // purely because "Rolls" contains "roll"). See findBoundGroup.
  sourceArchetype?: ArchetypeKey;
  // The option_groups row's own provenance column, when this ExtractedGroup
  // was built from a real per-item group (undefined for category-derived
  // candidates, which were never a real row). Used only by
  // hasStatedProvenanceGroup's step-5.5 gate below — never interpreted any
  // other way here (see file header: this module writes nothing).
  provenance?: string;
}

export interface InferItemInput {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  productKey: string | null;
  siblingCount: number;
  nameSlotChoices: string[] | null;
  descriptionSlotChoices: string[] | null;
  extractedGroups: ExtractedGroup[];
  // §5's "shared list" concept, recognized post-hoc: other categories in the
  // SAME menu, each turned into a candidate ExtractedGroup (category name as
  // group name, its items as choices). Lets bind_to_list_named match a real
  // category-as-choice-list (e.g. a "Bagels" category binding the bagel_type
  // slot on "Bagel With ..." items) the same way it already matches a real
  // per-item option_group. Optional/absent = no candidates (existing callers
  // and fixtures that don't build this keep working unchanged).
  categoryCandidateGroups?: ExtractedGroup[];
}

export interface CategoryPriceItem {
  name: string;
  priceCents: number;
}

// Turns every category in a menu into a candidate ExtractedGroup for
// categoryCandidateGroups above — one shared implementation so every caller
// (compile-menu.ts, the item-9 report, this file's own live tests) derives
// the same "category as shared list" shape and price-delta rule instead of
// three drifting reimplementations. Price delta is each item's own
// price_cents against the category's baseline (its most common price,
// smallest price wins ties) — real, sourced data; a choice priced at the
// baseline carries no delta at all rather than an invented 0.
// A category priced by a different unit than a single order-choice (found
// on NJB's real "Homemade Cream Cheese Spreads": every item name ends
// "(per pound)", priced $10.95-$13.95 as a standalone retail product) must
// never contribute a price delta — those absolute prices have nothing to
// do with what a flavor choice costs added to a $4-5 bagel sandwich. The
// choice NAMES from such a category are still real and usable; only the
// price-delta computation is suppressed.
const BULK_UNIT_PATTERN = /\(\s*per\s+(pound|lb\.?|dozen|doz\.?)\s*\)/i;

export function buildCategoryCandidateGroups(
  itemsByCategory: Map<string, CategoryPriceItem[]>,
): Map<string, ExtractedGroup> {
  const result = new Map<string, ExtractedGroup>();
  for (const [category, items] of itemsByCategory) {
    if (items.length === 0) continue;
    const isBulkUnitPriced = items.filter(it => BULK_UNIT_PATTERN.test(it.name)).length / items.length >= 0.5;
    const freq = new Map<number, number>();
    for (const it of items) freq.set(it.priceCents, (freq.get(it.priceCents) ?? 0) + 1);
    const maxCount = Math.max(...freq.values());
    const baseline = Math.min(...[...freq.entries()].filter(([, c]) => c === maxCount).map(([price]) => price));
    result.set(category, {
      name: category,
      required: false,
      choiceNames: items.map(it => it.name),
      ...(isBulkUnitPriced ? {} : {
        choicePriceDeltaCents: items.map(it => it.priceCents === baseline ? null : it.priceCents - baseline),
      }),
      sourceArchetype: classifyCategory(category, items.map(it => it.name)),
    });
  }
  return result;
}

// Slots whose "stated" source is the normalizer's per-item "X or Y" / "choice
// of" parse rather than a real extracted shared list. Engine-level wiring
// (§3 stage 4-5 notes: sandwich "protein from 'X or Y'", platter/eggs "side
// ... stated from 'choice of' parse", eggs "toast"), not archetype data —
// keeps SlotRule's shape exactly as specified in §4.2.
const NAME_SOURCED_SLOTS = new Set(["protein"]);
// "bread" added 2026-09-08: normalize.ts now extracts EVERY "choice of ..."
// clause in a description (not just the first) and lets a caller pick the
// bare-enumeration one via pickDescriptionSlot — closing the real NJB gap
// where "choice of bagel, bread, or roll" was stated in the source text but
// never reached this slot because bread wasn't in this set at all.
const DESCRIPTION_SOURCED_SLOTS = new Set(["side", "toast", "bread"]);

// Slots resolved from sibling product rows, never from a question (see file
// header). Universal across every archetype that declares one.
const SIBLING_SOURCED_SLOTS = new Set(["size", "count"]);

const TEMP_CHOICES = ["Rare", "Medium rare", "Medium", "Medium well", "Well done"];
const EGG_STYLE_CHOICES = ["Scrambled", "Over easy", "Over medium", "Over hard", "Sunny side up", "Poached"];

function notChickenVeggieTurkey(item: InferItemInput): boolean {
  return !/\b(chicken|veggie|vegetarian|turkey)\b/i.test(item.name);
}

// ============================================================
// ARCHETYPE LIBRARY v0 (Appendix A) — 11 named archetypes + the bundled
// side/dessert/kids/other catch-all as `other`. Order matters: it is the
// order classification tries `match` against, and (within an item) the
// canonical ask order for slots is separately given by `order`.
// ============================================================
export const ARCHETYPES: Archetype[] = [
  {
    key: "pizza",
    match: [/pizza/i, /\bpie\b/i, /calzone/i, /stromboli/i],
    slots: [
      { slot_key: "size", kitchen_critical: false, price_critical: true, owner_question: "", order: 1 },
    ],
    modifiers: [
      { slot_key: "toppings", bind_to_list_named: /topping/i, ask_mode: "offer_once", applies_when: item => !/specialty/i.test(item.name) },
      { slot_key: "toppings", bind_to_list_named: /topping/i, ask_mode: "on_request", applies_when: item => /specialty/i.test(item.name) },
    ],
  },
  {
    key: "burger",
    match: [/burger/i, /patty melt/i],
    slots: [
      {
        // Appendix A's shorthand doesn't spell out a bind regex for temp
        // (unlike bread/dressing/flavor), but the general algorithm (§3
        // stage 5) is "bind to a found list first, universal second" for
        // every slot -- and Vito's real data proves the point: it already
        // has hand-built "Temp" groups for its burgers. Skipping the bind
        // attempt would ask a redundant question the owner already answered.
        slot_key: "temp", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /temp/i,
        universal_choices: TEMP_CHOICES, applies_when: notChickenVeggieTurkey,
        owner_question: "Do customers pick a temperature on {category}?", order: 3,
      },
    ],
    modifiers: [
      { slot_key: "add_ons", bind_to_list_named: /add|extra/i, ask_mode: "on_request" },
    ],
  },
  {
    key: "steak",
    match: [/\bsteaks?\b/i, /\bfilet\b/i, /\bribeye\b/i, /\bsirloin\b/i, /\bstrip\b/i],
    slots: [
      {
        slot_key: "temp", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /temp/i,
        universal_choices: TEMP_CHOICES,
        owner_question: "Do customers pick a temperature on {category}?", order: 3,
      },
    ],
    modifiers: [],
  },
  {
    key: "sandwich",
    // /\bgyro\b/i isn't in Appendix A's literal match list, but Appendix B's
    // own worked example ("Zio's, Gyro (Beef or Chicken)") walks a gyro
    // through this exact archetype, and both Zio's and NJB have real "Gyro"
    // items -- omitting it would fail the design doc's own example.
    match: [/sandwich/i, /hoagie/i, /\bsub\b/i, /\bhero\b/i, /grinder/i, /wrap/i, /cheesesteak/i, /panini/i, /\bclub\b/i, /\bgyros?\b/i],
    slots: [
      { slot_key: "size", kitchen_critical: false, price_critical: true, owner_question: "", order: 1 },
      {
        // Unreachable via needs_question in practice: applies_when requires
        // nameSlotChoices, and NAME_SOURCED_SLOTS resolves that to `stated`
        // first. owner_question kept template-safe (no per-item
        // placeholders -- renderQuestionText only fills {category}/{items})
        // in case a future change to the ladder ever reaches it.
        slot_key: "protein", kitchen_critical: true, price_critical: false,
        applies_when: item => item.nameSlotChoices !== null,
        owner_question: "Do customers pick a protein (e.g. beef or chicken) on {category}?", order: 2,
      },
      {
        slot_key: "bread", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /bread|roll/i,
        owner_question: "Do customers pick a bread on {category}?", order: 4,
      },
    ],
    modifiers: [
      { slot_key: "extras", bind_to_list_named: /topping|extra/i, ask_mode: "on_request" },
    ],
  },
  {
    key: "salad",
    match: [/salad/i],
    slots: [
      {
        slot_key: "dressing", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /dressing/i,
        default_from_name: /caesar|greek|ranch|balsamic/i,
        owner_question: "Do customers pick a dressing on {category}?", order: 4,
      },
    ],
    modifiers: [
      { slot_key: "add_protein", bind_to_list_named: /add|protein/i, ask_mode: "on_request" },
      { slot_key: "extra_dressing", ask_mode: "on_request" },
    ],
  },
  {
    key: "wings",
    match: [/wings/i, /tenders/i, /boneless/i],
    slots: [
      {
        slot_key: "flavor", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /flavor|sauce/i,
        owner_question: "Which flavors do customers pick from on {category}?", order: 4,
      },
      { slot_key: "count", kitchen_critical: false, price_critical: true, owner_question: "", order: 1 },
    ],
    modifiers: [],
  },
  {
    key: "pasta",
    match: [/pasta/i, /penne/i, /\bziti\b/i, /spaghetti/i, /linguine/i, /fettuccine/i, /ravioli/i],
    slots: [
      // "kc only if a list is found or stated" (Appendix A) — kc/pc both
      // false so an unbound item falls to `skip`, not a question, per the
      // note "many places fix the pasta per dish."
      {
        slot_key: "pasta_type", kitchen_critical: false, price_critical: false,
        bind_to_list_named: /pasta/i,
        owner_question: "Do customers pick a pasta type on {category}?", order: 4,
      },
    ],
    modifiers: [
      { slot_key: "add_protein", bind_to_list_named: /add|protein/i, ask_mode: "on_request" },
    ],
  },
  {
    key: "bagel",
    match: [/bagel/i, /bialy/i],
    slots: [
      {
        slot_key: "bagel_type", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /bagel/i,
        applies_when: item => /^bagel\s+with\b/i.test(item.name.trim()),
        owner_question: "Which bagel types do customers pick from on {category}?", order: 4,
      },
      {
        slot_key: "spread", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /cream cheese|spread|schmear/i,
        applies_when: item => /\b(with|and)\b.*(cream cheese|butter|schmear)/i.test(item.name)
          || /(cream cheese|butter|schmear)/i.test(item.description ?? ""),
        owner_question: "Which cream cheese / spread flavors do customers pick from on {category}?", order: 5,
      },
    ],
    modifiers: [],
  },
  {
    key: "eggs",
    match: [/\begg\b/i, /eggs/i, /omelet/i, /omelette/i, /scramble/i, /benedict/i],
    slots: [
      {
        slot_key: "egg_style", kitchen_critical: true, price_critical: false,
        universal_choices: EGG_STYLE_CHOICES,
        applies_when: item => !/omelet|omelette/i.test(item.name),
        owner_question: "How would customers like their eggs cooked on {category}?", order: 3,
      },
      {
        slot_key: "toast", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /toast|bread/i,
        owner_question: "Do customers pick a toast/bread on {category}?", order: 4,
      },
      // Named distinctly from platter's `side` below: NJB's real descriptions
      // ("...home fries or hash brown and choice of bagel or toast.") carry
      // TWO implicit choices but normalize.ts's regex only ever captures the
      // first "choice of ... or ..." match (here, the toast clause). Sharing
      // `side` with platter would let this slot wrongly claim "stated" with
      // the toast slot's choices mislabeled as the side dish (P3: missing
      // beats wrong) -- so `egg_side` deliberately never attempts
      // description-sourced binding and always asks when kc and unbound.
      {
        slot_key: "egg_side", kitchen_critical: true, price_critical: false,
        owner_question: "Do customers pick a side on {category}?", order: 6,
      },
    ],
    modifiers: [],
  },
  {
    key: "platter",
    match: [/choice of/i, /served with your choice/i, /platter/i, /\bdinner\b/i, /\bentr[ée]e/i],
    slots: [
      {
        slot_key: "side", kitchen_critical: true, price_critical: false,
        owner_question: "Do customers pick a side on {category}?", order: 6,
      },
    ],
    modifiers: [],
  },
  {
    key: "beverage",
    match: [/soda/i, /coffee/i, /\btea\b/i, /juice/i, /shake/i, /smoothie/i, /drink/i],
    slots: [
      { slot_key: "size", kitchen_critical: false, price_critical: true, owner_question: "", order: 1 },
      {
        slot_key: "flavor", kitchen_critical: false, price_critical: false,
        bind_to_list_named: /flavor/i,
        owner_question: "Which flavors do customers pick from on {category}?", order: 4,
      },
    ],
    modifiers: [],
  },
  {
    key: "other",
    match: [],
    slots: [
      { slot_key: "size", kitchen_critical: false, price_critical: true, owner_question: "", order: 1 },
    ],
    modifiers: [],
  },
];

// ============================================================
// CLASSIFY (§3 stage 4) — keyword rules first. `match` is tried against
// category text, then (fallback) a majority vote over item names, per
// Appendix A's "match (category or name)" header.
// ============================================================

function matchesText(archetype: Archetype, text: string | null): boolean {
  if (!text) return false;
  return archetype.match.some(re => re.test(text));
}

const NAMED_ARCHETYPES = ARCHETYPES.filter(a => a.key !== "other");

export function classifyCategory(categoryName: string | null, itemNames: string[]): ArchetypeKey {
  for (const archetype of NAMED_ARCHETYPES) {
    if (matchesText(archetype, categoryName)) return archetype.key;
  }
  if (itemNames.length === 0) return "other";
  const counts = new Map<ArchetypeKey, number>();
  for (const name of itemNames) {
    for (const archetype of NAMED_ARCHETYPES) {
      if (matchesText(archetype, name)) {
        counts.set(archetype.key, (counts.get(archetype.key) ?? 0) + 1);
        break;
      }
    }
  }
  let best: ArchetypeKey = "other";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  // A single stray match (one "Steak" item among five Quesadillas, one "Key
  // Lime Pie" among ten Desserts) must not drag the whole category into an
  // archetype's owner questions -- real Vito's/Zio's data hits this often.
  // Require an actual majority of the category's items before the
  // item-name fallback wins; otherwise this category is a genuine 'other'
  // (useful signal that v0 doesn't cover it, not a false archetype).
  return bestCount >= Math.ceil(itemNames.length / 2) ? best : "other";
}

function getArchetype(key: ArchetypeKey): Archetype {
  const found = ARCHETYPES.find(a => a.key === key);
  if (!found) throw new Error(`unknown archetype key: ${key}`);
  return found;
}

// ============================================================
// INFER (§3 stage 5) — per category, per slot. Returns owner_questions
// payload shapes (§2.3 DDL columns minus id/status/timestamps, which the
// caller's INSERT fills in) plus per-item resolution detail for reporting/
// testing. Writes nothing; the caller decides whether/how to persist.
// ============================================================

export type SlotOutcomeKind = "stated" | "default" | "not_applicable" | "proposed" | "needs_question" | "skip" | "advisory";

export interface SlotOutcome {
  item_id: string;
  slot_key: string;
  kind: SlotOutcomeKind;
  choices?: string[];
  source?: "bind" | "name" | "description" | "sibling_rows";
  default_choice?: string;
  // Parallel to `choices`, only ever set when source is "bind" and the
  // bound group carried per-choice deltas (see ExtractedGroup).
  choicePriceDeltaCents?: (number | null)[];
}

export interface OwnerQuestionDraft {
  scope_type: "category";
  scope_id: string;
  slot_key: string;
  kind: "exists";
  question_text: string;
  proposal: {
    choices: string[];
    source: string;
    exclusions: string[];
  };
  blocking: boolean;
  priority: number;
  items_affected: number;
}

export interface CategoryInferResult {
  category: string;
  archetype: ArchetypeKey;
  itemCount: number;
  slotOutcomes: SlotOutcome[];
  questions: OwnerQuestionDraft[];
}

// §5.2, exact formula: priority = items_affected × (kc?3:0 + pc?3:0 + 1).
export function computePriority(itemsAffected: number, kitchenCritical: boolean, pricCritical: boolean): number {
  return itemsAffected * ((kitchenCritical ? 3 : 0) + (pricCritical ? 3 : 0) + 1);
}

// blocking iff kitchen_critical or price_critical (§2.3 DDL comment, §5.2).
export function computeBlocking(kitchenCritical: boolean, priceCritical: boolean): boolean {
  return kitchenCritical || priceCritical;
}

function resolveSiblingSourcedSlot(item: InferItemInput): SlotOutcome["kind"] {
  return item.siblingCount > 1 ? "stated" : "not_applicable";
}

// A category only qualifies as a bind-to-list candidate if the pattern
// isn't just an accident of the CATEGORY HEADING — most of its actual items
// have to be about the same thing. Real cases found against Vito's live
// data: "Stromboli Rolls" (pizza-family dishes: Cheesesteak, Pepperoni,
// Meat Lovers...) and "Flatbreads" (BBQ Chicken, Margherita...) both
// classify to an unrelated/no archetype and both match the sandwich
// archetype's /bread|roll/i on the CATEGORY NAME alone — 0 of their items
// mention bread or a roll. Contrast "Bagels" (25/26 items literally say
// "Bagel") and NJB's "Homemade Cream Cheese Spreads" (5/5 say "Cream
// Cheese Spread"). Majority-of-items is what tells these apart; the
// category name matching the pattern is necessary but not sufficient.
const CATEGORY_BIND_ITEM_MATCH_THRESHOLD = 0.5;

function categoryItemsSupportBind(group: ExtractedGroup, pattern: RegExp): boolean {
  if (group.choiceNames.length === 0) return false;
  const matching = group.choiceNames.filter(name => pattern.test(name)).length;
  return matching / group.choiceNames.length >= CATEGORY_BIND_ITEM_MATCH_THRESHOLD;
}

function findBoundGroup(item: InferItemInput, pattern: RegExp, currentArchetype: ArchetypeKey): ExtractedGroup | undefined {
  // A real per-item option_group (hand-built for THIS item) wins over a
  // same-menu category coincidentally matching the pattern — it's the more
  // specific, already-confirmed source.
  const own = item.extractedGroups.find(g => pattern.test(g.name));
  if (own) return own;
  // Two independent guards against a category matching a slot's pattern by
  // coincidence rather than being a real shared list: (1) archetype
  // coherence — the candidate must share the current archetype (plausibly
  // the same family, e.g. "Bagels" for the bagel archetype) or classify to
  // no archetype at all ("other" — a plain list with no competing dish
  // identity, e.g. "Homemade Cream Cheese Spreads"); a category with its
  // OWN unrelated named archetype (pizza, salad, ...) never qualifies.
  // (2) item-level support — see categoryItemsSupportBind above.
  return (item.categoryCandidateGroups ?? []).find(g =>
    pattern.test(g.name)
    && (g.sourceArchetype === currentArchetype || g.sourceArchetype === "other")
    && categoryItemsSupportBind(g, pattern));
}

// Guards NAME_SOURCED_SLOTS / DESCRIPTION_SOURCED_SLOTS binding against a
// real bug found in NJB's "Bacon, Sausage, Ham or Pork Roll Omelette
// Platter": normalize.ts's description parser only captures the FIRST
// "choice of ... or ..." clause per item, so a description with two such
// clauses ("choice of meat (Bacon, Sausage, Ham, or Pork Roll). Served with
// ... and choice of bagel or toast.") hands the `toast` slot the MEAT
// clause instead, split mid-parenthetical into
// ["Meat (Bacon","Sausage","Ham","Or Pork Roll)"]. Trusting that as
// `stated` would silently exclude the item from a real toast question with
// wrong data attached -- exactly what P3 ("missing beats wrong") forbids.
// An unbalanced paren is the tell; reject and fall through to the normal
// ladder (kc/pc -> needs_question) instead of guessing.
function looksLikeCleanChoiceList(choices: string[]): boolean {
  return choices.every(c => {
    const opens = (c.match(/\(/g) ?? []).length;
    const closes = (c.match(/\)/g) ?? []).length;
    return opens === closes;
  });
}

// Step 5.5's gate (see file header): true iff this item has at least one
// REAL per-item option_group sourced from a platform feed (Slice, or any
// future adapter) rather than archetype guesswork or a hand-built/owner-
// confirmed row. Deliberately checks the item's OWN extractedGroups only,
// not categoryCandidateGroups — a candidate built from a sibling category
// (e.g. "Bagels" as NJB's bagel_type list) was never a row on THIS item, so
// it says nothing about whether the platform already spoke for this item.
function hasStatedProvenanceGroup(item: InferItemInput): boolean {
  return item.extractedGroups.some(g => g.provenance === "stated");
}

// Step 5.5b's gate (added 2026-09-08, Zio's Gyro/Chicken Gyro incident):
// true iff the item has at least one real per-item REQUIRED (kind='slot')
// option_group AND every required group is a singleton (exactly one
// choice) — i.e. the item's own required-choice surface, whatever its
// provenance tag says, offers no real choice anywhere. Deliberately only
// looks at required groups: an optional modifier group with one choice
// (e.g. "Add Extra: Extra Cheese") says nothing about whether the item has
// other real choices, so it must not count here — see the
// owner_confirmed-modifier test below, which this gate must NOT flip.
// compile-menu.ts's deriveAskMode already treats a singleton group as
// `auto_single`, "a fact, not a question" (spec §2.2); this applies that
// same rule at INFERENCE time too, not just compile time, so a mistagged
// singleton group can't slip past 5.5 and get read as "no data at all".
// Concretely: Zio's Gyro/Chicken Gyro each carry one real Slice-sourced
// required "Type" group (single choice "Gyros", source_span "Gyros
// $12.95") whose GROUP row was mistagged provenance='inferred' — sibling
// Zio's burgers have the structurally identical required "Choose an
// option" singleton pattern correctly tagged 'stated' and are (correctly)
// never asked about. Without this gate, the sandwich archetype's `bread`
// slot read the mistagged group as if the item had no data at all and
// manufactured a blocking "pick a bread" owner_question with zero basis in
// the item's own description or option_groups (spec §4.3). Requires at
// least one required group — an item with ZERO groups, or only modifier
// groups (e.g. Zio's Double Burger, a separate known gap), says nothing
// and must still fall through to the normal kc/pc ladder rather than being
// silently excused.
function hasOnlySingletonGroups(item: InferItemInput): boolean {
  const requiredGroups = item.extractedGroups.filter(g => g.required);
  return requiredGroups.length > 0 && requiredGroups.every(g => g.choiceNames.length <= 1);
}

function resolveSlotForItem(slot: SlotRule, item: InferItemInput, currentArchetype: ArchetypeKey): SlotOutcome {
  const base = { item_id: item.id, slot_key: slot.slot_key };

  if (SIBLING_SOURCED_SLOTS.has(slot.slot_key)) {
    const kind = resolveSiblingSourcedSlot(item);
    return kind === "stated"
      ? { ...base, kind, source: "sibling_rows" }
      : { ...base, kind };
  }

  if (slot.applies_when && !slot.applies_when(item)) {
    return { ...base, kind: "not_applicable" };
  }

  if (slot.bind_to_list_named) {
    const found = findBoundGroup(item, slot.bind_to_list_named, currentArchetype);
    if (found) {
      return {
        ...base, kind: "stated", source: "bind", choices: found.choiceNames,
        ...(found.choicePriceDeltaCents ? { choicePriceDeltaCents: found.choicePriceDeltaCents } : {}),
      };
    }
  }

  if (NAME_SOURCED_SLOTS.has(slot.slot_key) && item.nameSlotChoices && looksLikeCleanChoiceList(item.nameSlotChoices)) {
    return { ...base, kind: "stated", source: "name", choices: item.nameSlotChoices };
  }

  if (DESCRIPTION_SOURCED_SLOTS.has(slot.slot_key) && item.descriptionSlotChoices && looksLikeCleanChoiceList(item.descriptionSlotChoices)) {
    return { ...base, kind: "stated", source: "description", choices: item.descriptionSlotChoices };
  }

  if (slot.default_from_name && slot.default_from_name.test(item.name)) {
    const m = item.name.match(slot.default_from_name);
    return { ...base, kind: "default", default_choice: m?.[0] };
  }

  if (hasStatedProvenanceGroup(item) || hasOnlySingletonGroups(item)) {
    return {
      ...base, kind: "advisory",
      ...(slot.universal_choices ? { choices: slot.universal_choices } : {}),
    };
  }

  if (slot.universal_choices) {
    return { ...base, kind: "proposed", choices: slot.universal_choices };
  }

  if (slot.kitchen_critical || slot.price_critical) {
    return { ...base, kind: "needs_question" };
  }

  return { ...base, kind: "skip" };
}

function renderQuestionText(template: string, category: string, itemCount: number): string {
  return template.replace("{category}", category).replace("{items}", String(itemCount));
}

// One category's worth of items -> one archetype + a slot-by-slot resolution
// for every item + the owner_questions rows that fall out of it. Pure, no
// I/O — the DB-backed caller assembles `InferItemInput[]` from menu_items /
// option_groups / normalize.ts output and does the actual INSERT.
export function inferCategory(category: string, items: InferItemInput[]): CategoryInferResult {
  const archetypeKey = classifyCategory(category, items.map(i => i.name));
  const archetype = getArchetype(archetypeKey);

  const slotOutcomes: SlotOutcome[] = [];
  const questions: OwnerQuestionDraft[] = [];

  for (const slot of archetype.slots) {
    const outcomesForSlot = items.map(item => resolveSlotForItem(slot, item, archetypeKey));
    slotOutcomes.push(...outcomesForSlot);

    const needsQuestion = outcomesForSlot.filter(o => o.kind === "needs_question" || o.kind === "proposed");
    if (needsQuestion.length === 0) continue;

    const exclusions = items
      .filter((_, idx) => {
        const kind = outcomesForSlot[idx].kind;
        return kind === "not_applicable" || kind === "default" || kind === "stated" || kind === "advisory";
      })
      .map(i => i.name);

    const proposedChoices = slot.universal_choices ?? [];
    const blocking = computeBlocking(slot.kitchen_critical, slot.price_critical);
    const priority = computePriority(needsQuestion.length, slot.kitchen_critical, slot.price_critical);

    questions.push({
      scope_type: "category",
      scope_id: category,
      slot_key: slot.slot_key,
      kind: "exists",
      question_text: renderQuestionText(slot.owner_question, category, items.length),
      proposal: {
        choices: proposedChoices,
        source: `archetype:${archetypeKey}`,
        exclusions,
      },
      blocking,
      priority,
      items_affected: needsQuestion.length,
    });
  }

  return { category, archetype: archetypeKey, itemCount: items.length, slotOutcomes, questions };
}
