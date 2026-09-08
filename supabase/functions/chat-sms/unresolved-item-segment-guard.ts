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
export function countUnresolvedSegments(
  currentMessage: string,
  cartBefore: unknown[],
  cartAfter:  unknown[],
): number {
  if (!currentMessage) return 0;
  const segments = currentMessage
    .split(/,| and /i)
    .map(s => s.trim())
    .filter(s => /^\d/.test(s)); // only count segments that actually state a quantity
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
