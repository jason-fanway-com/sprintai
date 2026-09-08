// D2 fix (2026-09-08 P0, Zio's live transcript, conversation
// b3dc366c-5e8a-47e2-930b-c384c9778dda): the customer said "I want 4 large
// pizzas" (no items in the cart yet — nothing to attach "large" to), then
// named the four pizzas in the NEXT message ("1 pepp, 1 plain, 1 hawaiin, 1
// meat lovers"). The compiled engine's resolveAskPlan (ask-plan-engine.ts)
// only ever sees chat-sms/index.ts's `userMessage` for the CURRENT turn, so
// "large" — stated one message earlier — was invisible by the time the four
// add_item calls ran, and every item asked for its size from scratch.
//
// Root cause confirmed to be a CARRY-FORWARD gap, not a matcher gap:
// matchChoiceInText's stemming already matches plain "large" against the
// choice displayed "Large 18''" correctly the moment both are in the SAME
// turn (verified against this exact transcript — turn 3, "...I told you I
// wanted 4 large", resolved the Neapolitan Cheese Pizza's Size step
// immediately). So this is mode (a) from the P0 dispatch, not mode (b) —
// narrow in scope (a specific two-message shape), not a universal defect
// across all 78 Zio's size groups.
//
// Fix: widen the text handed to the compiled engine to include the
// immediately preceding customer turn, bounded to exactly ONE turn back —
// same "bounded, not whole-history" discipline as GUARD 7's one-prior-turn
// category check (this file's neighbor, pending-disambiguation.ts) — so a
// stray word from several messages ago can never resurface unexpectedly on
// an unrelated later item. Deliberately scoped to a NEW parameter consumed
// only by the compiled-engine branch of executeTool's add_item case — the
// existing `customerMessage` parameter (and the legacy path's reactive
// modifier matcher that also reads it) is untouched, so Vito's legacy path
// is completely unaffected.
export function buildCompiledMatchText(
  currentMessage: string,
  history: Array<{ role: "user" | "assistant"; content: string | unknown }>,
): string {
  const priorCustomerTurn = [...history].reverse().find(
    (h): h is { role: "user"; content: string } => h.role === "user" && typeof h.content === "string",
  );
  const priorText = priorCustomerTurn?.content?.trim();
  if (!priorText) return currentMessage;
  return `${priorText} ${currentMessage}`;
}
