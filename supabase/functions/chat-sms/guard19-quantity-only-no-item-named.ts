// GUARD 19 pure decision core (2026-09-08, customer-CRM build,
// docs/specs/2026-09-03-customer-crm.md).
//
// SAME SHAPE AS TODAY'S P0 INCIDENT (commit b865d3a, Zio's real-money bug):
// a customer typed "reset" then "I want four large pizzas" — naming ZERO
// specific pizza types — and the bot filled the cart with pizza types
// inherited from an EARLIER conversation, priced at $89.95. That incident's
// root cause (RESET not clearing conversation history) is fixed. This guard
// exists because the CRM build deliberately does the SAME kind of thing on
// purpose: it injects prior-order context (favorite items, "the regular")
// into the system prompt so the bot CAN offer a returning customer their
// usual. Any mechanism that hands the model prior-order context is a lever
// the model could pull to invent a cart on a vague quantity-only message —
// intentional context injection is not immune to the same failure shape
// that unintentional context leakage caused.
//
// The rule: if the customer's OWN message this turn names a QUANTITY
// ("four", "4", "a couple") but names ZERO menu items, then whatever the
// model added this turn has no textual grounding in this turn's message at
// all — it can only have come from remembered/injected context, never from
// what the customer actually said. That is never sufficient grounds to
// charge a customer for specific items (CartOps never-auto-add rule): an
// item may only reach the cart because the customer named it THIS turn, or
// because the customer explicitly confirmed a specific item the bot just
// offered THIS turn (see GUARD 20). A bare quantity with no item satisfies
// neither, so ANY cart growth this turn is reverted in full and the bot
// must ask a clarifying question instead of guessing.
//
// Deliberately a FULL revert (restore the exact pre-turn snapshot), not a
// selective one like GUARD 9/13: with zero items named, there is no
// legitimate signal in this turn's message to partially preserve — every
// line that grew is equally ungrounded.

export interface Guard19CartLine {
  menu_item_id?: string;
  name?:         string;
  quantity?:     number;
}

// "four", "4", "a couple", "a few", "several" — every ordinary way a
// customer states a bare quantity. Deliberately excludes "a dozen"/"half
// dozen" (the bundle flow, start_bundle, is a distinct and already-guarded
// mechanism with its own explicit flavor-selection steps) and excludes
// "one" alone used as a filler pronoun (matching pending-disambiguation.ts's
// own documented reasoning for the same exclusion) — "one" only counts here
// as part of "just one"/"only one" phrasing, not bare "one".
const QUANTITY_RE =
  /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?|a\s+few|several|just\s+one|only\s+one)\b/i;

/**
 * Does this message state a bare quantity? Pure string check — grounding
 * (whether any menu item was ALSO named) is a separate, caller-supplied
 * check, since it depends on the shop's actual menu.
 */
export function statesQuantity(message: string): boolean {
  return QUANTITY_RE.test(message);
}

export interface Guard19Result<T> {
  tripped:      boolean;
  revertedCart: T[]; // exact pre-turn snapshot when tripped; unchanged guardCart otherwise
}

/**
 * `namedItemCount` is the caller-supplied count of menu items the customer's
 * OWN message this turn named (index.ts derives it the same way GUARD 9/13
 * do, via buildMenuItemNames + extractCustomerReferencedItems — kept out of
 * this module so it stays pure cart-array/string logic, same precedent as
 * those guards).
 */
export function computeGuard19<T extends Guard19CartLine>(
  userMessage:            string,
  cartSnapshotBeforeTurn: T[],
  guardCart:              T[],
  namedItemCount:         number,
): Guard19Result<T> {
  if (namedItemCount > 0) return { tripped: false, revertedCart: guardCart };
  if (!statesQuantity(userMessage)) return { tripped: false, revertedCart: guardCart };

  const qtyBefore = new Map<string, number>();
  for (const item of cartSnapshotBeforeTurn) {
    if (!item.menu_item_id) continue;
    qtyBefore.set(item.menu_item_id, (qtyBefore.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }
  const qtyAfter = new Map<string, number>();
  for (const item of guardCart) {
    if (!item.menu_item_id) continue;
    qtyAfter.set(item.menu_item_id, (qtyAfter.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  let grew = qtyAfter.size !== qtyBefore.size;
  if (!grew) {
    for (const [id, after] of qtyAfter) {
      if (after > (qtyBefore.get(id) || 0)) { grew = true; break; }
    }
  }
  if (!grew) return { tripped: false, revertedCart: guardCart };

  // Deep clone (JSON round-trip, matching index.ts's own cartSnapshotBeforeTurn
  // idiom) — cart lines nest arrays/objects (modifiers, options), and a
  // shallow copy would leave those shared by reference with the pristine
  // snapshot the caller still holds.
  return { tripped: true, revertedCart: JSON.parse(JSON.stringify(cartSnapshotBeforeTurn)) };
}
