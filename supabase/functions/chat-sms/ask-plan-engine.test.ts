// Item 8 sequencer/resolver — unit tests against fixtures shaped exactly
// like supabase/functions/_shared/compile-menu.ts's real buildAskPlan()
// output (same field names, same types imported directly from that module,
// not redeclared here).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AskPlan, CompiledStep } from "../_shared/compile-menu.ts";
import {
  matchChoiceInText,
  matchAssertedChoice,
  renderChoiceList,
  renderStepQuestion,
  resolveAskPlan,
  allSlotsResolved,
  enforceVerbatimStepQuestion,
  applyCompiledAddItem,
  applyCompiledModifyItem,
  isRemovalRequested,
  type CompiledCartLine,
  type CompiledMenuItem,
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
    { id: "c-1", display: "Buffalo Ranch", price_delta_cents: 500 },
    { id: "c-2", display: "Ranch Dressing", price_delta_cents: 500 },
  ];
  // "buffalo ranch dressing" satisfies BOTH choices' full stem sets, and
  // (unlike the exact-match cases below) is the verbatim full name of
  // NEITHER — a real overlapping-choice-name case where the customer's text
  // genuinely doesn't tell us which one they mean.
  const match = matchChoiceInText(choices, "buffalo ranch dressing");
  assertEquals(match, null);
});

Deno.test("matchChoiceInText: exact match wins over a shorter sibling choice whose stems are a subset (round-3 fix, real Vito's dressing shape)", () => {
  const choices = [
    { id: "c-italian", display: "Italian", price_delta_cents: 0 },
    { id: "c-creamy", display: "Creamy Italian", price_delta_cents: 0 },
  ];
  // Before the fix: "Italian"'s stems ({"italian"}) are a subset of
  // "Creamy Italian"'s full stem set too, so BOTH counted as hits and the
  // customer's own verbatim, unambiguous answer resolved to null forever
  // (§8.3 live report, Vito's Tuna Salad). The exact full-string match must
  // win outright before the fuzzy subset check ever runs.
  assertEquals(matchChoiceInText(choices, "Creamy Italian")?.id, "c-creamy");
  assertEquals(matchChoiceInText(choices, "Italian")?.id, "c-italian");
});

Deno.test("matchChoiceInText: exact match wins even when a numeric suffix is the only distinguishing stem (real Zio's wings shape)", () => {
  const choices = [
    { id: "c-8", display: "8 Pieces", price_delta_cents: 0 },
    { id: "c-14", display: "14 Pieces", price_delta_cents: 700 },
  ];
  // Both displays reduce to the identical stem {"piece"} once the sub-3-char
  // numeric tokens are dropped by significantStems, so the fuzzy path alone
  // can never tell them apart (§8.3 live report, Zio's Bone In Wings).
  assertEquals(matchChoiceInText(choices, "14 Pieces")?.id, "c-14");
  assertEquals(matchChoiceInText(choices, "8 Pieces")?.id, "c-8");
});

Deno.test("matchChoiceInText: two choices sharing the exact same display name stay ambiguous, never guesses", () => {
  const choices = [
    { id: "c-1", display: "Large", price_delta_cents: 500 },
    { id: "c-2", display: "Large", price_delta_cents: 700 },
  ];
  assertEquals(matchChoiceInText(choices, "Large"), null);
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

Deno.test("resolveAskPlan: round-3 fix — naming a specialty item whose OWN display_name contains an ingredient word does not reactively charge that ingredient as a modifier (real Zio's 'Mike's Hot Honey Pepperoni Sicilian' shape)", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    display_name: "Mike's Hot Honey Pepperoni Sicilian",
    steps: [
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.on_request",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }, { id: "c-bacon", display: "Bacon", price_delta_cents: 300 }] },
    ],
  };
  // §8.3's walk (and a real customer just naming the item) passes the
  // item's own display_name as customerText — before the fix this silently
  // matched "Pepperoni" via matchChoiceInText, since the word appears
  // verbatim in the item's own name, charging an extra the customer never
  // asked for.
  const named = resolveAskPlan(plan, "Mike's Hot Honey Pepperoni Sicilian", new Set(), new Map());
  assertEquals(named.resolved.length, 0);
  assertEquals(named.totalDeltaCents, 0);
});

Deno.test("resolveAskPlan: round-3 fix does not over-correct — a later, standalone request for a DIFFERENT topping still resolves and prices normally", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    display_name: "Mike's Hot Honey Pepperoni Sicilian",
    steps: [
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.on_request",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }, { id: "c-bacon", display: "Bacon", price_delta_cents: 300 }] },
    ],
  };
  // A later turn's text is its own message, not a repeat of the item's
  // name — "add extra bacon please" contributes real stems the item's own
  // name doesn't contain, so the fix's "said nothing beyond the name" gate
  // never engages and Bacon still resolves and prices normally.
  const result = resolveAskPlan(plan, "add extra bacon please", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "c-bacon");
  assertEquals(result.totalDeltaCents, 300);
});

Deno.test("resolveAskPlan: round-3 fix — answering a required SLOT question does not also reactively charge an unrelated MODIFIER choice sharing the same display (real Zio's 'Choose Cheese' / 'Add Extra' sub shape)", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    display_name: "Ham & Cheese Sub",
    steps: [
      { group_id: "grp-cheese", slot_key: "choice", kind: "slot", ask_mode: "ask", prompt_template: "choice.ask",
        choices: [{ id: "c-american", display: "American Cheese", price_delta_cents: 0 }, { id: "c-swiss", display: "Swiss Cheese", price_delta_cents: 0 }] },
      { group_id: "grp-extra", slot_key: null, kind: "modifier", ask_mode: "on_request", prompt_template: "extra.on_request",
        choices: [{ id: "c-extra-american", display: "American Cheese", price_delta_cents: 75 }, { id: "c-bacon", display: "Bacon", price_delta_cents: 200 }] },
    ],
  };
  // Answering the required "which cheese" slot with the choice's own exact
  // display ("American Cheese") must resolve ONLY the slot — the identical
  // text also fully satisfying an unrelated "Add Extra" modifier choice in a
  // DIFFERENT group is not a request for the $0.75 upcharge.
  const result = resolveAskPlan(plan, "American Cheese", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "c-american");
  assertEquals(result.totalDeltaCents, 0);
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

