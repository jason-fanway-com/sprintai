// Item 8 sequencer/resolver — unit tests against fixtures shaped exactly
// like supabase/functions/_shared/compile-menu.ts's real buildAskPlan()
// output (same field names, same types imported directly from that module,
// not redeclared here).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import {
  matchChoiceInText,
  renderChoiceList,
  renderStepQuestion,
  resolveAskPlan,
  allSlotsResolved,
} from "./ask-plan-engine.ts";

// Fixture matching Jason's real Zio's repro: Buffalo Chicken Pizza with a
// size slot whose group name is Slice's generic "Choose an option" label
// (bug 2) — the engine must resolve on the CHOICE display text, not the
// group name, so the generic label never needs to reach the customer.
const SIZE_STEP: CompiledStep = {
  group_id: "grp-size",
  slot_key: "size",
  kind: "slot",
  ask_mode: "ask",
  prompt_template: "size.ask",
  choices: [
    { id: "c-small", display: "Small", price_delta_cents: 0 },
    { id: "c-large", display: "Large", price_delta_cents: 500 },
  ],
};

const SIZE_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-07T00:00:00Z",
  compiler_version: 1,
  display_name: "Buffalo Chicken Pizza",
  base_price_cents: 1999,
  steps: [SIZE_STEP],
  recap_template: "{qty} {display_name}{, with {modifiers}}",
  ticket_template: "{name}{\n  + {choice.display} x{qty}}",
};

Deno.test("matchChoiceInText: 'large buffalo chicken pizza' resolves the Large choice, not Small", () => {
  const match = matchChoiceInText(SIZE_STEP.choices, "large buffalo chicken pizza");
  assertEquals(match?.id, "c-large");
  assertEquals(match?.price_delta_cents, 500);
});

Deno.test("matchChoiceInText: bare 'medium' resolves against 'Medium 12\"' — bare number tokens aren't significant stems", () => {
  const subChoices = [
    { id: "c-med", display: 'Medium 12"', price_delta_cents: 0 },
    { id: "c-lg", display: 'Large 16"', price_delta_cents: 800 },
  ];
  // significantStems() drops tokens shorter than 3 chars, so '12'/'16' never
  // become required stems — "medium" alone is enough to match 'Medium 12"'.
  // This is the desired real-world behavior: a customer saying a bare size
  // word must resolve against a Slice choice display that also carries a
  // size number, exactly like Jason's live "large"/"medium" repro cases.
  const match = matchChoiceInText(subChoices, "medium");
  assertEquals(match?.id, "c-med");
});

Deno.test("matchChoiceInText: exact single-stem choice display matches cleanly (real Zio's shape)", () => {
  const match = matchChoiceInText(SIZE_STEP.choices, "medium sub");
  assertEquals(match, null); // "medium" isn't one of Small/Large — no false positive
  const largeMatch = matchChoiceInText(SIZE_STEP.choices, "give me a large one");
  assertEquals(largeMatch?.id, "c-large");
});

Deno.test("matchChoiceInText: ambiguous text matching multiple choices returns null, never guesses", () => {
  const choices = [
    { id: "c-1", display: "Large", price_delta_cents: 500 },
    { id: "c-2", display: "Large Pizza", price_delta_cents: 500 },
  ];
  // "large pizza" satisfies BOTH choices' full stem sets (Large needs only
  // "large"; Large Pizza needs "large"+"pizza", both present) — a real
  // overlapping-choice-name case, not a contrived one.
  const match = matchChoiceInText(choices, "large pizza");
  assertEquals(match, null);
});

Deno.test("matchChoiceInText: empty text or empty choice list never matches", () => {
  assertEquals(matchChoiceInText(SIZE_STEP.choices, ""), null);
  assertEquals(matchChoiceInText([], "large"), null);
});

Deno.test("renderChoiceList: two choices join with 'or', no prices", () => {
  assertEquals(renderChoiceList(SIZE_STEP.choices, false), "Small or Large");
});

Deno.test("renderChoiceList: with prices shows a delta for the upcharge and 'no extra charge' for zero", () => {
  assertEquals(renderChoiceList(SIZE_STEP.choices, true), "Small (no extra charge) or Large +$5.00");
});

Deno.test("renderChoiceList: more than 6 choices truncates to 5 plus 'or something else'", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, display: `Choice${i}`, price_delta_cents: 0 }));
  const rendered = renderChoiceList(many, false);
  assertEquals(rendered, "Choice0, Choice1, Choice2, Choice3, Choice4, or something else");
});

