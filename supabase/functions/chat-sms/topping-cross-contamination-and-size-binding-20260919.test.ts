// M1 (2026-09-19 PO dispatch, TOP PRIORITY money bug, live conv d95306c8
// #26): "Hi, I'd like to order a Sausage Pizza - Small and a Gourmet White
// Fiesta - Large, please." — two separate pizzas named in one message, each
// with its own size. On HEAD (confirmed via probe-decide against real Vito's
// menu/lexicon data, propose.ts's own real proposal.adds shape:
// [{item_span:"Sausage Pizza - Small",...},{item_span:"Gourmet White Fiesta
// - Large",...}]) this billed:
//   1x Large Gourmet White Fiesta Pizza  $28.49  ($23.99 base + a Sausage
//                                                  topping never asked for)
//   + Sausage Pizza left pending its own which-one question
// "Sausage" got charged TWICE over: once as a phantom topping on the
// Gourmet White Fiesta, and again as its own still-pending pizza. Live, one
// turn later, it got worse — the customer's own restated sizes crossed
// between the two items and a THIRD line (a separate Small Sausage Pizza)
// landed on top, for a final $58.89 against what should have been $41.44.
//
// ROOT CAUSE 1 (topping bleed): the 00-BF modifier floor
// (turn-engine.ts's addGroups loop) scopes its topping scan to the current
// add's own phrase via phrase-split.ts's scopedModifierText — but
// resolveClaimedPhraseIndex matched a claim against a phrase using raw
// STRING substring containment, not word-level containment. The comma-split
// artifact "Hi" (from "Hi, I'd like to order...") is a literal substring of
// "White" ("gourmet WHITE fiesta large".includes("hi") === true), so the
// Gourmet White Fiesta claim matched BOTH its own real phrase and the bare
// "Hi" filler phrase — two matches, so resolveClaimedPhraseIndex returned
// null (its own "ambiguous claim" contract), and scopedModifierText fell
// back to the UNSCOPED whole message, in which "Sausage" (naming the OTHER
// pending pizza) read as a topping mention on the Gourmet White Fiesta line.
// Fixed two ways: (a) phrase-split.ts's resolveClaimedPhraseIndex now
// compares WORD arrays for a contiguous run, not raw substrings, so a short
// phrase's letters can never coincidentally match inside an unrelated
// word — see that file's own header; (b) a backstop,
// stripOtherItemSpansFromModifierText (phrase-split.ts), strips every OTHER
// add's own item_span (resolved sibling or still-pending disambiguation)
// out of the scoped text regardless of how it was derived, so a scoping
// failure from any OTHER cause can never reintroduce this bleed either.
//
// ROOT CAUSE 2 (size crossing): when an ambiguous add's own item_span drops
// the size word PROPOSE's model output sometimes drops (round-2 item 1's
// pre-existing "4 large pizzas" fix), the fallback used to scan the WHOLE
// raw customerMessage for the first size word it could find —
// extractGlobalSizeWord(customerMessage) — which silently grabs the OTHER
// item's size when two sized items are named in one message and the size
// word that happens to appear first in the raw text belongs to the other
// one. Fixed via rawMessageSizeWordForSpan (turn-engine.ts, right above
// decide()): the fallback is now scoped to the ambiguous span's OWN phrase
// (same splitCustomerPhrases/resolveClaimedPhraseIndex mechanism as the
// modifier floor), falling back to the old unscoped scan only when
// phrase-scoping itself has nothing better to offer — never worse than
// before this fix.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decide,
  type TurnEngineCartLine,
  type TurnEngineMenuItem,
  type Proposal,
} from "./turn-engine.ts";
import {
  splitCustomerPhrases,
  resolveClaimedPhraseIndex,
  stripOtherItemSpansFromModifierText,
} from "./phrase-split.ts";

// ── Root cause 1, isolated: resolveClaimedPhraseIndex's own word-boundary fix ──

Deno.test("resolveClaimedPhraseIndex (M1 root cause 1): a short filler phrase ('Hi') whose letters happen to appear inside an unrelated word ('White') must not falsely tie the match", () => {
  const message = "Hi, I'd like to order a Sausage Pizza - Small and a Gourmet White Fiesta - Large, please.";
  const phrases = splitCustomerPhrases(message);
  assertEquals(phrases, ["Hi", "I'd like to order a Sausage Pizza - Small", "a Gourmet White Fiesta - Large", "please."]);
  assertEquals(resolveClaimedPhraseIndex(phrases, "Gourmet White Fiesta - Large"), 2,
    "the Gourmet claim must resolve uniquely to its own real phrase, not bounce to null because 'Hi' coincidentally substring-matches inside 'White'");
  assertEquals(resolveClaimedPhraseIndex(phrases, "Sausage Pizza - Small"), 1,
    "the Sausage claim must resolve uniquely to its own real phrase");
});