Deno.test("resolveAskPlan: D1 fix — a modifier choice already in consumedModifierChoiceIds is not re-matched, even though the text still names it", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      SIZE_STEP,
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once",
        choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }] },
    ],
  };
  const consumed = new Set(["c-pep"]);
  const result = resolveAskPlan(plan, "large with pepperoni", new Set(), new Map(), consumed);
  // Size still resolves normally — only the already-consumed modifier is skipped.
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].slot_key, "size");
  assertEquals(result.totalDeltaCents, 500);
});

Deno.test("resolveAskPlan: consumedModifierChoiceIds does not affect an UNRELATED choice in the same group", () => {
  const plan: AskPlan = {
    ...SIZE_ASK_PLAN,
    steps: [
      { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "offer_once", prompt_template: "toppings.offer_once",
        choices: [
          { id: "c-pep", display: "Pepperoni", price_delta_cents: 300 },
          { id: "c-mush", display: "Mushroom", price_delta_cents: 250 },
        ] },
    ],
  };
  const consumed = new Set(["c-pep"]);
  const result = resolveAskPlan(plan, "with mushroom", new Set(), new Map(), consumed);
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "c-mush");
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

// ── Item 2 (2026-09-08, PO live verification): enforceVerbatimStepQuestion ─
// PO's real repro: "turkey sub" x4 produced 4 different renderings of the
// same compiled question (different wording, "(+$8)" vs "(+$8.00)", "-" vs
// ":" separator, straight vs curly quotes). These reproduce that class of
// paraphrase and assert the canonical text is what survives.
const TURKEY_QUESTION = "What size Turkey Sub? Medium 12'' (no extra charge) or Large 16'' +$8.00.";
const TURKEY_CHOICES = ["Medium 12''", "Large 16''"];

Deno.test("enforceVerbatimStepQuestion: model relayed it verbatim — left untouched, warm lead-in preserved", () => {
  const reply = `Turkey Sub added! ${TURKEY_QUESTION}`;
  assertEquals(enforceVerbatimStepQuestion(reply, TURKEY_QUESTION, TURKEY_CHOICES), reply);
});

Deno.test("enforceVerbatimStepQuestion: quote-style paraphrase (the exact PO repro) is dropped, canonical text appended", () => {
  // Straight double-quote inch marks instead of the stored two-apostrophe
  // choice names — the exact mismatch that broke the old raw-substring check.
  const modelReply = `Turkey Sub added! What size - medium 12" or large 16" (+$8)?`;
  const result = enforceVerbatimStepQuestion(modelReply, TURKEY_QUESTION, TURKEY_CHOICES);
  assertEquals(result, `Turkey Sub added! ${TURKEY_QUESTION}`);
  // The customer must see the canonical line exactly once, never the model's
  // own paraphrase attempt alongside it.
  assertEquals(result.split(TURKEY_QUESTION).length - 1, 1);
  assert(!result.includes("(+$8)?"), "the model's own wrong-format price clause must not survive alongside the canonical one");
});

Deno.test("enforceVerbatimStepQuestion: reply with no lead-in at all — canonical question stands alone, nothing to duplicate", () => {
  const modelReply = `Medium or large? Medium's free and large is eight bucks more.`;
  const result = enforceVerbatimStepQuestion(modelReply, TURKEY_QUESTION, TURKEY_CHOICES);
  assertEquals(result, TURKEY_QUESTION);
});

Deno.test("enforceVerbatimStepQuestion: reply has real warmth AND a wrong price attempt — warmth kept, price attempt dropped", () => {
  const modelReply = `Great choice! Turkey Sub added to your order. What size, medium or large (large is $8 more)?`;
  const result = enforceVerbatimStepQuestion(modelReply, TURKEY_QUESTION, TURKEY_CHOICES);
  assertEquals(result, `Great choice! Turkey Sub added to your order. ${TURKEY_QUESTION}`);
});

// ─── applyCompiledAddItem: D1 fix, the real Zio's "1 pepperoni, 1 plain,
// 1 hawaiian, 1 meat lovers" merge (2026-09-08 P0, PO re-diagnosis) ────────
//
// Empirically confirmed before this fix: two add_item calls in one turn for
// the SAME base item (one meaning "pepperoni", one meaning "plain") both
// receive the SAME whole-turn customerMessage (index.ts computes it once
// per turn and reuses it for every add_item call — correct for slots like
// size, wrong for modifiers). Both calls reactively matched "Pepperoni" from
// the shared text, computed IDENTICAL ask_plan_selections, and the existing
// identicalExisting quantity-stack logic (working exactly as designed, given
// wrong inputs) silently merged them into ONE line — the customer's "plain"
// pizza vanished with no error, no question, no trace.

const TOPPING_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-08T00:00:00Z",
  compiler_version: 1,
  display_name: "Neapolitan Cheese Pizza",
  base_price_cents: 1500,
  steps: [
    { group_id: "grp-size", slot_key: "size", kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
      choices: [{ id: "c-med", display: "Medium", price_delta_cents: 0 }, { id: "c-large", display: "Large 18''", price_delta_cents: 274 }] },
    { group_id: "grp-top", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.on_request",
      choices: [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }, { id: "c-mush", display: "Mushroom", price_delta_cents: 250 }] },
  ],
  recap_template: "",
  ticket_template: "",
};

function cheesePizzaMenuItem(): CompiledMenuItem {
  return {
    ask_plan: TOPPING_ASK_PLAN,
    bot_state: "orderable",
    option_groups: [{ id: "grp-size", name: "Size" }, { id: "grp-top", name: "Add Toppings" }],
  };
}

