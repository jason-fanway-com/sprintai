// P0 (2026-09-09, live money defect, item 1 of the nine-item decision doc):
// "no extra cheese" / "take the extra cheese off" / "remove extra cheese"
// against a cart line that ALREADY has that option applied never actually
// stripped it -- GUARD 1f (guard1f-correction-claim-20260909.ts, deployed
// v316) only stops the model from LYING about having removed it. The model
// never reliably calls modify_item to strip a single option; per BLOCKED.txt
// this is a "teach the model" gap that a deterministic code path replaces
// instead of trying to prompt away.
//
// Two independent, composable pieces live here, no I/O, no Supabase, no LLM:
//
//   1. isRemovalRequested(text, candidateName) -- clause-scoped removal-verb
//      detection, same idiom as reactive-modifier-match.ts's isNegated (which
//      this mirrors deliberately: negation stops an option from ever being
//      applied; removal strips one already applied). Consumed by
//      ask-plan-engine.ts's applyCompiledModifyItem as one of two signals
//      (the other being an explicit empty-array clear) that a modify_item
//      call for a compiled item should strip a currently-selected
//      MODIFIER-kind choice instead of being a no-op.
//
//   2. matchOptionRemovalPhrase / findCartLinesWithOption -- the deterministic
//      PRE-LLM detection index.ts's correction handler uses to decide WHICH
//      cart line a removal request targets before the LLM/tool loop ever
//      runs, so the customer's own words are never the only thing standing
//      between "I asked to remove it" and the model just narrating that it
//      did. Deliberately SEPARATE from the existing named-item-removal flow
//      (index.ts's namedRemoveMatch / resolveNamedCartRemoval in
//      pending-disambiguation.ts): "remove the extra cheese" stem-overlaps
//      "cheese" against a cart line literally named "... Neapolitan CHEESE
//      Pizza" (the menu's own SKU name), so routing this phrase through the
//      existing whole-item resolver risks targeting the ENTIRE pizza when
//      the customer asked to remove a $4 topping. The caller must run
//      findCartLinesWithOption FIRST; only fall through to the existing
//      whole-item resolver when it finds zero option matches, so every
//      existing whole-item-removal behavior/test is unaffected.

import { significantStems } from "./pending-disambiguation.ts";

// Verbs that precede the name ("remove the extra cheese", "no more
// pepperoni") -- same shape as reactive-modifier-match.ts's NEGATORS, inverse
// intent (stop it from EVER applying vs. strip it once ALREADY applied).
const REMOVAL_VERBS_BEFORE = ["remove", "no more", "get rid of", "drop", "cancel", "scratch", "without"];

/**
 * Does `text` ask to remove something already applied, governing
 * `candidateName` specifically? Clause-scoped (splits on but/and/also/plus/
 * punctuation) so "remove the pepperoni but keep the mushrooms" never also
 * flags mushrooms -- identical discipline to isNegated, inverse intent.
 * Checks both word orders a removal request naturally takes: verb-before-name
 * ("remove the extra cheese") and the "take X off" idiom, where "take" comes
 * before the name and "off" trails it.
 */
export function isRemovalRequested(text: string, candidateName: string): boolean {
  if (!text) return false;
  const nameStems = [...significantStems(candidateName)];
  if (nameStems.length === 0) return false;
  const stem = nameStems[0];
  const clauses = text.toLowerCase().split(/\b(?:but|and|also|plus)\b|[,.;]/);
  for (const clause of clauses) {
    for (const verb of REMOVAL_VERBS_BEFORE) {
      // Up to 3 short filler words between the verb and the name's first
      // significant stem (e.g. "remove the extra cheese please").
      const re = new RegExp(`\\b${verb}\\b(?:\\s+\\w+){0,3}\\s+${stem}`, "i");
      if (re.test(clause)) return true;
    }
    // "take (the/my) X off" / "take off (the/my) X" -- particle can lead or
    // trail the name, both real phrasings for the same idiom.
    const takeOffRe = new RegExp(
      `\\btake\\b(?:\\s+\\w+){0,3}\\s+${stem}(?:\\s+\\w+){0,2}\\s+off\\b|\\btake off\\b(?:\\s+\\w+){0,3}\\s+${stem}`,
      "i",
    );
    if (takeOffRe.test(clause)) return true;
  }
  return false;
}

export interface OptionRemovalCartLine {
  menu_item_id?: string;
  name: string;
  category?: string | null;
  price_cents: number;
  options?: Record<string, string[]>;
  modifiers?: string[];
}

