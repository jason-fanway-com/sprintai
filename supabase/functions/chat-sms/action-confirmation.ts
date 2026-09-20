// Reply inversion, stage 1 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
//
// ROOT CAUSE this closes: `reply = loopResult.reply` (index.ts) used to hand
// the model's own free text straight to the customer with zero constraint on
// content whenever a turn's tool loop finished. The 19:07 Vito's live
// incident is the exhaustive proof this was never safe: the model narrated
// "I've got your items: [three items]" against a cart that genuinely held
// two — the arithmetic in the money footer was still correct (it's
// code-rendered), so no guard caught a prose claim about item COUNT/IDENTITY,
// which nothing was watching.
//
// THE RULE (spec): any sentence asserting cart contents, quantities, prices,
// or totals is rendered by CODE from cart_json. The model may add warmth
// around it. It may not author it.
//
// Scope of this module: the single-item action-confirmation sentence for a
// turn that DID mutate the cart ("French Fries added.", "Swapped to
// Pepperoni.") — the one shape the existing itemizer.ts renderers
// (renderItemizedRecap/renderLedgerFooter/renderMissingOptionsPrompt/
// renderDisambiguationReask) don't cover. Pure, no I/O, unit-testable with
// nothing but literals — same discipline as turn-reconciler.ts and cart.ts.
//
// Identity/diffing intentionally reuses turn-reconciler.ts's identityKey —
// there is exactly one notion of "same cart line" in this codebase, and this
// module must not invent a second one.

import { identityKey } from "./turn-reconciler.ts";
import { renderItemizedLine, type ItemizedCartLine } from "./itemizer.ts";

export interface MutationCartLine {
  menu_item_id?: string;
  name?: string;
  quantity?: number;
  options?: Record<string, string[]>;
  modifiers?: string[];
  [key: string]: unknown;
}

export type CartMutationAction =
  | "added"
  | "removed"
  | "qty_set"
  | "corrected"
  | "option_added"
  | "option_removed";

export interface CartMutationEvent {
  action: CartMutationAction;
  itemName: string;
  qty?: number;
  // "corrected" only — the specific option/topping value that changed, when
  // it can be isolated cleanly (e.g. "Pepperoni"). Falls back to itemName
  // when no clean single-value diff exists.
  detailName?: string;
  // "added" / "option_added" only — the actual resulting cart line, so
  // renderActionConfirmation can tell whether it carries options/modifiers
  // worth itemizing (see that function's header).
  line?: MutationCartLine;
}

function isRealLine(l: MutationCartLine): boolean {
  return typeof l.menu_item_id === "string";
}

function keyOf(l: MutationCartLine): string {
  return identityKey(l.menu_item_id as string, l.options);
}

function flattenOptionValues(l: MutationCartLine): string[] {
  const fromOptions = Object.values(l.options ?? {}).flat();
  const fromModifiers = l.modifiers ?? [];
  return [...fromOptions, ...fromModifiers];
}

/**
 * Pure before/after cart diff, scoped to real (non-bundle) lines. Returns the
 * single event that best describes what changed, or null when either nothing
 * changed or the change is too ambiguous (e.g. several unrelated lines
 * touched in one turn) to name safely in one sentence — callers MUST treat
 * null-with-a-structural-difference as "fall back to the full itemized
 * recap", never as "say nothing changed".
 */
