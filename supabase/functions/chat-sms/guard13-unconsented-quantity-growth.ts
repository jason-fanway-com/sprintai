// GUARD 13 pure decision core (2026-09-07, Jason: quantity-doubling on an
// unrelated reply while a required option is still pending).
//
// CONFIRMED live against Zio's (session zios-bug3-repro-6-512ad83d...):
// turn 1 "large buffalo chicken pizza" -> cart qty=1, $19.99; turn 2
// "pickup" (a single, non-retried message, nothing to do with the pizza or
// its options) -> cart qty=2, $19.99. Root cause: the system prompt tells
// the model to call add_item immediately for an item with a pending
// required option (correct, turn 1), but nothing forbids the model from
// reaching for add_item AGAIN on a LATER, unrelated turn while that option
// is still open. add_item's own phantom-add guard only engages when the
// repeat call carries new `options` resolving the pending group — a repeat
// call with NO options falls to the plain existing-line match (same
// menu_item_id, options both undefined) and stacks quantity, exactly like a
// genuine "add another one" would.
//
// Distinct from GUARD 9 (guard9-unconsented-affirmation.ts): GUARD 9 only
// evaluates on a BARE AFFIRMATION (impliesOrderConfirmation — "yes", "looks
// good", ...); this bug's trigger ("pickup") is not an affirmation at all,
// so GUARD 9 never sees it.
//
// Extracted into its own importable module for the same reason GUARD 9 was
// (see that module's header): a hand-copied mirror in a test can pass while
// the real wiring in index.ts is broken. This keeps the decision logic
// testable against the REAL function.

export interface Guard13CartLine {
  menu_item_id?:     string;
  name?:             string;
  quantity?:         number;
  options?:          Record<string, string[]>;
  pending_options?:  string[];
}

export interface Guard13Revert<T> {
  item:      T;
  priorQty:  number;
}

/**
 * Decide which lines had unconsented quantity growth this turn. A line
 * qualifies only when ALL of:
 *   (a) it already had an open required option BEFORE this turn,
 *   (b) its quantity grew this turn,
 *   (c) its `options` are byte-identical before and after (nothing was
 *       actually resolved — a real resolution is not this bug's shape and
 *       must never be reverted), and
 *   (d) the customer's OWN message this turn never named the item (so a
 *       genuine "another one, please" — which does name the item — is left
 *       alone).
 *
 * `isItemNamedThisTurn` mirrors GUARD 9's own caller-supplied check
 * (index.ts derives it from buildMenuItemNames + extractCustomerReferencedItems,
 * which stay in index.ts since they depend on the shop's menu shape).
 */
export function computeGuard13<T extends Guard13CartLine>(
  cartSnapshotBeforeTurn: T[],
  guardCart:              T[],
  isItemNamedThisTurn:    (itemName: string) => boolean,
): Array<Guard13Revert<T>> {
  const beforeById = new Map<string, T>();
  for (const item of cartSnapshotBeforeTurn) {
    if (!item.menu_item_id) continue;
    beforeById.set(item.menu_item_id, item);
  }

  const reverts: Array<Guard13Revert<T>> = [];
  for (const item of guardCart) {
    if (!item.menu_item_id) continue;
    const before = beforeById.get(item.menu_item_id);
    if (!before) continue; // brand-new line this turn — not a re-add case
    if ((before.pending_options?.length ?? 0) === 0) continue; // wasn't pending before this turn — ordinary add path
    const qtyBefore = before.quantity || 1;
    const qtyAfter = item.quantity || 1;
    if (qtyAfter <= qtyBefore) continue;
    if (JSON.stringify(before.options ?? null) !== JSON.stringify(item.options ?? null)) continue; // a real resolution happened
    if (isItemNamedThisTurn(item.name ?? "")) continue; // customer actually named this item this turn
    reverts.push({ item, priorQty: qtyBefore });
  }
  return reverts;
}
