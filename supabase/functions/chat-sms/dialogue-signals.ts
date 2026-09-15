// Extracted 2026-09-14 (Turn Engine Phase 1, docs/specs/2026-09-14-turn-engine-oversight.md).
//
// These three predicates used to be private, unexported functions inside
// index.ts (buried at ~line 3631/3705/3717). turn-engine.ts's ANSWER step
// needs the identical logic for its own deterministic order_type/upsell
// resolution — the spec's explicit instruction is to extract a helper like
// this to its own module and import it from BOTH turn-engine.ts and
// index.ts, never maintain two copies. Pure move: no behavior change, no
// wording change, no regex change. index.ts now imports these instead of
// defining them locally.

/**
 * Does this text ask the customer for their pickup name? Shared by C2 (was
 * the customer's PRIOR message a name-ask, so this turn's short reply is
 * the name) and by the itemized-recap wiring in index.ts (is THIS turn's
 * reply a name-ask, regardless of whether GUARD 2 forced it or the model
 * asked on its own initiative). Extracted from C2's original inline check so
 * both call sites can never drift apart on what counts as a name-ask.
 */
export function isAskingForPickupName(text: string): boolean {
  return /\bname\b/i.test(text)
    && /pickup|pick up|under (?:what|which)|who(?:'s| is) (?:this|it) for|order for|(?:for|on) (?:the|this|your) order/i.test(text);
}

// C2c-upsell narrow acceptance check (2026-09-14, item G follow-up). Scoped
// to that ONE call site only — do not reuse elsewhere. impliesOrderConfirmation
// (guard9) is a broad "sounds like checkout-ready" detector that deliberately
// matches wrap-up phrases like "that's it"/"done"/"ready"/"all set"/"checkout"
// — exactly the opposite of accepting an upsell offer. Using it to mean
// "accepts the upsell" made "cheeseburger" -> "medium" -> "that's it" silently
// add the offered French Fries: the customer meant "I'm finished," not "yes,
// add that." This predicate matches ONLY a genuine bare affirmative to a
// yes/no question, excluding all checkout/completion language.
export function impliesUpsellAcceptance(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().trim();
  return /^(?:yes|yeah|yep|yup|sure|ok|okay|please|yes please|sounds good|add it|do it)[.!]?$/i.test(norm);
}

// C2c-upsell narrow decline check (2026-09-14, item C2). Symmetric with
// impliesUpsellAcceptance above and scoped the same way: a bare negative
// answer to our own yes/no upsell offer only, never a broader message. A
// message that also names a new item ("no thanks, but add a salad") does
// NOT match this — it falls through to the LLM, same as it always has, so
// the new item still gets heard.
export function impliesUpsellDecline(text: string): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().trim();
  return /^(?:no|nope|nah|no thanks|no thank you|not now|not today|not this time|i'?m good|im good|we'?re good|skip|pass)[.!]?$/i.test(norm);
}

// (Turn Engine Phase 1 addendum) index.ts's C2 pre-LLM name->submit shortcut
// (line ~7110) and its C2b-name sibling (line ~9776) each carry their OWN
// inline "does this look like a name" regex, and the two already disagree
// (C2 requires a capitalized first letter, `/^[A-Z][A-Za-z .'-]{0,30}$/`;
// C2b-name accepts either case, `/^[A-Za-z][A-Za-z .'-]{0,30}$/`). That is a
// pre-existing divergence in index.ts, not something this phase introduces —
// unifying it is a behavior decision for the PO, not a pure extraction, so
// it is deliberately NOT done here and index.ts's two inline copies are left
// untouched (frozen). This is turn-engine.ts's OWN, independent name-shape
// heuristic for its ANSWER step's `name` resolution, matching the more
// permissive (C2b-name) shape. If the PO later decides to unify all three
// call sites, this is the function to converge on, or replace.
export function looksLikeCustomerName(text: string): boolean {
  const trimmed = text.trim();
  return /^[A-Za-z][A-Za-z .'-]{0,30}$/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
}