export function detectCartMutation(
  before: MutationCartLine[],
  after: MutationCartLine[],
): CartMutationEvent | null {
  const beforeLines = before.filter(isRealLine);
  const afterLines = after.filter(isRealLine);

  const beforeMap = new Map<string, MutationCartLine>();
  for (const l of beforeLines) beforeMap.set(keyOf(l), l);
  const afterMap = new Map<string, MutationCartLine>();
  for (const l of afterLines) afterMap.set(keyOf(l), l);

  const addedKeys = [...afterMap.keys()].filter(k => !beforeMap.has(k));
  const removedKeys = [...beforeMap.keys()].filter(k => !afterMap.has(k));
  const commonKeys = [...afterMap.keys()].filter(k => beforeMap.has(k));

  // Exactly one identity disappeared and exactly one appeared, same base
  // item: the option set on that line changed shape. This is ONLY a true
  // swap/correction ("cheese" -> "pepperoni") when something was actually
  // REMOVED from the option value set. If every prior value is still
  // present and one or more new values were appended (Cheese ->
  // Cheese+Pepperoni), the customer ADDED a topping — cheese never left.
  //
  // 2026-09-13 FAILURE B: this branch used to classify any before/after
  // option diff as "corrected" regardless of whether a removal actually
  // happened, so an addition rendered "Swapped to Pepperoni." — a
  // CODE-authored false claim that the prior topping was gone. Worse than a
  // model hallucination, since nothing downstream questions what the
  // renderer itself asserts.
  if (addedKeys.length === 1 && removedKeys.length === 1) {
    const removedLine = beforeMap.get(removedKeys[0])!;
    const addedLine = afterMap.get(addedKeys[0])!;
    if (removedLine.menu_item_id === addedLine.menu_item_id) {
      const beforeVals = new Set(flattenOptionValues(removedLine).map(v => v.toLowerCase()));
      const afterVals = new Set(flattenOptionValues(addedLine).map(v => v.toLowerCase()));
      const newlyAdded = flattenOptionValues(addedLine).filter(v => !beforeVals.has(v.toLowerCase()));
      const trulyRemoved = flattenOptionValues(removedLine).filter(v => !afterVals.has(v.toLowerCase()));

      if (trulyRemoved.length === 0 && newlyAdded.length > 0) {
        return {
          action: "option_added",
          itemName: addedLine.name ?? "",
          detailName: newlyAdded.length === 1 ? newlyAdded[0] : (addedLine.name ?? undefined),
          line: addedLine,
        };
      }
      if (newlyAdded.length === 0 && trulyRemoved.length > 0) {
        return {
          action: "option_removed",
          itemName: addedLine.name ?? "",
          detailName: trulyRemoved.length === 1 ? trulyRemoved[0] : (addedLine.name ?? undefined),
        };
      }
      // Both a real removal and a real addition within the same option
      // group: a genuine swap.
      return {
        action: "corrected",
        itemName: addedLine.name ?? "",
        detailName: newlyAdded.length === 1 ? newlyAdded[0] : (addedLine.name ?? undefined),
      };
    }
  }

  // Exactly one new identity, zero removals: a single nameable add. Two or
  // more simultaneous new identities (fries + coke added in the same turn)
  // fall through to the `null` at the bottom of this function so the caller
  // falls back to the full itemized recap, per this function's own
  // docstring — naming only the first of several new lines used to drop
  // the rest of the add silently (2026-09-13 soft gap).
  if (addedKeys.length === 1 && removedKeys.length === 0) {
    const line = afterMap.get(addedKeys[0])!;
    return { action: "added", itemName: line.name ?? "", qty: line.quantity ?? 1, line };
  }

  if (removedKeys.length >= 1 && addedKeys.length === 0) {
    const line = beforeMap.get(removedKeys[0])!;
    return { action: "removed", itemName: line.name ?? "" };
  }

  for (const k of commonKeys) {
    const b = beforeMap.get(k)!;
    const a = afterMap.get(k)!;
    const bQty = b.quantity ?? 1;
    const aQty = a.quantity ?? 1;
    if (aQty > bQty) return { action: "qty_set", itemName: a.name ?? "", qty: aQty };
  }

  return null;
}

function lineHasOptions(line: MutationCartLine): boolean {
  return (line.modifiers?.length ?? 0) > 0 ||
    Object.values(line.options ?? {}).some(v => v.length > 0);
}

/**
 * Renders the single deterministic fact sentence for a detected mutation.
 * This is the ONLY function in the codebase permitted to state, in prose,
 * that an item was added/removed/corrected/re-quantified this turn — same
 * "exactly one writer" discipline turn-reconciler.ts applies to the cart
 * array itself, applied here to the CLAIM about the cart array.
 *
 * Rendering-consistency fix (2026-09-14, PO live diagnosis): "added" /
 * "option_added" used to always render bare ("Large Cheese Pizza added.")
 * even when the line just added carries options/modifiers the customer just
 * agreed to pay for (e.g. a $4.50 pepperoni upcharge) — the same fact showed
 * up itemized elsewhere (the ambiguous-diff -> full recap fallback) and bare
 * here, depending only on which path a given turn happened to take. A
 * plain, option-free item (French Fries) still gets the terse form.
 */
