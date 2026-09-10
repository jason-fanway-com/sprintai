// DETERMINISTIC TOPPING-ONLY PIZZA COMPOSE (2026-09-08 P0, PO root-cause
// direction — supersedes index.ts's system-prompt paragraph at "COMPOSING A
// TOPPING-ONLY PIZZA REQUEST").
//
// Some shops (Zio's: 362 items post-fold) have no standalone menu item for a
// topping named alone — "pepperoni" only exists as a choice inside the base
// cheese pizza's "Add Toppings" option group. Composing this correctly used
// to be a system-prompt instruction telling the model to pick the base
// item's ID itself and attach the topping. That instruction is losing an
// attention competition on large menus (it worked reliably on Vito's 224
// items, and dropped/garbled intermittently on Zio's 362) — a durability
// problem that gets WORSE as menus grow, not better. Per this project's own
// durability ranking (prompt instruction < clean up after the model < decide
// in code before the model < remove the capability < fix the data), this
// moves the decision into code: the model never has to find or guess the
// base item's ID for this case, code hands it a pre-resolved cart line.
//
// SCOPE: this module ONLY decides WHICH base pizza item + WHICH topping
// choice a bare word resolves to. It reuses ask-plan-engine.ts's
// applyCompiledAddItem (index.ts calls that directly with this module's
// output) to actually apply the line — no new cart-mutation logic here, so
// pricing/dedup/consumedModifierChoiceIds all stay governed by the one
// existing, tested path.
//
// SAFETY (non-negotiable, PO's explicit direction):
//   - NEVER resolve to a DIFFERENT real product whose name merely contains
//     the topping word (Pepperoni Calzone, Pepperoni Stromboli, Mike's Hot
//     Honey Pepperoni Sicilian, ...). Enforced by requiring the base
//     candidate's own category to be "Pizza" and its own name to denote a
//     plain/cheese pizza (see BASE_PIZZA_NAME_RE) — a Calzone/Stromboli
//     never matches that regex regardless of its own topping list.
//   - NEVER guess between two genuinely ambiguous families or sizes.
//     "Missing beats wrong" (this codebase's standing principle, see
//     ask-plan-engine.ts's matchChoiceInText): if the shop has multiple
//     cheese-pizza styles tied on the tie-break below, or no size can be
//     determined and more than one size variant exists, this module returns
//     no match for that token and the (unchanged, existing) model-driven
//     path is the fallback — never a silent wrong guess.
//   - "Plain pizza"/"pizza context established" gate: composition only runs
//     when the customer's own words (this turn or the immediately preceding
//     turn, same one-turn carry-forward window as
//     stated-attribute-carryforward.ts) mention pizza, or the cart already
//     has a pizza-category line. An empty/non-pizza context never composes.

import { significantStems } from "./pending-disambiguation.ts";
import { fuzzyWordMatch, GUARD19_GENERIC_WORDS } from "./guard19-fuzzy-item-match.ts";
import { splitCustomerPhrases } from "./phrase-split.ts";
import type { AskPlan } from "../_shared/compile-menu.ts";

export interface ComposeMenuItem {
  id: string;
  name: string;
  category: string;
  ask_plan?: AskPlan | null;
  bot_state?: string | null;
  option_groups?: Array<{ id: string; name: string }>;
}

export interface ComposeCartLineLike {
  menu_item_id: string;
}