Deno.test("resolveClaimedPhraseIndex: legitimate substring/prefix claims against their own phrase still resolve (no regression)", () => {
  const phrases = ["a Chicken Fajita", "2 Regular Slices with sausage", "please"];
  assertEquals(resolveClaimedPhraseIndex(phrases, "2 Regular Slices"), 1);
  assertEquals(resolveClaimedPhraseIndex(phrases, "Regular Slices"), 1);
});

// ── Root cause 1, isolated: stripOtherItemSpansFromModifierText backstop ──

Deno.test("stripOtherItemSpansFromModifierText (M1 root cause 1 backstop): strips another add's own span, leaves everything else intact", () => {
  const text = "Hi, I'd like to order a Sausage Pizza - Small and a Gourmet White Fiesta - Large, please.";
  const stripped = stripOtherItemSpansFromModifierText(text, ["Sausage Pizza - Small"]);
  assertEquals(/sausage/i.test(stripped), false, `"Sausage" must be gone: ${stripped}`);
  assertEquals(/gourmet white fiesta/i.test(stripped), true, `the Gourmet White Fiesta text must survive: ${stripped}`);
});

Deno.test("stripOtherItemSpansFromModifierText: never strips a span shorter than 3 characters (too collision-prone to remove as a unit)", () => {
  assertEquals(stripOtherItemSpansFromModifierText("a hi bye", ["hi"]), "a hi bye");
});

// ── End to end through decide(), real #26 message, real Vito's shapes ─────
//
// Menu/lexicon shapes below mirror real Vito's data exactly (verified live,
// 2026-09-19): Gourmet White Fiesta's three sizes each carry a real
// size_label ("Small (10\")" etc.), so resolveItem's size-token filter
// narrows the bare shared "gourmet white fiesta" term down to one target —
// this is what makes it resolve cleanly via the LEXICON. Sausage Pizza's
// three sizes carry NO size_label in real Vito's data (a separate,
// pre-existing menu-data gap unrelated to this dispatch), so resolveItem's
// own lexicon-based tiebreak genuinely ties it 3-way, exactly as it does
// live. Originally (rule 2's first half) that tie was left open as its own
// which-one question — since REOPENED: narrowAmbiguousCandidatesBySpanSize
// (turn-engine.ts) closes this same tie a different way, deriving each
// candidate's size from its own MENU ITEM NAME text instead of the missing
// lexicon size_label, so a customer-stated size resolves it outright. The
// correct acceptance shape is now "resolves directly when a size is stated,
// asks only when genuinely nothing narrows it" — see the tests below.

const GWF_SMALL = "gwf-small";
const GWF_MEDIUM = "gwf-medium";
const GWF_LARGE = "gwf-large";
const SAUSAGE_SMALL = "sausage-small";
const SAUSAGE_MEDIUM = "sausage-medium";
const SAUSAGE_LARGE = "sausage-large";
const TOPPING_GROUP = "grp-toppings";

const GWF_LARGE_MENU_ITEM: TurnEngineMenuItem = {
  id: GWF_LARGE, name: 'Gourmet White Fiesta - Large (16")', category: "Pizza", price_cents: 2399, bot_state: "orderable",
  ask_plan: {
    compiled_at: "", compiler_version: 1, display_name: "Large Gourmet White Fiesta Pizza",
    base_price_cents: 2399, recap_template: "", ticket_template: "",
    steps: [{
      group_id: TOPPING_GROUP, slot_key: "toppings", kind: "modifier" as const, ask_mode: "on_request" as const,
      prompt_template: "toppings.ask",
      choices: [
        { id: "c-sausage-whole", display: "Sausage (Whole pizza)", price_delta_cents: 450 },
        { id: "c-bacon-whole", display: "Bacon (Whole pizza)", price_delta_cents: 450 },
      ],
    }],
  },
  option_groups: [{ id: TOPPING_GROUP, name: "Toppings" }],
};

