// Checkout-mode insulation gate (2026-09-13).
//
// TWO LIVE INCIDENTS this exists to close:
//
// Incident A: customer said "Yes to delivery but I want pepperoni this time"
// and the bot jumped straight to "Putting this in for Jason, right?" with no
// "anything else?" in between. Root cause: the deterministic name-confirm
// guard (index.ts GUARD 2) fired on impliesOrderConfirmation(userMessage)
// alone (guard9-unconsented-affirmation.ts), which matches a bare "yes"
// ANYWHERE in a message with no shape constraint and no check on what
// question the bot had actually just asked. "Yes to delivery" was answering
// a delivery question, not the "anything else, or ready to check out?"
// question — it must never authorize checkout/name-confirm on its own.
//
// Incident B (conv fdf5ec8e, Vito's, real paid order): "Putting this in for
// Jason, right?" was sent four times in one conversation because nothing
// tracked that the question had already been asked. This module supplies the
// intent-classification half of the fix (index.ts's C2b-name block supplies
// the "don't repeat the identical question with nothing new to report" half,
// via the paired name_confirm_pending_total_cents tracking).
//
// Design: a bare affirmation ("yes"/"yeah"/"sure"/...) only ever counts as
// checkout/name-confirm intent when it is answering ONE of two specific
// questions the bot itself just asked (CHECKOUT_READY_QUESTION_RE or
// PICKUP_NAME_QUESTION_RE below) — never on its own, and never when this
// turn also carries competing intent (a named item, a quantity, a removal,
// or a request to see the order). An UNAMBIGUOUS customer-initiated phrase
// ("checkout", "that's it", "send me the link", ...) authorizes regardless
// of what was just asked, since the customer's own words carry the intent.
//
// Pure decision core, no DB/menu access — same reason computeGuard9 in
// guard9-unconsented-affirmation.ts takes an `isItemNamedThisTurn` result
// rather than the menu itself: keeps this independently testable, and keeps
// the one genuinely stateful lookup (the immediately preceding assistant
// message, and whether this turn names a menu item) in index.ts where the
// DB client and menu already live.

// Matches the bot's own checkout-readiness question, in every phrasing
// index.ts currently sends: "Anything else, or ready to check out?" (the
// runOrderingLoop soft-fallback and the cart-summary reply both use this
// wording, with or without a hyphen/space in "checkout"), and "...are you
// all set and ready to checkout?" (the ambiguous-removal reply). Deliberately
// does NOT match a plain "Add anything else?" / "anything else?" with no
// checkout language — those are mid-order continuation prompts, not the
// closing question, and a "yes" answering one of those means "yes, more
// items," never "yes, check me out."
export const CHECKOUT_READY_QUESTION_RE = /ready to check[\s-]*out/i;

// Matches the model's own final pre-submit confirmation question (system
// prompt: 'When confirming before submit_order, say "All good — confirm?"'
// / 'just say "Confirm?"'). By the time this question is on the table, the
// customer has already been through the pickup-name step and checkout
// intent was established earlier in the conversation — same reasoning as
// PICKUP_NAME_QUESTION_RE below, just one step later in the flow. A bare
// "yes" answering this question authorizes checkout the same way.
export const FINAL_CONFIRM_QUESTION_RE = /\bconfirm\?/i;

// Matches the bot's own pickup-name question, name-agnostically: both the
// cold ask (NAME_ASK, "What's your name for the order?") and the known-name
// confirm (nameConfirm's fixed template, "Putting this in for X, right?").
// Giving your name, or confirming it, is not itself an expression of
// checkout intent — it only counts here because the system prompt only ever
// asks this question AFTER the customer already signaled they were done, so
// by the time this question is on the table checkout intent was already
// established one or more turns earlier. Gated on hasCompetingIntentThisTurn
// in isExplicitCheckoutIntent below, so a compound turn that ALSO carries a
// fresh ask ("yes to Jason, can you add fries") is never read as a clean
// answer to this question — that's incident B's exact shape.
export const PICKUP_NAME_QUESTION_RE =
  /\bname\b.*(?:pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for|(?:for|on) (?:the|this|your) order)|putting this (?:order )?in for .+, right\?/i;

// Anchored (like this file's CART_SUMMARY_RE) on purpose: these phrases must
// be the substance of the message, not a word that happens to appear inside
// a longer sentence about something else ("I'll check out the menu" must
// never authorize checkout).
const EXPLICIT_CHECKOUT_PHRASE_RE = new RegExp(
  "^(?:ok(?:ay)?[,.]?\\s*)?(?:" +
    "that'?s it|that is it|" +
    "that'?s all|that is all|" +
    "i'?m done|im done|done|" +
    "ready to check[\\s-]*out|" +
    "send (?:me )?(?:a |the )?link|" +
    "check[\\s-]*out" +
  ")(?:[,.!]?\\s*(?:thanks?|please))?[\\s.!]*$",
  "i",
);

