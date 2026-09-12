// Pure decision core for C2b-regular (2026-09-12 P0, live money defect on
// Vito's, conv f60d3611 — different from the conv ce84c64b defect this same
// day; that one was a real add wrongly reverted, this one is a real accept
// that was never resolved at all).
//
// "Yes delivery again. But I want pepperoni on it today." is three things
// in one message: (1) confirm the delivery-again offer, (2) accept the
// regular item ("Cheese - Large (16\")") the bot just offered, (3) add
// pepperoni to it. GUARD 20's regularItemAuthorizedThisTurn already
// recognizes (2) as authorized — the bot's immediately preceding message
// offered this exact item and the customer's reply confirms it ("yes"). But
// GUARD 20 only ever REVERTS an unauthorized silent add; nothing in the
// codebase actually PERFORMS the authorized add deterministically. The
// system prompt tells the model to do it, but a prompt instruction is
// advisory — the model dropped the item and the topping entirely, leaving
// the cart empty. GUARD 1f then correctly reported that true (empty) state,
// which read to the customer as though we'd ignored them, because we had.
//
// This module resolves ONLY the modifier half of accepting a regular offer:
// given the customer's own message this turn and the accepted item's real
// option-group choices, does the message ALSO name a single topping/add-on,
// and if so, ADD it (attach a specific choice) or is it an EXCLUDE (a "no
// onions" that doesn't need any code action since the base item never
// includes it by default)? Deliberately conservative: any message naming
// zero or more than one distinct topping resolves to `null` (no modifier),
// so the caller falls back to just accepting the plain regular item — never
// a guess between two named toppings.

export interface ModifierChoiceOption {
  groupName: string;
  name:      string; // e.g. "Pepperoni (Whole pizza)", "Extra Cheese"
}

export interface ResolvedModifier {
  groupName:  string;
  choiceName: string; // exact choice display name to pass in options; "" when action is "exclude"
  action:     "add" | "exclude";
}

// Some shops (Vito's pizza toppings) record whole-pizza/half-pizza as two
// distinct choices sharing one topping name, e.g. "Pepperoni (Whole pizza)"
// / "Pepperoni (Half pizza)". Others (a plain "Extra Cheese" choice) have no
// such suffix at all — baseName returns the choice's own full name
// unchanged in that case, and portion stays null.
const PORTION_SUFFIX_RE = /\s*\(\s*(whole|half)\s+pizza\s*\)\s*$/i;

function baseName(choiceName: string): { base: string; portion: "whole" | "half" | null } {
  const m = choiceName.match(PORTION_SUFFIX_RE);
  if (!m) return { base: choiceName.trim(), portion: null };
  return { base: choiceName.slice(0, m.index).trim(), portion: m[1].toLowerCase() as "whole" | "half" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NEGATION_RE = /\b(?:no|without|hold\s+the|except|minus|leave\s+off|skip\s+the)\b/i;
const HALF_RE = /\b(?:half|one\s+side|only\s+half)\b/i;

/**
 * Finds at most one topping/add-on the customer's own message names among
 * `choices` (the accepted item's real option-group choices — caller flattens
 * option_groups into this shape). Returns null when zero or more than one
 * distinct base topping name is mentioned — "missing beats wrong" applies
 * here exactly as it does everywhere else in this codebase's guard suite.
 */
export function resolveModifierMention(message: string, choices: ModifierChoiceOption[]): ResolvedModifier | null {
  if (!message || choices.length === 0) return null;
  const norm = message.toLowerCase();

  const byBase = new Map<string, ModifierChoiceOption[]>();
  for (const c of choices) {
    const key = baseName(c.name).base.toLowerCase();
    if (!key) continue;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key)!.push(c);
  }

  const mentioned: string[] = [];
  for (const key of byBase.keys()) {
    const re = new RegExp(`\\b${escapeRegex(key)}\\b`, "i");
    if (re.test(norm)) mentioned.push(key);
  }
  if (mentioned.length !== 1) return null;

  const group = byBase.get(mentioned[0])!;
  if (NEGATION_RE.test(norm)) {
    // "no onions" / "hold the onions" — a genuine customer instruction, but
    // one that needs no code action: the base regular item never includes
    // this topping by default. Reported back to the caller so it can still
    // proceed with a plain accept rather than treating this as "no modifier
    // mentioned at all".
    return { groupName: group[0].groupName, choiceName: "", action: "exclude" };
  }

  const wantsHalf = HALF_RE.test(norm);
  const portioned = group.filter(c => baseName(c.name).portion === (wantsHalf ? "half" : "whole"));
  const chosen = portioned[0] ?? group[0];
  return { groupName: chosen.groupName, choiceName: chosen.name, action: "add" };
}
