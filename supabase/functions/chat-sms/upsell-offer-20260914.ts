// Item C (2026-09-14 burn-down): code-rendered upsell offer.
//
// ROOT CAUSE this closes (confirmed via live diagnostic, not assumed): the
// model DOES attempt a same-turn upsell sentence after adding a base item
// whose menu_items.upsell field is populated — e.g. "French Fries added!
// Want a Coke with that for $2.99?" — every single time, per the UPSELL
// RESTRAINT/UPSELL GUARD prompt rules. But action-confirmation.ts's
// extractQuestionsOnly (see its own header comment) deliberately drops any
// kept sentence that names a known cart/menu item or contains anything
// price-shaped — a real upsell offer, by definition, does both. That filter
// is correct and load-bearing for the reply-inversion money-safety
// guarantees (docs/specs/2026-09-13-reply-inversion.md); the fix is to stop
// asking the model's prose to carry this one sentence and render it from
// CODE instead, same discipline action-confirmation.ts already applies to
// the cart-mutation fact sentence itself.
//
// Scope: pure decision/render logic only, no I/O — same discipline as
// action-confirmation.ts / guard20-regular-offer-confirmation.ts. index.ts
// wires this to the real cart-mutation event, effectiveMenu, and history.

/**
 * menu_items.upsell (migration 050) is a semicolon-separated list of
 * "Name +Price" entries, e.g. "Shrimp +6.00; Black Diamond Steak +8.00".
 * Some shops instead record free-text cross-sell prose with no parseable
 * item+price ("Substitute side for an upcharge", "suggest a drink",
 * "add extra dressing") — that shape names no single real item to render a
 * deterministic offer for, so it is intentionally left alone (no offer
 * fires) rather than guessed at. Returns the name half of the FIRST entry
 * that matches the "Name +Price" shape, per the PO's explicit call: pick
 * the first listed option, not the cheapest/priciest/all of them. The price
 * half is deliberately NOT returned here — callers must resolve the name
 * against the real, currently-active menu and use ITS price, never trust
 * this string's dollar figure blindly (the menu may have drifted since the
 * upsell field was written).
 */
const NAME_PRICE_RE = /^(.+?)\s*\+\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/;

export function firstParseableUpsellName(upsellField: string): string | null {
  for (const raw of upsellField.split(";")) {
    const m = raw.trim().match(NAME_PRICE_RE);
    if (m) return m[1].trim();
  }
  return null;
}

export interface UpsellOffer {
  name:       string; // real, currently-active menu item name (canonical casing)
  priceCents: number; // real, currently-active menu item price — never the raw upsell string's figure
}

/**
 * The offer sentence is CODE-rendered, byte-for-byte, deliberately in a
 * fixed shape — this exact phrasing is both what the customer sees AND the
 * only marker this module ever looks for to answer "did we already offer
 * this conversation" (alreadyOfferedUpsellThisConversation below) and "what
 * item did that offer name" (extractOfferedItemName below). One writer, one
 * reader convention, same as action-confirmation.ts's renderActionConfirmation.
 */
export function renderUpsellOfferSentence(offer: UpsellOffer): string {
  return `Want to add ${offer.name} for $${(offer.priceCents / 100).toFixed(2)}?`;
}

const OFFER_SENTENCE_RE = /\bWant to add (.+?) for \$(\d+(?:\.\d{2}))\?/i;

/**
 * "Already offered this conversation" — scanned from ordinary conversation
 * history rather than a new DB column (PO directive, item C: prefer
 * existing state over new machinery when it is reliable enough). Reliable
 * here BECAUSE renderUpsellOfferSentence is the only writer of this exact
 * phrase anywhere in the codebase — the model's own free-text upsell
 * attempts never reach the customer (extractQuestionsOnly strips them), so
 * there is no other source that could produce a false positive from a real
 * upsell turn. A model reply on a NON-mutating turn could in principle
 * coincidentally match this phrasing; the cost of that false positive is
 * skipping a future offer, never a double offer or a wrong charge —
 * "missing beats wrong", the standing rule this codebase's guards already
 * apply everywhere else.
 */
export function alreadyOfferedUpsellThisConversation(
  history: Array<{ role: string; content: unknown }>,
): boolean {
  return history.some(h =>
    h.role === "assistant" &&
    typeof h.content === "string" &&
    OFFER_SENTENCE_RE.test(h.content),
  );
}

/**
 * Did the bot's own IMMEDIATELY PRECEDING message make this exact offer?
 * Same freshness discipline as GUARD 20's priorTurnOfferedRegular — an
 * offer from several turns back is not live consent for a later bare "yes"
 * (the 2026-09-06 "Luca" incident shape). Returns the offered item's name
 * (as it appeared in the offer sentence — callers still re-resolve it
 * against the live menu before adding anything) or null when the prior
 * message wasn't this module's offer at all.
 */
export function extractOfferedItemName(priorAssistantMessage: string | null | undefined): string | null {
  if (!priorAssistantMessage) return null;
  const m = priorAssistantMessage.match(OFFER_SENTENCE_RE);
  return m ? m[1].trim() : null;
}

/**
 * Full decision: should THIS turn's "added" event carry a code-rendered
 * upsell offer, and if so, for what (real, currently-active) menu item?
 *
 * `hasPendingRequiredQuestion` preserves the "at most one question per
 * turn" property — a required slot question (e.g. "How would you like that
 * cooked?") always wins over an optional upsell offer. The item is not
 * reconsidered for an offer on a later turn once this fires false for that
 * reason (index.ts only calls this once, for the turn's own "added" event);
 * this is a deliberate scope limit, not an oversight — see index.ts's call
 * site comment.
 */
export function computeUpsellOffer(
  upsellField:                 string | null | undefined,
  upsellEnabled:                boolean,
  hasPendingRequiredQuestion:   boolean,
  history:                      Array<{ role: string; content: unknown }>,
  lookupActiveMenuItem:         (name: string) => { name: string; price_cents: number } | null,
): UpsellOffer | null {
  if (!upsellEnabled || !upsellField || hasPendingRequiredQuestion) return null;
  if (alreadyOfferedUpsellThisConversation(history)) return null;
  const candidateName = firstParseableUpsellName(upsellField);
  if (!candidateName) return null;
  const resolved = lookupActiveMenuItem(candidateName);
  if (!resolved) return null;
  return { name: resolved.name, priceCents: resolved.price_cents };
}
