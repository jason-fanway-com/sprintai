// Item 3 (2026-09-09): deterministic phrase-isolated utterance resolver.
//
// PHRASE ISOLATION INVARIANT (structural, not guarded):
//   splitPhrases() partitions the utterance BEFORE any resolution begins.
//   resolvePhrase() accepts exactly one string and a read-only MenuLexicon;
//   it has no reference to any other phrase's tokens, accumulated state, or
//   resolved results. Cross-phrase token borrowing is impossible by
//   construction — there is no shared mutable context between calls, and
//   the only shared argument (MenuLexicon) is read-only.
//
// This is why the original pepperoni-on-two-pizzas defect cannot recur in
// this path: the token "pepperoni" that appears in phrase A is a local
// string inside resolvePhrase(phraseA, lexicon). It never becomes visible
// to resolvePhrase(phraseB, lexicon), even when phraseB is the very next
// call in the same map(). The isolation is not enforced by a runtime check;
// it is enforced by the call boundary itself.
//
// Entry point:   resolveUtterance(utterance, menu) -> ResolvedOp[]
// Side-car:      applyOps(ops, startingCart) -> CartState[]
// Tested without Supabase or LLM — pure functions over a menu snapshot.

import { fuzzyWordMatch, GUARD19_GENERIC_WORDS } from "./guard19-fuzzy-item-match.ts";
import type { ComposeMenuItem } from "./pizza-topping-compose.ts";

// ── LEXICON ────────────────────────────────────────────────────────────────

export interface LexiconTopping {
  id: string;
  display: string;
  priceDeltaCents: number;
}

export interface LexiconItem {
  id: string;
  name: string;          // raw DB name
  displayName: string;   // human-readable display name
  category: string;
  basePriceCents: number;
  toppings: LexiconTopping[];
  blocked: boolean;
}

export interface MenuLexicon {
  items: LexiconItem[];
}

// ── OPERATIONS ─────────────────────────────────────────────────────────────

export interface AddItemOp {
  kind: "add_item";
  phrase: string;
  itemId: string;
  itemName: string;
  quantity: number;
  addToppings: LexiconTopping[];
  removeToppingNames: string[];
}

export interface AskAmbiguityOp {
  kind: "ask_ambiguity";
  phrase: string;
  question: string;
  candidates: string[];
}

export interface HonestMissOp {
  kind: "honest_miss";
  phrase: string;
  missedToken: string;
  reason: "item_not_found" | "topping_not_sold";
  availableInstead: string[];
  gapLogged: true;
}

export interface RemoveToppingOp {
  kind: "remove_topping";
  phrase: string;
  targetItemHint: string;
  toppingName: string;
}

export type ResolvedOp = AddItemOp | AskAmbiguityOp | HonestMissOp | RemoveToppingOp;

// ── CART STATE (for test assertions) ──────────────────────────────────────

export interface CartState {
  itemId: string;
  itemName: string;
  quantity: number;
  toppings: string[];
}

// ── INTERNALS ──────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Words in an item's display name that are significant for matching purposes:
// length ≥ 3, not in the generic word set (size/format/course words).
function significantItemWords(displayName: string): string[] {
  return normalizeText(displayName)
    .split(" ")
    .filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w));
}

// Score 0.0–1.0: fraction of the item's own significant words that appear
// (via fuzzyWordMatch) in the given phrase text. Zero means no significant
// word matched; 1.0 means every one did.
function scoreItemMatch(phraseNorm: string, item: LexiconItem): number {
  const iWords = significantItemWords(item.displayName);
  if (iWords.length === 0) return 0;
  const phraseTokens = phraseNorm.split(" ");
  let matched = 0;
  for (const iw of iWords) {
    if (phraseTokens.some(pt => fuzzyWordMatch(pt, iw))) matched++;
  }
  return matched / iWords.length;
}