export function renderActionConfirmation(
  event: CartMutationEvent,
  priceIndexByMenuItemId?: Map<string, Map<string, number>>,
): string {
  if (event.action === "added" || event.action === "option_added") {
    const line = event.line;
    const priceCents = line ? (line as unknown as { price_cents?: unknown }).price_cents : undefined;
    if (line && lineHasOptions(line) && typeof priceCents === "number") {
      return renderItemizedLine(line as unknown as ItemizedCartLine, priceIndexByMenuItemId);
    }
  }
  switch (event.action) {
    case "added": {
      // PO dispatch 2026-09-20 (real live conv 93559ccf: "I want two
      // Chicken Noodle cups" -> the soup's own cart line lands with the
      // correct quantity (2, confirmed via effectiveAddQuantity/
      // disambiguationQuantity's own carry-through, and via
      // extractDisambiguationAnswerQuantity when the customer restates it)
      // -- but this terse, option-free branch always rendered bare
      // ("Cup Chicken Noodle Soup added."), with no "2x" or count anywhere,
      // regardless of event.qty. The PO's own reading of the transcript
      // ("only 1x, not 2x") was this sentence, not the cart: the charge was
      // always right, but nothing the customer was TOLD ever said 2. Same
      // "a quantity word next to the item name is the quantity" rule
      // already applied to qty_set just above and to index.ts's own
      // qtyPrefixC2b for the legacy engine's equivalent confirmation —
      // extended here so the itemized branch above and this bare branch
      // never disagree about whether quantity gets stated.
      const qty = event.qty ?? 1;
      return `${qty > 1 ? `${qty}x ` : ""}${event.itemName} added.`;
    }
    case "removed":
      return `${event.itemName} removed.`;
    case "qty_set":
      return `${event.itemName} — now ${event.qty}.`;
    case "corrected":
      return `Swapped to ${event.detailName ?? event.itemName}.`;
    case "option_added":
      return `${event.detailName ?? event.itemName} added.`;
    case "option_removed":
      return `${event.detailName ?? event.itemName} removed.`;
  }
}

// A cart FACT (what's in the cart, how many, what it costs) is, in most
// live transcripts this spec is built from, a declarative sentence — "I've
// got your items: X, Y, Z", "Subtotal: $25.99". A genuine VOICE need that
// must survive a mutated turn (the EARLY ORDER TYPE GATE's "pickup or
// delivery?", a clarifying re-ask, an upsell offer) is, in every one of
// those same prompts, phrased as a question.
//
// 2026-09-13 FAILURE A: keeping a sentence purely because it contains "?"
// is NOT sufficient — a false cart-fact claim survives just fine fused into
// the SAME sentence as a genuine question ("...So that's your large cheese
// pepperoni pizza, french fries, and a large plain cheese pizza — confirm?"
// is one interrogative sentence by this module's own sentence-boundary
// rule). The model only has to phrase its lie as part of the confirm
// question to slip through a filter keyed on sentence-final "?" alone.
//
// So a kept (interrogative) sentence is filtered a second time: if it
// contains anything price-shaped, or the name of any known cart/menu item,
// it is dropped outright rather than trusted. This can lose a legitimate
// same-turn upsell mention that happens to name an item — an acceptable
// cost, since the module's own rule is that the model may add warmth, not
// content, around the code-rendered fact; losing warmth is safe, letting an
// item/price claim through is not.
//
// Same sentence-boundary idiom checkout-intent-gate-20260913.ts's
// stripPrematureNameAskSentence already uses, so the two don't disagree on
// where one sentence ends and the next begins.
const PRICE_SHAPED = /\$\s?\d|\b(?:subtotal|total|balance\s+due)\b/i;

// Round 2 (2026-09-13): the item-name/price scrub above catches a claim
// naming WHAT is in the cart but not one asserting HOW MANY things are in
// it — "That's 3 items — confirm?" contains no known item name and no $
// sign, so it sailed straight through despite being the literal shape of
// the origin 19:07 incident (model claimed 3 items against a 2-item cart).
// This also covers a spelled-out quantity glued to an item-category word
// ("your two pizzas and a soda") — again no substring match against any
// single known item name.
const QUANTITY_SHAPED =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(items?|pizzas?|drinks?|orders?|things?|of\s+(?:those|these|them))\b/i;

// Round 2 (2026-09-13), known residual gap: a COLLOQUIAL/abbreviated
// reference to a real item ("the pep pizza" for "Large Cheese Pepperoni
// Pizza") does not substring-match the canonical name and is NOT scrubbed
// by this module. A general abbreviation-matching heuristic (e.g. prefix
// matching against every word of every known item name) was evaluated and
// rejected here: short, common word-fragments ("pep", "reg", "med") are
// prefixes of enough unrelated words and modifier fragments that it would
// reopen the round-1/2 over-strip failure this same round also had to fix
// (see isShortSingleWordName below) at a much larger scale. Left open
// rather than shipped as a guess; see
// extractQuestionsOnly: FAILURE A round 2 — colloquial item reference is a
// known unresolved gap" in action-confirmation.test.ts.

// Round 2 (2026-09-13): a menu item literally named a short, common English
// word ("Side", "Water") makes the substring/word check above fire on
// completely unrelated, harmless customer-facing questions ("anything on
// the side?", "a water with that?"), silently deleting a real question the
// customer asked. Multi-word names ("French Fries", "Large Plain Cheese
// Pizza") are specific enough to keep checking regardless of length; it's
// single-word names short enough to double as ordinary vocabulary that need
// excluding.
function isShortSingleWordName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed) && trimmed.length <= 5;
}