Deno.test("applyCompiledAddItem: D1 real repro — without consumedModifierChoiceIds, 'pepperoni' then 'plain' merge into ONE line (documents the pre-fix defect)", () => {
  const cart: CompiledCartLine[] = [];
  const turnText = "I want 4 large pizzas. 1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers";
  applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null); // no consumed set passed
  applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null);
  assertEquals(cart.length, 1, "documents the bug: both calls collapse into one line when nothing tracks consumption");
  assertEquals(cart[0].quantity, 2);
});

Deno.test("applyCompiledAddItem: D1 fix — WITH consumedModifierChoiceIds, 'pepperoni' then 'plain' produce TWO distinct lines", () => {
  const cart: CompiledCartLine[] = [];
  const turnText = "I want 4 large pizzas. 1 pepperoni, 1 plain, 1 hawaiian, 1 meat lovers";
  const consumed = new Set<string>();
  const r1 = applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null, consumed);
  const r2 = applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null, consumed);
  assertEquals(cart.length, 2, "each named item must get its own cart line");
  assert(r1.cartChanged && r2.cartChanged);
  const withPepperoni = cart.filter(c => c.options?.["Add Toppings"]?.includes("Pepperoni"));
  const withoutPepperoni = cart.filter(c => !c.options?.["Add Toppings"]);
  assertEquals(withPepperoni.length, 1, "exactly one line should carry the Pepperoni topping");
  assertEquals(withoutPepperoni.length, 1, "exactly one line should be the plain cheese pizza with no topping");
  assertEquals(withPepperoni[0].price_cents, 1500 + 274 + 300); // base + Large size delta + pepperoni delta
  assertEquals(withoutPepperoni[0].price_cents, 1500 + 274); // base + Large size delta only
});

Deno.test("applyCompiledAddItem: D1 fix — a genuinely DIFFERENT base item in the same turn is unaffected by the consumed set", () => {
  const cart: CompiledCartLine[] = [];
  const turnText = "1 pepperoni pizza, 1 pepperoni calzone";
  const consumed = new Set<string>();
  applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null, consumed);
  const calzoneAskPlan: AskPlan = { ...TOPPING_ASK_PLAN, display_name: "Calzone", steps: [
    { group_id: "grp-calzone-top", slot_key: "toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "toppings.on_request",
      choices: [{ id: "c-calzone-pep", display: "Pepperoni", price_delta_cents: 350 }] },
  ] };
  const calzoneMenuItem: CompiledMenuItem = { ask_plan: calzoneAskPlan, bot_state: "orderable", option_groups: [{ id: "grp-calzone-top", name: "Add Toppings" }] };
  applyCompiledAddItem(cart, calzoneMenuItem, "calzone-id", 1, turnText, null, consumed);
  assertEquals(cart.length, 2);
  assert(cart[0].options?.["Add Toppings"]?.includes("Pepperoni"), "the pizza's own Pepperoni choice id is unrelated to the calzone's — must still apply");
  assert(cart[1].options?.["Add Toppings"]?.includes("Pepperoni"), "a different item's own topping choice id is a different choice id — must still apply independently");
});

Deno.test("applyCompiledAddItem: D1 fix — a genuinely repeated identical order (no list, same item twice with the same topping) still stacks quantity when there's no consumed-set collision risk (single call, quantity=2)", () => {
  const cart: CompiledCartLine[] = [];
  const consumed = new Set<string>();
  // A single add_item call with quantity=2 (the normal QUANTITY PARSING path,
  // e.g. "2 pepperoni pizzas") must still produce ONE line with quantity 2 —
  // this fix must not break ordinary quantity stacking.
  applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 2, "2 pepperoni pizzas", null, consumed);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 2);
  assert(cart[0].options?.["Add Toppings"]?.includes("Pepperoni"));
});

// ── P0 LIVE MONEY REGRESSION (2026-09-09, PO idx444, the actual reported
// shape): "one plain, one pepperoni, one meat lover and one hawaai" bled the
// Pepperoni topping onto the Meat Lover's AND Hawaiian lines too — $6.00 of
// toppings nobody ordered. The D1 consumedModifierChoiceIds mechanism above
// does NOT catch this: Meat Lover's Pizza and Hawaiian Pizza each have their
// OWN, separately-ID'd "Pepperoni" topping choice on their own "Add Extra
// Toppings" modifier group (a real menu shape — a specialty pizza can still
// take extra toppings) — a DIFFERENT DB id than the cheese pizza's own
// Pepperoni choice, so ID-based consumption tracking never sees them as the
// same thing. The bleed happens because Meat Lover's/Hawaiian's own reactive
// modifier match scans the WHOLE turn's text, finds the word "pepperoni"
// (already spoken for by a completely different phrase/line), and matches
// it against their OWN Pepperoni choice. otherItemPhraseHints (the
// deterministic compose step's own claimed tokens, e.g. "one pepperoni")
// must exclude that phrase from Meat Lover's/Hawaiian's own reactive text so
// neither can ever reactively claim it.
const MEAT_LOVERS_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-09T00:00:00Z",
  compiler_version: 1,
  display_name: "Meat Lover's Pizza",
  base_price_cents: 2499,
  steps: [
    { group_id: "grp-ml-size", slot_key: "size", kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
      choices: [{ id: "c-ml-large", display: "Large 18''", price_delta_cents: 0 }] },
    { group_id: "grp-ml-extra", slot_key: "extra_toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "extra.on_request",
      choices: [{ id: "c-ml-pep", display: "Pepperoni", price_delta_cents: 300 }, { id: "c-ml-mush", display: "Mushroom", price_delta_cents: 250 }] },
  ],
  recap_template: "",
  ticket_template: "",
};
function meatLoversMenuItem(): CompiledMenuItem {
  return { ask_plan: MEAT_LOVERS_ASK_PLAN, bot_state: "orderable", option_groups: [{ id: "grp-ml-size", name: "Size" }, { id: "grp-ml-extra", name: "Add Extra Toppings" }] };
}
const HAWAIIAN_ASK_PLAN: AskPlan = {
  compiled_at: "2026-09-09T00:00:00Z",
  compiler_version: 1,
  display_name: "Hawaiian Pizza",
  base_price_cents: 2499,
  steps: [
    { group_id: "grp-haw-size", slot_key: "size", kind: "slot", ask_mode: "ask", prompt_template: "size.ask",
      choices: [{ id: "c-haw-large", display: "Large 18''", price_delta_cents: 0 }] },
    { group_id: "grp-haw-extra", slot_key: "extra_toppings", kind: "modifier", ask_mode: "on_request", prompt_template: "extra.on_request",
      choices: [{ id: "c-haw-pep", display: "Pepperoni", price_delta_cents: 300 }] },
  ],
  recap_template: "",
  ticket_template: "",
};
function hawaiianMenuItem(): CompiledMenuItem {
  return { ask_plan: HAWAIIAN_ASK_PLAN, bot_state: "orderable", option_groups: [{ id: "grp-haw-size", name: "Size" }, { id: "grp-haw-extra", name: "Add Extra Toppings" }] };
}

