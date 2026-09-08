// Bug 4 (2026-09-07, escalated urgent): "buffalo chicken pizza with pepperoni"
// silently dropped the topping AND its $3.00 price. Root cause on the LEGACY
// (non-compiled) add_item/modify_item path: modifier/topping application is
// driven ENTIRELY by the LLM's structured tool-call input (`modifiers`,
// `options`) — there is no deterministic fallback that looks at the
// customer's own words. When the model fails to extract "pepperoni" into its
// tool call (which it does often enough to be the reported bug, not a rare
// miss), the topping — and its price — never applies, with no error and no
// signal to the guard chain. The compiled path already solved the equivalent
// problem for SLOT groups via ask-plan-engine.ts's matchChoiceInText; this
// module is the same discipline applied to the legacy path's MODIFIER-shaped
// data (modifiers_json entries + non-required option_groups, i.e. toppings/
// add-ons — never required/slot-like groups like size, which stay on the
// existing pending/ask flow unchanged).
//
// Reuses significantStems rather than a second ad hoc matcher, per the
// standing rule from the named-item-removal fix ("reuse the resolution
// primitives, don't hand-roll a new ad hoc regex matcher") — same rule
// ask-plan-engine.ts followed for the compiled path.

import { significantStems } from "./pending-disambiguation.ts";

export interface ReactiveCandidate {
  // null groupName = a modifiers_json entry; otherwise a non-required
  // option_groups[].name this candidate's choice belongs to.
  groupName: string | null;
  name: string;
  price_cents: number;
}

export interface ReactiveMatch {
  groupName: string | null;
  name: string;
  price_cents: number;
}

// Negation guard: "no pepperoni" / "without pepperoni" / "hold the pepperoni"
// / "not the pepperoni" must never auto-apply pepperoni. Checked against the
// raw text (word order matters here, unlike the stemmed bag-of-words match
// below), within a short window so "no, and also add pepperoni" still
// applies pepperoni — only a negation immediately governing THIS candidate's
// own words is suppressed.
const NEGATORS = ["no", "not", "without", "hold the", "hold on the", "minus", "skip the", "except the", "except"];

// A negator only governs the words in its own clause — "no pepperoni but add
// mushrooms" must negate pepperoni without also negating mushrooms, which a
// fixed word-count window (checked against the whole message) cannot do
// reliably, since "no <2 words> mushroom" fits the same window as "no
// <2 words> pepperoni" once "but add" sits in between. Splitting on
// conjunctions/punctuation first keeps each negator scoped to its own clause.
function isNegated(text: string, candidateName: string): boolean {
  const nameStems = [...significantStems(candidateName)];
  if (nameStems.length === 0) return false;
  const clauses = text.toLowerCase().split(/\b(?:but|and|also|plus)\b|[,.;]/);
  for (const clause of clauses) {
    for (const negator of NEGATORS) {
      // Up to 2 short filler words between the negator and the name's first
      // significant stem (e.g. "no extra pepperoni please").
      const re = new RegExp(`\\b${negator}\\b(?:\\s+\\w+){0,2}\\s+${nameStems[0]}`, "i");
      if (re.test(clause)) return true;
    }
  }
  return false;
}

/**
 * Match customer text against candidate modifiers/toppings not already
 * selected this turn. Deterministic, stem-based, "missing beats wrong"
 * (spec P3): a candidate only matches if every significant stem it
 * contributes appears in the customer's text, same requirement as
 * ask-plan-engine.ts's matchChoiceInText. Unlike that function, a topping
 * list is inherently multi-select, so every unambiguous hit is returned,
 * not just one — each candidate is judged independently, so "pepperoni and
 * mushrooms" correctly yields two matches with no ambiguity between them.
 */
export function matchReactiveExtras(
  candidates: ReactiveCandidate[],
  text: string,
  alreadyNamed: Set<string>, // lowercased names already selected this turn or already on the cart line
): ReactiveMatch[] {
  if (!text) return [];
  const textStems = significantStems(text);
  if (textStems.size === 0) return [];

  const matches: ReactiveMatch[] = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    if (alreadyNamed.has(key)) continue;
    const stems = significantStems(c.name);
    if (stems.size === 0) continue;
    const allPresent = [...stems].every(s => textStems.has(s));
    if (!allPresent) continue;
    if (isNegated(text, c.name)) continue;
    matches.push({ groupName: c.groupName, name: c.name, price_cents: c.price_cents });
  }
  return matches;
}
