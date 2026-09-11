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
//   4.5. `bread` slot only: description states  -> stated (description) — no question
//        one FIXED value ("on rye bread") with     see extractStatedBreadFact below
//        no "or" (no real choice) —
//   5. default_from_name matches the item name  -> default            — no question,
//                                                                        recorded as an
//                                                                        exclusion
//   5.5. item already has ANY platform-sourced -> advisory (no question, no
//        (provenance='stated') option_group,     owner tap) — see
//        just not one THIS slot bound to         hasStatedProvenanceGroup below
//   5.5b. item has real group(s), all of them   -> advisory (same as 5.5) —
//        a required singleton (1 choice) —        see hasOnlySingletonGroups
//        regardless of provenance tag              below
//   5.7. slot opted into                        -> advisory (no question, no
//        universalSuppliesWithoutQuestion —        owner tap) — see that
//        universal_choices IS the answer,           flag's own comment on
//        no restaurant-specific data needed —       SlotRule (egg_style is
//        (added 2026-09-08, egg_style)               the only slot so far)
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
// Bagels) are completely unaffected — steps 6/7 still apply to them exactly as before,
// EXCEPT for a slot that opts into step 5.7 (egg_style only, so far).
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
  // 2026-09-08, PO-directed egg_style fix. Most universal_choices slots
  // (burger/steak `temp`) still fall to `proposed` (step 6, an owner tap)
  // when unbound -- a real restaurant can genuinely offer only some temps,
  // or none at all, so the list needs the owner's confirmation before it's
  // trustworthy. `egg_style` is different in kind, not degree: "how do you
  // want your eggs" with these six answers is a customer-facing universal
  // any establishment that serves eggs "any style" already implies, not a
  // restaurant-specific menu fact — there is no real-world answer set this
  // could be wrong about the way a bread or dressing question could. Set
  // true ONLY where that's true; leaves burger/steak temp's existing
  // ask-when-unbound behavior (and its known 3 pre-existing blocked Vito's
  // burgers) untouched, since changing that is a separate, unreviewed call
  // this task never asked for.
  universalSuppliesWithoutQuestion?: boolean;
}