Deno.test("applyCompiledAddItem: modifierScopeText stops Pepperoni (claimed by a DIFFERENT item's own compose) from bleeding onto Meat Lover's/Hawaiian's OWN separate Pepperoni choice", () => {
  const cart: CompiledCartLine[] = [];
  const turnText = "one plain, one pepperoni, one meat lover and one hawaai";
  const consumed = new Set<string>();
  // Each call is scoped to exactly its OWN real phrase (as index.ts's
  // source_phrase + resolveClaimedPhraseIndex would establish) — "one
  // pepperoni" never appears in either scope, so neither call can reactively
  // claim it.
  applyCompiledAddItem(cart, meatLoversMenuItem(), "ml-id", 1, turnText, null, consumed, [], "one meat lover");
  applyCompiledAddItem(cart, hawaiianMenuItem(), "haw-id", 1, turnText, null, consumed, [], "one hawaai");
  assertEquals(cart.length, 2);
  assertEquals(cart[0].options?.["Add Extra Toppings"], undefined, "Meat Lover's must NOT reactively claim Pepperoni from a different phrase");
  assertEquals(cart[1].options?.["Add Extra Toppings"], undefined, "Hawaiian must NOT reactively claim Pepperoni from a different phrase");
  assertEquals(cart[0].price_cents, 2499);
  assertEquals(cart[1].price_cents, 2499);
});

// ── Item 8 fix (2026-09-08 P0, 392894c diagnosis, PO sign-off) ─────────────
// Root cause: matchChoiceInText only strips plurals, so "pepp" (or any
// abbreviation) never text-matches "Pepperoni" — full stop, regardless of
// consumedModifierChoiceIds. Separately, the compiled add_item branch threw
// away the model's own resolved modifiers/options tool-call input entirely,
// so even a model that correctly composed "pepp" -> Pepperoni per the system
// prompt had no path to get that decision into ask_plan_selections. These
// tests exercise the fix: matchAssertedChoice (constraint 1's validation
// gate) and its wiring into resolveAskPlan/applyCompiledAddItem/
// applyCompiledModifyItem (constraint 2).

Deno.test("matchAssertedChoice: exact case-insensitive name match resolves; the abbreviation itself never matches (no fuzzy tolerance)", () => {
  const choices = [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }, { id: "c-mush", display: "Mushroom", price_delta_cents: 250 }];
  assertEquals(matchAssertedChoice(choices, ["Pepperoni"])?.id, "c-pep");
  assertEquals(matchAssertedChoice(choices, ["pepperoni"])?.id, "c-pep", "case-insensitive");
  assertEquals(matchAssertedChoice(choices, ["  Pepperoni  "])?.id, "c-pep", "trims whitespace");
  assertEquals(matchAssertedChoice(choices, ["pepp"]), null, "an abbreviation is not an exact name — never trusted on its own word");
});

Deno.test("matchAssertedChoice: a string naming no real choice is never trusted — constraint 1, no unvalidated write-through", () => {
  const choices = [{ id: "c-pep", display: "Pepperoni", price_delta_cents: 300 }];
  assertEquals(matchAssertedChoice(choices, ["Anchovies"]), null);
  assertEquals(matchAssertedChoice(choices, []), null);
  assertEquals(matchAssertedChoice([], ["Pepperoni"]), null);
});

Deno.test("resolveAskPlan: 'pepp' never resolves via customerText alone (documents 392894c's root cause — still true after the fix, by design)", () => {
  const result = resolveAskPlan(TOPPING_ASK_PLAN, "1 pepp, 1 plain", new Set(["grp-size"]), new Map());
  assertEquals(result.resolved.find(r => r.group_id === "grp-top"), undefined, "text-only 'pepp' must not silently become Pepperoni");
});

Deno.test("resolveAskPlan: the fix — a model-asserted 'Pepperoni' (validated) resolves the topping even though customerText only says 'pepp'", () => {
  const result = resolveAskPlan(TOPPING_ASK_PLAN, "1 pepp, 1 plain", new Set(["grp-size"]), new Map(), undefined, ["Pepperoni"]);
  const top = result.resolved.find(r => r.group_id === "grp-top");
  assertEquals(top?.choice.id, "c-pep");
  assertEquals(top?.choice.price_delta_cents, 300);
});

Deno.test("resolveAskPlan: a model-asserted choice still respects consumedModifierChoiceIds (constraint 1 doesn't bypass D1's per-turn guard)", () => {
  const consumed = new Set<string>(["c-pep"]);
  const result = resolveAskPlan(TOPPING_ASK_PLAN, "1 pepp", new Set(["grp-size"]), new Map(), consumed, ["Pepperoni"]);
  assertEquals(result.resolved.find(r => r.group_id === "grp-top"), undefined, "already consumed this turn — must not be re-granted even via structured assertion");
});

