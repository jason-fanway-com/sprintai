// GUARD 21 pure decision core (2026-09-12 P0, live money defect on Vito's,
// conv ce84c64b + reproduced flakily against a fresh seed: same shape, ~1
// in ~3 runs).
//
// GUARD 9 catches unconsented cart growth on a bare AFFIRMATION
// ("yes"/"looks good"/...). GUARD 13 catches it on any turn while a
// required option is still pending. GUARD 19 catches it when the message
// states a bare QUANTITY with zero items named. None of the three fire on
// a message that is none of those things -- an ordinary reply that neither
// affirms, states a quantity, nor names anything ("You already know my
// name.", in response to the bot asking for a pickup name).
//
// Live shape: cart already correctly held one Large Cheese Pizza + whole-
// pizza pepperoni ($21.00) after a prior turn. The bot asked "What's your
// name for the order?"; the customer replied "You already know my name." --
// carrying zero item reference and zero quantity language, pure
// conversational redirect. The model (non-deterministically -- confirmed by
// re-running the identical sequence, which reproduced clean about 2 times in
// 3) re-issued add_item for the SAME line already in the cart, doubling
// quantity to 2 ($42.00) with no textual grounding for the second unit
// anywhere in this turn's message.
//
// The general invariant CartOps requires (never-auto-add; only what the
// customer names this turn, or an authorized regular/offer confirmation,
// may grow the cart) already holds for the three narrower trigger shapes.
// This guard is the general backstop: ANY turn where the customer's own
// message carries NEITHER a named item NOR a quantity word is, by
// construction, incapable of legitimately grounding new growth -- whatever
// grew came from remembered/injected context or model drift, never from
// what was actually said. Deliberately still uses PER-ITEM selective
// revert (like GUARD 9), not GUARD 19's full-cart revert: with a real,
// correctly-resolved cart already in place, only the ungrounded growth
// itself should be undone, not the whole order.
//
// Kept as its own small pure module (matching the guard9/13/19 precedent,
// see guard9's own header for why a shared/mirrored diff was rejected)
// so this stays independently testable against the real before/after
// shapes without depending on any other guard's internals.

export interface Guard21CartLine {
  menu_item_id?: string;
  name?:         string;
  quantity?:     number;
  options?:      Record<string, string[]>;
}

export interface Guard21Result<T> {
  tripped:     boolean;
  phantomAdds: T[];
  qtyReverts:  Array<{ item: T; priorQty: number }>;
}

/**
 * `hasAnyOrderingSignal` is true iff this turn's message named at least one
 * menu item OR stated a bare quantity (caller-supplied — index.ts already
 * computes both for GUARD 9/13/19 and reuses them here, never recomputed).
 * When true, this guard is a no-op: some other guard's own named-item check
 * already governs whether growth is legitimate.
 */
export function computeGuard21<T extends Guard21CartLine>(
  cartSnapshotBeforeTurn:  T[],
  guardCart:               T[],
  hasAnyOrderingSignal:    boolean,
): Guard21Result<T> {
  if (hasAnyOrderingSignal) return { tripped: false, phantomAdds: [], qtyReverts: [] };

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
    if (!item.menu_item_id) continue;
    qtyAfter.set(item.menu_item_id, (qtyAfter.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  const phantomAdds: T[] = [];
  const qtyReverts: Array<{ item: T; priorQty: number }> = [];
  for (const [menuItemId, after] of qtyAfter) {
    let delta = after - (qtyBefore.get(menuItemId) || 0);
    if (delta <= 0) continue;
    const postLines = guardCart.filter(i => i.menu_item_id === menuItemId);

    // Same two-pass order as GUARD 9: consume growth against lines whose
    // exact fingerprint already existed before (a real quantity bump on an
    // unchanged line) first, then against lines with no prior fingerprint
    // match at all (a brand-new line), bounded by `delta`.
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