// An exact, whole-string match against an item's own display name beats any
// word-coverage heuristic: it can never misattribute (it requires full
// string equality against a real catalog name) and it sidesteps every
// downstream heuristic — "with"/"no"/quantity parsing, generic-word
// filtering, pizza-context fallback — that exists only to interpret PARTIAL
// phrases. Many real dish names are themselves built from words that
// resolver.ts's own significance filter treats as noise ("Regular Slice",
// "Side Salad" — both words generic), contain "with" as part of the name
// rather than a topping clause ("Chicken Fingers (5) With French Fries"),
// lead with a numeral that parseQuantity would otherwise strip as an order
// quantity ("10 Pieces Wings (Bone-In)"), or share a flavor word with an
// unrelated item in a different format ("Turkey Wrap" vs "Turkey Sub",
// "Garden Salad" vs "Garden Pizza") — none of which should ever block an
// exact echo of the item's own name from resolving to that exact item.
// Returns null (not a guess) when zero or more than one item shares that
// exact name — e.g. a genuine duplicate display_name across two items.
function findExactItemMatch(text: string, lexicon: MenuLexicon): LexiconItem | null {
  const norm = normalizeText(text);
  const matches = lexicon.items.filter(i => !i.blocked && normalizeText(i.displayName) === norm);
  return matches.length === 1 ? matches[0] : null;
}

// Find the best-matching menu item for the given text. Requires ≥ 50% of
// the item's significant words to match. Among tied-score candidates, breaks
// ties by size-word presence (e.g. "large" in phrase -> prefer items whose
// name contains "large"). Returns null on genuine ambiguity or no match.
function findItemInText(text: string, lexicon: MenuLexicon): LexiconItem | null {
  const exactMatch = findExactItemMatch(text, lexicon);
  if (exactMatch) return exactMatch;

  const norm = normalizeText(text);
  let bestScore = 0.5; // minimum threshold — below this is noise
  let bestItems: LexiconItem[] = [];

  for (const item of lexicon.items) {
    if (item.blocked) continue;
    const score = scoreItemMatch(norm, item);
    if (score > bestScore) {
      bestScore = score;
      bestItems = [item];
    } else if (score === bestScore && score >= 0.5) {
      bestItems.push(item);
    }
  }

  if (bestItems.length === 0) return null;
  if (bestItems.length === 1) return bestItems[0];

  // Tiebreak by specificity: prefer the item with the most significant
  // words (the longest/most-specific matching name). A customer saying
  // "Nacho Cheese Fries" fully satisfies both that item and the shorter
  // superset-of-words "Cheese Fries" (2/2 words), but "Nacho Cheese Fries"
  // (3/3 words) accounts for the whole phrase and is the one actually named
  // — it must win, not tie-break arbitrarily toward the shorter name.
  const maxSignificantWords = Math.max(
    ...bestItems.map(i => significantItemWords(i.displayName).length),
  );
  const mostSpecific = bestItems.filter(
    i => significantItemWords(i.displayName).length === maxSignificantWords,
  );
  if (mostSpecific.length === 1) return mostSpecific[0];
  bestItems = mostSpecific;

  // Tiebreak by size word: prefer the item whose raw name contains the
  // size word present in the customer's phrase.
  const sizeTag = (norm.match(/\b(small|medium|large|family|personal|jumbo)\b/) ?? [])[1];
  if (sizeTag) {
    const withSize = bestItems.filter(i => i.name.toLowerCase().includes(sizeTag));
    if (withSize.length === 1) return withSize[0];
    if (withSize.length > 0) return withSize[0]; // multiple same-size matches: take first
  }

  // Genuine tie — do not guess.
  return null;
}