// Deliberately narrow to the exact words a bare-affirmation answer to a
// yes/no closing question actually looks like in real SMS traffic — plus the
// two extremely common misspellings "yea"/"yup". Only ever sufficient when
// paired with CHECKOUT_READY_QUESTION_RE or PICKUP_NAME_QUESTION_RE below; on
// its own it authorizes nothing.
const BARE_AFFIRMATIVE_RE = /^(?:yes|yeah|yea|yep|yup|sure|correct)[.!]?$/i;

/**
 * Does the customer's OWN current-turn message authorize entering/advancing
 * checkout (asking for/confirming the pickup name, or submitting the order)?
 *
 * @param customerMessage            This turn's raw customer text.
 * @param lastAssistantMessage       The immediately preceding assistant
 *                                   message (freshest first — never scanned
 *                                   further back than that, same "immediately
 *                                   preceding" discipline as GUARD 9/20).
 * @param hasCompetingIntentThisTurn Caller-computed: does this turn ALSO name
 *                                   a menu item, state a quantity, ask to see
 *                                   the order/cart, or use an add/remove/
 *                                   change verb? True means this turn carries
 *                                   more than a bare answer and must never be
 *                                   read as checkout/name intent.
 */
export function isExplicitCheckoutIntent(
  customerMessage: string | null | undefined,
  lastAssistantMessage: string | null | undefined,
  hasCompetingIntentThisTurn: boolean,
): boolean {
  const trimmed = (customerMessage ?? "").trim();
  if (!trimmed) return false;

  // An unambiguous customer-initiated phrase always authorizes, regardless
  // of what the bot just asked or whether this turn also names something —
  // "checkout" said plainly is never ambiguous the way a bare "yes" is.
  if (EXPLICIT_CHECKOUT_PHRASE_RE.test(trimmed)) return true;

  if (hasCompetingIntentThisTurn) return false;

  const lastMsg = lastAssistantMessage ?? "";
  const isBareAffirmative = BARE_AFFIRMATIVE_RE.test(trimmed);

  if (isBareAffirmative && (CHECKOUT_READY_QUESTION_RE.test(lastMsg) || FINAL_CONFIRM_QUESTION_RE.test(lastMsg))) return true;
  if (PICKUP_NAME_QUESTION_RE.test(lastMsg)) return true;

  return false;
}

// docs/specs/2026-09-13-checkout-insulation.md: "It always rushes to get
// your name, which is the trigger for checkout. That's unnatural... It
// should ask the user if they are ready to check out and then ask for their
// name." The name-ask/name-confirm must STOP being the thing that starts
// closing — entering the close requires the "anything else, or ready to
// check out?" question to have been asked AND answered with real checkout
// intent first (or an explicit customer-initiated phrase this very turn).
//
// This is a prompt-only rule today (index.ts's PICKUP NAME RULE) and the
// model does not reliably follow it — it reaches for the name-ask the
// moment an item lands, before "anything else?" is ever asked. GUARD 2
// (index.ts) only ever FORCES a name-ask/confirm when
// isExplicitCheckoutIntent is already true, so it is already correctly
// gated; the gap is the model's OWN unforced name-ask/confirm text, which
// nothing previously intercepted. This function is the deterministic
// backstop: it is checked against whatever `reply` is about to go out,
// regardless of who authored it.
export function shouldRedirectNameAskToCheckoutGate(
  replyText: string | null | undefined,
  hasPickupName: boolean,
  checkoutIntentEstablishedThisTurn: boolean,
  checkoutIntentConfirmedPersisted: boolean,
): boolean {
  // Once a pickup name is already on file, a later mention of "name"/"order"
  // in a reply is not a fresh close-trigger attempt — this gate is only
  // about the FIRST time the flow tries to start closing.
  if (hasPickupName) return false;
  // Checkout intent already established — this turn (a bare affirmative
  // answering the ready-to-checkout question, or an explicit customer
  // phrase like "that's it") or persisted from an earlier turn. Either way
  // the close was properly triggered; a name-ask/confirm reply is allowed.
  if (checkoutIntentEstablishedThisTurn || checkoutIntentConfirmedPersisted) return false;
  return PICKUP_NAME_QUESTION_RE.test(replyText ?? "");
}