export interface ComposedPizzaToken {
  token:               string; // the customer's own bare word, e.g. "pepp"
  // The 0-based index of this token's own segment within
  // splitIntoSegments(customerMessage) — i.e. splitCustomerPhrases's ordering
  // over the raw utterance. Identity, not a guess: it is the same segment
  // loop index this function already iterates in, threaded straight onto the
  // resulting cart line (index.ts) so downstream modifier resolution can
  // scope itself to exactly this phrase instead of re-deriving "which phrase
  // was this" via text search (see ask-plan-engine.ts's former
  // isolatePhraseForItem, removed 2026-09-09 P0 in favor of this field).
  phraseIndex:         number;
  quantity:            number;
  baseMenuItemId:       string;
  baseDisplayName:      string;
  // Present for a topping compose ("pepp" -> Pepperoni). Absent for a bare
  // "plain"/"cheese" compose (base pizza, no toppings selected).
  toppingChoiceDisplay?: string;
  // The choice's own DB id — caller adds this to preConsumedModifierChoiceIds
  // after a successful apply so the model's own loop can't re-apply the same
  // topping to a different pizza line in the same turn.
  toppingChoiceId?: string;
}

// A real base/cheese pizza item: category is Pizza, and its OWN name (once
// a trailing " - <size>" suffix is stripped) denotes plain cheese, not a
// specialty already baked into the name. \bcheese\b / \bplain\b require word
// boundaries so "Bacon Cheeseburger Pan Pizza" (contains "Cheeseburger", not
// the word "cheese") never matches.
const BASE_PIZZA_NAME_RE = /\b(cheese|plain)\b/i;
const PIZZA_WORD_RE = /\bpizzas?\b/i;
const SIZE_WORDS = ["small", "medium", "large", "family", "personal", "jumbo"];

function familyKey(name: string): string {
  return name.replace(/\s*-\s*[^-]*$/, "").trim().toLowerCase();
}

function sizeTagOf(name: string): string | null {
  const lower = name.toLowerCase();
  for (const s of SIZE_WORDS) {
    if (new RegExp(`\\b${s}\\b`).test(lower)) return s;
  }
  return null;
}

/**
 * Groups the shop's own base cheese/plain pizza items into size-variant
 * families and picks ONE family deterministically: the one with the most
 * active size variants (a shop's true "build your own" canvas is typically
 * offered across its widest size range; single-size entries are far more
 * often a specialty/alternate crust). Ties (including "only one candidate
 * exists" being trivially untied) resolve to the family with the fewest
 * ties; a genuine tie among 2+ families returns null — missing beats wrong.
 */
