// GUARD 9 pure decision core: on a bare affirmation ("Looks good", "yes",
// "sure", ...) compares total quantity per menu_item_id between the TRUE
// pre-turn cart snapshot and the post-tool-call cart, and decides what
// unconsented growth (if any) must be reverted before the reply ships.
//
// P0 INCIDENT (2026-09-06, Jason's tester "Luca"): an unresolved upsell offer
// sat in conversation history; two turns later "Looks good" was read by the
// model as consent to add all of it. Cart went from 2 items/$37.97 to 4
// items/$74.95 with zero customer intent. See index.ts's comment above GUARD
// 9's call site for the full incident writeup.
//
// FOLLOW-UP INCIDENT (same day, caught by independent QA before ship): the
// first version of this guard was wired to index.ts's `cartItems` variable as
// its "before" snapshot. `cartItems` is mutated IN PLACE by executeTool's
// push()/splice() calls during the tool-execution loop that runs BEFORE this
// guard — so by the time the guard ran, `cartItems` already reflected the
// POST-turn state, `qtyBefore` and `qtyAfter` were computed from the same
// mutated data, and the guard could never trip. This module exists so that
// bug class cannot recur: the pure decision logic below has no access to
// `cartItems` at all — its only inputs are the two arrays the caller
// explicitly passes in. index.ts MUST pass its `cartSnapshotBeforeTurn` (a
// deep clone taken before the tool loop runs, documented at that
// declaration) as `cartSnapshotBeforeTurn` here, never `cartItems`.
//
// Extracted into its own importable module (matching the
// pending-disambiguation.ts / phantom-add-guard.ts precedent) so a test can
// import and exercise the REAL decision function, not a hand-copied mirror.
// A mirror fed clean, independently-constructed before/after arrays is
// exactly why the wiring bug above shipped once already — it can't catch an
// integration bug in how the real code obtains its inputs.

export interface Guard9CartLine {
  menu_item_id?: string;
  name?:         string;
  quantity?:     number;
  options?:      Record<string, string[]>;
}

// Guard 2 / Guard 9 shared helper: does this message imply the customer is
// confirming/closing the order (a BARE affirmation, not a specific ask)?
export function impliesOrderConfirmation(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().trim();
  // FIX (2026-09-06, Jason — live QA, the checkout-gate "coin flip"): "that's
  // it"/"that's all" required the apostrophe (or a literal space) to match —
  // "thats it" (no apostrophe, extremely common in real SMS) silently missed
  // every alternation here, leaving that turn's whole checkout decision to
  // the model's own judgment instead of this deterministic backstop. Same
  // optional-apostrophe pattern this function already uses correctly for
  // "let's go"/"let's do it" below.
  return /\b(?:yes|yeah|yep|yup|confirm|sure|place (?:the |my |an )?order|check out|checkout|that'?s it|that is it|looks good|all good|go ahead|proceed|go for it|do it|send it|pay|ready|done|that'?s all|that is all|all set|i'?m ready|i'?m done|good to go|let'?s go|let'?s do it|place it|ring it up|finalize|submit)\b/i.test(norm) ||
    /^(?:ok|okay|k|kk|fine|perfect|great|awesome|excellent|fantastic|sounds good|good|yes please|do it|let's do this)[.!]?$/i.test(norm);
}

export interface Guard9Result<T> {
  tripped:     boolean;
  phantomAdds: T[];
  qtyReverts:  Array<{ item: T; priorQty: number }>;
}

/**
 * Pure decision core of GUARD 9. `isItemNamedThisTurn` is the caller-supplied
 * "did the customer's own words (this turn's message alone, never history)
 * name this item" check — index.ts derives it from buildMenuItemNames +
 * extractCustomerReferencedItems, which stay in index.ts since they depend on
 * the shop's menu shape and are shared by several other guards. Kept out of
 * this module so the module stays pure cart-array/string logic.
 *
 * Returned `phantomAdds`/`qtyReverts` items are the SAME object references
 * passed in via `guardCart` (never cloned) — callers that need to mutate the
 * live cart by object identity (not by menu_item_id, which can collide across
 * two lines of the same item with different options) can do so directly.
 */
export function computeGuard9<T extends Guard9CartLine>(
  userMessage:            string,
  cartSnapshotBeforeTurn: T[],
  guardCart:              T[],
  isItemNamedThisTurn:    (itemName: string) => boolean,
): Guard9Result<T> {
  if (!impliesOrderConfirmation(userMessage)) {
    return { tripped: false, phantomAdds: [], qtyReverts: [] };
  }

  const fingerprint = (i: T) => `${i.menu_item_id}::${JSON.stringify(i.options ?? undefined)}`;
  const beforeByFingerprint = new Map<string, T>();
  const qtyBefore = new Map<string, number>();
  for (const item of cartSnapshotBeforeTurn) {
    if (!item.menu_item_id) continue; // skip bundles
    beforeByFingerprint.set(fingerprint(item), item);
    qtyBefore.set(item.menu_item_id, (qtyBefore.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }
  const qtyAfter = new Map<string, number>();
  for (const item of guardCart) {
    if (!item.menu_item_id) continue; // skip bundles
    qtyAfter.set(item.menu_item_id, (qtyAfter.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  const phantomAdds: T[] = [];
  const qtyReverts: Array<{ item: T; priorQty: number }> = [];
  for (const [menuItemId, after] of qtyAfter) {
    let delta = after - (qtyBefore.get(menuItemId) || 0);
    if (delta <= 0) continue;
    const postLines = guardCart.filter(i => i.menu_item_id === menuItemId);
    if (isItemNamedThisTurn(postLines[0]?.name ?? "")) continue;

    // Consume the growth against lines whose exact fingerprint already
    // existed before (a real quantity bump on an unchanged line) first, then
    // against lines with no prior fingerprint match at all (a brand-new
    // line) — bounded by `delta` so an unrelated resolved-options line for
    // the same item is never touched once the growth it's responsible for
    // has been fully accounted for.
    for (const line of postLines) {
      if (delta <= 0) break;
      const before = beforeByFingerprint.get(fingerprint(line));
      if (!before) continue;
      const bump = (line.quantity || 1) - (before.quantity || 1);
      if (bump <= 0) continue;
      const take = Math.min(bump, delta);
      qtyReverts.push({ item: line, priorQty: (line.quantity || 1) - take });
      delta -= take;
    }
    for (const line of postLines) {
      if (delta <= 0) break;
      if (beforeByFingerprint.has(fingerprint(line))) continue;
      const lineQty = line.quantity || 1;
      if (lineQty <= delta) {
        phantomAdds.push(line);
        delta -= lineQty;
      } else {
        qtyReverts.push({ item: line, priorQty: lineQty - delta });
        delta = 0;
      }
    }
  }

  return { tripped: phantomAdds.length > 0 || qtyReverts.length > 0, phantomAdds, qtyReverts };
}
