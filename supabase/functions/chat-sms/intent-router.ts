// Item 2 (2026-09-09, module extraction): pure pre-LLM turn-routing
// predicates pulled out of index.ts's runOrderingLoop verbatim. Given the
// conversation history and/or the current turn's tool calls, these decide
// whether a turn should skip the LLM entirely (a bare tip reply) or whether
// a particular tool call the LLM already chose should be suppressed before
// it runs (clear_cart called in a context that almost certainly wasn't a
// real "start over"). No Supabase, no LLM, no I/O.

/**
 * Fix 1: Detect bare-tip reply — when the prior assistant turn offered a
 * driver tip and the user replied with a bare tip amount, this is a
 * tip-only turn.
 */
export function detectBareTipReply(
  history: Array<{ role: "user" | "assistant"; content: string | unknown }>,
  userMessage: string,
): boolean {
  const lastAssistant = [...history].reverse().find(h => h.role === "assistant");
  const offeredTip = lastAssistant && typeof lastAssistant.content === "string"
    && /\b(?:tip|driver tip)\b/i.test(lastAssistant.content)
    && /\$(?:1|2|3|5)\b/i.test(lastAssistant.content);
  const userMsg = userMessage.trim();
  return Boolean(offeredTip && (
    /^\$?\s*(1|2|3|5)\s*$/.test(userMsg) ||
    /^(no tip|no thanks|skip|none|pass|no)\s*$/i.test(userMsg)
  ));
}

/** Parses the whole-dollar amount out of a bare-tip reply (e.g. "$3" -> 3, "no tip" -> 0). */
export function parseBareTipDollars(userMessage: string): number {
  const userMsg = userMessage.trim();
  const tipMatch = userMsg.match(/\$?\s*([0-9]+)/);
  return tipMatch ? parseInt(tipMatch[1], 10) : 0;
}

// ─── E1 (2026-08-29): Cross-turn clear_cart guard ────────────────────────
// Extends B3 to the free-form conversational path: the model sometimes
// calls clear_cart when the user says something additive like "and also",
// "and a", etc. — even when no add_item is in the same turn. This catches
// the cross-turn case that the same-turn B3 guard misses. Suppress
// clear_cart when: (a) user message is additive AND (b) cart has items.
// Explicit "start over"/"cancel everything" still clears normally.
// ── E1 FIX (2026-09-01): Broaden isExplicitRestart to catch messages
// that CONTAIN a cancel/restart phrase (e.g. "Actually, cancel my order")
// — the anchored ^…$ pattern missed these. The broader check uses a
// second non-anchored regex so "actually" + "cancel my order" passes.

export function isExplicitCartRestart(userMessage: string): boolean {
  const msg = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(start over|restart|cancel (?:everything|all|the order|it all|my order)|new order|clear (?:the cart|it all|everything)|reset|wipe (?:the cart|it|everything))[!.]?$/i.test(msg)
    || /\b(?:cancel\s+(?:my\s+)?order|cancel\s+(?:everything|all|it\s+all)|forget\s+(?:it|the whole|everything)|start\s+over|wipe\s+(?:the\s+)?(?:cart|it|everything|all))\b/i.test(msg);
}

export function isAdditiveClearCartMessage(userMessage: string): boolean {
  const msg = userMessage.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(?:also|add(?: another| a| an)?|and a|and another|and some|and the|can i also|let me also|let me get|i also|ill also|ill have|i'll also|i'll have|i want|gimme|give me|actually |oh and|plus)\b/i.test(msg);
}