Deno.test("applyCompiledAddItem: THE FIX — 'pepp'/'plain' repro with model-asserted options per call produces TWO distinct, correctly-composed lines", () => {
  // Mirrors the live acceptance test's exact wording ("1 pepp, 1 plain, 1
  // hawaiin, 1 meat lovers") for the two same-base-item segments, and
  // exercises what the fixed index.ts's add_item branch now does: passes
  // each call's OWN modelAssertedChoiceTexts (flattened modifiers/options
  // from that specific tool call), not just the shared turn-wide text.
  const cart: CompiledCartLine[] = [];
  // Real production flow: D2's stated-attribute-carryforward prepends the
  // PRIOR turn ("I want 4 large pizzas") onto compiledMatchText, so "large"
  // is visible to every add_item call this turn exactly like this fixture.
  const turnText = "I want 4 large pizzas. 1 pepp, 1 plain, 1 hawaiin, 1 meat lovers";
  const consumed = new Set<string>();
  const r1 = applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null, consumed, ["Pepperoni"]);
  const r2 = applyCompiledAddItem(cart, cheesePizzaMenuItem(), "cheese-id", 1, turnText, null, consumed, []);
  assertEquals(cart.length, 2, "the pepp/plain segments must land as two real lines, not merge");
  assert(r1.cartChanged && r2.cartChanged);
  const withPepperoni = cart.filter(c => c.options?.["Add Toppings"]?.includes("Pepperoni"));
  const withoutPepperoni = cart.filter(c => !c.options?.["Add Toppings"]);
  assertEquals(withPepperoni.length, 1, "exactly one line explicitly named Pepperoni");
  assertEquals(withoutPepperoni.length, 1, "exactly one line stays plain — no phantom topping");
  assertEquals(withPepperoni[0].price_cents, 1500 + 274 + 300); // base + Large size delta + pepperoni delta
  assertEquals(withoutPepperoni[0].price_cents, 1500 + 274); // base + Large size delta only
});

// ── Constraint 2: applyCompiledModifyItem — modify_item must be ask_plan-
// aware for a compiled item, never a side channel around ask_plan_selections.
Deno.test("applyCompiledModifyItem: quantity-only change applies directly, does not touch ask_plan_selections", () => {
  const cart: CompiledCartLine[] = [{ menu_item_id: "cheese-id", name: "Neapolitan Cheese Pizza", quantity: 1, price_cents: 1774, modifiers: [], options: { Size: ["Large 18''"] }, ask_plan_selections: { "grp-size": "c-large" } }];
  const result = applyCompiledModifyItem(cart, cheesePizzaMenuItem(), "cheese-id", 3, "", []);
  assertEquals(result.ok, true);
  assertEquals(cart[0].quantity, 3);
  assertEquals(cart[0].ask_plan_selections, { "grp-size": "c-large" });
});

Deno.test("applyCompiledModifyItem: resolving a pending slot via a model-asserted (validated) choice writes into ask_plan_selections and recomputes real price — not a raw field write", () => {
  const cart: CompiledCartLine[] = [{ menu_item_id: "cheese-id", name: "Neapolitan Cheese Pizza", quantity: 1, price_cents: 1500, modifiers: [], ask_plan_selections: {}, pending_options: ["Size"] }];
  const result = applyCompiledModifyItem(cart, cheesePizzaMenuItem(), "cheese-id", undefined, "", ["Large 18''"]);
  assertEquals(result.ok, true);
  assertEquals(cart[0].ask_plan_selections, { "grp-size": "c-large" });
  assertEquals(cart[0].price_cents, 1500 + 274, "real compiled delta applied, not left at base price");
  assertEquals(cart[0].pending_options, undefined, "no more open slots");
});

Deno.test("applyCompiledModifyItem: an asserted string naming no real choice is silently dropped — never written unvalidated (constraint 1 inside modify_item too)", () => {
  const cart: CompiledCartLine[] = [{ menu_item_id: "cheese-id", name: "Neapolitan Cheese Pizza", quantity: 1, price_cents: 1500, modifiers: [], ask_plan_selections: {}, pending_options: ["Size"] }];
  const result = applyCompiledModifyItem(cart, cheesePizzaMenuItem(), "cheese-id", undefined, "", ["Extra Large"]);
  assertEquals(result.ok, true);
  assertEquals(cart[0].ask_plan_selections, {}, "an unmatched string must never land in ask_plan_selections");
  assertEquals(cart[0].pending_options, ["Size"], "the slot is still open — nothing was silently guessed");
});

Deno.test("applyCompiledModifyItem: modify_item for a compiled line honors consumedModifierChoiceIds — the same choice already granted to another line this turn is not re-applied", () => {
  const cart: CompiledCartLine[] = [
    { menu_item_id: "cheese-id", name: "Neapolitan Cheese Pizza", quantity: 1, price_cents: 1500, modifiers: [], ask_plan_selections: { "grp-size": "c-med" } },
  ];
  const consumed = new Set<string>(["c-pep"]);
  const result = applyCompiledModifyItem(cart, cheesePizzaMenuItem(), "cheese-id", undefined, "", ["Pepperoni"], consumed);
  assertEquals(result.ok, true);
  assertEquals(cart[0].ask_plan_selections?.["grp-top"], undefined, "already consumed elsewhere this turn — modify_item must not create a second grant");
});

Deno.test("applyCompiledModifyItem: item not in cart returns ok:false, never mutates", () => {
  const cart: CompiledCartLine[] = [];
  const result = applyCompiledModifyItem(cart, cheesePizzaMenuItem(), "cheese-id", 2, "", []);
  assertEquals(result.ok, false);
  assertEquals(result.cartChanged, false);
});

