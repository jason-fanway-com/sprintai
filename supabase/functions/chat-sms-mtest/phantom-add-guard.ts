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
export function claimsAddedWithoutMutation(
  reply: string,
  cartBefore: unknown[],
  cartAfter: unknown[],
): boolean {
  if (!reply) return false;
  // Quick check: if cart grew, the add was real — no alarm.
  if (cartAfter.length > cartBefore.length) return false;
  // If cart contents changed (different items), the add was real.
  if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter)) return false;
  // Cart is identical (empty or unchanged). Any claim of an item add is phantom.
  //
  // (1) Explicit cart phrasing OR a friendly completion. "for ya"/"for u" are
  //     colloquial variants the bot uses shop-wide.
  if (
    /\b(?:added|i['"]?ve\s+added|i\s+added|put|i['"]?ve\s+put|threw|tossed)\s+(?:a\s+)?.*(?:to\s+(?:your|the)\s+cart|in\s+(?:your|the)\s+cart|for\s+(?:you|ya|u))\b/i
      .test(reply)
  ) return true;
  if (/\b(?:got\s+you|got\s+that).*(?:added|in\s+(?:your|the)\s+cart)\b/i.test(reply)) return true;
  // (2) Bare item-add claim with no cart/completion suffix ("I've added a
  //     Pumpernickel Bagel!"). Only reached when the cart did NOT change, so any
  //     such claim about a food item is phantom. Exclude fee/tip/service/note
  //     narration, which legitimately says "added" without a cart mutation
  //     (e.g. "$2 driver tip added", "service fee added at checkout").
  const bare = reply.match(
    /\b(?:i['"]?ve\s+added|i\s+added|added|i['"]?ve\s+put|i\s+put)\s+(?:a|an|the|your|some)\s+([\w][\w\s&'-]{1,40}?)\s*[.!?\n]/i,
  );
  if (bare) {
    const obj = bare[1].toLowerCase();
    if (!/\b(?:tip|fee|service|gratuity|surcharge|note|discount|coupon|delivery|checkout)\b/.test(obj)) {
      return true;
    }
  }
  return false;
}
