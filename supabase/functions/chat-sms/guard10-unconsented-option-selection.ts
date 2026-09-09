// GUARD 10 pure decision core (2026-09-06, Jason — live QA, 5 fresh sessions
// of "i want a caesar salad"): "the dressing decision is still made three
// different ways" — (1) added, no dressing mentioned at all; (2,3,5) added,
// asks dressing (correct — no is_default exists); (4) added, "with Caesar
// dressing - added!" (invented). The model can supply add_item/modify_item
// options that pass a required group's validation (a real recorded choice
// name) without the customer ever having named it — indistinguishable from a
// genuine selection by add_item alone, since both produce the identical
// `options: { Dressing: ["Caesar"] }`.
//
// The ONLY code-driven way an option may be set with no customer selection
// is default-fill (is_default, zero price) — anything else that changed
// THIS TURN and wasn't customer-stated is invented and reverts to pending,
// same shape as GUARD 9 reverting a phantom cart add.
//
// BUG (2026-09-07, found live-testing GUARD 11 against Zio's real menu
// data): the original version of this check was a literal substring test —
// `chosen.some(v => msgLower.includes(v.toLowerCase()))` — against the
// FULL choice name ("Large 18''"). A real customer typing "large" never
// produces that literal substring, so GUARD 10 wrongly reverted a selection
// GUARD 11 had JUST correctly resolved via the file's real stem-matcher
// (resolvePendingOptionAnswer). Fixed by using that SAME matcher here
// instead of a second, weaker check — "was this customer-stated" must mean
// the same thing everywhere in this file.
//
// Extracted into its own importable module for the same reason GUARD 9/13
// were (see those modules' headers): a hand-copied mirror in a test can
// drift from the real logic silently — this file's own test used to do
// exactly that, and stayed green through the substring-check bug above
// because it tested its OWN copy, not the real code.

import { resolvePendingOptionAnswer, type PendingOptionChoice } from "./pending-option.ts";

export interface Guard10Choice extends PendingOptionChoice {
  is_default: boolean;
}

export interface Guard10Group {
  name:     string;
  required: boolean;
  choices:  Guard10Choice[];
}

/**
 * True when `chosen` (the group's current selection on this cart line) must
 * be treated as invented — set by the model with no real customer basis —
 * and reverted to pending. `itemName` is stripped word-by-word from
 * `userMessage` first so naming the DISH never counts as naming a CHOICE
 * that happens to share a word with it (e.g. "Chicken Caesar" / "Caesar"
 * dressing).
 */
export function isInventedSelection(
  chosen:      string[] | undefined,
  beforeChosen: string[] | undefined,
  group:       Guard10Group,
  itemName:    string,
  userMessage: string,
): boolean {
  if (!chosen || chosen.length === 0) return false;
  if (JSON.stringify(beforeChosen ?? null) === JSON.stringify(chosen)) return false; // resolved on an earlier turn — already vetted then
  const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
  if (defaultChoice && chosen.length === 1 && chosen[0] === defaultChoice.name) return false; // our own deterministic default-fill

  const itemNameWords = itemName.toLowerCase().split(/\s+/).filter(Boolean);
  let msgLower = userMessage.toLowerCase();
  for (const w of itemNameWords) {
    msgLower = msgLower.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }

  const genuinelyStated = chosen.some(v => resolvePendingOptionAnswer(msgLower, [{ name: v, price_cents: 0 }]) !== null);
  if (genuinelyStated) return false;
  return true;
}
