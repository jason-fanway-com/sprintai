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

// Live defect (2026-09-13, conv v430, Vito's): "yes im ready to check out"
// answered EXPLICIT_CHECKOUT_PHRASE_RE's anchored test (the phrase must BE
// the message) and BARE_AFFIRMATIVE_RE's anchored test (the message must be
// NOTHING but the bare word) both fail it — it has a leading "yes" AND
// trailing words, so it satisfies neither shape. Result: GUARD 23 re-asked
// the identical "anything else, or ready to check out?" question the
// customer had just answered unambiguously, looping them.
//
// This is the same core checkout phrase set as EXPLICIT_CHECKOUT_PHRASE_RE,
// anchored to the END of the message instead of the whole message, for use
// ONLY when an affirmative lead-in word is also present (see
// AFFIRMATIVE_LEAD_IN_RE below) — an affirmative word FOLLOWED BY real
// checkout language, with nothing after it but optional politeness, is
// exactly as unambiguous as the phrase alone. Deliberately still anchored
// (at the end, not the start) rather than a true substring-anywhere match:
// an unanchored bare "check[\s-]*out" would wrongly fire on "yes I'll check
// out the menu but add pepperoni too" — checkout language ABOUT THE MENU,
// not the order, with real competing intent right after it. End-anchoring
// means the checkout phrase has to be the last thing said, which the "menu"
// case never is. Also deliberately excludes the bare "done" alternative
// EXPLICIT_CHECKOUT_PHRASE_RE carries — "yes, dinner's not done" ends in
// "done" and must never authorize; nothing in the live defect or the PO's
// required matrix needs "done" recognized this way.
const CHECKOUT_PHRASE_SUFFIX_RE = new RegExp(
  "(?:" +
    "that'?s it|that is it|" +
    "that'?s all|that is all|" +
    "ready to check[\\s-]*out|" +
    "send (?:me )?(?:a |the )?link|" +
    "check[\\s-]*out" +
  ")(?:[,.!]?\\s*(?:thanks?|please))?[\\s.!]*$",
  "i",
);

// The affirmative half of the "yes" + checkout-language combination above.
// Broader than BARE_AFFIRMATIVE_RE on purpose (that one requires the ENTIRE
// message to be nothing but the word; this one only requires the word to
// appear as a whole word somewhere) — safe here because it is never
// sufficient alone, only paired with CHECKOUT_PHRASE_SUFFIX_RE matching in
// the SAME message.
const AFFIRMATIVE_LEAD_IN_RE = /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|correct)\b/i;