function sentenceAssertsCartFact(sentence: string, knownItemNames: string[]): boolean {
  if (PRICE_SHAPED.test(sentence)) return true;
  if (QUANTITY_SHAPED.test(sentence)) return true;
  const lower = sentence.toLowerCase();
  for (const name of knownItemNames) {
    if (name && !isShortSingleWordName(name) && lower.includes(name.toLowerCase())) return true;
  }
  return false;
}

export function extractQuestionsOnly(modelReply: string, knownItemNames: string[] = []): string {
  const sentences = (modelReply ?? "").split(/(?<=[.!?\n])\s+/).filter(s => s.trim().length > 0);
  const questions = sentences
    .filter(s => s.includes("?"))
    .filter(s => !sentenceAssertsCartFact(s, knownItemNames));
  return questions.join(" ").replace(/\s+/g, " ").trim();
}

// Round 3 (2026-09-14, item H — reply-inversion ESCAPE, Vito's Cheese
// Burger/Temp canary, ~1-in-5 live failure surviving item G): every check
// above (renderActionConfirmation, extractQuestionsOnly/
// sentenceAssertsCartFact) only ever runs on a turn the tool loop actually
// mutated the cart on — index.ts's own `cartMutatedAtLoop` gate leaves
// `reply` as the model's raw, unconstrained text on any turn that did NOT
// mutate the cart, trusting a prompt instruction (ITEM/CART-CLAIM SCOPE)
// alone to keep the model from claiming success it didn't earn. Live
// transcripts prove the model doesn't reliably obey that instruction —
// "Got it - a Cheese Burger added." and "I've got your cheeseburger!" both
// reached the customer on turns where add_item never actually wrote a line
// (subtotal_cents stayed 0 for the rest of both conversations). This is the
// code-level backstop for that path: the same discipline extractQuestionsOnly
// already applies to the MUTATED path's leftover warmth, extended to catch a
// MUTATION CLAIM specifically (not just any item/price mention) — an
// unmutated turn is still allowed to talk about items ("what's in a Cheese
// Burger?"), it just can't claim one was just added.
//
// Loose (whitespace-stripped) item-name matching is deliberate: the false
// claim used the customer's own casual "cheeseburger" (no space) against the
// catalog's "Cheese Burger" (with space) — a plain substring check via
// sentenceAssertsCartFact's un-normalized item list missed it.
const MUTATION_CLAIM_RE =
  /\b(?:added|noted|got\s+(?:it|that|your)|i(?:'ve| have)\s+(?:added|got)|on\s+your\s+order|added\s+(?:it\s+)?to\s+your\s+(?:cart|order))\b/i;

function normalizeCompact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sentenceClaimsMutation(
  sentence: string,
  knownItemNames: string[],
  knownChoiceValues: string[],
): boolean {
  if (!MUTATION_CLAIM_RE.test(sentence)) return false;
  if (sentenceAssertsCartFact(sentence, knownItemNames)) return true;
  const compact = normalizeCompact(sentence);
  for (const name of knownItemNames) {
    const compactName = normalizeCompact(name);
    if (compactName.length >= 4 && compact.includes(compactName)) return true;
  }
  for (const value of knownChoiceValues) {
    const trimmed = (value ?? "").trim();
    if (trimmed.length < 3) continue;
    if (new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i").test(sentence)) return true;
  }
  return false;
}

/**
 * Backstop for the UNMUTATED path (see header above): strips any sentence
 * that claims a cart mutation just happened, when the tool loop's own
 * before/after diff says it did not. Never meaningful to call on a turn that
 * DID mutate — that path's fact sentence is already code-rendered by
 * renderActionConfirmation, and this function has no notion of what a real
 * mutation looks like, only what a FALSE claim of one looks like.
 */
export function stripFalseMutationClaims(
  modelReply: string,
  knownItemNames: string[],
  knownChoiceValues: string[],
): { reply: string; stripped: boolean } {
  const sentences = (modelReply ?? "").split(/(?<=[.!?\n])\s+/).filter(s => s.trim().length > 0);
  const kept = sentences.filter(s => !sentenceClaimsMutation(s, knownItemNames, knownChoiceValues));
  if (kept.length === sentences.length) return { reply: modelReply, stripped: false };
  let reply = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!/\?/.test(reply)) reply = reply ? `${reply} What would you like to order?` : "What would you like to order?";
  return { reply, stripped: true };
}