// PO dispatch 2026-09-19 (rule 2 REOPENED): a minimal, no-modifier-steps
// ask_plan — real enough to pass the "isn't available to order this way
// yet" ask_plan gate (turn-engine.ts's add-application loop) that a resolved
// add must clear, without dragging in unrelated topping-step fixtures. Real
// Vito's Sausage Pizza items DO carry ask_plan in live data (confirmed via
// the probe-decide harness this fix was verified against) — this test never
// needed one before because Sausage always stayed pending its own
// disambiguation; now that it resolves outright, it needs one too.
function basicAskPlan(displayName: string, priceCents: number) {
  return {
    compiled_at: "", compiler_version: 1, display_name: displayName,
    base_price_cents: priceCents, recap_template: "", ticket_template: "",
    steps: [],
  };
}

const M1_MENU: TurnEngineMenuItem[] = [
  { id: GWF_SMALL, name: 'Gourmet White Fiesta - Small (10")', category: "Pizza", price_cents: 1295, bot_state: "orderable" },
  { id: GWF_MEDIUM, name: 'Gourmet White Fiesta - Medium (14")', category: "Pizza", price_cents: 2199, bot_state: "orderable" },
  GWF_LARGE_MENU_ITEM,
  { id: SAUSAGE_SMALL, name: 'Sausage Pizza - Small (10")', category: "Pizza", price_cents: 1745, bot_state: "orderable", ask_plan: basicAskPlan("Small Sausage Pizza", 1745) },
  { id: SAUSAGE_MEDIUM, name: 'Sausage Pizza - Medium (14")', category: "Pizza", price_cents: 1945, bot_state: "orderable", ask_plan: basicAskPlan("Medium Sausage Pizza", 1945) },
  { id: SAUSAGE_LARGE, name: 'Sausage Pizza - Large (16")', category: "Pizza", price_cents: 2100, bot_state: "orderable", ask_plan: basicAskPlan("Large Sausage Pizza", 2100) },
];

const M1_LEXICON = [
  // Gourmet White Fiesta — bare term shared by all 3 sizes; size_label
  // (below) is what narrows it, exactly like real Vito's data.
  { term: "gourmet white fiesta", target_id: GWF_SMALL, category: "Pizza", size_label: 'Small (10")' },
  { term: "gourmet white fiesta", target_id: GWF_MEDIUM, category: "Pizza", size_label: 'Medium (14")' },
  { term: "gourmet white fiesta", target_id: GWF_LARGE, category: "Pizza", size_label: 'Large (16")' },
  { term: "gourmet white fiesta pizza", target_id: GWF_LARGE, category: "Pizza", size_label: 'Large (16")' },
  // Sausage Pizza — bare term shared by all 3 sizes, NO size_label (real
  // Vito's data gap, out of this dispatch's scope) — genuinely ties.
  { term: "sausage pizza", target_id: SAUSAGE_SMALL, category: "Pizza", size_label: null },
  { term: "sausage pizza", target_id: SAUSAGE_MEDIUM, category: "Pizza", size_label: null },
  { term: "sausage pizza", target_id: SAUSAGE_LARGE, category: "Pizza", size_label: null },
];

const M1_MESSAGE = "Hi, I'd like to order a Sausage Pizza - Small and a Gourmet White Fiesta - Large, please.";

// The real proposal.adds shape captured live from propose.ts against real
// Vito's data for this exact message.
const M1_PROPOSAL: Proposal = {
  intent: "order", removes: [], modifies: [],
  adds: [
    { item_span: "Sausage Pizza - Small", quantity: 1, choices: [] },
    { item_span: "Gourmet White Fiesta - Large", quantity: 1, choices: [] },
  ],
};