// ── P0 (2026-09-09, live money defect): negated modifiers must never charge ──
// Live incident: Zio's Pizzeria (shop_id 2cba7b51-211c-4437-8910-1af4dcc03498),
// "large plain pizza, no extra cheese" -> Extra Cheese ($4.00) was silently
// added to the cart line anyway. Live-verified 2026-09-09 against the real
// endpoint (channel: web, no test flag) before this fix: cart came back with
// options: {"Add Toppings": ["Extra Cheese"]}, price_cents 2199 (base 1799 +
// 400). Root cause: resolveAskPlan's modifier branch had no negation check at
// all -- matchChoiceInText only requires every one of a choice's stems to
// appear in the text, and "extra"/"cheese" are both present in "no extra
// cheese" the same as they'd be present in a genuine request for it.
//
// Fixture below uses the REAL group_id and choice ids/prices read live from
// Zio's Large 18" Neapolitan Cheese Pizza's own ask_plan (menu_items.id
// 35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd), not invented values, so a schema/id
// drift in the real menu would show up here.
const ZIOS_LARGE_TOPPINGS_STEP: CompiledStep = {
  group_id: "c61917b8-f553-4a7b-b138-8bf640069d72",
  slot_key: null,
  kind: "modifier",
  ask_mode: "on_request",
  prompt_template: "make_it.on_request",
  choices: [
    { id: "28a7d57a-4dcc-4e66-b303-2917f2f12bd7", display: "Pepperoni", price_delta_cents: 300 },
    { id: "a7b5c218-0006-4d8d-b14b-4609a2f4f2d3", display: "Extra Cheese", price_delta_cents: 400 },
  ],
};

const ZIOS_LARGE_PLAN: AskPlan = {
  ...SIZE_ASK_PLAN,
  display_name: "Neapolitan Cheese Pizza - Large 18''",
  base_price_cents: 1799,
  steps: [ZIOS_LARGE_TOPPINGS_STEP],
};

Deno.test("resolveAskPlan: P0 fix -- 'no extra cheese' never resolves Extra Cheese, real Zio's ids/prices", () => {
  const result = resolveAskPlan(ZIOS_LARGE_PLAN, "large plain pizza, no extra cheese", new Set(), new Map());
  assertEquals(result.resolved.length, 0, "Extra Cheese must not be resolved when the customer explicitly declined it");
  assertEquals(result.totalDeltaCents, 0);
});

Deno.test("resolveAskPlan: P0 fix -- an UNNEGATED topping in the same message still resolves and prices correctly (no over-correction)", () => {
  const result = resolveAskPlan(ZIOS_LARGE_PLAN, "large pizza with pepperoni", new Set(), new Map());
  assertEquals(result.resolved.length, 1);
  assertEquals(result.resolved[0].choice.id, "28a7d57a-4dcc-4e66-b303-2917f2f12bd7");
  assertEquals(result.totalDeltaCents, 300);
});

Deno.test("resolveAskPlan: P0 fix -- negating one topping does not suppress a different, unnegated topping in a separate step (same message)", () => {
  // Two separate steps (mirrors Zio's real ask_plan shape: multiple modifier
  // steps coexist, e.g. "Make it"/"Add Toppings") so each choice list is
  // textually unambiguous on its own -- matchChoiceInText's single-match
  // ambiguity rule (unrelated to this fix) is not what's under test here.
  const cheeseOnlyStep: CompiledStep = { ...ZIOS_LARGE_TOPPINGS_STEP, group_id: "grp-cheese-only", choices: [ZIOS_LARGE_TOPPINGS_STEP.choices[1]] };
  const pepperoniOnlyStep: CompiledStep = { ...ZIOS_LARGE_TOPPINGS_STEP, group_id: "grp-pepperoni-only", choices: [ZIOS_LARGE_TOPPINGS_STEP.choices[0]] };
  const plan: AskPlan = { ...ZIOS_LARGE_PLAN, steps: [cheeseOnlyStep, pepperoniOnlyStep] };
  const result = resolveAskPlan(plan, "pepperoni pizza, no extra cheese", new Set(), new Map());
  assertEquals(result.resolved.length, 1, "exactly the unnegated Pepperoni should resolve");
  assertEquals(result.resolved[0].choice.id, "28a7d57a-4dcc-4e66-b303-2917f2f12bd7");
  assertEquals(result.totalDeltaCents, 300);
});

Deno.test("resolveAskPlan: P0 fix -- a model-asserted choice is also negation-checked, not just the text-matched fallback", () => {
  const result = resolveAskPlan(
    ZIOS_LARGE_PLAN,
    "large plain pizza, no extra cheese please",
    new Set(),
    new Map(),
    undefined,
    ["Extra Cheese"], // model incorrectly proposed it despite the decline
  );
  assertEquals(result.resolved.length, 0, "a model-asserted choice must still be rejected when the customer's own text negates it");
});

Deno.test("resolveAskPlan: 'no extra toppings' (generic, no specific topping named) never matches any real choice — sanity check for the broader phrasing", () => {
  const result = resolveAskPlan(ZIOS_LARGE_PLAN, "large plain pizza, no extra toppings", new Set(), new Map());
  assertEquals(result.resolved.length, 0);
  assertEquals(result.totalDeltaCents, 0);
});

// ── P0 (2026-09-09, live money — cart-mutation gap): "remove the extra
// cheese" against a cart line that already HAS Extra Cheese selected must
// actually strip it from the cart, not just produce a reply that claims it
// did. Live incident: Zio's Pizzeria (shop_id
// 2cba7b51-211c-4437-8910-1af4dcc03498) — "large cheese pizza with extra
// cheese" -> cart Large 18'' Neapolitan Cheese Pizza, options {"Add
// Toppings": ["Extra Cheese"]}, price_cents 2199; "remove the extra cheese"
// / "actually remove the extra cheese" -> cart UNCHANGED, still 2199,
// reproduced deterministically pre-fix. Every test below asserts BOTH the
// tool result AND the real cart-line state (options/ask_plan_selections/
// price_cents) after the call — a passing reply with an unchanged cart is
// exactly how the mutation gap shipped as "fixed" the first time (v316
// tested reply text only).
function ziosLargeCheeseMenuItem(): CompiledMenuItem {
  return {
    ask_plan: ZIOS_LARGE_PLAN,
    bot_state: "orderable",
    option_groups: [{ id: ZIOS_LARGE_TOPPINGS_STEP.group_id, name: "Add Toppings" }],
  };
}