// Find the best-matching topping among the item's own choices. Uses the
// same coverage-rank + word-length tiebreak algorithm as pizza-topping-
// compose.ts so the two modules stay consistent on ambiguity handling.
// Returns null when zero or multiple candidates tie (missing beats wrong).
function findToppingInText(text: string, toppings: LexiconTopping[]): LexiconTopping | null {
  const tokenWords = normalizeText(text)
    .split(" ")
    .filter(w => w.length >= 3);

  interface Hit { topping: LexiconTopping; coverage: number; wordLen: number }
  const hits: Hit[] = [];

  for (const t of toppings) {
    const tWords = normalizeText(t.display)
      .split(" ")
      .filter(w => w.length >= 3 && !GUARD19_GENERIC_WORDS.has(w));
    if (tWords.length === 0) continue;
    const matchedWord = tWords.find(tw => tokenWords.some(pw => fuzzyWordMatch(pw, tw)));
    if (matchedWord) {
      hits.push({ topping: t, coverage: 1 / tWords.length, wordLen: matchedWord.length });
    }
  }

  if (hits.length === 0) return null;
  const maxCoverage = Math.max(...hits.map(h => h.coverage));
  const topTier = hits.filter(h => h.coverage === maxCoverage);
  if (topTier.length === 1) return topTier[0].topping;
  const sorted = [...topTier].sort((a, b) => b.wordLen - a.wordLen);
  // Only resolve the tie if the longest word is strictly longer.
  if (sorted[0].wordLen > sorted[1].wordLen) return sorted[0].topping;
  return null; // genuine tie — missing beats wrong
}

// Extract a leading quantity from text. Returns the quantity and the
// remainder. Defaults to 1 when no quantity is present.
function parseQuantity(text: string): { qty: number; rest: string } {
  const trimmed = text.trim();
  // Leading numeral
  const numMatch = trimmed.match(/^(\d+)\s+(.+)$/s);
  if (numMatch) return { qty: parseInt(numMatch[1], 10), rest: numMatch[2] };
  // Leading word-number (skip "a"/"an" — handled separately below)
  const lower = trimmed.toLowerCase();
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    if (word === "a" || word === "an") continue;
    if (lower.startsWith(word + " ")) return { qty: val, rest: trimmed.slice(word.length + 1) };
  }
  // Leading article ("a pizza") -> qty 1
  const articleMatch = trimmed.match(/^(?:a|an)\s+(.+)$/i);
  if (articleMatch) return { qty: 1, rest: articleMatch[1] };
  return { qty: 1, rest: trimmed };
}

// When findItemInText returns null but the phrase contains a pizza indicator
// word ("pizza", "pie", "plain", "cheese" used alone), attempt to resolve
// to the shop's base cheese pizza family.
// Returns { item, addTexts } or null (missing beats wrong on genuine ambiguity).
//
// addTexts comes in two flavours:
//   • Already parsed (caller found "with X"): passed through unchanged.
//   • Implicit (topping-before-item pattern like "pepperoni pizza"): the
//     significant non-pizza, non-cheese words in the base text become the
//     add token. This is the only path that generates addTexts from
//     baseText directly, and it runs only when addTexts was empty.
function findPizzaContextResolution(
  baseText: string,
  addTexts: string[],
  fullNorm: string,
  lexicon: MenuLexicon,
): { item: LexiconItem; addTexts: string[] } | null {
  const cheesePizzas = lexicon.items.filter(
    i => /\b(?:cheese|plain)\b/i.test(i.name) &&
         i.category.toLowerCase() === "pizza" &&
         !i.blocked,
  );
  if (cheesePizzas.length === 0) return null;

  const sizeTag =
    (fullNorm.match(/\b(small|medium|large|family|personal|jumbo)\b/) ?? [])[1];

  let baseItem: LexiconItem | null = null;
  if (sizeTag) {
    const withSize = cheesePizzas.filter(cp => cp.name.toLowerCase().includes(sizeTag));
    if (withSize.length >= 1) baseItem = withSize[0]; // first match; ties within the same size family are acceptable
  } else if (cheesePizzas.length === 1) {
    baseItem = cheesePizzas[0];
  }
  // Multiple size variants, no size stated: cannot pick. Return null — ask.

  if (!baseItem) return null;

  // If "with X" was already parsed into addTexts, use them unchanged.
  if (addTexts.length > 0) return { item: baseItem, addTexts };

  // Topping-before-item case ("large pepperoni pizza"):
  // Extract the residual significant words from baseText (everything that
  // is not a size/format/cheese qualifier) as the topping token.
  const residual = normalizeText(baseText)
    .split(" ")
    .filter(w =>
      w.length >= 3 &&
      !GUARD19_GENERIC_WORDS.has(w) &&
      !/^(?:cheese|plain)$/.test(w),
    )
    .join(" ");

  if (residual.length > 0) return { item: baseItem, addTexts: [residual] };

  // Bare "pizza" / "large pizza" / "cheese pizza" — no topping intended.
  return { item: baseItem, addTexts: [] };
}