// PO dispatch 2026-09-19 (M1 rule 2, REOPENED — same conv d95306c8 #26): the
// two tests below originally asserted that Sausage Pizza stays pending its
// own 3-way which-one question, on the theory that resolveItem's LEXICON
// size_label gap (Sausage Pizza's size_label is null in real Vito's data,
// unlike Gourmet White Fiesta's) made that tie unbreakable without asking.
// It doesn't: the customer's own words state "Small" right next to "Sausage
// Pizza", and narrowAmbiguousCandidatesBySpanSize (turn-engine.ts, beside
// rawMessageSizeWordForSpan) now derives each candidate's size from its own
// MENU ITEM NAME text — the same way filterCandidatesBySizeWord already
// narrows an answered disambiguation — closing the tie before a question
// ever opens. Verified against real Vito's live menu/lexicon data via the
// probe-decide harness (scripts/tmp-m1-topping-crosscontam-probe-20260919.ts
// plus an ad hoc extension covering this exact message): real propose.ts
// output for this message resolves to "1x Small Sausage Pizza $17.45" and
// "1x Large Gourmet White Fiesta Pizza $23.99", total $41.44, no
// disambiguation — the fixture prices below match those real figures.
Deno.test("decide() (M1 END TO END, acceptance 1+2, real #26 message, rule 2 completed): Sausage Pizza and Gourmet White Fiesta BOTH resolve immediately — Small Sausage Pizza and Large Gourmet White Fiesta, no which-one question for either, no phantom topping", () => {
  const out = decide(M1_PROPOSAL, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, M1_MESSAGE);
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");

  assertEquals(realLines.length, 2, `expected exactly two resolved cart lines, got ${JSON.stringify(out.cart)}`);
  assertEquals(out.disambiguationCandidateIds, null,
    `no which-one question must open for either item — got ${JSON.stringify(out.disambiguationCandidateIds)}`);

  const sausageLine = realLines.find(l => l.menu_item_id === SAUSAGE_SMALL);
  assert(sausageLine, `expected a resolved Small Sausage Pizza line — got ${JSON.stringify(out.cart)}`);
  assertEquals(sausageLine!.price_cents, 1745, `Small Sausage Pizza must price at its real $17.45, got $${(sausageLine!.price_cents / 100).toFixed(2)}`);

  const gwfLine = realLines.find(l => l.menu_item_id === GWF_LARGE);
  assert(gwfLine, `expected a resolved Large Gourmet White Fiesta line — got ${JSON.stringify(out.cart)}`);
  assertEquals(gwfLine!.price_cents, 2399, `Gourmet White Fiesta must price at its real $23.99 base, got $${(gwfLine!.price_cents / 100).toFixed(2)}`);
  const optionsJson = JSON.stringify(gwfLine!.options ?? {});
  assertEquals(optionsJson.includes("Sausage"), false, `no Sausage topping must ever land on the Gourmet White Fiesta line — got ${optionsJson}`);

  const total = realLines.reduce((s, l) => s + l.price_cents * (l.quantity ?? 1), 0);
  assertEquals(total, 4144, `total must be the real $41.44 ($17.45 + $23.99), got $${(total / 100).toFixed(2)}`);
});

Deno.test("decide() (M1 END TO END, acceptance 2, sizes never cross): Sausage Pizza resolves to Small, never Large bled in from the Gourmet White Fiesta clause", () => {
  const out = decide(M1_PROPOSAL, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, M1_MESSAGE);
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");
  const sausageIds = new Set([SAUSAGE_SMALL, SAUSAGE_MEDIUM, SAUSAGE_LARGE]);
  const sausageLine = realLines.find(l => sausageIds.has(l.menu_item_id as string));
  assertEquals(sausageLine?.menu_item_id, SAUSAGE_SMALL,
    `Sausage Pizza must resolve to Small, its OWN stated size, never a size bled in from the Gourmet White Fiesta clause — got ${JSON.stringify(out.cart)}`);
});

// ── Acceptance point 3: a legitimate single-item + shared-vocabulary-topping
// message must still work — the fix must not over-strip ──────────────────