function cartLineWithExtraCheese(): CompiledCartLine {
  return {
    menu_item_id: "zios-large-cheese",
    name: "Neapolitan Cheese Pizza - Large 18''",
    quantity: 1,
    price_cents: 2199,
    modifiers: [],
    options: { "Add Toppings": ["Extra Cheese"] },
    ask_plan_selections: { [ZIOS_LARGE_TOPPINGS_STEP.group_id]: "a7b5c218-0006-4d8d-b14b-4609a2f4f2d3" },
  };
}

Deno.test("isRemovalRequested: 'remove the extra cheese' matches 'Extra Cheese'", () => {
  assertEquals(isRemovalRequested("remove the extra cheese", "Extra Cheese"), true);
});

Deno.test("isRemovalRequested: 'actually remove the extra cheese' matches (filler word before the verb)", () => {
  assertEquals(isRemovalRequested("actually remove the extra cheese", "Extra Cheese"), true);
});

Deno.test("isRemovalRequested: unrelated text (no verb, no name) does not match", () => {
  assertEquals(isRemovalRequested("large pepperoni pizza please", "Extra Cheese"), false);
});

Deno.test("isRemovalRequested: removal verb present but naming a DIFFERENT option does not match", () => {
  assertEquals(isRemovalRequested("remove the pepperoni", "Extra Cheese"), false);
});

Deno.test("applyCompiledModifyItem: THE FIX — 'remove the extra cheese' actually mutates the cart line (options, ask_plan_selections, and price all update), not just the reply", () => {
  const cart: CompiledCartLine[] = [cartLineWithExtraCheese()];
  const result = applyCompiledModifyItem(
    cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined,
    "remove the extra cheese", [],
  );
  assertEquals(result.ok, true);
  assertEquals(result.cartChanged, true, "the whole point of the fix — this must no longer be a silent no-op");
  // Reply-facing value:
  assertEquals((result.result as { price: number }).price, 1799, "reply-facing price must reflect the real post-removal total");
  // Real cart state — the actual bug: a reply can lie, the cart_json cannot.
  assertEquals(cart[0].price_cents, 1799, "base price only, Extra Cheese's $4.00 must be gone");
  assertEquals(cart[0].options, undefined, "no options left once the only selected topping is removed");
  assertEquals(cart[0].ask_plan_selections?.[ZIOS_LARGE_TOPPINGS_STEP.group_id], undefined, "engine-authoritative state must also be cleared, not just the display fields");
});

Deno.test("applyCompiledModifyItem: 'actually remove the extra cheese' (the exact second live repro phrasing) also mutates the cart", () => {
  const cart: CompiledCartLine[] = [cartLineWithExtraCheese()];
  const result = applyCompiledModifyItem(
    cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined,
    "actually remove the extra cheese", [],
  );
  assertEquals(result.cartChanged, true);
  assertEquals(cart[0].price_cents, 1799);
  assertEquals(cart[0].options, undefined);
});

Deno.test("applyCompiledModifyItem: a bare modify_item(menu_item_id) call with NO options/modifiers args still removes the option — the model doesn't need to know the right arg shape, the customer's own words drive it", () => {
  const cart: CompiledCartLine[] = [cartLineWithExtraCheese()];
  // Empty modelAssertedChoiceTexts, no explicitOptions — only customerMessage
  // carries the removal intent, exactly like a minimal/uninformed tool call.
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "remove the extra cheese", []);
  assertEquals(result.cartChanged, true);
  assertEquals(cart[0].price_cents, 1799);
});

Deno.test("applyCompiledModifyItem: explicit empty-array options signal (\"Add Toppings\": []) also clears the selection — parity with the legacy non-compiled path's contract", () => {
  const cart: CompiledCartLine[] = [cartLineWithExtraCheese()];
  const result = applyCompiledModifyItem(
    cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined,
    "", [], undefined, { "Add Toppings": [] },
  );
  assertEquals(result.cartChanged, true);
  assertEquals(cart[0].price_cents, 1799);
  assertEquals(cart[0].ask_plan_selections?.[ZIOS_LARGE_TOPPINGS_STEP.group_id], undefined);
});