export interface ModifierRule {
  slot_key: string;
  bind_to_list_named?: RegExp;
  ask_mode: "offer_once" | "on_request";
  applies_when?: (item: InferItemInput) => boolean;
  // When true, the compile-time D1 pass generates one derived menu_items row
  // per (base pizza × non-not_composable choice) for this modifier group.
  // Phase 0: pizza toppings only.
  composable?: boolean;
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
  // 2026-09-08, real NJB two-choice-clause fix. normalize.ts's
  // pickDescriptionSlot picks the BREAD/named-sub-attribute clause into
  // descriptionSlotChoices above; this is the separate "served with A or B"
  // SIDE clause a description can state alongside it (normalize.ts's own
  // pickSideDescriptionSlot) — e.g. NJB's "... served with home fries or
  // hash brown and choice of bagel or toast." states a side AND a bread
  // choice in one sentence, and the two must never collapse into a single
  // field the way they used to (see egg_side's own comment below). Null
  // when the description states no such clause (every non-NJB-egg-platter
  // item today).
  sideSlotChoices: string[] | null;
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
// `egg_side` is deliberately NOT in the set above: it reads its own
// `sideSlotChoices` field (see InferItemInput and the egg_side SlotRule's
// own comment), not the shared `descriptionSlotChoices` field this set's
// slots all read — the two clauses a description like NJB's "... served
// with home fries or hash brown and choice of bagel or toast." states are
// never the same list, so they can't share one field the way `side` and
// `toast` currently do (harmless today only because no live item uses both
// `side` and `toast`/`bread` at once — egg_side's own history is exactly
// what happens when two real, DIFFERENT clauses collapse onto one field).

// Slots resolved from sibling product rows, never from a question (see file
// header). Universal across every archetype that declares one.
const SIBLING_SOURCED_SLOTS = new Set(["size", "count"]);

const TEMP_CHOICES = ["Rare", "Medium rare", "Medium", "Medium well", "Well done"];
const EGG_STYLE_CHOICES = ["Scrambled", "Over easy", "Over medium", "Over hard", "Sunny side up", "Poached"];

function notChickenVeggieTurkey(item: InferItemInput): boolean {
  return !/\b(chicken|veggie|vegetarian|turkey)\b/i.test(item.name);
}

// A sandwich item whose own NAME already names its bread form -- "Steak
// Sub", "Ham & Cheese Sub", "Chicken Cheesesteak Sub" -- states the fact
// the same way a wrap does (2026-09-08, ac8f69d's wrap guard, generalized
// here rather than adding a third one-off): there's no separate bread
// choice to ask about, the name IS the answer. Confirmed against real
// Zio's data (PO audit, 2026-09-08): 24 Hot/Cold Subs items carry zero
// bread option_group and no description mentioning bread at all -- every
// one of them names its own form ("... Sub"). Genuine open gaps ("Chicken
// Cutlet", "Turkey Melt", "Reuben") name neither a sandwich vessel nor a
// specific bread, so they correctly fall through and keep asking.
const BREAD_FORM_IN_NAME_PATTERN = /\b(subs?|hoagies?|heroe?s?|grinders?|wraps?|gyros?|paninis?|bagels?|rolls?|pitas?|baguettes?|croissants?)\b/i;

function nameStatesBreadForm(item: InferItemInput): boolean {
  return BREAD_FORM_IN_NAME_PATTERN.test(item.name);
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
      { slot_key: "toppings", bind_to_list_named: /topping/i, ask_mode: "offer_once", applies_when: item => !/specialty/i.test(item.name), composable: true },
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
        // Bread-form-in-name guard, generalized 2026-09-08 (PO audit,
        // this commit) from the wrap-only guard ac8f69d introduced --
        // same shape as burger's notChickenVeggieTurkey. See
        // nameStatesBreadForm's own comment for the full rationale.
        slot_key: "bread", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /bread|roll/i,
        applies_when: item => !nameStatesBreadForm(item),
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
        // universalSuppliesWithoutQuestion added 2026-09-08 (PO directive,
        // superseding this slot's own prior behavior): egg_style used to
        // fall to `proposed` like any other universal_choices slot when
        // unbound, which meant NJB's "Two Eggs Any Style Platter" -- the one
        // item this slot genuinely applies to -- sat blocked on an owner tap
        // for a fact that isn't restaurant-specific (see the flag's own
        // comment on SlotRule for why egg_style differs from burger/steak
        // temp here). Resolves as `advisory` now: the six choices are
        // supplied, no owner_question is created, no tap spent.
        slot_key: "egg_style", kitchen_critical: true, price_critical: false,
        universal_choices: EGG_STYLE_CHOICES,
        universalSuppliesWithoutQuestion: true,
        applies_when: item => !/omelet|omelette/i.test(item.name),
        owner_question: "How would customers like their eggs cooked on {category}?", order: 3,
      },
      {
        slot_key: "toast", kitchen_critical: true, price_critical: false,
        bind_to_list_named: /toast|bread/i,
        owner_question: "Do customers pick a toast/bread on {category}?", order: 4,
      },
      // SUPERSEDES the prior standing note here (2026-09-08, PO directive):
      // this slot used to say it "deliberately never attempts description-
      // sourced binding and always asks when kc and unbound" — reasonable
      // as a stopgap when normalize.ts could only ever surface ONE
      // "choice of ..." clause per description (so `side` and `toast` would
      // have collided on the same mislabeled data, P3 "missing beats
      // wrong"), but that stopgap is not the answer. normalize.ts now
      // extracts the "served with A or B" side clause as its own,
      // independently-anchored slot (InferItemInput.sideSlotChoices, fed by
      // pickSideDescriptionSlot) distinct from the "choice of C or D" bread
      // clause `toast` reads above — there's no more collision to guard
      // against, so `egg_side` binds to its own real, stated data below
      // exactly like every other description-sourced slot in this file.
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

// Single-fixed-value bread fact (added 2026-09-08, NJB 23-of-38-blocked
// audit): DESCRIPTION_SOURCED_SLOTS above only recognizes a "choice of A or
// B" LIST as settling a slot. A description stating one fixed bread type
// ("...on rye bread.", "Beef on pita...", "Wheat toast schmeared...") states
// the fact just as authoritatively -- there's no "or" because there's no
// choice -- but the ladder had no equivalent for it, so these items (real
// NJB data: Avocado Crush, Sloppy Joe x2, Beef/Grilled Chicken Gyro, Big
// John's, Cheddar Cheeseball Cheesesteak, Cheesesteak, Chicken Cutlet
// Sandwich, Pizza Bagel, Rachel, Reuben) fell all the way to
// needs_question with zero real data gap. Scoped to `bread` only, and
// wired in below as a fallback AFTER the real choice-of-list check --
// items with a genuine enumerated bread choice (e.g. NJB's "on choice of
// bagel, bread, or roll") resolve there first and never reach this. Bare
// "bread" is deliberately NOT one of the alternatives (only a named type +
// bread/toast, e.g. "rye bread") so this can't misfire on NJB's real
// GENUINE gap ("...on choice of bread." -- Turkey Melt / Tuna Melt --
// literally unenumerated, must stay needs_question, not get guessed at).
const BREAD_FIXED_VALUE_PATTERN =
  /(?:^|\bon\s+(?:an?\s+)?|\bin\s+(?:an?\s+)?)((?:grilled\s+)?(?:rye|wheat|white|sourdough|multigrain)\s+(?:bread|toast)|pita|wrap|roll|bagel)\b/i;

function extractStatedBreadFact(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(BREAD_FIXED_VALUE_PATTERN);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
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

// Generalized version of the "prefer a real found list over asking" rule
// bind_to_list_named already expresses BY NAME (§3 stage 5) — for a slot the
// archetype library gives no name pattern at all, the compiler must still
// not manufacture an owner_question when the item already carries a real,
// unused option_group that answers exactly this slot's question. Real Vito's
// incident: Entrees' `side` slot has no bind_to_list_named, so 9 items each
// already carrying a real, owner_confirmed "Pasta" group (Spaghetti/Penne/
// Angel Hair/Linguine) sat needs_question anyway, indistinguishable from a
// genuine data gap, even though the item's OWN row already answers it.
//
// Deliberately conservative in two ways:
//  1. Only ever consulted for slots with NO bind_to_list_named of their own
//     (checked by the caller) — a slot that DOES have a name pattern
//     (bread, temp, dressing, ...) already tried and failed to find its
//     answer by name; falling back to "whatever unclaimed group happens to
//     exist" for THOSE slots would risk wiring an unrelated group to the
//     wrong question (real Vito's shape: Buffalo Chicken Cheesesteak has a
//     real "Sauce" group and a genuinely missing "Bread" group — auto-
//     wiring bread to Sauce because it's the only other group around would
//     be exactly the kind of wrong-not-missing guess P3 forbids).
//  2. Exactly one unclaimed candidate, not "any" — an item with two or more
//     real unclaimed groups is a genuine ambiguity (which one answers THIS
//     slot?) the compiler must not guess at; it still falls through to
//     needs_question rather than picking wrong.
// "Claimed" means already matched by some OTHER slot in this archetype via
// ITS OWN bind_to_list_named pattern — a group a named slot already spoke
// for is never available as a guess for an unnamed one.
//
// A THIRD guard (2026-09-11, caught by independent review before this ever
// shipped): "claimed by a bind pattern" only rules out a group some OTHER
// slot already spoke for BY NAME — it says nothing about a group that's
// simply unrelated to every slot in the archetype. Real eggs shape: eggs has
// TWO slots with no bind_to_list_named (egg_style, egg_side) plus one that
// has one (toast). An item with a real "Toast" group (claimed by toast's
// bind) AND a real, unrelated "Fillings" group (Ham & Cheese / Veggie / Meat
// Lovers — nothing to do with a side dish) would leave exactly ONE unclaimed
// candidate ("Fillings") and Step 2's "exactly one" check would happily wire
// it to egg_side as if omelette fillings answered "do customers pick a
// side" — wrong, not missing, precisely what this function exists to avoid.
// The claim-by-name-pattern check alone cannot distinguish "unrelated real
// group" from "the group this slot is actually looking for" once an
// archetype has more than one slot with nothing to bind by name — there's
// no way to tell which no-bind slot (or neither) an unclaimed group
// answers. So this fallback is restricted to archetypes with EXACTLY ONE
// slot lacking a bind_to_list_named — platter's lone `side` slot today,
// the one real shape this was written for. `eggs` (two such slots) is
// deliberately excluded; egg_side keeps falling through to needs_question
// exactly as it did before this fix, which is the safe default.
function archetypeSafeForUnclaimedGroupFallback(archetype: Archetype): boolean {
  return archetype.slots.filter(s => !s.bind_to_list_named).length === 1;
}

function findUnclaimedRealGroup(item: InferItemInput, archetype: Archetype): ExtractedGroup | undefined {
  if (!archetypeSafeForUnclaimedGroupFallback(archetype)) return undefined;
  const claimedNames = new Set<string>();
  for (const s of archetype.slots) {
    if (!s.bind_to_list_named) continue;
    const bound = item.extractedGroups.find(g => s.bind_to_list_named!.test(g.name));
    if (bound) claimedNames.add(bound.name);
  }
  const candidates = item.extractedGroups.filter(g =>
    g.required && g.choiceNames.length > 1 && !claimedNames.has(g.name));
  return candidates.length === 1 ? candidates[0] : undefined;
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

  if (slot.slot_key === "bread") {
    const fixedBread = extractStatedBreadFact(item.description);
    if (fixedBread) {
      return { ...base, kind: "stated", source: "description", choices: [fixedBread] };
    }
  }

  // egg_side reads its OWN field rather than DESCRIPTION_SOURCED_SLOTS'
  // shared descriptionSlotChoices — see sideSlotChoices' comment on
  // InferItemInput and egg_side's own SlotRule comment for why the two
  // clauses can't share one field.
  if (slot.slot_key === "egg_side" && item.sideSlotChoices && looksLikeCleanChoiceList(item.sideSlotChoices)) {
    return { ...base, kind: "stated", source: "description", choices: item.sideSlotChoices };
  }

  if (slot.default_from_name && slot.default_from_name.test(item.name)) {
    const m = item.name.match(slot.default_from_name);
    return { ...base, kind: "default", default_choice: m?.[0] };
  }

  if (!slot.bind_to_list_named) {
    const unclaimed = findUnclaimedRealGroup(item, getArchetype(currentArchetype));
    if (unclaimed) {
      return { ...base, kind: "stated", source: "bind", choices: unclaimed.choiceNames };
    }
  }

  if (hasStatedProvenanceGroup(item) || hasOnlySingletonGroups(item)) {
    return {
      ...base, kind: "advisory",
      ...(slot.universal_choices ? { choices: slot.universal_choices } : {}),
    };
  }

  // See SlotRule.universalSuppliesWithoutQuestion's own comment: a narrow,
  // explicitly-opted-in escape from step 6 below for slots whose universal
  // list is a customer-facing fact, not a restaurant-specific one — checked
  // AFTER the bind/name/description/default attempts above (a real stated
  // answer always wins over the universal fallback) and before step 6 so it
  // never reaches `proposed`.
  if (slot.universalSuppliesWithoutQuestion && slot.universal_choices) {
    return { ...base, kind: "advisory", choices: slot.universal_choices };
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