export function findBasePizzaFamily(menu: ComposeMenuItem[]): ComposeMenuItem[] | null {
  const candidates = menu.filter(m =>
    m.category?.toLowerCase() === "pizza" &&
    BASE_PIZZA_NAME_RE.test(m.name) &&
    m.bot_state !== "blocked" && m.bot_state !== "display_only",
  );
  if (candidates.length === 0) return null;

  const families = new Map<string, ComposeMenuItem[]>();
  for (const c of candidates) {
    const key = familyKey(c.name);
    if (!families.has(key)) families.set(key, []);
    families.get(key)!.push(c);
  }

  let best: ComposeMenuItem[] | null = null;
  let bestCount = -1;
  let tied = false;
  for (const members of families.values()) {
    if (members.length > bestCount) {
      best = members;
      bestCount = members.length;
      tied = false;
    } else if (members.length === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Picks the size variant matching the customer's stated size, from the
 * merged current+prior-turn text (same one-turn carry-forward window as
 * stated-attribute-carryforward.ts's buildCompiledMatchText — deliberately
 * bounded so a stray size word from several messages ago can't resurface).
 * Returns null (missing beats wrong) rather than guess when the family has
 * more than one member and no size is unambiguously stated.
 */
export function pickSizeVariant(family: ComposeMenuItem[], carryforwardText: string): ComposeMenuItem | null {
  if (family.length === 1) return family[0];
  const textLower = carryforwardText.toLowerCase();
  const hits = family.filter(m => {
    const tag = sizeTagOf(m.name);
    return tag !== null && new RegExp(`\\b${tag}\\b`).test(textLower);
  });
  return hits.length === 1 ? hits[0] : null;
}

function hasEstablishedPizzaContext(carryforwardText: string, cart: ComposeCartLineLike[], menuById: Map<string, ComposeMenuItem>): boolean {
  if (PIZZA_WORD_RE.test(carryforwardText)) return true;
  return cart.some(line => menuById.get(line.menu_item_id)?.category?.toLowerCase() === "pizza");
}

/**
 * Does this segment already name a REAL standalone active item (typo
 * included)? Requires EVERY one of that item's own significant (non-
 * generic) words to be covered by some word in the segment — a PARTIAL
 * overlap must never count. Without this, "pepp" would wrongly appear to
 * "already name" the real, standalone "Pepperoni Calzone" (which shares the
 * word "pepperoni" but also carries its own distinct "calzone" that the
 * customer never said) and this module would refuse to compose the
 * pepperoni pizza the customer actually asked for. Full coverage is exactly
 * the bar "hawaiin" -> "Hawaiian Pizza" (one significant word, fully
 * covered) and "meat lovers" -> "Meat Lover's Pizza" (two significant
 * words, both covered) need to keep working.
 */
function matchesStandaloneItem(tokenWords: string[], menu: ComposeMenuItem[]): boolean {
  for (const item of menu) {
    const itemWords = item.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
      .filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w));
    if (itemWords.length === 0) continue;
    const allCovered = itemWords.every(iw => tokenWords.some(tw => fuzzyWordMatch(tw, iw)));
    if (allCovered) return true;
  }
  return false;
}

interface Segment {
  quantity: number;
  text: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function splitIntoSegments(message: string, menu: ComposeMenuItem[]): Segment[] {
  // P0 fix (2026-09-09): was comma-only (plus a bare "and", unconditionally
  // recursed via splitOnAndItem-like matching elsewhere) — see phrase-
  // split.ts's header for the live regression this widened separator set
  // (',' | 'and' | '&', plus the implicit repeated-digit-quantity boundary)
  // fixes: "and" was one of the recognized boundaries already inside this
  // very split, but a message with NO comma/and at all ("1 cheese 1
  // pepperoni 1 meat lover 1 hawaiian") had no recognized boundary whatsoever
  // and collapsed to one giant segment.
  const parts = splitCustomerPhrases(message, menu);
  const segments: Segment[] = [];
  // P0 fix (2026-09-09, matrix case 6: "gimme a plain and a pepperoni and a
  // meat lovers and a hawaiian"): the quantity token used to have to be the
  // very FIRST word of the segment, so the leading filler verb in the
  // opening phrase of a list ("gimme a plain") left the quantity anchor
  // unrecognized and the whole "gimme a plain" fell through untouched — the
  // plain cheese pizza silently never got composed at all. Only the FIRST
  // phrase of a list can carry this kind of preamble (every later phrase
  // starts right at its own boundary from splitCustomerPhrases), so this
  // searches for the quantity/article word boundary anywhere in the
  // segment, not just position 0, and discards anything before it — a bare
  // dish name with no quantity word at all (e.g. "plain pizza") still falls
  // through unchanged to the segments.push below.
  const QTY_TOKEN_RE = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i;
  for (const part of parts) {
    const m = part.match(QTY_TOKEN_RE);
    if (m) {
      const qtyToken = m[1].toLowerCase();
      const qty = /^\d+$/.test(qtyToken) ? parseInt(qtyToken, 10) : NUMBER_WORDS[qtyToken];
      if (qty !== undefined && m[2].trim().length > 0) {
        segments.push({ quantity: qty, text: m[2].trim() });
        continue;
      }
    }
    segments.push({ quantity: 1, text: part });
  }
  return segments;
}

/**
 * The full deterministic decision: for each comma/and-separated segment of
 * the customer's message, resolve a bare topping or bare plain/cheese word
 * to a composed pizza cart line, or leave it alone (undecided — the
 * existing model-driven add_item path is the unchanged fallback for
 * everything this function does not confidently resolve).
 */
export function composeDeterministicPizzaLines(
  customerMessage: string,
  carryforwardText: string,
  menu: ComposeMenuItem[],
  cart: ComposeCartLineLike[],
): ComposedPizzaToken[] {
  const menuById = new Map(menu.map(m => [m.id, m]));
  if (!hasEstablishedPizzaContext(carryforwardText, cart, menuById)) return [];

  const family = findBasePizzaFamily(menu);
  if (!family) return [];
  const baseItem = pickSizeVariant(family, carryforwardText);
  if (!baseItem || !baseItem.ask_plan) return [];

  // All modifier-kind choices on the resolved base item, with the option
  // group name each belongs to (unused downstream today — applyCompiledAddItem
  // derives group name itself from menuItem.option_groups — kept here only
  // for composed-line display bookkeeping if ever needed).
  const modifierChoices = baseItem.ask_plan.steps
    .filter(s => s.kind === "modifier")
    .flatMap(s => s.choices);

  const results: ComposedPizzaToken[] = [];
  const segments = splitIntoSegments(customerMessage, menu);
  for (let phraseIndex = 0; phraseIndex < segments.length; phraseIndex++) {
    const seg = segments[phraseIndex];
    // Bare "plain"/"cheese" (with only size/format/course words alongside,
    // e.g. "1 cheese pizza") names the base pizza itself, not a topping —
    // checked FIRST and unconditionally, before any topping match is even
    // attempted. This must not depend on GUARD19_GENERIC_WORDS filtering
    // "cheese" away: it deliberately does NOT (see that set's own file —
    // "cheese" legitimately distinguishes real items like "Cheese Steak"
    // elsewhere), which used to mean a bare "1 cheese" segment fell through
    // to the topping-match branch below and matched an unrelated "Extra
    // Cheese" choice purely because both contain the word "cheese" — live
    // regression, 2026-09-09 matrix case 5 ("1 cheese 1 pepperoni 1 meat
    // lover 1 hawaiian"): the plain cheese pizza silently never got added.
    // "cheese" and "plain" are equally valid bare-pizza-indicator words here
    // (BASE_PIZZA_NAME_RE already treats them identically for defining the
    // family) — this check restores that equivalence for segment
    // classification too.
    const bare = seg.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
    const isBarePlain = bare.every(w => w === "plain" || w === "cheese" || w === "pizza" || w === "pizzas") &&
      bare.some(w => w === "plain" || w === "cheese");
    if (isBarePlain) {
      results.push({ token: seg.text, phraseIndex, quantity: seg.quantity, baseMenuItemId: baseItem.id, baseDisplayName: baseItem.ask_plan?.display_name ?? baseItem.name });
      continue;
    }

    const tokenWords = significantStems(seg.text).size > 0
      ? seg.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w))
      : [];
    if (tokenWords.length === 0) continue;
    // (a) Skip if this segment already names a real standalone item —
    // that's the model's existing (working) typo-correction path, not this
    // module's job.
    if (matchesStandaloneItem(tokenWords, menu)) continue;

    // (b) Does it match a topping/modifier choice on the base item?
    //
    // Two real ambiguities on a real topping list, both confirmed live
    // (2026-09-08 P0 verification):
    //   1. A short prefix like "pepp" is a valid abbreviation-match for
    //      MORE than one real choice (Zio's has both "Pepperoni" and
    //      "Peppers" — "pepp" is a clean 4-letter prefix of both).
    //   2. Matching word-by-word against a MULTI-word choice ("Roasted Red
    //      Peppers", "Hot Peppers") lets an unrelated shared word
    //      ("peppers") falsely match a compound topping the customer never
    //      asked for — live-confirmed regression: "pepp" resolved to
    //      "Roasted Red Peppers" instead of "Pepperoni".
    // Fix: rank by COVERAGE first — what fraction of the choice's own
    // significant words the match explains (1/wordCount). "Pepperoni" and
    // "Peppers" are both single-word choices (coverage 1.0); "Roasted Red
    // Peppers" is 1-of-3 (coverage 0.33) and is correctly out-ranked/
    // excluded before the tie-break ever runs. Only among the TOP coverage
    // tier does length break remaining ties (an abbreviation is far more
    // likely to stand in for the word it saves the most characters against
    // — nobody shortens "peppers" to "pepp", people shorten "pepperoni" to
    // it). A genuine tie survives — missing beats wrong — and falls through
    // to the existing model path.
    interface Hit { choice: typeof modifierChoices[number]; coverage: number; wordLen: number }
    const hits: Hit[] = [];
    for (const c of modifierChoices) {
      const choiceWords = c.display.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
        .filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w));
      if (choiceWords.length === 0) continue;
      const matchedWord = choiceWords.find(cw => tokenWords.some(tw => fuzzyWordMatch(tw, cw)));
      if (matchedWord) hits.push({ choice: c, coverage: 1 / choiceWords.length, wordLen: matchedWord.length });
    }
    let match: typeof modifierChoices[number] | null = null;
    if (hits.length > 0) {
      const maxCoverage = Math.max(...hits.map(h => h.coverage));
      const topTier = hits.filter(h => h.coverage === maxCoverage);
      if (topTier.length === 1) {
        match = topTier[0].choice;
      } else {
        const sorted = [...topTier].sort((a, b) => b.wordLen - a.wordLen);
        if (sorted[0].wordLen > sorted[1].wordLen) match = sorted[0].choice;
      }
    }
    if (!match) continue;

    results.push({
      token: seg.text,
      phraseIndex,
      quantity: seg.quantity,
      baseMenuItemId: baseItem.id,
      baseDisplayName: baseItem.ask_plan?.display_name ?? baseItem.name,
      toppingChoiceDisplay: match.display,
      toppingChoiceId: match.id,
    });
  }
  return results;
}