Deno.test("renderStepQuestion: known slot_key 'size' uses the exact Appendix C template with real prices", () => {
  const q = renderStepQuestion(SIZE_STEP, "Buffalo Chicken Pizza");
  assertEquals(q, "What size Buffalo Chicken Pizza? Small (no extra charge) or Large +$5.00.");
});

Deno.test("renderStepQuestion: unknown slot_key falls back to a generic deterministic template, never the raw Slice group name", () => {
  const step: CompiledStep = {
    group_id: "grp-x", slot_key: "spice_level", kind: "slot", ask_mode: "ask",
    prompt_template: "spice_level.ask",
    choices: [{ id: "c-mild", display: "Mild", price_delta_cents: 0 }, { id: "c-hot", display: "Hot", price_delta_cents: 0 }],
  };
  const q = renderStepQuestion(step, "Wings");
  assertEquals(q, "What spice level would you like for the Wings? Mild (no extra charge) or Hot (no extra charge).");
  // Bug 2 regression: the raw platform label ("Choose an option") must
  // never appear in a rendered question, known template or fallback.
  assert(!q.toLowerCase().includes("choose an option"));
});

// REGRESSION (2026-09-08, item 8 follow-up): the exact drift this fix
// closes — a group whose slot_key is null (the real state of all 494
// Zio's option_groups before this task) but whose prompt_template was
// already correctly compiler-derived from the group name. Before this fix,
// renderStepQuestion read slot_key directly and always missed, no matter
// what prompt_template said. Now it reads prompt_template, so a null
// slot_key no longer defeats a fallback the compiler already computed.
Deno.test("renderStepQuestion: null slot_key with a compiler-derived prompt_template still hits the Appendix C template (the Zio's turkey sub repro)", () => {
  const step: CompiledStep = {
    group_id: "grp-turkey-size", slot_key: null, kind: "slot", ask_mode: "ask",
    prompt_template: "size.ask",
    choices: [
      { id: "c-med", display: 'Medium 12"', price_delta_cents: 0 },
      { id: "c-lg", display: 'Large 16"', price_delta_cents: 800 },
    ],
  };
  const q = renderStepQuestion(step, "Turkey Sub");
  assertEquals(q, 'What size Turkey Sub? Medium 12" (no extra charge) or Large 16" +$8.00.');
});

// Same null-slot_key case, but the group name doesn't resolve to any known
// Appendix C key — prompt_template's own name-derived fallback becomes the
// readable label instead of the old bare "option" fallback.
Deno.test("renderStepQuestion: null slot_key with an unrecognized name-derived prompt_template uses a readable fallback label", () => {
  const step: CompiledStep = {
    group_id: "grp-x", slot_key: null, kind: "slot", ask_mode: "ask",
    prompt_template: "choose_an_option.ask",
    choices: [{ id: "c-a", display: "Basket", price_delta_cents: 0 }],
  };
  const q = renderStepQuestion(step, "Chicken Fingers & Fries");
  assertEquals(q, "What choose an option would you like for the Chicken Fingers & Fries? Basket (no extra charge).");
});

Deno.test("resolveAskPlan: 'large buffalo chicken pizza' resolves size to Large with the real $5.00 delta (bug 1)", () => {
  const result = resolveAskPlan(SIZE_ASK_PLAN, "large buffalo chicken pizza", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "c-large");
  assertEquals(result.totalDeltaCents, 500);
  assertEquals(result.nextStep, null);
});

Deno.test("resolveAskPlan: unresolvable text returns the step as nextStep, never invents a choice", () => {
  const result = resolveAskPlan(SIZE_ASK_PLAN, "chicken cheesesteak sub", new Set(), new Map());
  assertEquals(result.resolved.length, 0);
  assertEquals(result.totalDeltaCents, 0);
  assertEquals(result.nextStep?.group_id, "grp-size");
});

Deno.test("resolveAskPlan: auto_single applies the sole choice silently, no question", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [{
      group_id: "grp-only", slot_key: "prep", kind: "slot", ask_mode: "auto_single",
      prompt_template: "prep.auto_single",
      choices: [{ id: "c-only", display: "Grilled", price_delta_cents: 0 }],
    }],
  };
  const result = resolveAskPlan(plan, "anything, doesn't matter", new Set(), new Map());
  assertEquals(result.resolved[0].choice.id, "c-only");
  assertEquals(result.nextStep, null);
});

Deno.test("resolveAskPlan: apply_default applies the mapped default choice when the caller supplies one", () => {
  const step: CompiledStep = {
    group_id: "grp-dress", slot_key: "dressing", kind: "slot", ask_mode: "apply_default",
    prompt_template: "dressing.apply_default",
    choices: [
      { id: "c-ranch", display: "Ranch", price_delta_cents: 0 },
      { id: "c-caesar", display: "Caesar", price_delta_cents: 0 },
    ],
  };
  const plan: AskPlan = { ...SIZE_ASK_PLAN, steps: [step] };
  const result = resolveAskPlan(plan, "just the salad please", new Set(), new Map([["grp-dress", "c-ranch"]]));
  assertEquals(result.resolved[0].choice.id, "c-ranch");
  assertEquals(result.nextStep, null);
});

