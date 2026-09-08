// GUARD 17's fix (2026-09-08) closed the false claim AFTER the model had
// already composed it: "Switched to an everything bagel... Just to be clear
// — Bagel With Plain Cream Cheese doesn't have that kind of option here, so
// nothing was actually changed." Jason's own read of that transcript: this
// is an ORDERING problem, not a wording problem — a claim followed by its
// own retraction is self-contradictory no matter how honest the retraction
// is. The fix has to happen before the model composes anything, so it says
// ONE coherent thing from the start.
//
// This module is that "before" step. Run it against the CUSTOMER's message
// (not the model's reply — the reply doesn't exist yet) and the CURRENT
// cart, before the system prompt is built for this turn. If the customer's
// message plausibly asks to change an attribute of an item that has zero
// configurable options, the model gets an explicit heads-up appended to its
// system prompt for this turn only, so its tool calls AND its final text
// are both composed already knowing it can't claim a change happened.
//
// Deliberately permissive on the trigger side (unlike GUARD 17's own
// after-the-fact check, which had to be precise because a false positive
// there visibly injects a wrong correction into text the customer already
// received): the cost of an unnecessary reminder here is nothing more than
// an extra sentence in the model's own context that it may or may not act
// on. There's no customer-visible downside to triggering this a bit too
// often, so this errs toward including the hint rather than toward the
// narrow precision GUARD 17 needs.
//
// GUARD 17 stays in place as the deterministic backstop for whenever the
// model ignores this hint (prompt compliance is probabilistic, never
// guaranteed) — this is prevention, not a replacement for the safety net.

export interface ZeroOptionCartLine {
  menu_item_id?: string;
}

export interface ZeroOptionMenuItem {
  id: string;
  ask_plan?: { display_name: string; steps: unknown[] } | null;
}

const CHANGE_VERB_RE =
  /\b(?:switch(?:ed|ing)?|chang(?:e|ed|ing)|swap(?:ped|ping)?|instead\s+of|now\s+(?:a|an|with)|make\s+(?:it|that)\s+an?|updat(?:e|ed|ing)\s+to)\b/i;

/**
 * Returns a system-prompt addendum when the customer's message uses
 * change/switch language AND the current order has at least one item with
 * zero ask_plan steps (no configurable options at all) — or `null` when
 * neither condition holds, in which case the system prompt is unaffected.
 */
export function buildZeroOptionAttributeChangeHint(
  userMessage: string,
  cartLines: ZeroOptionCartLine[],
  effectiveMenu: ZeroOptionMenuItem[],
): string | null {
  if (!CHANGE_VERB_RE.test(userMessage)) return null;

  const menuById = new Map(effectiveMenu.map(mi => [mi.id, mi]));
  const zeroOptionNames = new Set<string>();
  for (const line of cartLines) {
    if (!line.menu_item_id) continue;
    const menuItem = menuById.get(line.menu_item_id);
    if (menuItem?.ask_plan && menuItem.ask_plan.steps.length === 0) {
      zeroOptionNames.add(menuItem.ask_plan.display_name);
    }
  }
  if (zeroOptionNames.size === 0) return null;

  const names = [...zeroOptionNames].join(", ");
  return (
    `\n\nIMPORTANT — HONESTY CHECK FOR THIS REPLY: the customer's message uses ` +
    `change/switch language, and the order currently includes these items with ` +
    `NO configurable options at all: ${names}. If the customer is asking to ` +
    `change an attribute of one of these (a bagel type, a topping, or anything ` +
    `else that isn't a real listed option), you may call set_note to record ` +
    `their preference for the kitchen, but your reply must be ONE honest, ` +
    `coherent message — never claim the item itself changed. For example: ` +
    `"I can't officially change the bagel type on that one, but I've noted ` +
    `everything bagel for the kitchen." Never say something was switched or ` +
    `changed and then contradict that in the same reply.`
  );
}