// ── PHRASE SPLITTER ────────────────────────────────────────────────────────

// Matches phrase-split.ts's splitCustomerPhrases exactly: comma, '&', and
// "and" when immediately followed by a quantity word or article (keeping
// dish names like "Mac and Cheese" intact; "and one hawaiian" / "and a plain"
// are boundaries). Also splits on implicit digit-repeat ("1 cheese 1 pepp").
// The lexicon parameter is retained for backward compatibility but unused.
const _RESOLVER_SEP_RE = new RegExp(
  `,|&|\\band\\s+(?=(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|the)\\b)`,
  "i",
);
const _RESOLVER_DIGIT_RE = /\s+(?=\d+\s)/;

export function splitPhrases(utterance: string, _lexicon?: MenuLexicon): string[] {
  return utterance
    .split(_RESOLVER_SEP_RE)
    .flatMap(seg => seg.split(_RESOLVER_DIGIT_RE))
    .map(s => s.trim())
    .filter(Boolean);
}

// ── RESOLVER ──────────────────────────────────────────────────────────────

// Resolve ONE phrase in complete isolation. This function is the structural
// enforcement of the phrase isolation invariant: the only inputs are the
// raw text of this phrase and the read-only lexicon. There is no reference
// to any previously resolved phrase, any accumulated cart state, or any
// other mutable context. A token from phraseA cannot reach phraseB because
// phraseA and phraseB are never in scope at the same time.
export function resolvePhrase(rawText: string, lexicon: MenuLexicon): ResolvedOp {
  const phrase = rawText.trim();
  const fullNorm = normalizeText(phrase);

  // ── Step A: Correction pattern "remove X from [item]" ─────────────────
  const removeFromMatch = phrase.match(
    /^(?:remove|take\s+off|delete)\s+(.+?)\s+from\s+(?:the\s+)?(.+)$/i,
  );
  if (removeFromMatch) {
    return {
      kind: "remove_topping",
      phrase,
      targetItemHint: removeFromMatch[2].trim(),
      toppingName: removeFromMatch[1].trim(),
    };
  }

  // ── Step B: Parse leading quantity ────────────────────────────────────
  const { qty, rest } = parseQuantity(phrase);
  const restNorm = normalizeText(rest);

  // ── Step C: Parse add/remove modifier clauses ─────────────────────────
  // "with X [and Y]" -> addTexts. "no X" / "without X" -> removeTexts.
  let baseText: string;
  let addTexts: string[];
  let removeTexts: string[];

  const withIdx = rest.search(/\bwith\b/i);
  if (withIdx !== -1) {
    baseText = rest.slice(0, withIdx).trim();
    const afterWith = rest.slice(withIdx + 4).trim();
    addTexts = afterWith
      .split(/\band\b|,/i)
      .map(s => s.replace(/^(?:extra|add|plus)\s+/i, "").trim())
      .filter(Boolean);
    removeTexts = [];
  } else {
    baseText = rest;
    addTexts = [];
    removeTexts = [];
  }

  // "no X" / "without X" present in baseText
  const noMatch = baseText.match(/\b(?:no|without)\s+(\w[\w\s]*?)(?=\s+(?:pizza|pie|on|from)\b|\s*$)/i);
  if (noMatch) {
    removeTexts.push(noMatch[1].trim());
    baseText = baseText.slice(0, noMatch.index).trim();
  }

  // ── Step D: Find the base item ────────────────────────────────────────
  let foundItem = findItemInText(baseText, lexicon);

  // ── Step E: Pizza-context fallback ────────────────────────────────────
  // Triggers in two cases:
  //   1. findItemInText returned null AND the phrase contains a pizza
  //      indicator ("pizza", "pie", "plain", or bare "cheese").
  //   2. findItemInText returned a NON-pizza-category item (e.g. Pepperoni
  //      Calzone) but the phrase also contains "pizza" — the customer said
  //      "pepperoni pizza", which names a composition, not a calzone. The
  //      pizza-context path wins when this override applies.
  //
  // The bare "plain"/"cheese" pattern (no explicit "pizza"/"pie" word) is
  // only a pizza indicator for case 1, where nothing else on the menu
  // explains the phrase. It must NOT drive case 2: overriding an item that
  // was already matched requires checking that item's own category, not a
  // bare regex over the raw phrase — otherwise a real non-pizza item whose
  // name happens to start with "cheese " ("Cheese Fries", "cheese steak")
  // gets misrouted into pizza disambiguation.
  const explicitPizzaWord = /\bpizza\b|\bpie\b/i.test(fullNorm);
  const bareCheeseOrPlain =
    /^(?:plain|cheese)$/i.test(normalizeText(baseText).trim()) ||
    /^(?:plain|cheese)\s+\w/i.test(normalizeText(baseText).trim());
  const hasPizzaIndicator = explicitPizzaWord || bareCheeseOrPlain;

  const nonPizzaOverride =
    foundItem !== null &&
    explicitPizzaWord &&
    foundItem.category.toLowerCase() !== "pizza";

  if (!foundItem || nonPizzaOverride) {
    if (hasPizzaIndicator) {
      const result = findPizzaContextResolution(baseText, addTexts, fullNorm, lexicon);
      if (result) {
        foundItem = result.item;
        addTexts = result.addTexts;
      } else if (!foundItem) {
        // Multiple size variants, no size stated — ask which size.
        const cheesePizzas = lexicon.items.filter(
          i => /\b(?:cheese|plain)\b/i.test(i.name) &&
               i.category.toLowerCase() === "pizza" && !i.blocked,
        );
        if (cheesePizzas.length > 1) {
          return {
            kind: "ask_ambiguity",
            phrase,
            question: "Which size pizza would you like?",
            candidates: cheesePizzas.map(i => i.displayName),
          };
        }
      }
      // If nonPizzaOverride was set but pizza-context also fails (no cheese
      // pizza family), fall back to the original non-pizza item.
      if (!result && nonPizzaOverride) {
        foundItem = findItemInText(baseText, lexicon);
      }
    }
  }

  // ── Step F: No item found at all ──────────────────────────────────────
  if (!foundItem) {
    return {
      kind: "honest_miss",
      phrase,
      missedToken: baseText || rest,
      reason: "item_not_found",
      availableInstead: lexicon.items
        .filter(i => !i.blocked)
        .slice(0, 6)
        .map(i => i.displayName),
      gapLogged: true,
    };
  }

  // ── Step G: Resolve toppings against the found item ───────────────────
  const addToppings: LexiconTopping[] = [];

  for (const addText of addTexts) {
    const cleaned = addText.trim();
    if (!cleaned) continue;

    const match = findToppingInText(cleaned, foundItem.toppings);
    if (match) {
      addToppings.push(match);
    } else if (foundItem.toppings.length > 0) {
      // The shop sells toppings on this item, but not this one.
      console.log(`[resolver] honest-miss: "${cleaned}" not sold on ${foundItem.displayName}`);
      return {
        kind: "honest_miss",
        phrase,
        missedToken: cleaned,
        reason: "topping_not_sold",
        availableInstead: foundItem.toppings.map(t => t.display),
        gapLogged: true,
      };
    }
    // If foundItem.toppings is empty, silently ignore the topping request
    // (the item may be a specialty pizza with no add-on toppings sold).
  }

  return {
    kind: "add_item",
    phrase,
    itemId: foundItem.id,
    itemName: foundItem.displayName,
    quantity: qty,
    addToppings,
    removeToppingNames: removeTexts,
  };
}