// Live defect (2026-09-13, third-party independent verification): the combo
// path below (AFFIRMATIVE_LEAD_IN_RE + CHECKOUT_PHRASE_SUFFIX_RE) matches a
// trailing checkout phrase with no regard for negation earlier in the
// message, so "yeah, I'm not ready to check out" satisfied both halves and
// returned true — reading an explicit DECLINE as checkout intent, exactly
// the "rushes to close against the customer" failure this feature exists to
// prevent. Handles both apostrophe and no-apostrophe SMS spellings ("dont"
// as well as "don't"); "n't" alone is not matched standalone since SMS
// senders don't type a bare "n't".
const NEGATION_CUE_RE =
  /\b(?:not|never|dont|don'?t|doesnt|doesn'?t|isnt|isn'?t|cant|can'?t|wont|won'?t)\b|maybe later/i;

// Only the CLAUSE containing the matched checkout phrase is checked for a
// negation cue, not the whole message — "no, not the pepperoni, add the
// sausage, ready to check out" has an early decline-shaped "not" that
// belongs to an earlier clause about a topping, and must still authorize
// its genuinely trailing, unnegated checkout intent. Splitting on
// comma/semicolon/dash and taking the LAST clause is safe here because
// CHECKOUT_PHRASE_SUFFIX_RE is end-anchored — the matched phrase is always
// inside that last clause.
function hasNegatedCheckoutClause(message: string): boolean {
  const clauses = message.split(/[,;]|--+|[–—]/);
  const lastClause = clauses[clauses.length - 1] ?? message;
  return NEGATION_CUE_RE.test(lastClause);
}

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

  // Same unambiguity, just not confined to being the entire message: an
  // affirmative word PLUS real checkout language in the same message (e.g.
  // "yes im ready to check out", "yeah let's check out", "ok send the
  // link") carries the customer's own intent exactly like the phrase alone
  // does, regardless of what the bot just asked. "yes to delivery but I
  // want pepperoni" does NOT match — it has the affirmative word but no
  // checkout-language substring, so it correctly falls through to the
  // competing-intent/bare-affirmative logic below.
  //
  // Regression (2026-09-13, Melvin adversarial pass): unlike
  // EXPLICIT_CHECKOUT_PHRASE_RE above (anchored to the WHOLE message, so
  // there is never room for competing content to sneak in), this suffix
  // match only anchors the END of the message — words naming a competing
  // ask can precede it ("yes add fries and ready to checkout"). This check
  // used to run before the hasCompetingIntentThisTurn gate below, so it
  // authorized checkout whenever the competing item happened to be named
  // BEFORE the checkout phrase, while the identical competing intent named
  // AFTER the checkout phrase correctly fell through and got blocked
  // (CHECKOUT_PHRASE_SUFFIX_RE simply didn't match with trailing words).
  // Word order must never change whether competing intent blocks this path,
  // so gate it explicitly here too, matching the bare-affirmative path.
  //
  // Also gated on !hasNegatedCheckoutClause: see that function's comment.
  // EXPLICIT_CHECKOUT_PHRASE_RE above does NOT need the same guard — it is
  // anchored to the START of the message (after only an optional "ok"
  // prefix), so a leading negation word ("not ready to check out", "don't
  // check out") can never satisfy that anchor in the first place; the
  // negation blind spot only exists on this suffix-anchored combo path,
  // where arbitrary text (including a negation cue) may precede the match.
  if (
    AFFIRMATIVE_LEAD_IN_RE.test(trimmed) &&
    CHECKOUT_PHRASE_SUFFIX_RE.test(trimmed) &&
    !hasCompetingIntentThisTurn &&
    !hasNegatedCheckoutClause(trimmed)
  ) {
    return true;
  }

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

// Live regression (2026-09-13, conv v430, Vito's, defect 1): GUARD 23's
// call site used to replace the ENTIRE reply with a flat
// "You've got N item(s) in your cart..." template whenever it fired —
// discarding whatever legitimate item-confirmation (and any upsell offer
// riding along with it, defect 2) the model's original reply carried. A
// customer who swapped a topping got a content-free item tally instead of
// "Got it, swapped to pepperoni!" because the model, per the (correctly
// suppressed) PICKUP NAME RULE, tacked a premature name-ask/confirm onto
// the SAME reply.
//
// Fix: remove only the offending name-ask/confirm SENTENCE, keep everything
// else the model said, then append the one question this reply is allowed
// to carry. Splitting on sentence-ending punctuation followed by whitespace
// (the same idiom index.ts already uses for its own sentence-level guards)
// avoids breaking mid-token on things like "$8.49" — moot in practice here
// since stripLlmMoneyLines() has already run on `replyText` by the time
// index.ts calls this, but kept split-safe regardless.
function stripPrematureNameAskSentence(replyText: string): string {
  const sentences = (replyText ?? "").split(/(?<=[.!?\n])\s+/).filter(s => s.trim().length > 0);
  const kept = sentences.filter(s => !PICKUP_NAME_QUESTION_RE.test(s));
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

const READY_TO_CHECK_OUT_QUESTION = "Anything else, or ready to check out?";

/**
 * Builds the actual replacement reply for a GUARD 23 redirect (call this only
 * when shouldRedirectNameAskToCheckoutGate returned true). Preserves any
 * item-confirmation/upsell content the model's reply carried by stripping out
 * just the premature name-ask/confirm sentence and appending the
 * ready-to-checkout question; falls back to a generic cart-count tally only
 * when nothing else survives (e.g. the model's entire reply WAS the
 * name-ask/confirm, with nothing else said).
 */
export function renderGuard23Redirect(replyText: string | null | undefined, cartLength: number): string {
  const preserved = stripPrematureNameAskSentence(replyText ?? "");
  if (preserved) return `${preserved} ${READY_TO_CHECK_OUT_QUESTION}`;
  return `You've got ${cartLength} item${cartLength === 1 ? "" : "s"} in your cart. ${READY_TO_CHECK_OUT_QUESTION}`;
}