Deno.test("decide() (M1 acceptance 3, no false negative): naming ONLY Gourmet White Fiesta with a real 'extra sausage' topping request still applies the topping — the word 'sausage' is not automatically excluded just because a DIFFERENT, UNNAMED menu item happens to share it", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Gourmet White Fiesta - Large", quantity: 1, choices: [] }],
  };
  const out = decide(proposal, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined,
    "a Large Gourmet White Fiesta with extra sausage please");
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(realLines.length, 1, `expected exactly one cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(realLines[0].menu_item_id, GWF_LARGE);
  const optionsJson = JSON.stringify(realLines[0].options ?? {});
  assert(optionsJson.includes("Sausage (Whole pizza)"), `a genuinely requested Sausage topping on a single-item message must still land — got ${optionsJson}`);
});

// ── Root cause 2, isolated via decide(): the raw-message size fallback is
// scoped to the ambiguous item's own phrase, never the whole message ──────
//
// Forces the fallback by handing decide() an item_span that (like PROPOSE's
// own model output sometimes does — see round-2 item 1's pre-existing
// comment above the fallback in turn-engine.ts) omits the size word the
// customer actually typed, and reverses which item comes first in the raw
// message so a naive first-match-in-string scan would grab the WRONG item's
// size.

// PO dispatch 2026-09-19 (rule 2 REOPENED): originally this test forced the
// phrase-scoped fallback and asserted only that the eventual QUESTION's held
// size text was correct ("Small", never "Large"). Now that a correctly
// recovered size closes the tie outright (narrowAmbiguousCandidatesBySpanSize
// reuses the identical rawMessageSizeWordForSpan recovery this test exists
// to prove, just one step earlier), the same recovery resolves Sausage Pizza
// directly — no question, no held span text at all. The regression this test
// guards — the OTHER item's size never bleeding onto Sausage Pizza — is now
// asserted against the resolved cart line instead of the question's text.
Deno.test("decide() (M1 root cause 2, reversed order): Sausage Pizza's OWN phrase resolves it to Small even when its item_span drops the size and the OTHER item's size word appears earlier in the raw message", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [
      // Gourmet named FIRST, with its size — resolves cleanly.
      { item_span: "Gourmet White Fiesta - Large", quantity: 1, choices: [] },
      // Sausage named SECOND — item_span drops "Small" (PROPOSE model-output
      // gap), even though the customer's own raw message states it.
      { item_span: "Sausage Pizza", quantity: 1, choices: [] },
    ],
  };
  const message = "a Gourmet White Fiesta - Large and a Sausage Pizza - Small, please.";
  const out = decide(proposal, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, message);

  assertEquals(out.disambiguationCandidateIds, null,
    `expected Sausage Pizza to resolve outright, no pending tie — got ${JSON.stringify(out.disambiguationCandidateIds)}`);
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");
  const sausageIds = new Set([SAUSAGE_SMALL, SAUSAGE_MEDIUM, SAUSAGE_LARGE]);
  const sausageLine = realLines.find(l => sausageIds.has(l.menu_item_id as string));
  assertEquals(sausageLine?.menu_item_id, SAUSAGE_SMALL,
    `Sausage Pizza's own phrase must resolve it to Small, never the Gourmet White Fiesta's "Large" bled in from earlier in the raw message — got ${JSON.stringify(out.cart)}`);
  const gwfLine = realLines.find(l => l.menu_item_id === GWF_LARGE);
  assert(gwfLine, `expected the Gourmet White Fiesta to still resolve to Large — got ${JSON.stringify(out.cart)}`);
});

// ── New (rule 2 completion): a single-item message with a stated size that
// ties must resolve immediately too — the same narrowing, not a multi-item-
// only special case. ─────────────────────────────────────────────────────

Deno.test("decide() (M1 rule 2 completion, single item): 'Sausage Pizza - Small' alone (no second item) resolves to Small directly, no which-one question, confirming the size-binding mechanism this fix reuses works standalone", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Sausage Pizza - Small", quantity: 1, choices: [] }],
  };
  const message = "Hi, I'd like a Sausage Pizza - Small, please.";
  const out = decide(proposal, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, message);

  assertEquals(out.disambiguationCandidateIds, null,
    `expected Sausage Pizza to resolve outright — got ${JSON.stringify(out.disambiguationCandidateIds)}`);
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(realLines.length, 1, `expected exactly one resolved cart line, got ${JSON.stringify(out.cart)}`);
  assertEquals(realLines[0].menu_item_id, SAUSAGE_SMALL, `expected the Small Sausage Pizza — got ${JSON.stringify(out.cart)}`);
  assertEquals(realLines[0].price_cents, 1745, `Small Sausage Pizza must price at its real $17.45, got $${(realLines[0].price_cents / 100).toFixed(2)}`);
});

Deno.test("decide() (M1 rule 2 completion, no size stated at all): 'Sausage Pizza' with NO size anywhere in the message still opens its genuine 3-way which-one question — the new narrowing never guesses when there is nothing to narrow with", () => {
  const proposal: Proposal = {
    intent: "order", removes: [], modifies: [],
    adds: [{ item_span: "Sausage Pizza", quantity: 1, choices: [] }],
  };
  const message = "Hi, I'd like a Sausage Pizza, please.";
  const out = decide(proposal, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, message);

  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");
  assertEquals(realLines.length, 0, `expected no cart line — a genuine tie with no stated size must still ask, got ${JSON.stringify(out.cart)}`);
  assertEquals(
    (out.disambiguationCandidateIds ?? []).slice().sort(),
    [SAUSAGE_LARGE, SAUSAGE_MEDIUM, SAUSAGE_SMALL].sort(),
    `expected the genuine 3-way tie pending — got ${JSON.stringify(out.disambiguationCandidateIds)}`,
  );
});
