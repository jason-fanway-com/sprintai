// PO fix (00-BG Part 2, committed standalone in 00-BH Part A):
// matchChoiceInText's stem-subset match has no negation awareness —
// "not well done, actually give me a large fries too" stem-matches "Well
// Done" (both its stems, "well" and "done", are literally present) with
// nothing to say the customer just ruled it out. Reuses reactive-modifier-
// match.ts's isNegated exactly as ask-plan-engine.ts's modifier branch
// already uses it — not a second detector. Scoped to the deterministic
// fallback only; a model-asserted choice is unaffected.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import { resolveAskPlan } from "./ask-plan-engine.ts";

// Real Vito's-style Temp slot (5 choices, all $0 delta — same shape used
// throughout this session's turn-engine fixtures).
const TEMP_STEP: CompiledStep = {
  group_id: "grp-temp", slot_key: null, kind: "slot", ask_mode: "ask", prompt_template: "temp.ask",
  choices: [
    { id: "well", display: "Well Done", price_delta_cents: 0 },
    { id: "med", display: "Medium", price_delta_cents: 0 },
    { id: "rare", display: "Rare", price_delta_cents: 0 },
    { id: "medwell", display: "Medium Well", price_delta_cents: 0 },
    { id: "medrare", display: "Medium Rare", price_delta_cents: 0 },
  ],
};
const TEMP_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-15T00:00:00Z", compiler_version: 1, display_name: "Cheese Burger", base_price_cents: 849,
  steps: [TEMP_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}", ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

Deno.test("'not well done, actually give me a large fries too' does not resolve to Well Done", () => {
  const result = resolveAskPlan(TEMP_ASK_PLAN, "not well done, actually give me a large fries too", new Set(), new Map());
  assertEquals(result.resolved, [], "a negated choice must never resolve, even though its stems are all present in the message");
  assertEquals(result.nextStep?.group_id, "grp-temp");
});

Deno.test("plain 'well done' (no negation) still resolves correctly — the negation check must not break the normal case", () => {
  const result = resolveAskPlan(TEMP_ASK_PLAN, "well done please", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.display, "Well Done");
});

// NOTE: "not well done, medium please" is NOT a clean isolation case — both
// "Well Done" and "Medium"'s full stem sets are simultaneously present in
// that message, so matchChoiceByStems's pre-existing tie rule (2+ choices
// whose complete stems are all present -> ambiguous) already returns null
// regardless of negation. That is a separate, pre-existing limitation of
// the tie logic, not something this negation check was asked to solve —
// not asserted here to avoid claiming a guarantee this fix doesn't make.
