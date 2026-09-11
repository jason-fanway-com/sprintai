// D1 fix (2026-09-08 P0, Zio's live transcript, conversation
// b3dc366c-5e8a-47e2-930b-c384c9778dda): the customer said "1 pepp, 1
// plain, 1 hawaiin, 1 meat lovers" — four named items — and only three
// landed in the cart. Root cause: there is no standalone "Pepperoni Pizza"
// menu item at Zio's — pepperoni only exists as an "Add Toppings" choice on
// the Neapolitan Cheese Pizza — and the LLM never called add_item for
// "pepp" at all. No error, no question, no mention.
//
// A word-overlap detector was tried first and rejected: comparing each
// comma-separated segment's own words against the final cart false-
// positived on "plain" (customer's word for the base cheese pizza — "plain"
// shares NO letters with "Neapolitan Cheese Pizza" at all, so a purely
// textual check cannot tell "correctly resolved via semantic knowledge"
// apart from "genuinely dropped"). Flagging a correctly-added item as
// missing is its own defect — it trains the customer not to trust the
// bot's clarifying questions.
//
// This module checks COUNT instead of identity: when the customer's message
// looks like a quantity-prefixed list ("1 X, 1 Y, 1 Z"), the number of
// listed segments should equal the number of NEW compiled cart lines this
// turn actually created. A shortfall means something named was dropped —
// without the detector ever having to know (or guess) WHICH item, avoiding
// both the typo/semantic-mapping false-positive trap above and the
// fuzzy-alternative-suggestion trap that caused GUARD 4's P0 upsell
// incident (2026-09-06): this module never names a specific item or
// suggests an alternative, it only reports a count gap.
/**
 * Returns the shortfall (segments named minus new compiled lines added) when
 * the customer's message looks like a quantity list and fewer NEW lines
 * landed than were named — 0 when the counts match, or when the message
 * isn't a list (fewer than 2 segments) at all. Only the LENGTH of
 * cartBefore/cartAfter matters, so any cart-line-shaped array works.
 */
import { splitCustomerPhrases } from "./phrase-split.ts";

// PO-mandated structural invariant (2026-09-11, not-forgivable #1 — GUARD
// 7c silently collapsed a 4-item Vito's order to 1 line with a cheerful
// "Got it... Anything else?"): countUnresolvedSegments above is deliberately
// narrow — digit-quantity lists only ("1 X, 1 Y"), by design (see its own
// test "single free-form sentence... out of scope, never flags", using
// "can I get a pepperoni pizza" as the canonical example of what must NOT
// trip it). That narrowness is correct for where it's wired in today (after
// the main LLM/tool loop completes), but it left every DETERMINISTIC
// PRE-LLM guard (7, 7b, 7c, pending-disambiguation/option-answer
// resolution) with NO invariant at all — each can resolve exactly one item
// and `return` before ever reaching countUnresolvedSegments's call site.
// The GUARD 7c incident's actual message ("can I get a chicken bacon ranch
// flatbread, a bbq chicken one with pepperoni on it, a cheesesteak and a
// margherita") has zero digit-quantity segments — countUnresolvedSegments
// would return 0 even if it WERE wired in there.
//
// This is the general-purpose counterpart: splitCustomerPhrases already
// recognizes digit AND article/quantity-word boundaries ("a", "an", "one",
// two, ...), the same primitive every phrase-scoping fix tonight already
// unified on, per PO direction. A guard about to silently confirm-and-
// return after resolving exactly one item must check phraseCountShortfall
// first — independent of WHICH upstream resolver or guard would otherwise
// have caused the miscount, this is the last line of defense, not another
// point patch.
export function phraseCountShortfall(
  currentMessage: string,
  menu: { name: string }[] | undefined,
  linesBefore: number,
  linesAfter: number,
): number {
  const phrases = splitCustomerPhrases(currentMessage, menu);
  if (phrases.length < 2) return 0; // not a multi-item message — no signal either way
  const newLineCount = Math.max(linesAfter - linesBefore, 0);
  if (newLineCount === 0) return 0; // not an add-items turn — same "0 new lines" exemption as countUnresolvedSegments
  const shortfall = phrases.length - newLineCount;
  return shortfall > 0 ? shortfall : 0;
}

export function countUnresolvedSegments(
  currentMessage: string,
  cartBefore: unknown[],
  cartAfter:  unknown[],
): number {
  if (!currentMessage) return 0;
  const segments = currentMessage
    .split(/,| and /i)
    .map(s => s.trim())
    // Only count segments that actually state a quantity — a leading digit
    // run followed by a word boundary. \b after \d+ is what excludes an
    // ordinal ("1st time ordering", "2nd thing") from being misread as a
    // quantity: there's no boundary between a digit and the letter suffix
    // it's glued to, so "1st"/"2nd"/"3rd"/"4th" never match, only a genuine
    // bare count like "2 pizzas" does (2026-09-08, adversarial review —
    // "1st time ordering, 2 pizzas please" was miscounted as 2 segments).
    .filter(s => /^\d+\b/.test(s));
  if (segments.length < 2) return 0;

  const newLineCount = Math.max(cartAfter.length - cartBefore.length, 0);
  // Require at least ONE new line this turn — proves this was genuinely an
  // add-items turn (matching the real repro: cart went from 0 to 3 lines).
  // A turn that adds nothing new (newLineCount === 0) is presumably a pure
  // correction/modify_item turn, not a dropped add — a comma-separated
  // correction like "no, 1 large and 1 small" must never trip this guard.
  if (newLineCount === 0) return 0;
  const shortfall = segments.length - newLineCount;
  return shortfall > 0 ? shortfall : 0;
}