export interface OptionRemovalCandidate {
  menu_item_id: string;
  name: string;
  category: string | null;
  price_cents: number;
  group_name: string | null; // null => a flat `modifiers` entry, not an option-group choice
  matched_value: string;     // the exact stored string to remove (case-preserved)
}

/**
 * Detect an explicit request to remove a named option/topping from
 * something already in the cart. Anchored to the WHOLE (normalized) message
 * -- same convention as index.ts's existing bare-correction patterns
 * (`^(remove one|remove that|...)$`) -- so a longer, compound message (e.g.
 * a fresh order that also happens to negate an option for the NEW item,
 * "medium pepperoni pizza, no mushrooms") never matches here: that case has
 * more content around the negation and is correctly left to the existing
 * ask-plan-engine negation handling for NEW items, not this cart-correction
 * path. Returns the captured phrase (untrimmed of internal words, trimmed of
 * whitespace), or null.
 */
export function matchOptionRemovalPhrase(normalizedMessage: string): string | null {
  const msg = normalizedMessage.trim();
  if (!msg) return null;

  const patterns = [
    // "remove/drop/cancel/delete/scratch/get rid of (the|my|any) X"
    /^(?:please\s+)?(?:remove|drop|cancel|delete|scratch|get rid of)\s+(?:the\s+|my\s+|any\s+)?(.+)$/i,
    // "take (the|my) X off" -- object-before-particle word order.
    /^(?:please\s+)?take\s+(?:the\s+|my\s+)?(.+?)\s+off$/i,
    // "take off (the|my) X" -- particle-before-object word order.
    /^(?:please\s+)?take off\s+(?:the\s+|my\s+)?(.+)$/i,
    // "no more X" -- unambiguous (implies "I had X, now don't"), safe even
    // as a bare, anchored phrase.
    /^(?:actually,?\s+)?no more\s+(?:the\s+)?(.+)$/i,
    // Bare "no X" -- the loosest pattern here, deliberately gated by the
    // caller: this only ever fires when findCartLinesWithOption below finds
    // at least one REAL applied option matching the captured phrase, so a
    // fresh new-item negation (which won't match anything already in the
    // cart) safely falls through untouched.
    /^(?:actually,?\s+)?no\s+(?:the\s+)?(.+)$/i,
  ];

  for (const re of patterns) {
    const m = msg.match(re);
    if (m) {
      const captured = m[1].trim();
      if (captured.length >= 3) return captured;
    }
  }
  return null;
}

/**
 * Does `phrase` name this specific option value? Subset-stem containment
 * (every significant stem of the phrase must appear in the option value's
 * stems), plus a bidirectional plain-substring check for the common exact
 * case ("extra cheese" / "Extra Cheese"). Deliberately stricter than the
 * whole-item resolver's 3-stem-overlap heuristic (cart.ts's claimsItemInCart)
 * -- option names are short and specific, so requiring full containment
 * avoids a generic word ("cheese" alone) accidentally matching "Extra
 * Cheese" when the customer actually named something else entirely.
 */
function phraseMatchesValue(phrase: string, value: string): boolean {
  const p = phrase.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (!p || !v) return false;
  if (p === v || v.includes(p) || p.includes(v)) return true;
  const phraseStems = significantStems(phrase);
  if (phraseStems.size === 0) return false;
  const valueStems = significantStems(value);
  for (const s of phraseStems) if (!valueStems.has(s)) return false;
  return true;
}

/**
 * Find every cart line that currently has an option/modifier matching
 * `phrase` applied, one candidate per matching line (a line is either a
 * match for this removal request or it isn't; which single value within it
 * gets removed is resolved precisely by re-running this same function
 * restricted to one line once a target is chosen).
 */
export function findCartLinesWithOption(
  phrase: string,
  cartLines: OptionRemovalCartLine[],
): OptionRemovalCandidate[] {
  const out: OptionRemovalCandidate[] = [];
  for (const line of cartLines) {
    if (!line.menu_item_id) continue;
    let found: { group_name: string | null; matched_value: string } | null = null;
    for (const [groupName, values] of Object.entries(line.options ?? {})) {
      for (const v of values) {
        if (phraseMatchesValue(phrase, v)) { found = { group_name: groupName, matched_value: v }; break; }
      }
      if (found) break;
    }
    if (!found) {
      for (const m of line.modifiers ?? []) {
        if (phraseMatchesValue(phrase, m)) { found = { group_name: null, matched_value: m }; break; }
      }
    }
    if (found) {
      out.push({
        menu_item_id: line.menu_item_id,
        name: line.name,
        category: line.category ?? null,
        price_cents: line.price_cents,
        group_name: found.group_name,
        matched_value: found.matched_value,
      });
    }
  }
  return out;
}
