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
// 00-AV (2026-09-17): looksLikeCustomerName above answers "is this message
// NOTHING BUT a name". That is the wrong question to ask a person. In a live
// sim run a customer answered "It's Alex!" and "My name is Alex!" nine times
// and was asked "What's the name for the order?" nine times, because neither
// message IS a bare name. Nothing caps the repeat, so the only exit was the
// customer leaving -- and that is what they did.
//
// This reads the name OUT of the message. Deterministic, no model call: a
// small set of carrier phrases people actually use, then the same shape test
// as above applied to what they carried.
//
// Bias, stated deliberately: a WRONG name is low harm and visible on the
// receipt; an unanswerable question repeated forever loses the order. So this
// leans toward extracting. The blocklists below exist to stop the specific
// harm of stamping an order "Pickup" or "Yes", not to be exhaustive.

const NOT_A_NAME = new Set([
  "yes", "yeah", "yep", "yup", "no", "nope", "ok", "okay", "sure", "thanks",
  "thank you", "please", "pickup", "pick up", "delivery", "deliver", "cash",
  "card", "hi", "hello", "hey", "stop", "help", "done", "nothing", "none",
  "that's it", "thats it", "no thanks", "it", "me", "mine", "us", "the name",
  "not important", "for pickup", "for delivery", "same", "whatever",
]);

// A token that, appearing anywhere in the candidate, means it is not a name.
const NOT_NAME_TOKENS = new Set([
  "not", "no", "pickup", "delivery", "order", "pizza", "please", "just",
  "the", "a", "an", "how", "what", "when", "where", "why", "can", "could",
  "would", "should", "do", "does", "is", "are", "was", "were", "i", "we",
  "you", "they", "my", "your", "finish", "complete", "finalize", "said",
  "told", "name", "names", "thanks", "thank", "want", "need", "get",
]);

// "Alex! Can we finalize" -> "Alex". Cut at the first terminal punctuation,
// then at the first conversational connector.
function trimToName(raw: string): string {
  let s = raw.trim().replace(/^["'`]+/, "");
  const punct = s.search(/[.,!?;:]/);
  if (punct >= 0) s = s.slice(0, punct);
  s = s.replace(/\s+(?:can|please|lets|let's|and|that|thats|that's|i|we|you)\b.*$/i, "");
  return s.trim();
}

function acceptName(candidate: string): string | null {
  const s = trimToName(candidate);
  if (!s) return null;
  if (/\d/.test(s)) return null;
  const lower = s.toLowerCase();
  if (NOT_A_NAME.has(lower)) return null;
  const tokens = lower.split(/\s+/);
  if (tokens.length > 3) return null;
  if (tokens.some(t => NOT_NAME_TOKENS.has(t))) return null;
  if (!looksLikeCustomerName(s)) return null;
  return s;
}

const NAME_CARRIERS: RegExp[] = [
  /(?:^|\b)(?:my |the )?names?(?:'s)?\s+(?:is\s+)?(.+)$/i,
  /(?:^|\b)(?:it'?s|this is|i'?m|im)\s+(.+)$/i,
  /(?:^|\b)(?:put (?:it|me) )?under\s+(.+)$/i,
  // 00-BL: "The name for the order is Alex." -- the top repeater in the
  // 2026-09-17 run. The carriers above capture everything after "name", which
  // is "for the order is Alex." and fails the shape test. A name at the very
  // END of the sentence, right after "is", is the shape people actually use
  // when they restate the question back at you. Last carrier deliberately:
  // every more specific one gets first refusal.
  /\bis\s+([A-Za-z][A-Za-z'\-]{1,29})\s*[.!?]?\s*$/i,
];

/**
 * Read a customer's name out of whatever they actually typed, or null.
 * Tries, in order: a carrier phrase ("my name is X", "it's X", "under X"),
 * a leading name followed by punctuation ("Alex! That's the name!"), then
 * the whole message as a bare name (the original behavior, preserved).
 */
export function extractCustomerName(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  for (const re of NAME_CARRIERS) {
    const m = trimmed.match(re);
    if (m?.[1]) {
      const got = acceptName(m[1]);
      if (got) return got;
    }
  }

  // "Alex! That's the name!" -- a name is only read off the front when it is
  // immediately followed by punctuation, so "How much is it?" and "I want a
  // pizza" cannot match on their first word.
  const lead = trimmed.match(/^([A-Za-z][A-Za-z'\-]{1,29})[.,!?;:]/);
  if (lead?.[1]) {
    const got = acceptName(lead[1]);
    if (got) return got;
  }

  return acceptName(trimmed);
}

export function looksLikeCustomerName(text: string): boolean {
  const trimmed = text.trim();
  return /^[A-Za-z][A-Za-z .'-]{0,30}$/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
}