// ── LEXICON BUILDER ────────────────────────────────────────────────────────

// Build a read-only MenuLexicon from the raw menu snapshot. This is the
// only place that reads ComposeMenuItem; everything else works on
// MenuLexicon. Items without ask_plan are included (they're orderable
// directly without required choices) but have an empty toppings array.
export function buildLexicon(menu: ComposeMenuItem[]): MenuLexicon {
  const items: LexiconItem[] = menu.map(m => {
    const toppings: LexiconTopping[] = m.ask_plan
      ? m.ask_plan.steps
          .filter(s => s.kind === "modifier")
          .flatMap(s =>
            s.choices.map(c => ({
              id: c.id,
              display: c.display,
              priceDeltaCents: c.price_delta_cents,
            })),
          )
      : [];

    return {
      id: m.id,
      name: m.name,
      displayName: m.ask_plan?.display_name ?? m.name,
      category: m.category ?? "",
      basePriceCents: m.ask_plan?.base_price_cents ?? 0,
      toppings,
      blocked: m.bot_state === "blocked" || m.bot_state === "display_only",
    };
  });

  return { items };
}

// ── ENTRY POINT ────────────────────────────────────────────────────────────

// Resolve a full customer utterance into a list of independent operations,
// one per phrase. Phrase isolation is guaranteed by construction:
// splitPhrases() runs first, resolvePhrase() sees exactly one phrase string.
export function resolveUtterance(utterance: string, menu: ComposeMenuItem[]): ResolvedOp[] {
  const lexicon = buildLexicon(menu);

  // Whole-utterance exact match, BEFORE splitPhrases. Some real dish names
  // contain a comma ("Chicken, Ranch & Bacon Pan Pizza") or the word "with"
  // ("Sauteed Pierogies With Onions (5)") as part of the name itself, not as
  // a customer-intended phrase separator or topping clause. splitPhrases and
  // resolvePhrase's "with X" parsing would otherwise carve a name like that
  // into the wrong pieces before item matching ever runs. An exact match of
  // the ENTIRE utterance against a real item's own display name is
  // authoritative — it is what the customer said, verbatim — so it takes
  // priority over every phrase-splitting and clause-parsing heuristic below.
  const wholeUtteranceMatch = findExactItemMatch(utterance, lexicon);
  if (wholeUtteranceMatch) {
    return [{
      kind: "add_item",
      phrase: utterance.trim(),
      itemId: wholeUtteranceMatch.id,
      itemName: wholeUtteranceMatch.displayName,
      quantity: 1,
      addToppings: [],
      removeToppingNames: [],
    }];
  }

  return splitPhrases(utterance, lexicon).map(p => resolvePhrase(p, lexicon));
}

