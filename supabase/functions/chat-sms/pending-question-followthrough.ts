// D3/D5 fix (2026-09-08 P0, Zio's live transcript, conversation
// b3dc366c-5e8a-47e2-930b-c384c9778dda):
//
// D3 — the bot replied "Got it!" after a turn that resolved ONE open option
// (Size on the Neapolitan Cheese Pizza) while TWO other cart lines
// (Hawaiian Pizza, Meat Lover's Pizza) still had an unresolved required
// option from an EARLIER turn that this turn's tool calls never touched.
// "Got it!" with no further content reads as "handled" when it plainly
// wasn't. The existing per-call mechanism (chat-sms/index.ts's
// `compiledStepQuestions` + ask-plan-engine.ts's `enforceVerbatimStepQuestion`)
// only knows about a question a call THIS turn left open — it has no
// visibility into a line that was already pending and simply never got
// called again this turn. findUnaddressedPendingLine closes that gap: it
// scans the FINAL post-turn cart for any compiled line with a pending
// option nobody asked about this turn.
//
// D5 — "no, I said 4 pizzas" and "oh brother..." both hit the SAME still-
// open Hawaiian Pizza Size question, byte-for-byte, because neither
// contained a matchable size word (matchChoiceInText correctly declines to
// guess) and nothing tracked that this was the SAME question being asked
// again with the customer's real answer discarded. isRepeatedQuestion
// checks the two most recent assistant turns for the identical rendered
// question; when found, the caller escalates instead of repeating verbatim
// — same class of fix as the caesar-loop fix (2026-09-06): an unparsed
// answer to a pending question must escalate on repeat, not loop forever.
export interface PendingFollowThrough {
  menuItemId: string;
  itemName:   string;
  groupName:  string;
}

/**
 * First compiled cart line with a pending option this turn's tool calls
 * never addressed. `renderedThisTurn` maps menu_item_id -> the set of group
 * names a compiled add_item call for that item rendered a question for THIS
 * turn (chat-sms/index.ts's `compiledRenderedGroups`). Returns null when
 * every pending line was already addressed (or nothing is pending).
 */
export function findUnaddressedPendingLine(
  cart: Array<{ menu_item_id?: string; name?: string; pending_options?: string[] }>,
  renderedThisTurn: Map<string, Set<string>>,
): PendingFollowThrough | null {
  for (const item of cart) {
    if (!item.menu_item_id || !item.pending_options?.length) continue;
    const rendered = renderedThisTurn.get(item.menu_item_id);
    const stillUnaddressed = item.pending_options.find(g => !rendered?.has(g));
    if (stillUnaddressed) {
      return { menuItemId: item.menu_item_id, itemName: item.name ?? "", groupName: stillUnaddressed };
    }
  }
  return null;
}

/** True when the exact rendered question appears in BOTH of the last two assistant turns. */
export function isRepeatedQuestion(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string | unknown }>,
): boolean {
  const recentAssistant = history
    .filter((h): h is { role: "assistant"; content: string } => h.role === "assistant" && typeof h.content === "string")
    .slice(-2);
  if (recentAssistant.length < 2) return false;
  return recentAssistant.every(h => h.content.includes(question));
}