/**
 * The system-prompt note this turn's composed lines produce, so the model
 * (a) never re-adds them and (b) states the real composition verbatim in
 * its reply instead of paraphrasing a bare topping word away.
 */
export function buildComposedLinesNote(composed: ComposedPizzaToken[]): string {
  if (composed.length === 0) return "";
  const lines = composed.map(c =>
    c.toppingChoiceDisplay
      ? `${c.quantity}x ${c.baseDisplayName} with ${c.toppingChoiceDisplay} (composed from the customer's own word "${c.token}")`
      : `${c.quantity}x ${c.baseDisplayName}, no toppings (composed from the customer's own word "${c.token}")`,
  );
  // Deliberately avoids "in your/the cart" / "already" language — GUARD 1c
  // (index.ts's claimsItemInCart) treats those phrases as cart-content claims
  // and string-matches them against cart line bare names. Composed lines keep
  // the topping in `options` (not in `name`), so "X with Pepperoni in your
  // cart" fails the substring check → false "Sorry, I got mixed up" — live-
  // confirmed regression 2026-09-08 (v303). The model MUST describe composed
  // items as freshly-confirmed, using the EXACT display name below.
  const exampleLine = composed[0].toppingChoiceDisplay
    ? `${composed[0].baseDisplayName} with ${composed[0].toppingChoiceDisplay}`
    : `${composed[0].baseDisplayName}`;
  return `\n\nSYSTEM-COMPOSED THIS TURN (CRITICAL — read this before responding): Code resolved the item(s) below and placed them in the order. Your tools confirm they are live. MANDATORY RULES:\n1. Do NOT call add_item for any of these items — they are handled.\n2. In your reply, describe each one as a freshly-confirmed item, using the EXACT name string shown below (verbatim, letter-for-letter — not a paraphrase, not a shorter form). Example: "${exampleLine}"\n3. FORBIDDEN PHRASES — do NOT write any of: "in your cart", "in the cart", "already have", "already added", "already in", "have a … in your". Use present-tense description ("I've added…") without any "in the cart" suffix.\n${lines.join("\n")}`;
}