Deno.test("applyCompiledModifyItem: removal is scoped to the NAMED option only — a second selected topping on the same line survives", () => {
  // Mirrors the real production shape (same as the "negating one topping
  // does not suppress a different, unnegated topping" test above): each
  // topping is its own single-choice step/group, not two choices sharing one
  // group — Zio's real compiled menu gives every on-request modifier its own
  // group_id.
  const cheeseOnlyStep: CompiledStep = { ...ZIOS_LARGE_TOPPINGS_STEP, group_id: "grp-cheese-only", choices: [ZIOS_LARGE_TOPPINGS_STEP.choices[1]] };
  const pepperoniOnlyStep: CompiledStep = { ...ZIOS_LARGE_TOPPINGS_STEP, group_id: "grp-pepperoni-only", choices: [ZIOS_LARGE_TOPPINGS_STEP.choices[0]] };
  const plan: AskPlan = { ...ZIOS_LARGE_PLAN, steps: [cheeseOnlyStep, pepperoniOnlyStep] };
  const menuItem: CompiledMenuItem = {
    ask_plan: plan,
    bot_state: "orderable",
    option_groups: [{ id: cheeseOnlyStep.group_id, name: "Extra Cheese" }, { id: pepperoniOnlyStep.group_id, name: "Pepperoni" }],
  };
  const cart: CompiledCartLine[] = [{
    menu_item_id: "zios-large-both",
    name: "Neapolitan Cheese Pizza - Large 18''",
    quantity: 1,
    price_cents: 1799 + 400 + 300,
    modifiers: [],
    options: { "Extra Cheese": ["Extra Cheese"], "Pepperoni": ["Pepperoni"] },
    ask_plan_selections: {
      [cheeseOnlyStep.group_id]: "a7b5c218-0006-4d8d-b14b-4609a2f4f2d3",
      [pepperoniOnlyStep.group_id]: "28a7d57a-4dcc-4e66-b303-2917f2f12bd7",
    },
  }];
  const result = applyCompiledModifyItem(cart, menuItem, "zios-large-both", undefined, "remove the extra cheese", []);
  assertEquals(result.cartChanged, true);
  assertEquals(cart[0].price_cents, 1799 + 300, "Extra Cheese's $4.00 removed, Pepperoni's $3.00 stays");
  assertEquals(cart[0].ask_plan_selections?.[cheeseOnlyStep.group_id], undefined);
  assertEquals(cart[0].ask_plan_selections?.[pepperoniOnlyStep.group_id], "28a7d57a-4dcc-4e66-b303-2917f2f12bd7", "the unrelated, unnamed topping must survive");
  assertEquals(cart[0].options, { Pepperoni: ["Pepperoni"] }, "Extra Cheese's group must be gone from the displayed options entirely");
});

Deno.test("applyCompiledModifyItem: no removal language present — an already-selected option is left completely alone (regression guard)", () => {
  const cart: CompiledCartLine[] = [cartLineWithExtraCheese()];
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "can I also get a large pepperoni pizza", []);
  assertEquals(cart[0].price_cents, 2199, "an unrelated message must never silently strip an existing selection");
  assertEquals(cart[0].options, { "Add Toppings": ["Extra Cheese"] });
});

// D1 fix (2026-09-09, live money, both directions — real Zio's repro: "a
// large cheese pizza with extra cheese and a plain large cheese pizza"
// added as one qty-2 line, then differentiated via modify_item, priced
// Extra Cheese onto BOTH pizzas — $43.98 instead of the correct $39.98).
function twoPlainCheesePizzas(): CompiledCartLine[] {
  return [{
    menu_item_id: "zios-large-cheese",
    name: "Neapolitan Cheese Pizza - Large 18''",
    quantity: 2,
    price_cents: 1799,
    modifiers: [],
    ask_plan_selections: {},
  }];
}

Deno.test("applyCompiledModifyItem: D1 fix — adding a modifier to a qty-2 line with no 'both/all' language SPLITS one unit off, does not re-price the whole line", () => {
  const cart = twoPlainCheesePizzas();
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "one with extra cheese", ["Extra Cheese"]);
  assertEquals(result.cartChanged, true);
  assertEquals(cart.length, 2, "must become two distinct lines, not one qty-2 line");
  assertEquals(cart[0].quantity, 1);
  assertEquals(cart[0].price_cents, 1799, "the untouched pizza keeps the plain price");
  assertEquals(cart[0].options, undefined);
  assertEquals(cart[1].quantity, 1);
  assertEquals(cart[1].price_cents, 2199, "only the split-off pizza gets Extra Cheese's $4.00");
  assertEquals(cart[1].options, { "Add Toppings": ["Extra Cheese"] });
  const total = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  assertEquals(total, 3998, "$39.98 total — Extra Cheese charged exactly once, not twice");
});

Deno.test("applyCompiledModifyItem: D1 fix — 'both'/'all' language applies the change to the WHOLE line, no split", () => {
  const cart = twoPlainCheesePizzas();
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "extra cheese on both please", ["Extra Cheese"]);
  assertEquals(result.cartChanged, true);
  assertEquals(cart.length, 1, "explicit 'both' must not split the line");
  assertEquals(cart[0].quantity, 2);
  assertEquals(cart[0].price_cents, 2199);
  const total = cart.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  assertEquals(total, 4398, "$43.98 — both pizzas genuinely got Extra Cheese this time");
});

Deno.test("applyCompiledModifyItem: D1 fix — a qty-1 line is never split (nothing to split off)", () => {
  const cart: CompiledCartLine[] = [{
    menu_item_id: "zios-large-cheese", name: "Neapolitan Cheese Pizza - Large 18''",
    quantity: 1, price_cents: 1799, modifiers: [], ask_plan_selections: {},
  }];
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "with extra cheese", ["Extra Cheese"]);
  assertEquals(result.cartChanged, true);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
  assertEquals(cart[0].price_cents, 2199);
});

Deno.test("applyCompiledModifyItem: D1 fix — removal on a qty-2 line also splits (one loses the topping, one keeps it)", () => {
  const cart: CompiledCartLine[] = [{
    menu_item_id: "zios-large-cheese", name: "Neapolitan Cheese Pizza - Large 18''",
    quantity: 2, price_cents: 2199, modifiers: [],
    options: { "Add Toppings": ["Extra Cheese"] },
    ask_plan_selections: { [ZIOS_LARGE_TOPPINGS_STEP.group_id]: "a7b5c218-0006-4d8d-b14b-4609a2f4f2d3" },
  }];
  const result = applyCompiledModifyItem(cart, ziosLargeCheeseMenuItem(), "zios-large-cheese", undefined, "remove the extra cheese from one of them", []);
  assertEquals(result.cartChanged, true);
  assertEquals(cart.length, 2);
  assertEquals(cart[0].quantity, 1);
  assertEquals(cart[0].price_cents, 2199, "the untouched unit keeps Extra Cheese");
  assertEquals(cart[1].quantity, 1);
  assertEquals(cart[1].price_cents, 1799, "the split-off unit lost Extra Cheese");
});
