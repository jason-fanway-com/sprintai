// C4 (docs/DEFECT-CLASSES.md) — a confirmation word ANYWHERE in a message
// was trusted as license for an irreversible action (submit_order), no
// matter what else the same message also carried. Three instances found
// in one day, all Vito's, all real money/trust incidents:
//   1. "Yes delivery. But I wanted a pepperoni pizza."   -> item dropped
//   2. "Show me the order. Yes it's for me."             -> read dropped, link sent
//   3. "Yes to Jason. Can you add fries to that?"        -> add dropped, link sent
// The root cause is the SAME shape each time: impliesOrderConfirmation
// (guard9-unconsented-affirmation.ts) is a substring test — it matches "yes"
// wherever it sits in a message, with no view of anything else in that
// message. A confirmation means "yes to what we just discussed"; it cannot
// mean that when the same breath changes what's being discussed.
//
// This module is the ONE central place that decides "does this message
// carry something beyond a bare confirmation" — built once, per the PO's
// explicit instruction after instance 2 was fixed as a narrow, symptom-level
// patch (CART_SUMMARY_MENTION_RE, wired only at the two sites instance 2
// happened to hit) instead of this general rule. Every irreversible-action
// shortcut in index.ts (C2b-name, D1) must gate on this, not on
// impliesOrderConfirmation alone.
//
// Approach: strip the message of everything that IS recognized as pure
// confirmation/name-verification filler; if non-trivial text survives,
// the message carries other intent and the caller must never treat it as
// license to submit/finalize -- it should apply or ask about that other
// intent first (see index.ts call sites for what "handle it first" means
// per intent: a read request gets the deterministic recap; anything else
// falls through to the normal ordering loop, which is what actually applies
// an add/remove/modify, backed by the existing guard suite).

// Same vocabulary impliesOrderConfirmation matches, kept as its own export so
// this module's residual-check and any caller can both use one source of
// truth instead of two regexes silently drifting apart.
export const CONFIRMATION_WORDS_RE =
  /\b(?:yes|yeah|yep|yup|confirm|confirmed|sure|correct|right|place (?:the |my |an )?order|check ?out|that'?s it|that is it|looks good|all good|go ahead|proceed|go for it|do it|send it|pay|ready|done|that'?s all|that is all|all set|i'?m ready|i'?m done|good to go|let'?s go|let'?s do it|place it|ring it up|finalize|submit)\b/gi;

// Bare acknowledgement/politeness words that carry no order-relevant content
// on their own -- stripped alongside confirmation words so "yes, thanks!"
// doesn't get held for one extra turn over a pleasantry.
const FILLER_WORDS_RE = /\b(?:thanks|thank you|please|ok|okay|k|kk|fine|perfect|great|awesome|fantastic|sounds good|good|that'?s|it'?s)\b/gi;

// "it's/that's for me/him/her/them" -- the standard pickup-name
// verification phrasing, not a distinct request.
const NAME_VERIFICATION_RE = /\b(?:it'?s|that'?s)\s+for\s+(?:me|him|her|them)\b/gi;

/**
 * Does `message` carry any content beyond a bare confirmation (plus name-
 * verification filler and the customer's own already-known name)? True
 * means: do NOT treat this message as a clean "yes" alone -- the other
 * content must be handled before (or instead of) acting on the confirmation.
 *
 * `knownName`, when supplied, is stripped as a "for/to <name>" fragment or a
 * bare mention of the ALREADY-KNOWN name only -- deliberately never a
 * wildcard "to <anything>" pattern, which would risk silently eating real
 * content that happens to follow the word "to".
 */
export function hasNonConfirmationContent(message: string, knownName?: string | null): boolean {
  if (!message) return false;
  let residual = message.toLowerCase();

  if (knownName && knownName.trim().length > 0) {
    const nameLower = knownName.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    residual = residual.replace(new RegExp(`\\b(?:for|to)\\s+${nameLower}\\b`, "g"), " ");
    residual = residual.replace(new RegExp(`\\b${nameLower}\\b`, "g"), " ");
  }
  residual = residual.replace(NAME_VERIFICATION_RE, " ");
  residual = residual.replace(CONFIRMATION_WORDS_RE, " ");
  residual = residual.replace(FILLER_WORDS_RE, " ");
  // Punctuation and bare connective glue ("and", "but", "to") left over once
  // the substantive words around them are stripped.
  residual = residual
    .replace(/[.,!?;:]/g, " ")
    .replace(/\b(?:and|but|to)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return residual.length > 0;
}
