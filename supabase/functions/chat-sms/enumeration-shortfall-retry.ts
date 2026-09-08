// D1 fix (2026-09-08 P0, PO re-diagnosis of the original D1 dispatch —
// conversation b3dc366c-5e8a-47e2-930b-c384c9778dda, Zio's live transcript):
// the original D1 fix (unresolved-item-segment-guard.ts) only detects a
// count shortfall AFTER the whole turn has already finished, so the only
// thing it can do is tell the customer "one of those didn't go through" and
// make them repeat themselves. The PO reproduced the real failure
// deterministically and it isn't a silent drop — "1 pepp, 1 plain" merged
// into ONE cart line (base pizza + Add Toppings: Pepperoni) instead of two.
// Either shape (a true drop, or a wrong-line merge) is invisible to the
// model itself unless something tells it, because nothing in a normal
// add_item tool_result says "you were asked for N items and only N-1 cart
// lines exist now."
//
// This module reuses countUnresolvedSegments UNCHANGED (same detection, same
// "count only, never guess which segment or why" discipline) at a different
// point in the turn: mid-turn, while the model still has tool calls
// available, instead of only after the turn is already over. Wired into
// runOrderingLoop's existing attempt loop (index.ts) right where the model
// signals it's done calling tools — if there's still a shortfall, the loop
// gets one more attempt with an explicit correction instead of returning.
// index.ts's post-turn GUARD (same countUnresolvedSegments call, unchanged)
// stays in place as the final honest fallback for whatever this retry can't
// resolve (e.g. a genuinely off-menu item) — this does not replace it, it
// just gives the model a chance to fix itself first.

import { countUnresolvedSegments } from "./unresolved-item-segment-guard.ts";

export interface ShortfallRetryDecision {
  shouldRetry: boolean;
  hint?: string;
}

/**
 * Decide whether to give the model one more attempt to fix an undercounted
 * (dropped OR wrong-line-merged) multi-item add, and what to tell it.
 * shouldRetry is false once retriesUsed reaches maxRetries or there is no
 * shortfall — the caller falls through to its normal reply either way.
 */
export function decideShortfallRetry(
  userMessage: string,
  cartBefore: unknown[],
  cartAfter: unknown[],
  retriesUsed: number,
  maxRetries: number,
): ShortfallRetryDecision {
  if (retriesUsed >= maxRetries) return { shouldRetry: false };
  const shortfall = countUnresolvedSegments(userMessage, cartBefore, cartAfter);
  if (shortfall <= 0) return { shouldRetry: false };

  const itemsWord  = shortfall === 1 ? "one item" : `${shortfall} items`;
  const verbPhrase = shortfall === 1 ? "hasn't landed" : "haven't landed";
  return {
    shouldRetry: true,
    hint: `Count check: you were asked to add several items from this list: "${userMessage}". ${itemsWord} named in that list ${verbPhrase} as its own separate cart line yet. Go back through the list one item at a time and call add_item for whichever one is still missing — give it its OWN add_item call, never attach it as an option/modifier onto a DIFFERENT item's line. If it has to be composed from a base menu item plus a topping or option because there's no standalone item for it, that composition is still exactly ONE add_item call for that one item.`,
  };
}
