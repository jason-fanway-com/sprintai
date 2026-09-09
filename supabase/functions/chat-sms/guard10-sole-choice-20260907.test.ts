// P0 (2026-09-07, found live-testing the stated-provenance gate fix — see
// compile-menu.test.ts's "orderable when a category-scoped blocking question
// EXCLUDES this item by name" — against real Zio's data): the gate fix
// correctly took Zio's Burgers/Wraps from 17 bot_state='blocked' items down
// to 2 genuinely-unresolved ones. Live transcript on one of the newly-
// orderable items, "cheese burger":
//   -> item 8's compiled engine correctly auto-resolves "Choose an option"
//      (its sole choice, "Regular", ask_mode=auto_single, price $0) AND
//      "Add Extra" (Bacon, reactively matched) in the SAME add_item call —
//      ask_plan_selections shows BOTH group ids resolved, price is exactly
//      right ($10.99 + $2.00 bacon = $12.99).
//   -> then GUARD 10 (unconsented option selection), unaware of the
//      compiled engine's auto_single semantics, saw "Choose an option" =
//      "Regular" appear this turn with no is_default=true choice recorded
//      (common on Slice-imported single-choice groups) and no customer
//      text naming "regular" — indistinguishable, to GUARD 10's existing
//      checks, from the model inventing a selection — and reverted it:
//      deleted it from cart_json.options, added it back to pending_options,
//      dropped the correctly-resolved price contribution (it was $0 here,
//      but the mechanism would drop a nonzero one identically). Reply
//      became "I still need to know what option you'd like on the Cheese
//      Burger. What'll it be?" — a dead-end question with only ONE valid
//      answer that the customer already, structurally, cannot get wrong.
//
// This was UNREACHABLE before the gate fix (every item with a sole-choice
// required group had been bot_state='blocked' menu-wide), not a regression
// introduced by item 8 or GUARD 10 individually — the interaction was never
// exercised live until an item with this exact shape (required group, ONE
// active choice, that choice not flagged is_default) became orderable.
//
// FIX: a required group with exactly ONE active choice can never have an
// "invented" selection — there is nothing else it could ever resolve to.
// Applying it is a fact, not a decision, the same reasoning ask-plan-
// engine.ts's own auto_single mode already documents (spec §2.2). This is
// NOT compiled-path-specific: a legacy add_item call resolving a required
// single-choice group has the identical shape and the identical latent bug,
// simply never reached live before now.
//
// GUARD 10 lives inline in index.ts (Deno.serve() at module scope, not
// importable). This mirrors the CURRENT decision logic (not the stale copy
// in guard10-unconsented-option-selection-20260906.test.ts, which still
// tests the substring-match version GUARD 10 no longer uses — see that
// guard's own 2026-09-07 fix comment in index.ts), with a source-text
// regression check at the bottom.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Choice { name: string; price_cents: number; is_default: boolean }
interface Group { name: string; required: boolean; choices: Choice[] }

// Mirrors GUARD 10's per-group skip conditions in index.ts, in order:
// (1) unchanged since last turn, (2) our own deterministic default-fill,
// (3) sole-choice (this fix), (4) genuinely customer-stated this turn (the
// real resolvePendingOptionAnswer stem-matcher is exercised elsewhere —
// pending-option.test.ts — so it's stubbed here as "never matches" to
// isolate the sole-choice condition under test).
function isSkippedByGuard10(chosen: string[], beforeChosen: string[] | undefined, group: Group): boolean {
  if (JSON.stringify(beforeChosen ?? null) === JSON.stringify(chosen)) return true;
  const defaultChoice = group.choices.find(c => c.is_default && c.price_cents === 0);
  if (defaultChoice && chosen.length === 1 && chosen[0] === defaultChoice.name) return true;
  if (group.choices.length === 1 && chosen.length === 1 && chosen[0] === group.choices[0].name) return true;
  return false;
}

const SOLE_CHOICE_NOT_DEFAULT: Group = {
  name: "Choose an option",
  required: true,
  choices: [{ name: "Regular", price_cents: 0, is_default: false }], // real Zio's Cheese Burger shape
};

Deno.test("GUARD 10 fix: a required group's sole choice is never reverted, even when not flagged is_default", () => {
  assert(isSkippedByGuard10(["Regular"], undefined, SOLE_CHOICE_NOT_DEFAULT));
});

Deno.test("GUARD 10 fix: sole-choice skip still requires the chosen value to actually match that one choice", () => {
  const group: Group = { name: "Choose an option", required: true, choices: [{ name: "Regular", price_cents: 0, is_default: false }] };
  assertEquals(isSkippedByGuard10(["Something Else"], undefined, group), false);
});

Deno.test("GUARD 10: a MULTI-choice group's non-default, non-stated selection is still reverted (the guard's real purpose, unaffected)", () => {
  const dressing: Group = {
    name: "Dressing",
    required: true,
    choices: [{ name: "Caesar", price_cents: 0, is_default: false }, { name: "Ranch", price_cents: 0, is_default: false }],
  };
  assertEquals(isSkippedByGuard10(["Caesar"], undefined, dressing), false);
});

Deno.test("GUARD 10: a multi-choice group's REAL default-fill (is_default, $0) is still skipped, unaffected by this fix", () => {
  const dressing: Group = {
    name: "Dressing",
    required: true,
    choices: [{ name: "Caesar", price_cents: 0, is_default: true }, { name: "Ranch", price_cents: 0, is_default: false }],
  };
  assertEquals(isSkippedByGuard10(["Caesar"], undefined, dressing), true);
});

Deno.test("regression: index.ts's GUARD 10 has the sole-choice skip, positioned before the revert", () => {
  assert(
    INDEX_SOURCE.includes("group.choices.length === 1 && chosen.length === 1 && chosen[0] === group.choices[0].name"),
    "GUARD 10 must skip reverting a required group's sole choice — there is nothing else it could have been",
  );
  const soleChoiceIdx = INDEX_SOURCE.indexOf("group.choices.length === 1 && chosen.length === 1");
  const revertIdx = INDEX_SOURCE.indexOf('GUARD 10 (unconsented option selection) tripped');
  assert(soleChoiceIdx > 0 && revertIdx > soleChoiceIdx, "the sole-choice skip must run BEFORE the revert/warn, not after");
});