Deno.test("resolveAskPlan: apply_default with no known default falls back to asking rather than guessing (missing beats wrong)", () => {
  const step: CompiledStep = {
    group_id: "grp-dress", slot_key: "dressing", kind: "slot", ask_mode: "apply_default",
    prompt_template: "dressing.apply_default",
    choices: [
      { id: "c-ranch", display: "Ranch", price_delta_cents: 0 },
      { id: "c-caesar", display: "Caesar", price_delta_cents: 0 },
    ],
  };
  const plan: AskPlan = { ...SIZE_ASK_PLAN, steps: [step] };
  const result = resolveAskPlan(plan, "just the salad please", new Set(), new Map());
  assertEquals(result.resolved.length, 0);
  assertEquals(result.nextStep?.group_id, "grp-dress");
});

Deno.test("resolveAskPlan: already-resolved groups are skipped (multi-turn continuation)", () => {
  const twoStepPlan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      SIZE_STEP,
      { group_id: "grp-crust", slot_key: "crust", kind: "slot", ask_mode: "ask", prompt_template: "crust.ask",
        choices: [{ id: "c-thin", display: "Thin", price_delta_cents: 0 }, { id: "c-thick", display: "Thick", price_delta_cents: 0 }] },
    ],
  };
  // size already resolved on a prior turn; customer now answers the crust question.
  const result = resolveAskPlan(twoStepPlan, "thin", new Set(["grp-size"]), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "c-thin");
  assertEquals(result.nextStep, null);
});

Deno.test("resolveAskPlan: bug 4 fix — a modifier named in the same message is applied with its real price (spec Appendix B worked example)", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      SIZE_STEP,
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }] },
    ],
  };
  const result = resolveAskPlan(plan, "large with pepperoni", new Set(), new Map());
  assertEquals(result.resolved.length, 2);
  const bySlotKey = Object.fromEntries(result.resolved.map(r => [r.slot_key, r.choice]));
  assertEquals(bySlotKey["size"].id, "c-large");
  assertEquals(bySlotKey["toppings"].id, "c-pep");
  assertEquals(result.totalDeltaCents, 800); // $5.00 size delta + $3.00 pepperoni
});

Deno.test("resolveAskPlan: a modifier NOT mentioned this turn is simply not applied (never a question, never a guess)", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      SIZE_STEP,
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }] },
    ],
  };
  const result = resolveAskPlan(plan, "large", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].slot_key, "size");
  assertEquals(result.nextStep, null); // modifiers never become the "next question"
});

Deno.test("resolveAskPlan: an already-applied modifier (from a prior turn) is not re-matched or double-charged", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }] },
    ],
  };
  const result = resolveAskPlan(plan, "and also pepperoni again", new Set(["grp-top"]), new Map());
  assertEquals(result.resolved.length, 0);
  assertEquals(result.totalDeltaCents, 0);
});

Deno.test("allSlotsResolved: true only when every slot group_id is present, ignores modifier groups", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      SIZE_STEP,
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once", choices: [] },
    ],
  };
  assertEquals(allSlotsResolved(plan, new Set()), false);
  assertEquals(allSlotsResolved(plan, new Set(["grp-size"])), true); // modifier group never required
});

// ── Real-shape regression: the chicken cheesesteak sub bug (bug 5) ─────────
// "large" resolved a slot label but never applied the $8.00 delta. This
// fixture reproduces the exact real prices from Jason's live verification.
Deno.test("resolveAskPlan: chicken cheesesteak sub 'large' applies the real $8.00 delta (bug 5)", () => {
  const subStep: CompiledStep = {
    group_id: "grp-sub-size", slot_key: "size", kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
    choices: [
      { id: "c-med", display: "Medium", price_delta_cents: 0 },
      { id: "c-large", display: "Large", price_delta_cents: 800 },
    ],
  };
  const subPlan: AskPlan = { ...SIZE_ASK_PLAN, base_price_cents: 1099, steps: [subStep] };
  const result = resolveAskPlan(subPlan, "large", new Set(), new Map());
  assertEquals(result.resolved[0].choice.id, "c-large");
  assertEquals(result.totalDeltaCents, 800);
  assertEquals(subPlan.base_price_cents + result.totalDeltaCents, 1899); // $18.99
});
