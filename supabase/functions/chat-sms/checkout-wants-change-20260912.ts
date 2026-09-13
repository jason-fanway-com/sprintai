// C4 (docs/DEFECT-CLASSES.md, 2026-09-12, conv 08782185): "Add fries" in
// checkout phase was refused — the customer was told to type the magic word
// CHANGE first. This is our internal state machine leaking into the
// conversation: "add fries" is an unambiguous add request on its own,
// with or without CHANGE. Widened the keyword match to also recognize
// add/remove/swap-shaped language, not just explicit correction language.
//
// Extracted into its own module (same precedent as GUARD 9/13/19/20/21 and
// cart-summary-intent-20260909.ts) so a test can assert against the EXACT
// regex index.ts uses.

export const CHECKOUT_WANTS_RESTART_RE = /\b(RESTART|START OVER|NEW ORDER)\b/;

export const CHECKOUT_WANTS_CHANGE_RE =
  /\b(WAIT|CHANGE|WRONG|FIX|MODIFY|UPDATE|REMOVE|ADD|ALSO|ANOTHER|DROP|SWAP|INSTEAD|TAKE.{0,4}OFF|NO MORE|DON'?T WANT|NOT RIGHT|THAT'S NOT|THATS NOT|CHARGED.*WRONG|ONLY ORDERED|DIDN'T ORDER|DIDNT ORDER)\b/;
