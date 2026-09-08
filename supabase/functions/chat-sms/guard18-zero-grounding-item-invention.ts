// GUARD 18 pure decision core (2026-09-08, P0 Zio's real-money incident,
// witnessed live by Jason on Zio's Test Kitchen, 16:27-16:28 UTC):
//
//   CUST: reset
//   BOT:  Session reset. Text when the kitchen is open, or TESTMODE to test again.
//   CUST: I want four large pizzas
//   BOT:  All four large pizzas added: pepperoni, plain cheese, Hawaiian, and
//         meat lovers. [...] $89.95 total
//
// The customer named ZERO pizza types. The four specific types came from
// this SAME conversation's own turns from ~5 hours earlier ("1 pepp, 1
// plain, 1 hawaiin, 1 meat lovers" at 11:38 UTC) — confirmed by reading the
// actual `messages` rows for this conversation_id. `reset` only expires the
// order_carts row; it never truncates or scopes the conversation history fed
// to the model (see the paired fix in index.ts's RESET handler), so all of
// that pre-reset text was still sitting in the model's context window when
// it answered "four large pizzas" and it read the old order as grounding.
//
// The RESET fix closes the specific mechanism that leaked history across a
// reset boundary. This guard is the independent, broader backstop Jason
// asked for: regardless of WHERE stale grounding came from (a reset that
// didn't fully clear, or just a customer's own much-earlier turn in a long
// unreset session), a turn where the customer's own current message names
// not a single menu item must never result in brand-new item lines being
// silently added. "Four large pizzas" is a question ("which four?"), never
// a cart to fill from memory.
//
// Distinct from GUARD 9 (guard9-unconsented-affirmation.ts): GUARD 9 only
// fires on a BARE AFFIRMATION ("yes"/"looks good"/...). "I want four large
// pizzas" is an explicit new request with a stated quantity, not an
// affirmation, so GUARD 9's impliesOrderConfirmation() gate never sees it.
// GUARD 18 has no message-shape gate at all — it fires whenever the
// customer's own words this turn ground NOTHING, on any phrasing.
//
// Deliberately narrower than GUARD 9's growth detection in one respect: it
// only reverts BRAND-NEW menu items (zero quantity before this turn). An
// existing line's quantity growing (e.g. "make it 2") is GUARD 13's
// territory, with its own pending-option nuance, and is left untouched here
// to avoid double-reverting or fighting a sibling guard.

export interface Guard18CartLine {
  menu_item_id?: string;
  name?:         string;
  quantity?:     number;
}

export interface Guard18Result<T> {
  tripped:     boolean;
  phantomAdds: T[];
}

/**
 * FIX (2026-09-08, caught in live regression testing on Vito's BEFORE this
 * guard shipped unreverted): the first version of this guard gated on a
 * single global "did the message name ANY menu item at all" boolean, built
 * from extractCustomerReferencedItems — which does an exact, whitespace-
 * sensitive substring match against each menu item's canonical name. A
 * customer typing "cheeseburger" (no space) never matches the registered key
 * "cheese burger" (from the menu item literally named "Cheese Burger"), so
 * the global boolean was false even though the model correctly resolved and
 * added the right item — and GUARD 18 reverted a completely legitimate,
 * unambiguous single-item order, replying "What would you like to order?"
 * to a cart the customer had just correctly filled.
 *
 * Fixed by switching from one global boolean to a PER-ITEM grounding check
 * (`isItemGroundedThisTurn`), mirroring GUARD 9/13's own per-item shape. The
 * caller combines the existing whole-menu named check with a second,
 * whitespace/punctuation-insensitive direct comparison between the
 * customer's message and the specific item's own name — "cheeseburger"
 * compacts to the same string as "Cheese Burger" and is recognized as
 * grounded, while "I want four large pizzas" still contains no compacted
 * form of "Pepperoni Pizza" / "Hawaiian Pizza" / etc., so the original
 * incident shape still trips correctly.
 */
export function computeGuard18<T extends Guard18CartLine>(
  isItemGroundedThisTurn: (itemName: string) => boolean,
  cartSnapshotBeforeTurn: T[],
  guardCart:              T[],
): Guard18Result<T> {
  const qtyBefore = new Map<string, number>();
  for (const item of cartSnapshotBeforeTurn) {
    if (!item.menu_item_id) continue; // skip bundles
    qtyBefore.set(item.menu_item_id, (qtyBefore.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  const phantomAdds: T[] = [];
  for (const item of guardCart) {
    if (!item.menu_item_id) continue; // skip bundles
    if (qtyBefore.has(item.menu_item_id)) continue; // existed before this turn — not this guard's shape
    if (isItemGroundedThisTurn(item.name ?? "")) continue; // customer's own words this turn grounded THIS item
    phantomAdds.push(item);
  }

  return { tripped: phantomAdds.length > 0, phantomAdds };
}

/** Lowercase, strip everything but letters/digits — so "cheeseburger" and
 *  "Cheese Burger" compare equal regardless of spacing/punctuation. */
export function compactForGrounding(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