// ── CART APPLICATOR ────────────────────────────────────────────────────────

// Apply resolved operations to a starting cart (read-only copy) and return
// the resulting cart state. For test assertions only — not wired into the
// live ordering path (which has its own cart and pricing modules).
export function applyOps(ops: ResolvedOp[], startingCart: CartState[]): CartState[] {
  const cart: CartState[] = startingCart.map(c => ({ ...c, toppings: [...c.toppings] }));

  for (const op of ops) {
    if (op.kind === "add_item") {
      cart.push({
        itemId: op.itemId,
        itemName: op.itemName,
        quantity: op.quantity,
        toppings: op.addToppings.map(t => t.display),
      });
    } else if (op.kind === "remove_topping") {
      const hint = op.targetItemHint.toLowerCase();
      const toppingLower = op.toppingName.toLowerCase();
      // Find the most recently added cart line whose name matches the hint.
      for (let i = cart.length - 1; i >= 0; i--) {
        const nameLower = cart[i].itemName.toLowerCase();
        if (nameLower.includes(hint) || hint.split(/\s+/).some(w => w.length >= 4 && nameLower.includes(w))) {
          cart[i].toppings = cart[i].toppings.filter(
            t => !t.toLowerCase().includes(toppingLower),
          );
          break;
        }
      }
    }
    // honest_miss and ask_ambiguity never mutate the cart.
  }

  return cart;
}
