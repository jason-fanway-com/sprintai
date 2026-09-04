// Guard 1d helper: detects when the model's reply claims an item was added
// ("added X to your cart", "I've added X for ya") but the cart didn't actually
// change this turn. Pure + side-effect free so it can be unit-tested without
// importing the edge entrypoint (index.ts calls Deno.serve at module load).
//
// 2026-09-02 money bug (NJB menu-single-504): the bot said "I've added a
// Pumpernickel Bagel for ya" with an EMPTY cart. The old regex only accepted
// "for you" / "to your cart", so the guard stayed silent and the ungrounded
// reply shipped. See guard-phantom-add.test.ts for the pinned red-then-green.

// Only length + structural identity (via JSON.stringify) matter here, so the
// cart params are typed `unknown[]` — any concrete cart-item array is assignable.
// Narration that legitimately says "added" WITHOUT changing cart_json: money
// lines, kitchen notes, prep instructions. Applied to the captured object of an
// add-claim, never to the whole reply — a reply can both drop an item and
// mention a fee, and we must still catch the dropped item.
// Narration that legitimately says "added" WITHOUT changing cart_json: money
// lines, kitchen notes, prep instructions. Applied to the captured OBJECT of an
// add-claim, never to the whole reply - a reply can both drop an item and
// mention a fee, and we must still catch the dropped item.
// Plurals included: "added the allergy notes" must not trip the guard.
const NON_ITEM_NARRATION =
  /\b(?:tip|fee|service|gratuity|surcharge|note|discount|coupon|delivery|checkout|instruction|preference|request|allergy|charge|tax)s?\b/i;

// A capitalised word after "for" is only a person if it is not a fulfilment
// method or a time. "Added the pizza for Pickup" / "for Friday" are not adds
// addressed to a human.
const NOT_A_PERSON =
  /^(?:pickup|pick|delivery|takeout|carryout|here|later|now|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunch|dinner|breakfast|brunch|free)$/i;

// Verbs that assert an add. "put" is deliberately NOT here on its own: bare
// "put" matches scheduling narration ("I'll put your order in for Pickup"),
// which is not a cart claim. Only first-person "I put" / "I've put" qualify.
const ADD_VERB = "(?:i['\"\u2019]?ve\\s+added|i\\s+added|added|i['\"\u2019]?ve\\s+put|i\\s+put|threw|tossed)";
const ITEM = "([\\w][\\w\\s&'()/-]{0,60}?)";

// (1a) Explicit cart phrasing, or a recipient named by relationship/pronoun.
//      SEV-1 (2026-09-04): the recipient is not always the customer. A real
//      order dropped an $11.99 item on "Added the Chicken Parmesan sandwich for
//      mom (comes with fries)!" - "for mom" is not "for you/ya/u", so this
//      stayed silent. Families order together; accept any recipient.
const ADDRESSED = new RegExp(
  `\\b${ADD_VERB}\\s+(?:a|an|the|your|some)?\\s*${ITEM}\\s*(?:to\\s+(?:your|the)\\s+cart|in\\s+(?:your|the)\\s+cart|for\\s+(?:you|ya|u|him|her|them|mom|mum|dad|grandma|grandpa|my\\s+\\w+|your\\s+\\w+|his\\s+\\w+|her\\s+\\w+|the\\s+\\w+))\\b`,
  "i",
);

// (1b) Same, but the recipient is a personal name ("for Jason"). Case-sensitive
//      on the NAME only - hence a separate pattern, because putting /i on the
//      whole thing would make [A-Z] match anything, and dropping /i would stop
//      "Threw"/"Tossed"/"Put" at the start of a sentence from matching at all.
const ADDRESSED_BY_NAME = new RegExp(
  `\\b${ADD_VERB}\\s+(?:a|an|the|your|some)?\\s*${ITEM}\\s*for\\s+([A-Z][a-z]+)\\b`,
);

// (2) Bare item-add claim with no cart/recipient suffix ("I've added a
//     Pumpernickel Bagel!"). Only reached when the cart did NOT change.
//     SEV-1: the terminator set was [.!?\n] only, so the "(" in
//     "...for mom (comes with fries)!" - a parenthetical this bot writes
//     constantly - hid the claim entirely. "(" and end-of-string now terminate
//     the item phrase. Comma/semicolon are deliberately NOT terminators: they
//     let the pattern truncate at a clause boundary and fire on references to
//     earlier adds ("Earlier I added the Greek salad, want me to remove it?").
const BARE = new RegExp(
  `\\b(?:i['"\u2019]?ve\\s+added|i\\s+added|added|i['"\u2019]?ve\\s+put|i\\s+put)\\s+(?:a|an|the|your|some)\\s+${ITEM}\\s*(?:[.!?\\n(]|$)`,
  "i",
);

export function claimsAddedWithoutMutation(
  reply: string,
  cartBefore: unknown[],
  cartAfter: unknown[],
): boolean {
  if (!reply) return false;
  // Quick check: if cart grew, the add was real - no alarm.
  if (cartAfter.length > cartBefore.length) return false;
  // If cart contents changed (different items), the add was real.
  if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter)) return false;
  // Cart is identical (empty or unchanged). Any claim of an item add is phantom.

  const addressed = reply.match(ADDRESSED);
  if (addressed && !NON_ITEM_NARRATION.test(addressed[1])) return true;

  const byName = reply.match(ADDRESSED_BY_NAME);
  if (byName && !NON_ITEM_NARRATION.test(byName[1]) && !NOT_A_PERSON.test(byName[2])) return true;

  if (/\b(?:got\s+you|got\s+that).*(?:added|in\s+(?:your|the)\s+cart)\b/i.test(reply)) return true;

  const bare = reply.match(BARE);
  if (bare && !NON_ITEM_NARRATION.test(bare[1])) return true;

  return false;
}
