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
// this is what makes it resolve cleanly. Sausage Pizza's three sizes carry
// NO size_label in real Vito's data (a separate, pre-existing menu-data gap
// unrelated to this dispatch — the Small/Medium/Large-prefixed lexicon terms
// are also word-order "small sausage pizza" vs. the span's own trailing
// "sausage pizza small", so they never win the longest-match either), so it
// genuinely ties 3-way exactly as it does live — the correct acceptance
// shape here is "resolves to its own which-one list", never merged into the
// other item, never silently guessed.

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

const M1_MENU: TurnEngineMenuItem[] = [
  { id: GWF_SMALL, name: 'Gourmet White Fiesta - Small (10")', category: "Pizza", price_cents: 1295, bot_state: "orderable" },
  { id: GWF_MEDIUM, name: 'Gourmet White Fiesta - Medium (14")', category: "Pizza", price_cents: 2199, bot_state: "orderable" },
  GWF_LARGE_MENU_ITEM,
  { id: SAUSAGE_SMALL, name: 'Sausage Pizza - Small (10")', category: "Pizza", price_cents: 1745, bot_state: "orderable" },
  { id: SAUSAGE_MEDIUM, name: 'Sausage Pizza - Medium (14")', category: "Pizza", price_cents: 1945, bot_state: "orderable" },
  { id: SAUSAGE_LARGE, name: 'Sausage Pizza - Large (16")', category: "Pizza", price_cents: 2100, bot_state: "orderable" },
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

Deno.test("decide() (M1 END TO END, acceptance 1+2, real #26 message): Gourmet White Fiesta prices at its real $23.99 base, NO phantom Sausage topping, and Sausage Pizza resolves as its own separate which-one list — never merged", () => {
  const out = decide(M1_PROPOSAL, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, M1_MESSAGE);
  const realLines = out.cart.filter(l => typeof l.menu_item_id === "string");

  assertEquals(realLines.length, 1, `expected exactly one resolved cart line (Gourmet White Fiesta), got ${JSON.stringify(out.cart)}`);
  const gwfLine = realLines[0];
  assertEquals(gwfLine.menu_item_id, GWF_LARGE, "the resolved line must be the Large Gourmet White Fiesta");
  assertEquals(gwfLine.price_cents, 2399, `Gourmet White Fiesta must price at its real $23.99 base, got $${(gwfLine.price_cents / 100).toFixed(2)}`);
  const optionsJson = JSON.stringify(gwfLine.options ?? {});
  assertEquals(optionsJson.includes("Sausage"), false, `no Sausage topping must ever land on the Gourmet White Fiesta line — got ${optionsJson}`);

  // Sausage Pizza must be genuinely pending its own which-one question —
  // never silently dropped, never merged into the Gourmet line.
  assertEquals(
    (out.disambiguationCandidateIds ?? []).slice().sort(),
    [SAUSAGE_LARGE, SAUSAGE_MEDIUM, SAUSAGE_SMALL].sort(),
    `Sausage Pizza must tie its own 3 sizes as a pending which-one list — got ${JSON.stringify(out.disambiguationCandidateIds)}`,
  );
});

Deno.test("decide() (M1 END TO END, acceptance 2, sizes never cross): the Sausage Pizza disambiguation's own held size is 'Small', never 'Large' bled in from the Gourmet White Fiesta clause", () => {
  const out = decide(M1_PROPOSAL, [] as TurnEngineCartLine[], M1_MENU, M1_LEXICON, undefined, M1_MESSAGE);
  assertEquals(out.disambiguationSpanText, "Sausage Pizza - Small",
    `the held span text for the Sausage Pizza question must carry ITS OWN size, never the Gourmet White Fiesta's — got ${JSON.stringify(out.disambiguationSpanText)}`);
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

Deno.test("decide() (M1 root cause 2, reversed order): the ambiguous Sausage Pizza's held size is scoped to its OWN phrase even when its item_span drops the size and the OTHER item's size word appears earlier in the raw message", () => {
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

  assertEquals(
    (out.disambiguationCandidateIds ?? []).slice().sort(),
    [SAUSAGE_LARGE, SAUSAGE_MEDIUM, SAUSAGE_SMALL].sort(),
    `expected the Sausage Pizza tie pending — got ${JSON.stringify(out.disambiguationCandidateIds)}`,
  );
  assert(
    /small/i.test(out.disambiguationSpanText ?? ""),
    `held size must be recovered from Sausage Pizza's OWN phrase ("Small"), never the Gourmet White Fiesta's ("Large") — got ${JSON.stringify(out.disambiguationSpanText)}`,
  );
  assert(
    !/large/i.test(out.disambiguationSpanText ?? ""),
    `the OTHER item's size ("Large") must never bleed into this held span — got ${JSON.stringify(out.disambiguationSpanText)}`,
  );
});
