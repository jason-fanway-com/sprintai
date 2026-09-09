// Item 2 (2026-09-09, module extraction): pure "what do we ask next, and did
// we already ask it" helpers pulled out of index.ts verbatim. These compose
// and dedupe the customer-facing question for one or more pending option
// groups — no Supabase, no LLM, no I/O. Sibling to pending-option.ts and
// ask-plan-engine.ts (which own per-item slot resolution); this module owns
// turning "these items still need these groups answered" into a single
// coherent sentence, and telling a caller whether that sentence has already
// been said this turn.

import { displayGroupName, significantStems } from "./pending-disambiguation.ts";

/**
 * FIX (2026-09-06, Jason — internal-name leak, the 4th place a raw name
 * reached a customer today, this one written AFTER the earlier sweep): a
 * customer was told "Almost - I still need to know: Chicken Caesar
 * (Dressing). What'll it be?" — an item name with an option-group name
 * bolted on in parentheses is not how a person talks; a person asks "what
 * dressing do you want on the Caesar salad?"
 *
 * This is the ONE place any customer-facing text asks about missing
 * required options, on ANY item — GUARD 2's pending-options branch and D1's
 * pending-options failure branch both call this instead of interpolating
 * `${item.name} (${groups.join(", ")})` themselves. A new call site cannot
 * reintroduce this leak by accident because there is no raw interpolation
 * left to copy.
 */
export function renderMissingOptionsPrompt(items: Array<{ name: string; missingGroups: string[] }>): string {
  const clauses = items.map(item => {
    // BUG 2 fix (2026-09-07): missingGroups holds the RAW group name as
    // stored in pending_options (must stay raw there — it's matched by
    // exact string elsewhere) but a Slice import artifact like "Choose an
    // option" must never be read aloud to the customer. Sanitize only here,
    // at render time.
    const displayGroups = item.missingGroups.map(displayGroupName);
    const groups = displayGroups.length > 1
      ? `${displayGroups.slice(0, -1).join(", ")} and ${displayGroups[displayGroups.length - 1]}`
      : displayGroups[0];
    return `what ${groups.toLowerCase()} you'd like on the ${item.name}`;
  });
  const joined = clauses.length > 1
    ? `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`
    : clauses[0];
  return `I still need to know ${joined}. What'll it be?`;
}

/**
 * ITEM 1 (2026-09-08, PO live verification — "Turkey Sub added! What size -
 * medium 12" or large 16" (+$8)? ... Choices for Size: Medium 12'', Large
 * 16''"): the real question is never "is this group's display name a
 * generic Slice import artifact" — it's "did the customer already hear
 * these choices this turn." The old check (displayGroupName(...) ===
 * "option") happened to mask the duplicate for generic-named groups
 * ("Choose an option") but did nothing for a real-named group like "Size" —
 * which is exactly what fired in the PO's repro, and always would have,
 * generic-label check or not.
 *
 * "Already said" has two sources of truth, checked in order:
 *   1. Structural (compiled path): `compiledRenderedGroups` records exactly
 *      which group's canonical question enforceVerbatimStepQuestion just
 *      placed in `reply` this turn — unambiguous, no text-matching needed.
 *   2. Textual (legacy path / anything else): every choice's real name is
 *      already present in the given text. Stem-based (reusing
 *      `significantStems`, the same primitive `matchChoiceInText` in
 *      ask-plan-engine.ts uses) rather than a raw substring/quote match —
 *      the ORIGINAL bug here was "12"" (model's straight quote) failing to
 *      substring-match "12''" (stored two-apostrophe choice name);
 *      stemming strips punctuation on both sides so that mismatch can't
 *      recur.
 *
 * The generic-label check is NOT folded into this function — it still runs
 * as its own, separate anti-leak fallback at each call site (never show the
 * literal string "Choices for option: ..." to a customer), which is a
 * different concern (avoiding a raw import-artifact label) from this one
 * (avoiding a duplicate).
 */
export function groupChoicesAlreadySaid(
  menuItemId: string, groupName: string, choiceNames: string[], text: string,
  compiledRenderedGroups: Map<string, Set<string>>,
): boolean {
  if (compiledRenderedGroups.get(menuItemId)?.has(groupName)) return true;
  const textStems = significantStems(text);
  return choiceNames.every(name => {
    const nameStems = significantStems(name);
    return nameStems.size === 0 || [...nameStems].every(s => textStems.has(s));
  });
}
