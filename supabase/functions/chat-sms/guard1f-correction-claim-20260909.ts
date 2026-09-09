// GUARD 1f pure decision core (2026-09-09 P0 live money defect).
//
// Live incident: "Removed the extra cheese from the large ... Anything
// else?" (also seen as "Done - removed the extra cheese from the large
// pizza...") shipped to a real customer while cartBefore === cartAfter
// byte-for-byte -- the Extra Cheese option was still on the line, subtotal
// unchanged. GUARD 1f exists specifically to catch a narrated correction
// with no cart mutation, but its `replyAcknowledgesCart` escape hatch
// (CHANGE 2, 2026-09-04) silenced it here: a false correction claim, to be
// believable, ALWAYS names the item it claims to have fixed ("the large
// pizza"), which is exactly what replyAcknowledgesCart's item-name-substring
// check reads as "coherent, ship it."
//
// CHANGE 2's escape hatch was built for a narrower, weaker signal -- a bare
// quantity phrase ("just one" / "1x") sitting next to "want"/"need" that can
// coincidentally appear inside an ordinary, honest cart recital. An EXPLICIT
// correction verb (removed/fixed/corrected/updated/changed/took off) is a
// different, unambiguous claim: if the cart is byte-identical, that claim is
// false no matter what else the reply mentions. Splitting the two signals so
// only the weak one stays escapable makes the strong one structurally
// impossible to suppress -- the caller in index.ts has no code path left
// that lets an explicit correction claim through on an unchanged cart.

export interface Guard1fCartItem {
  name?: string;
}

/**
 * Does the reply already show plain awareness of the cart -- either generic
 * cart/order vocabulary, or naming something actually in `cart`? Used only
 * to gate the WEAK/ambiguous correction signal below; never the explicit one.
 */
export function replyAcknowledgesCart(reply: string, cart: Guard1fCartItem[]): boolean {
  const text = (reply ?? "").trim();
  if (text.length === 0) return false;

  if (/\b(?:cart|order|added|got it|that'?s|so far|total)\b/i.test(text)) return true;

  const norm = text.toLowerCase();
  for (const item of cart) {
    const name = (item.name ?? "").toLowerCase();
    if (!name) continue;
    if (norm.includes(name)) return true;
    const words = name.split(/[^a-z0-9]+/).filter(w => w.length > 3);
    if (words.some(w => norm.includes(w))) return true;
  }
  return false;
}

/**
 * Unambiguous correction verbs. Never escapable by replyAcknowledgesCart --
 * see module header. cartBefore/cartAfter are compared by JSON identity, the
 * same authoritative check the rest of the guard chain uses.
 */
export function claimsExplicitCorrectionWithoutMutation(
  reply: string,
  cartBefore: unknown[],
  cartAfter: unknown[],
): boolean {
  if (!reply) return false;
  if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter)) return false;
  return /\b(?:fixed|corrected|updated|changed|adjusted|removed|took\s+(?:that|it)\s+off|took\s+(?:that|it)\s+out)\b/i
    .test(reply.toLowerCase());
}

/**
 * Weaker, genuinely ambiguous signal (CHANGE 2, 2026-09-04): a bare quantity
 * phrase next to want/need language, which can appear inside an honest cart
 * recital. Callers must additionally check !replyAcknowledgesCart before
 * treating this as a false claim.
 */
export function claimsAmbiguousCorrectionWithoutMutation(
  reply: string,
  cartBefore: unknown[],
  cartAfter: unknown[],
): boolean {
  if (!reply) return false;
  if (JSON.stringify(cartBefore) !== JSON.stringify(cartAfter)) return false;
  const norm = reply.toLowerCase();
  return /\b(?:just\s+one|only\s+one|1x|one\s+(?:left|now|total)|that'?s\s+one)\b/i.test(norm) &&
    /\b(?:want|wanted|said|asked|meant|need|needed)\b/i.test(norm);
}

export interface Guard1fResult {
  tripped: boolean;
  reason: "explicit" | "ambiguous" | null;
}

/**
 * The single call index.ts makes. Explicit correction claims trip
 * unconditionally on an unchanged cart; the ambiguous signal only trips when
 * the reply ALSO shows no plain awareness of the real cart contents.
 */
export function evaluateGuard1f(
  reply: string,
  cartBefore: Guard1fCartItem[],
  cartAfter: Guard1fCartItem[],
): Guard1fResult {
  if (claimsExplicitCorrectionWithoutMutation(reply, cartBefore, cartAfter)) {
    return { tripped: true, reason: "explicit" };
  }
  if (claimsAmbiguousCorrectionWithoutMutation(reply, cartBefore, cartAfter) && !replyAcknowledgesCart(reply, cartAfter)) {
    return { tripped: true, reason: "ambiguous" };
  }
  return { tripped: false, reason: null };
}
