// GUARD 20 pure decision core (2026-09-08, customer-CRM build,
// docs/specs/2026-09-03-customer-crm.md, AC6).
//
// "The regular" (a favorite item with >= 3 paid orders, computed server-side
// in _shared/customer-profile.ts and injected into the system prompt) is an
// OFFER, never a silent add — the spec's own AC6 and this project's standing
// CartOps never-auto-add rule. The system prompt instructs the model to
// offer it and wait, but a prompt instruction is advisory, not enforcement —
// every other high-stakes cart rule in this file (GUARD 9, GUARD 13, ...) is
// backed by a deterministic code guard for exactly that reason. This is that
// guard for the regular-item path specifically.
//
// The item may reach the cart ONLY when BOTH hold this turn:
//   (a) the bot's own IMMEDIATELY PRECEDING message actually offered this
//       exact item (named it, or said "regular"/"usual") — never a stale
//       offer from earlier in the conversation (the same "Luca" incident
//       shape GUARD 9 already guards against: an old unresolved offer sitting
//       in history is not consent), and
//   (b) the customer's message THIS turn either confirms (impliesOrderConfirmation
//       — "yes", "sounds good", ...) or explicitly invokes "the regular"/
//       "my usual"/"same as last time" itself.
// Anything else — including the customer saying "I want the regular" with no
// prior offer on the table, which must still be answered with an offer, not
// an immediate add — is unauthorized, and any new line for that item this
// turn is reverted (not the whole cart, unlike GUARD 19: here the specific
// unauthorized item is known).

import { impliesOrderConfirmation } from "./guard9-unconsented-affirmation.ts";

const REGULAR_INVOCATION_RE =
  /\b(?:the\s+|my\s+)?(?:regular|usual)\b|\bsame\s+as\s+(?:usual|last\s+time|always)\b/i;

export function mentionsRegularInvocation(message: string): boolean {
  return REGULAR_INVOCATION_RE.test(message);
}

function namesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  return na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na));
}

/**
 * Did the bot's own immediately-preceding message actually put this specific
 * item on the table — by name, or by saying "regular"/"usual" generically
 * (the system prompt's own instructed vocabulary for the offer)? This is the
 * "freshness" check that stops a stale offer from being reactivated by an
 * unrelated later "yes" — same incident class GUARD 9 already guards
 * against for upsell offers.
 */
export function priorTurnOfferedRegular(
  priorAssistantMessage: string | null | undefined,
  regularItemName:       string,
): boolean {
  if (!priorAssistantMessage) return false;
  if (namesMatch(priorAssistantMessage, regularItemName)) return true;
  return /\b(?:regular|usual)\b/i.test(priorAssistantMessage);
}

/**
 * Combines both conditions above into the single "is this turn's regular-item
 * add authorized" answer. Exported separately from computeGuard20 so index.ts
 * can reuse the EXACT same authorization logic to extend GUARD 9/13's own
 * "was this item named this turn" predicate — without that, GUARD 9 would
 * revert a legitimately-confirmed regular-item add as an unconsented
 * affirmation-triggered growth (it has no concept of "the regular" at all).
 * One authorization function, three call sites, matching the DRY precedent
 * pending-disambiguation.ts already sets for shared resolution logic.
 */
export function regularItemAuthorizedThisTurn(
  userMessage:            string,
  priorAssistantMessage:  string | null | undefined,
  regularItemName:        string,
): boolean {
  if (!priorTurnOfferedRegular(priorAssistantMessage, regularItemName)) return false;
  return impliesOrderConfirmation(userMessage) || mentionsRegularInvocation(userMessage);
}

export interface Guard20CartLine {
  menu_item_id?: string;
  name?:         string;
  quantity?:     number;
  /** Customer-chosen option selections, e.g. { Toppings: ["Pepperoni"] }. */
  options?:      Record<string, string[]> | null;
  /** Free-text modifiers carried on the line. */
  modifiers?:    unknown[] | null;
}

/**
 * A line that carries option or modifier choices is NOT the bare regular being
 * silently re-added — it is a different order that happens to share the regular's
 * base menu row.
 *
 * Vito's "Cheese - Large (16\")" is both the plain pizza and the base row for every
 * topped large pizza. A returning customer whose regular is that plain pizza asking
 * for "a large pepperoni pizza" produces a line with the same name and id plus
 * Toppings: ["Pepperoni"]. Before this check, GUARD 20 reverted it and re-offered the
 * regular, so the pizza silently vanished from the cart and only the side survived —
 * observed live 2026-09-11 on the demo shop.
 *
 * The guard's purpose is to stop the model slipping the regular in unasked. An
 * explicit option choice is the customer describing the item themselves, which is the
 * opposite of that, so those lines are left alone.
 */
function carriesExplicitChoices(line: Guard20CartLine): boolean {
  const opts = line.options;
  if (opts && typeof opts === "object") {
    for (const sels of Object.values(opts)) {
      if (Array.isArray(sels) && sels.length > 0) return true;
    }
  }
  return Array.isArray(line.modifiers) && line.modifiers.length > 0;
}

export interface RegularOfferContext {
  name: string; // the eligible regular item's name (favorite_items[0].name, count >= 3)
}

export interface Guard20Result<T> {
  tripped:  boolean;
  reverted: T[]; // the specific unauthorized new line(s) for the regular item, by object identity
}

/**
 * `isItemNamedThisTurn` is the SAME caller-supplied predicate GUARD 9/13 use
 * (ordinary menu-item naming, built from buildMenuItemNames +
 * extractCustomerReferencedItems in index.ts) — a genuinely, ordinarily
 * named order for this item (e.g. the customer just said "large pepperoni
 * pizza" and it happens to be their regular) is not this guard's business at
 * all; it is caller's responsibility to fold regularItemAuthorizedThisTurn
 * into that same predicate so GUARD 9/13 and this guard agree on what counts
 * as grounded.
 */
export function computeGuard20<T extends Guard20CartLine>(
  cartSnapshotBeforeTurn: T[],
  guardCart:              T[],
  regularItem:            RegularOfferContext | null,
  isItemNamedThisTurn:    (itemName: string) => boolean,
): Guard20Result<T> {
  if (!regularItem) return { tripped: false, reverted: [] };
  if (isItemNamedThisTurn(regularItem.name)) return { tripped: false, reverted: [] };

  const beforeQtyById = new Map<string, number>();
  for (const item of cartSnapshotBeforeTurn) {
    if (!item.menu_item_id) continue;
    beforeQtyById.set(item.menu_item_id, (beforeQtyById.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  const reverted: T[] = [];
  for (const line of guardCart) {
    if (!line.name || !namesMatch(line.name, regularItem.name)) continue;
    if (carriesExplicitChoices(line)) continue; // a topped variant is not the bare regular
    const before = line.menu_item_id ? (beforeQtyById.get(line.menu_item_id) || 0) : 0;
    if (before > 0) continue; // already legitimately in the cart before this turn
    reverted.push(line);
  }

  return { tripped: reverted.length > 0, reverted };
}
