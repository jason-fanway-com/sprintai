// BLOCKER 1 (docs/specs/2026-09-06-disambiguation-and-menu-gaps.md): unit
// coverage for the deterministic pending-disambiguation resolver. The live
// acceptance transcript (all four answer forms against the real public
// tester) is the real proof; this file locks the pure logic down so it can't
// silently regress.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  candidateNameForConfirm,
  candidateOptionText,
  candidateShortText,
  categoryWordMatches,
  displayGroupName,
  extractDisambiguationAnswerQuantity,
  extractGlobalSizeWord,
  extractPartialSizeClause,
  extractPriceCentsFromMessage,
  facetDisplayValues,
  isDisambiguationListDropSignal,
  isDisambiguationOptionsRequest,
  isNarrowingCandidateSet,
  isPendingDisambiguationDeclined,
  matchOrdinalPosition,
  narrowCandidatesByFacetAnswer,
  pickNarrowingFacet,
  renderDisambiguationReask,
  renderOptionAlternatives,
  resolvePendingDisambiguation,
  stemWord,
  type PendingCandidate,
} from "./pending-disambiguation.ts";

const BLT_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "cold-blt", name: "BLT", category: "Cold Sandwiches", price_cents: 799 },
  { menu_item_id: "panini-blt", name: "BLT", category: "Homemade Paninis", price_cents: 1099 },
];

const CAESAR_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "caesar-salad", name: "Chicken Caesar", category: "Salads", price_cents: 1295 },
  { menu_item_id: "caesar-wrap", name: "Chicken Caesar", category: "Wraps", price_cents: 999 },
];

// Real Vito's rows (2026-09-11, PO live repro): raw `name` is identical for
// both ("Gyro (Beef or Chicken)"), only `display_name` (menu-compiler
// disambiguation rename) tells them apart.
const GYRO_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "gyro-salad", name: "Gyro (Beef or Chicken)", display_name: "Gyro Salad", category: "Salads", price_cents: 1499 },
  { menu_item_id: "gyro-sandwich", name: "Gyro (Beef or Chicken)", display_name: "Gyro Sandwich", category: "Hot Sandwiches", price_cents: 1099 },
];

Deno.test("stemWord: singular/plural round-trips for the categories that actually collide", () => {
  assertEquals(stemWord("Salads"), "salad");
  assertEquals(stemWord("salad"), "salad");
  assertEquals(stemWord("Wraps"), "wrap");
  assertEquals(stemWord("wrap"), "wrap");
  assertEquals(stemWord("Sandwiches"), "sandwich");
  assertEquals(stemWord("Paninis"), "panini");
});

Deno.test("categoryWordMatches: 'caesar salad' names the Salads category (Guard 7 fix)", () => {
  assertEquals(categoryWordMatches("Salads", "caesar salad"), true);
  assertEquals(categoryWordMatches("Wraps", "caesar salad"), false);
});

Deno.test("categoryWordMatches: 'the wrap' names the Wraps category", () => {
  assertEquals(categoryWordMatches("Wraps", "just the wrap please"), true);
});

Deno.test("categoryWordMatches: unrelated message matches neither side", () => {
  assertEquals(categoryWordMatches("Cold Sandwiches", "large pepperoni pizza"), false);
});

Deno.test("resolvePendingDisambiguation form (b): category word — 'the panini one'", () => {
  const resolved = resolvePendingDisambiguation("the panini one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation form (c): ordinal — 'the first one'", () => {
  const resolved = resolvePendingDisambiguation("the first one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "cold-blt");
});

Deno.test("resolvePendingDisambiguation: bare digit positional — '2'", () => {
  const resolved = resolvePendingDisambiguation("2", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation form (d): price — 'the 10.99 one' does NOT read as position 1", () => {
  const resolved = resolvePendingDisambiguation("the 10.99 one", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "panini-blt");
});

Deno.test("resolvePendingDisambiguation: price match tolerates a leading dollar sign", () => {
  const resolved = resolvePendingDisambiguation("$7.99 please", BLT_CANDIDATES);
  assertEquals(resolved?.menu_item_id, "cold-blt");
});

Deno.test("resolvePendingDisambiguation: unresolvable answer returns null, never guesses", () => {
  assertEquals(resolvePendingDisambiguation("um not sure", BLT_CANDIDATES), null);
});

// DEFECT 2 (2026-09-06 live QA): "forget the salad" was silently ADDING the
// salad — category matching ran with no idea the customer had just declined
// it. These lock down that a decline cue next to a candidate word (or a
// generic referent to "the pending item") is caught before any selection
// could happen, never after.
Deno.test("isPendingDisambiguationDeclined: 'forget the salad' declines, never selects", () => {
  assertEquals(isPendingDisambiguationDeclined("forget the salad", CAESAR_CANDIDATES), true);
  assertEquals(resolvePendingDisambiguation("forget the salad", CAESAR_CANDIDATES)?.category, "Salads");
});

Deno.test("isPendingDisambiguationDeclined: 'not the wrap' declines", () => {
  assertEquals(isPendingDisambiguationDeclined("not the wrap", CAESAR_CANDIDATES), true);
});

Deno.test("isPendingDisambiguationDeclined: 'never mind the caesar' declines", () => {
  assertEquals(isPendingDisambiguationDeclined("never mind the caesar", CAESAR_CANDIDATES), true);
});

Deno.test("isPendingDisambiguationDeclined: 'cancel that' declines", () => {
  assertEquals(isPendingDisambiguationDeclined("cancel that", CAESAR_CANDIDATES), true);
  assertEquals(resolvePendingDisambiguation("cancel that", CAESAR_CANDIDATES), null);
});

Deno.test("isPendingDisambiguationDeclined: 'skip it' declines", () => {
  assertEquals(isPendingDisambiguationDeclined("skip it", CAESAR_CANDIDATES), true);
  assertEquals(resolvePendingDisambiguation("skip it", CAESAR_CANDIDATES), null);
});

Deno.test("isPendingDisambiguationDeclined: \"don't want the salad\" declines", () => {
  assertEquals(isPendingDisambiguationDeclined("don't want the salad", CAESAR_CANDIDATES), true);
});

Deno.test("isPendingDisambiguationDeclined: 'drop the wrap one' declines", () => {
  assertEquals(isPendingDisambiguationDeclined("drop the wrap one", CAESAR_CANDIDATES), true);
});

Deno.test("isPendingDisambiguationDeclined: an ordinary answer is never mistaken for a decline", () => {
  assertEquals(isPendingDisambiguationDeclined("the salad one", CAESAR_CANDIDATES), false);
  assertEquals(isPendingDisambiguationDeclined("2", CAESAR_CANDIDATES), false);
  assertEquals(isPendingDisambiguationDeclined("um not sure", CAESAR_CANDIDATES), false);
});

Deno.test("matchOrdinalPosition: excludes the fractional half of a decimal price", () => {
  assertEquals(matchOrdinalPosition("the 12.95 one", 2), null);
});

Deno.test("extractPriceCentsFromMessage: parses dollar and bare decimal forms", () => {
  assertEquals(extractPriceCentsFromMessage("the 12.95 one"), [1295]);
  assertEquals(extractPriceCentsFromMessage("$9.99"), [999]);
});

Deno.test("renderDisambiguationReask: never produces GUARD 7's original sentence shape", () => {
  const reask = renderDisambiguationReask(BLT_CANDIDATES);
  assertEquals(reask.includes(" or "), true);
  assertEquals(reask.startsWith("We've got a couple options"), false);
});

Deno.test("renderDisambiguationReask: impossible by construction to repeat the identical prior reply", () => {
  const first = renderDisambiguationReask(BLT_CANDIDATES, null);
  const second = renderDisambiguationReask(BLT_CANDIDATES, first);
  assertNotEquals(first, second);
  // A third consecutive failure must not cycle back to a string equal to the
  // immediately preceding one either.
  const third = renderDisambiguationReask(BLT_CANDIDATES, second);
  assertNotEquals(second, third);
});

// BUG 2 (2026-09-07, Jason, Zio's live verification, exact repro): "what
// choose an option you'd like on the Buffalo Chicken Pizza" — a real Slice
// import artifact leaking into a customer-facing reply.
Deno.test("displayGroupName: 'Choose an option' (Zio's real live group name) is replaced", () => {
  assertEquals(displayGroupName("Choose an option"), "option");
});

Deno.test("displayGroupName: case/whitespace-insensitive on the generic label", () => {
  assertEquals(displayGroupName("  CHOOSE AN OPTION  "), "option");
  assertEquals(displayGroupName("Select One"), "option");
  assertEquals(displayGroupName("please select"), "option");
});

Deno.test("displayGroupName: a real, informative group name is returned unchanged", () => {
  assertEquals(displayGroupName("Sauce"), "Sauce");
  assertEquals(displayGroupName("Wing Flavor"), "Wing Flavor");
  assertEquals(displayGroupName("Bread Type"), "Bread Type");
  assertEquals(displayGroupName("Size"), "Size");
});

// BUG 1 (2026-09-11, PO — Vito's Gyro live loop): GUARD 7's re-ask (and every
// other disambiguation render site) used to build its text from the raw,
// duplicate `name` ("Gyro (Beef or Chicken)") even though `display_name`
// ("Gyro Salad"/"Gyro Sandwich") was sitting right on the same candidate.
Deno.test("candidateOptionText: a real display_name is used bare, no redundant category word", () => {
  assertEquals(candidateOptionText(GYRO_CANDIDATES[0]), "Gyro Salad — $14.99");
  assertEquals(candidateOptionText(GYRO_CANDIDATES[1]), "Gyro Sandwich — $10.99");
});

Deno.test("candidateOptionText: no display_name falls back to name + category word (unchanged old behavior)", () => {
  assertEquals(candidateOptionText(CAESAR_CANDIDATES[0]), "the Chicken Caesar salad — $12.95");
  assertEquals(candidateOptionText(CAESAR_CANDIDATES[1]), "the Chicken Caesar wrap — $9.99");
});

Deno.test("candidateShortText: real display_name, no fallback category word", () => {
  assertEquals(candidateShortText(GYRO_CANDIDATES[0]), "Gyro Salad");
  assertEquals(candidateShortText(GYRO_CANDIDATES[1]), "Gyro Sandwich");
});

Deno.test("candidateShortText: no display_name falls back to 'the {name} {word}'", () => {
  assertEquals(candidateShortText(CAESAR_CANDIDATES[0]), "the Chicken Caesar salad");
});

Deno.test("candidateNameForConfirm: real display_name used bare for 'Got it — X added.'", () => {
  assertEquals(candidateNameForConfirm(GYRO_CANDIDATES[0]), "Gyro Salad");
});

Deno.test("candidateNameForConfirm: no display_name falls back to 'name word' (unchanged old behavior)", () => {
  assertEquals(candidateNameForConfirm(CAESAR_CANDIDATES[0]), "Chicken Caesar salad");
});

Deno.test("renderDisambiguationReask: Gyro-style candidates never leak the raw duplicate name into the numbered list", () => {
  const reask = renderDisambiguationReask(GYRO_CANDIDATES);
  assert(reask.includes("1) Gyro Salad — $14.99"), reask);
  assert(reask.includes("2) Gyro Sandwich — $10.99"), reask);
  assertEquals(reask.includes("Gyro (Beef or Chicken)"), false, reask);
});

// Backstop (2026-09-11): the numbered list's positions resolve through the
// EXISTING matchOrdinalPosition/resolvePendingDisambiguation mechanism — a
// bare "1"/"2" reply needs no new resolution logic, only the numbered render.
Deno.test("Backstop: a bare '1' or '2' reply to the Gyro numbered list resolves via the existing ordinal matcher", () => {
  assertEquals(resolvePendingDisambiguation("1", GYRO_CANDIDATES)?.menu_item_id, "gyro-salad");
  assertEquals(resolvePendingDisambiguation("2", GYRO_CANDIDATES)?.menu_item_id, "gyro-sandwich");
});

// The exact scripted repro (menu-checkout-13): "Bleu Cheese, Beef" names
// neither a category word, an ordinal, nor a price — it must NOT resolve
// deterministically (that's the whole reason the backstop is needed at all).
Deno.test("Backstop: a genuine real-world answer naming neither category/ordinal/price stays unresolved (why the backstop is needed)", () => {
  assertEquals(resolvePendingDisambiguation("Bleu Cheese, Beef", GYRO_CANDIDATES), null);
});

// ── renderOptionAlternatives (reply inversion, stage 2, 2026-09-13) ──────────
// One writer for the "Gyro Salad — $14.99 or Gyro Sandwich — $10.99" clause
// inside GUARD 7's "couple options" prompt. Closing the last inline
// .map(candidateOptionText).join(" or ") at a reply= site (site #40 in the
// classification pass). See reply-inversion-stage2-enforcement.test.ts.
Deno.test("renderOptionAlternatives: Gyro candidates produce the same string as the old inline join", () => {
  // This must be byte-for-byte identical to the old inline expression:
  // candidates.map(c => candidateOptionText(c)).join(" or ")
  const expected = `${candidateOptionText(GYRO_CANDIDATES[0])} or ${candidateOptionText(GYRO_CANDIDATES[1])}`;
  assertEquals(renderOptionAlternatives(GYRO_CANDIDATES), expected);
});

Deno.test("renderOptionAlternatives: BLT candidates (no display_name) use category-word fallback", () => {
  const result = renderOptionAlternatives(BLT_CANDIDATES);
  assert(result.includes("Cold Sandwiches") || result.includes("Paninis") || result.includes("cold") || result.includes("panini"), `expected category word in "${result}"`);
  assert(result.includes(" or "), `expected ' or ' separator in "${result}"`);
});

Deno.test("renderOptionAlternatives: single candidate produces no ' or ' separator", () => {
  const single = [GYRO_CANDIDATES[0]];
  const result = renderOptionAlternatives(single);
  assertEquals(result.includes(" or "), false);
  assertEquals(result, candidateOptionText(GYRO_CANDIDATES[0]));
});

// ── LIVE MONEY BUG (2026-09-15, Vito's + Zio's): matchOrdinalPosition was ──
// unanchored — a digit or ordinal/number word ANYWHERE in the message
// matched, not just a genuine positional pick. Live repro: a 14-candidate
// salad disambiguation open, customer says "10 pieces" (answering an
// already-resolved quantity slot, unrelated to the disambiguation) — the
// bare "10" matched and silently added candidate #10 to the cart. Modeled on
// the real Zio's salad list shape from that repro.
const SALAD_14_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "sal-1",  name: "Garden Salad",              category: "Salads", price_cents: 599  },
  { menu_item_id: "sal-2",  name: "Greek Salad",                category: "Salads", price_cents: 799  },
  { menu_item_id: "sal-3",  name: "Chef Salad",                 category: "Salads", price_cents: 899  },
  { menu_item_id: "sal-4",  name: "Antipasto Salad",            category: "Salads", price_cents: 999  },
  { menu_item_id: "sal-5",  name: "Tuna Salad Plate",           category: "Salads", price_cents: 899  },
  { menu_item_id: "sal-6",  name: "Grilled Chicken Salad",      category: "Salads", price_cents: 999  },
  { menu_item_id: "sal-7",  name: "Buffalo Chicken Salad",      category: "Salads", price_cents: 999  },
  { menu_item_id: "sal-8",  name: "Caesar Salad",               category: "Salads", price_cents: 799  },
  { menu_item_id: "sal-9",  name: "Chicken Caesar Salad",       category: "Salads", price_cents: 899  },
  { menu_item_id: "sal-10", name: "Serves 2 Caesar Salad",      category: "Salads", price_cents: 899  },
  { menu_item_id: "sal-11", name: "House Salad",                category: "Salads", price_cents: 599  },
  { menu_item_id: "sal-12", name: "Spinach Salad",              category: "Salads", price_cents: 799  },
  { menu_item_id: "sal-13", name: "Cobb Salad",                 category: "Salads", price_cents: 999  },
  { menu_item_id: "sal-14", name: "Steak Salad",                category: "Salads", price_cents: 1199 },
];

Deno.test("LIVE MONEY BUG: 14-candidate disambiguation open, '10 pieces' must NOT select candidate #10", () => {
  assertEquals(matchOrdinalPosition("10 pieces", SALAD_14_CANDIDATES.length), null);
  assertEquals(resolvePendingDisambiguation("10 pieces", SALAD_14_CANDIDATES), null);
});

Deno.test("LIVE MONEY BUG: 14-candidate disambiguation open, 'two cheeseburgers and a large fries' must NOT select candidate #2", () => {
  assertEquals(matchOrdinalPosition("two cheeseburgers and a large fries", SALAD_14_CANDIDATES.length), null);
  assertEquals(resolvePendingDisambiguation("two cheeseburgers and a large fries", SALAD_14_CANDIDATES), null);
});

const POSITIONAL_MUST_RESOLVE: Array<[string, number]> = [
  ["3", 2],
  ["#3", 2],
  ["number 3", 2],
  ["3rd", 2],
  ["the third one", 2],
  ["second please", 1],
  ["two", 1],
];

for (const [text, expectedIdx] of POSITIONAL_MUST_RESOLVE) {
  Deno.test(`matchOrdinalPosition: "${text}" resolves to position ${expectedIdx}`, () => {
    assertEquals(matchOrdinalPosition(text, SALAD_14_CANDIDATES.length), expectedIdx);
  });
}

const POSITIONAL_MUST_NOT_RESOLVE: string[] = [
  "10 pieces",
  "two cheeseburgers and a large fries",
  "i'll be there at 6",
  "make it 2 of the first thing",
];

for (const text of POSITIONAL_MUST_NOT_RESOLVE) {
  Deno.test(`matchOrdinalPosition: "${text}" must NOT resolve to any position`, () => {
    assertEquals(matchOrdinalPosition(text, 14), null);
  });
}

// ── PO dispatch (2026-09-18): natural-language answers to the numbered ─────
// disambiguation question. Real candidate sets from the 50-conversation live
// measurement at build aac8be0c, conversations 40 and 16 (reconstructed from
// the run's manifest.json dialogue_state.candidates + the bot's own rendered
// list, which is candidateOptionText's "the {name} {category word} — $price"
// fallback shape — none of these rows have a display_name).
const CHEESESTEAK_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "49bf7de5-95b7-48a5-827d-258f757554bc", name: "Chicken Cheesesteak",           category: "Homemade Paninis", price_cents: 1099 },
  { menu_item_id: "68945bf7-7c21-4cd7-aa47-bfbbaf1757b0", name: "Chicken Cheesesteak",           category: "Stromboli Rolls",  price_cents: 999  },
  { menu_item_id: "cf368253-8663-42fc-8ede-4c576a35664a", name: "Chicken Cheesesteak",           category: "Hot Sandwiches",   price_cents: 1199 },
  { menu_item_id: "e423aae6-a03b-4899-9f98-9e917fc4f6bb", name: "California Chicken Cheesesteak", category: "Hot Sandwiches",   price_cents: 1299 },
];

const GRILLED_CHICKEN_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "7b13d6a1-ae24-47b9-838d-a369b02934da", name: "Grilled Chicken",           category: "Salads",          price_cents: 1295 },
  { menu_item_id: "9208c088-bc5a-4611-bcc8-892f3b9c17b2", name: "Southwest Grilled Chicken",  category: "Wraps",           price_cents: 1099 },
  { menu_item_id: "941ca847-5324-4772-b83c-86a87bde165f", name: "Grilled Chicken",            category: "Homemade Paninis", price_cents: 1099 },
  { menu_item_id: "db249934-e93f-410e-83f4-388e072210cf", name: "Buffalo Grilled Chicken",     category: "Salads",          price_cents: 1295 },
];

Deno.test("resolvePendingDisambiguation: bare '3' still resolves (unchanged)", () => {
  assertEquals(resolvePendingDisambiguation("3", CHEESESTEAK_CANDIDATES)?.menu_item_id, "cf368253-8663-42fc-8ede-4c576a35664a");
});

Deno.test("resolvePendingDisambiguation: '3 please, the Chicken Cheesesteak hot sandwich!' resolves to the hot sandwich, not the California one", () => {
  assertEquals(
    resolvePendingDisambiguation("3 please, the Chicken Cheesesteak hot sandwich!", CHEESESTEAK_CANDIDATES)?.menu_item_id,
    "cf368253-8663-42fc-8ede-4c576a35664a",
  );
});

Deno.test("resolvePendingDisambiguation: 'Number 3, please, the Chicken Cheesesteak hot sandwich!' resolves to the hot sandwich", () => {
  assertEquals(
    resolvePendingDisambiguation("Number 3, please, the Chicken Cheesesteak hot sandwich!", CHEESESTEAK_CANDIDATES)?.menu_item_id,
    "cf368253-8663-42fc-8ede-4c576a35664a",
  );
});

Deno.test("resolvePendingDisambiguation: 'I'd like the Chicken Cheesesteak hot sandwich, please.' resolves via the exact label, not the California one", () => {
  assertEquals(
    resolvePendingDisambiguation("I'd like the Chicken Cheesesteak hot sandwich, please.", CHEESESTEAK_CANDIDATES)?.menu_item_id,
    "cf368253-8663-42fc-8ede-4c576a35664a",
  );
});

Deno.test("resolvePendingDisambiguation: bare '1' still resolves (unchanged)", () => {
  assertEquals(resolvePendingDisambiguation("1", GRILLED_CHICKEN_CANDIDATES)?.menu_item_id, "7b13d6a1-ae24-47b9-838d-a369b02934da");
});

Deno.test("resolvePendingDisambiguation: 'I would like option 1) the Grilled Chicken salad - $12.95.' resolves to the plain Grilled Chicken salad, not Buffalo", () => {
  assertEquals(
    resolvePendingDisambiguation("I would like option 1) the Grilled Chicken salad - $12.95.", GRILLED_CHICKEN_CANDIDATES)?.menu_item_id,
    "7b13d6a1-ae24-47b9-838d-a369b02934da",
  );
});

Deno.test("resolvePendingDisambiguation: 'Oh, I meant the grilled chicken salad! So that's 2 of the Grilled Chicken salads...' resolves to the plain Grilled Chicken salad", () => {
  assertEquals(
    resolvePendingDisambiguation(
      "Oh, I meant the grilled chicken salad! So that's 2 of the Grilled Chicken salads with blackened salmon on one and black diamond steak on the other, and ranch dressing on both. Thanks!",
      GRILLED_CHICKEN_CANDIDATES,
    )?.menu_item_id,
    "7b13d6a1-ae24-47b9-838d-a369b02934da",
  );
});

// Negative case 1 (PO dispatch, 2026-09-18): a digit immediately followed by
// "of" is a QUANTITY ("2 of those" = 2 units), not a position pick — must
// not be misread as "position 2" even though it's the leading token.
const THREE_ITEM_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "burger",  name: "Cheeseburger", category: "Burgers",  price_cents: 899 },
  { menu_item_id: "chicken", name: "Chicken Sandwich", category: "Sandwiches", price_cents: 799 },
  { menu_item_id: "fries",   name: "Loaded Fries", category: "Sides", price_cents: 599 },
];

Deno.test("resolvePendingDisambiguation: '2 of those, please' is a quantity, not a position — stays unresolved", () => {
  assertEquals(resolvePendingDisambiguation("2 of those, please", THREE_ITEM_CANDIDATES), null);
});

// LIVE MONEY BUG (2026-09-19, PO dispatch, priority item 3): the negative
// case above only exercised a BARE leading number with no qualifier before
// it. "I want 2 of the medium ones" against a rendered "1) Medium 2) Large
// 3) Small" has "I want" sitting right before the "2" -- a real qualifier
// (LEADING_ORDINAL_TWO_WORD_QUALIFIERS) -- so the qualifier tier used to
// return position 2 (Large) before ever checking what follows the number,
// silently discarding "medium" (the word that actually answers the
// question) and charging for the wrong size: $45.98 for what should have
// been $39.98 (2x $19.99 Large vs 2x $19.99... i.e. the wrong item at all).
const SIZE_ONLY_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "id-medium", name: "Cheese - Medium (14\")", category: "Pizza", price_cents: 1499 },
  { menu_item_id: "id-large",  name: "Cheese - Large (16\")",  category: "Pizza", price_cents: 1650 },
  { menu_item_id: "id-small",  name: "Cheese - Small (10\")",  category: "Pizza", price_cents: 1295 },
];

Deno.test("resolvePendingDisambiguation: 'I want 2 of the medium ones' resolves to MEDIUM, not position #2 (Large) — the money bug", () => {
  assertEquals(resolvePendingDisambiguation("I want 2 of the medium ones", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-medium");
});

Deno.test("resolvePendingDisambiguation: '2 of the medium ones' (no leading qualifier either) also resolves to MEDIUM", () => {
  assertEquals(resolvePendingDisambiguation("2 of the medium ones", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-medium");
});

// Every OTHER wrapping around a genuine position pick must keep working —
// this fix only rejects a number immediately followed by "of".
Deno.test("resolvePendingDisambiguation: genuine position picks are unaffected by the quantity-partitive fix", () => {
  assertEquals(resolvePendingDisambiguation("I'll take 2", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-large");
  assertEquals(resolvePendingDisambiguation("the second one", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-large");
  assertEquals(resolvePendingDisambiguation("#2", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-large");
  assertEquals(resolvePendingDisambiguation("2)", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-large");
  assertEquals(resolvePendingDisambiguation("option 2", SIZE_ONLY_CANDIDATES)?.menu_item_id, "id-large");
});

// Negative case 2 (PO dispatch, 2026-09-18): "salad" alone narrows the
// category to two different salads with no further distinguishing word —
// category+name narrowing must return null (re-list), never guess between
// them just because the customer said "the salad".
Deno.test("resolvePendingDisambiguation: 'the salad' is ambiguous between two different salads — stays unresolved", () => {
  const twoSalads = [GRILLED_CHICKEN_CANDIDATES[0], GRILLED_CHICKEN_CANDIDATES[3]];
  assertEquals(resolvePendingDisambiguation("the salad", twoSalads), null);
});

// ── PO dispatch (2026-09-18, amendment): a restated whole order later in ───
// the same message must not pull the leading-ordinal/category-narrowing
// tiers toward an unrelated candidate. LIVE MONEY BUG: conversations
// 2d3183e3-d7c8-4d62-9173-5aec4045a8b4, 41b2bc4f-4a9d-4576-993a-58cf6dc05962,
// e26db9de-e471-4c1a-8159-feeeeeb6fef5 — a customer answering "the Gyro hot
// sandwich for $10.99" and then restating their full order ("...a Gyro
// sandwich, and a medium Hawaiian pizza") got charged $19.99 for a pizza
// they never asked for, because the restatement's "medium"/"pizza" words
// out-scored the hot sandwich candidate's own name stems. Reconstructed from
// the real 8-candidate Vito's gyro list shape (one hot sandwich, four pizza
// sizes, salad/wrap/plate).
const GYRO_8_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "gyro-hot-sandwich", name: "Gyro (Beef or Chicken)", category: "Hot Sandwiches", price_cents: 1099 },
  { menu_item_id: "gyro-pizza-sm",     name: "Gyro - Small (10\")",    category: "Pizza",          price_cents: 1499 },
  { menu_item_id: "gyro-pizza-md",     name: "Gyro - Medium (14\")",   category: "Pizza",          price_cents: 1999 },
  { menu_item_id: "gyro-pizza-lg",     name: "Gyro - Large (16\")",    category: "Pizza",          price_cents: 2299 },
  { menu_item_id: "gyro-pizza-xl",     name: "Gyro - X-Large (18\")",  category: "Pizza",          price_cents: 2599 },
  { menu_item_id: "gyro-salad",        name: "Gyro Salad",             category: "Salads",         price_cents: 1199 },
  { menu_item_id: "gyro-wrap",         name: "Gyro Wrap",              category: "Wraps",          price_cents: 999  },
  { menu_item_id: "gyro-plate",        name: "Gyro Plate",             category: "Platters",       price_cents: 1399 },
];

Deno.test("resolvePendingDisambiguation: 'the Gyro hot sandwich for $10.99' resolves to the hot sandwich", () => {
  assertEquals(
    resolvePendingDisambiguation("I'll go with the Gyro hot sandwich for $10.99.", GYRO_8_CANDIDATES)?.menu_item_id,
    "gyro-hot-sandwich",
  );
});

Deno.test("LIVE MONEY BUG: the same answer, with a full-order restatement appended, still resolves to the hot sandwich — not the $19.99 medium pizza", () => {
  assertEquals(
    resolvePendingDisambiguation(
      "I'll go with the Gyro hot sandwich for $10.99. So that's an Alfredo with spaghetti, a Gyro sandwich, and a medium Hawaiian pizza.",
      GYRO_8_CANDIDATES,
    )?.menu_item_id,
    "gyro-hot-sandwich",
  );
});

// ── TOP PRIORITY LIVE MONEY BUG (2026-09-19, live conv 4c52298c, turn #5): ──
// a which-one list was open for "pepperoni pizza" with candidates in real
// transcript list order where option 2 happened to be Small. The customer
// answered "I'll take 2 Large Pepperoni pizzas, please." — matchLeadingOrdinal's
// "I'll take" qualifier used to return idx unconditionally, so the leading
// "2" was read as "pick candidate #2" (Small, $17.45) instead of "quantity 2"
// — the customer's own stated "Large" was silently discarded, and the cart
// ended up 2x Small Pepperoni Pizza ($17.45 each = $34.90) instead of 2x
// Large ($21.00 each = $42.00). No clarifying question was ever asked, and
// nothing flagged the wrong item/wrong money to anyone.
//
// The fix, in resolvePendingDisambiguation's own tiers: a leading number is a
// QUANTITY, never a position index, whenever real content — a size word, an
// item/family word, or a partitive "of" — follows it. An index is
// specifically a BARE number ("2"), "option N"/"number N"/"#N"/"N)", or an
// ordinal word ("the second one"). extractDisambiguationAnswerQuantity is the
// companion read: it returns the stated quantity in exactly the cases
// matchLeadingOrdinal now refuses to treat as an index, and null (no
// override) in every case that still IS a genuine index pick — so callers
// combine `extractDisambiguationAnswerQuantity(msg) ?? <the open question's
// own quantity>` to get the right count without ever double-reading the
// same number as both an index and a quantity.
//
// Candidate order intentionally mirrors the real transcript: option 2
// (0-based index 1) is Small — an index-based misread of "2" would visibly
// resolve to Small, exactly the live incident, if the fix were wrong.
const PEPPERONI_PIZZA_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "pep-medium", name: "Pepperoni Pizza - Medium (14\")", category: "Pizza", price_cents: 1900 },
  { menu_item_id: "pep-small",  name: "Pepperoni Pizza - Small (10\")",  category: "Pizza", price_cents: 1745 },
  { menu_item_id: "pep-large",  name: "Pepperoni Pizza - Large (16\")",  category: "Pizza", price_cents: 2100 },
];

Deno.test("LIVE MONEY BUG (real repro, conv 4c52298c): \"I'll take 2 Large Pepperoni pizzas, please.\" resolves to LARGE, quantity 2 — never Small via index misread", () => {
  assertEquals(resolvePendingDisambiguation("I'll take 2 Large Pepperoni pizzas, please.", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-large");
  assertEquals(extractDisambiguationAnswerQuantity("I'll take 2 Large Pepperoni pizzas, please."), 2);
});

Deno.test("resolvePendingDisambiguation: \"2 large please\" resolves to LARGE, quantity 2", () => {
  assertEquals(resolvePendingDisambiguation("2 large please", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-large");
  assertEquals(extractDisambiguationAnswerQuantity("2 large please"), 2);
});

Deno.test("resolvePendingDisambiguation: \"option 2\" is a bare position pick (Small, this fixture's option 2) — quantity override stays null, unchanged from today's index-based behavior", () => {
  assertEquals(resolvePendingDisambiguation("option 2", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-small");
  assertEquals(extractDisambiguationAnswerQuantity("option 2"), null);
});

Deno.test("resolvePendingDisambiguation: bare \"2\" is the same position pick as \"option 2\" (Small) — quantity override stays null, unchanged from today's index-based behavior", () => {
  assertEquals(resolvePendingDisambiguation("2", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-small");
  assertEquals(extractDisambiguationAnswerQuantity("2"), null);
});

Deno.test("resolvePendingDisambiguation: \"the second one\" is the ordinal path to the same position (Small) — quantity override stays null", () => {
  assertEquals(resolvePendingDisambiguation("the second one", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-small");
  assertEquals(extractDisambiguationAnswerQuantity("the second one"), null);
});

Deno.test("resolvePendingDisambiguation: \"2 of the large\" resolves to LARGE, quantity 2 (partitive-of shape)", () => {
  assertEquals(resolvePendingDisambiguation("2 of the large", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, "pep-large");
  assertEquals(extractDisambiguationAnswerQuantity("2 of the large"), 2);
});

// Regression baseline (acceptance point 3): "option 2" and bare "2" resolve
// to the SAME candidate (pep-small, this fixture's position 2) as the
// unmodified logic on this exact repo commit produced before this fix —
// captured by running the original resolvePendingDisambiguation against
// these two messages and this exact PEPPERONI_PIZZA_CANDIDATES fixture prior
// to any change in this file. The fix must never move an index pick's
// result, only stop a QUANTITY from being misread as one.
Deno.test("resolvePendingDisambiguation: index-pick baseline unchanged — \"option 2\" and bare \"2\" both still resolve to the pre-fix candidate", () => {
  const preFixBaseline = "pep-small"; // captured from HEAD~ (pre-fix) resolvePendingDisambiguation against this exact fixture
  assertEquals(resolvePendingDisambiguation("option 2", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, preFixBaseline);
  assertEquals(resolvePendingDisambiguation("2", PEPPERONI_PIZZA_CANDIDATES)?.menu_item_id, preFixBaseline);
});

// ── P0 fix (2026-09-19, docs/specs/2026-09-15-narrowing-questions.md, live
// conv b685494d-62e9-4a2d-b5c1-f761cd6d6c5b): pickNarrowingFacet/
// isDisambiguationOptionsRequest unit coverage — turn-engine-runner.test.ts
// exercises the full render() pipeline; these lock the pure facet-extraction
// logic down directly.

const SEVEN_LARGE_PIZZAS: PendingCandidate[] = [
  "Pepperoni", "Cheese", "Sausage", "Buffalo Chicken", "Meat Lovers", "Veggie", "Hawaiian",
].map((kind, i) => ({ menu_item_id: `pizza-${i}`, name: `Large ${kind} Pizza`, category: "Pizza", price_cents: 1800 + i * 100 }));

Deno.test("pickNarrowingFacet: 7 large pizzas of different kinds -> a bare kind question, no examples, no head noun", () => {
  const result = pickNarrowingFacet(SEVEN_LARGE_PIZZAS);
  assertEquals(result?.facet, "kind");
  // PO amendment (2026-09-19): the facet question is fixed copy chosen by
  // the facet alone — no candidate examples, no "of pizza" head noun. The
  // acknowledgement phrase and any facet-specific follow-up text are
  // turn-engine.ts's render()'s job (narrowingKindQuestion), not this
  // function's — see pending-disambiguation.test.ts's own header.
  assertEquals(result?.question, "What kind?");
});

const SAME_KIND_DIFFERENT_SIZES: PendingCandidate[] = [
  { menu_item_id: "p-s", name: "Cheese Pizza - Small 10''", category: "Pizza", price_cents: 1200 },
  { menu_item_id: "p-m", name: "Cheese Pizza - Medium 14''", category: "Pizza", price_cents: 1600 },
  { menu_item_id: "p-l", name: "Cheese Pizza - Large 18''", category: "Pizza", price_cents: 1900 },
];

Deno.test("pickNarrowingFacet: same kind, different sizes -> a bare size question, not kind (kind doesn't distinguish)", () => {
  const result = pickNarrowingFacet(SAME_KIND_DIFFERENT_SIZES);
  assertEquals(result?.facet, "size");
  assertEquals(result?.question, "What size?");
});

Deno.test("pickNarrowingFacet: nothing distinguishes the set -> null (caller falls back to the full list)", () => {
  const identicalKindAndSize: PendingCandidate[] = [
    { menu_item_id: "a", name: "BLT", category: "Cold Sandwiches", price_cents: 799 },
    { menu_item_id: "b", name: "BLT", category: "Homemade Paninis", price_cents: 1099 },
  ];
  assertEquals(pickNarrowingFacet(identicalKindAndSize), null);
});

// ── PO amendment (2026-09-19): narrowCandidatesByFacetAnswer/facetDisplayValues/
// isNarrowingCandidateSet/extractPartialSizeClause/extractGlobalSizeWord — the
// pure helpers behind the exact fixed-copy narrowing flow. turn-engine-
// runner.test.ts exercises the full pipeline against a real conversation;
// these lock the extraction/matching logic down directly.

Deno.test("isNarrowingCandidateSet: 7 candidates is a narrowing set; 2 is not", () => {
  assertEquals(isNarrowingCandidateSet(SEVEN_LARGE_PIZZAS), true);
  assertEquals(isNarrowingCandidateSet(BLT_CANDIDATES), false);
});

Deno.test("narrowCandidatesByFacetAnswer: 'pepperoni' against 7 kinds narrows to the one Pepperoni candidate", () => {
  const result = narrowCandidatesByFacetAnswer(SEVEN_LARGE_PIZZAS, "kind", "pepperoni");
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].menu_item_id, "pizza-0");
});

Deno.test("narrowCandidatesByFacetAnswer: 'pepperoni' against same-kind-different-sizes candidates narrows by kind, leaving every size", () => {
  const mixed: PendingCandidate[] = [
    ...SAME_KIND_DIFFERENT_SIZES,
    { menu_item_id: "p-s2", name: "Pepperoni Pizza - Small 10''", category: "Pizza", price_cents: 1300 },
    { menu_item_id: "p-m2", name: "Pepperoni Pizza - Medium 14''", category: "Pizza", price_cents: 1700 },
    { menu_item_id: "p-l2", name: "Pepperoni Pizza - Large 18''", category: "Pizza", price_cents: 2000 },
  ];
  const result = narrowCandidatesByFacetAnswer(mixed, "kind", "pepperoni");
  assertEquals(result?.length, 3);
  assert(result?.every(c => c.name.startsWith("Pepperoni")), JSON.stringify(result));
});

Deno.test("narrowCandidatesByFacetAnswer: 'large' against same-kind-different-sizes narrows by size to exactly one", () => {
  const result = narrowCandidatesByFacetAnswer(SAME_KIND_DIFFERENT_SIZES, "size", "large please");
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].menu_item_id, "p-l");
});

Deno.test("narrowCandidatesByFacetAnswer: an answer naming nothing real returns null, never guesses", () => {
  assertEquals(narrowCandidatesByFacetAnswer(SEVEN_LARGE_PIZZAS, "kind", "um not sure"), null);
});

// Round 2 addendum item B, 2026-09-19 (live + offline, real Vito's "White"
// vs "Gourmet White Fiesta" pizzas): an exact kind-name match must always
// beat a merely partial/substring one. Before this fix "one white" scored
// an identical stem-overlap tie between the two kinds (both contain the
// word "white") and the clause was silently dropped.
const WHITE_PIZZA_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "white-l", name: "White Pizza - Large 18''", category: "Pizza", price_cents: 1900 },
  { menu_item_id: "gwf-l", name: "Gourmet White Fiesta Pizza - Large 18''", category: "Pizza", price_cents: 2200 },
];

Deno.test("narrowCandidatesByFacetAnswer: 'white' names the exact 'White' kind, not the merely-containing 'Gourmet White Fiesta' kind", () => {
  const result = narrowCandidatesByFacetAnswer(WHITE_PIZZA_CANDIDATES, "kind", "one white");
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].menu_item_id, "white-l");
});

Deno.test("narrowCandidatesByFacetAnswer: 'gourmet white fiesta' still resolves to its own exact (longer) kind", () => {
  const result = narrowCandidatesByFacetAnswer(WHITE_PIZZA_CANDIDATES, "kind", "gourmet white fiesta");
  assertEquals(result?.length, 1);
  assertEquals(result?.[0].menu_item_id, "gwf-l");
});

// Round 2 addendum item A, rule 2 (2026-09-19, live sim persona, real
// repro): "I just want the pizzas" answered a dead numbered list five
// times with no exit. isDisambiguationListDropSignal names the replies
// that abandon a list outright (turn-engine-runner.ts gates this on the
// list already having missed at least once — see its own doc).
Deno.test("isDisambiguationListDropSignal: bare 'no' and 'none'/'none of those'/'none of them' all drop the list", () => {
  for (const msg of ["no", "No.", "none", "none of those", "None of them!"]) {
    assert(isDisambiguationListDropSignal(msg), `"${msg}" must be a drop signal`);
  }
});

Deno.test("isDisambiguationListDropSignal: 'I just want the pizzas' (the live repro) drops the list", () => {
  assert(isDisambiguationListDropSignal("I just want the pizzas"));
  assert(isDisambiguationListDropSignal("I only want a large cheese"));
});

Deno.test("isDisambiguationListDropSignal: an ordinary answer naming a candidate — including a plain 'I want X' with no 'just'/'only' — is never mistaken for a drop signal", () => {
  assert(!isDisambiguationListDropSignal("the bacon one"));
  assert(!isDisambiguationListDropSignal("2"));
  assert(!isDisambiguationListDropSignal("cheese pizza"));
  assert(!isDisambiguationListDropSignal("I want the large"), "'I want X' with no just/only is the single most ordinary way to answer — must not drop");
  assert(!isDisambiguationListDropSignal("nope that's not right, I want the large"), "embedded 'no' inside a real answer must not drop it");
});

// DEFECT 1 (2026-09-19 live QA, PO priority item 4, real transcript conv
// 009de656 #5): the bot's own re-ask fallback ("I couldn't match that. Reply
// with a number, or say "none of those".") tells the customer to use this
// exact escape hatch — but the OLD regex required the ENTIRE trimmed message
// to be nothing but "none of those" (a `$` anchor with no prefix support),
// so "None of those." followed by the customer's own restated order never
// matched at all. BEFORE this fix: the live conversation looped EIGHT
// times, byte-identical fallback every turn, on these exact 8 real customer
// messages (pulled directly from the conversation, never guessed) — the
// customer said the bot's own suggested words, verbatim, capital N and
// trailing period included, and the bot never recognized it once. AFTER
// this fix: every one of these is recognized as the escape hatch, and
// turn-engine-runner.ts's existing dropDisambiguationList handling (already
// correct, untouched by this fix) forwards the whole message — restated
// order included — to PROPOSE as a fresh message with nothing open, exactly
// as it already does for a bare "no"/"none".
const REAL_CONV_009DE656_NONE_OF_THOSE_MESSAGES = [
  "None of those. I wanted 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Can you confirm that for me?",
  "None of those. I just want to confirm my order: 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese.",
  "None of those. I just want to place my order as is: 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese on the side. Can we finalize that?",
  "None of those. I just want to place my order, which is 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Please confirm this order.",
  "None of those. I just want to place my order: 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Can we finalize that?",
  "None of those. Can I just confirm my final order? It's 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Please finalize it!",
  "None of those. I want to finalize my order for 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Can you please confirm this?",
  "None of those. I want to confirm my order: 2x Chicken Alfredo with linguine, 2x Large Pepperoni pizzas, and 1x bleu cheese. Can we finalize that?",
];

Deno.test("isDisambiguationListDropSignal: real conv 009de656 live loop — all 8 real 'None of those. <restated order>' messages now trip the drop signal (BEFORE this fix, none of them did)", () => {
  assertEquals(REAL_CONV_009DE656_NONE_OF_THOSE_MESSAGES.length, 8, "sanity: this is the real 8-message loop, not a guessed count");
  for (const msg of REAL_CONV_009DE656_NONE_OF_THOSE_MESSAGES) {
    assert(isDisambiguationListDropSignal(msg), `real live message must trip the drop signal: "${msg}"`);
  }
});

Deno.test("isDisambiguationListDropSignal: 'none of those' prefix match is case/punctuation insensitive, with or without restated text after it", () => {
  const restated = "2x Large Pepperoni pizzas please";
  for (const phrase of ["none of those", "NONE OF THOSE", "None Of Those", "None of those.", "NONE OF THOSE!", "None Of Those,"]) {
    assert(isDisambiguationListDropSignal(phrase), `bare "${phrase}" must trip the drop signal`);
    assert(isDisambiguationListDropSignal(`${phrase} ${restated}`), `"${phrase} ${restated}" must trip the drop signal — the escape hatch plus a restated order`);
  }
  // "none of them" is the sibling phrasing this same prefix rule covers.
  assert(isDisambiguationListDropSignal("None of them. I'll take the large one instead."));
});

Deno.test("isDisambiguationListDropSignal: a word that merely STARTS WITH 'none' is never mistaken for the escape hatch", () => {
  assert(!isDisambiguationListDropSignal("nonetheless I'll take the large one"), "'nonetheless' must not be read as 'none' + leftover text");
  assert(!isDisambiguationListDropSignal("nonexistent items aside, give me the large one"));
});

// PO dispatch 2026-09-19 night (real live repro, conv 6de8bd13 #4): a
// shrimp wrap/appetizer disambiguation stayed open through "I don't want
// either of those. Just the hoagie, cheeseburgers, and cheesesteak." — the
// SAME shrimp list got shown again at least twice, the conversation never
// reached payment. The pre-existing prefix mechanism above only recognized
// "none of those"/"none of them"/bare "no"/"none" — this widens the SAME
// mechanism's phrase list (no new mechanism) to also recognize "I don't
// want either of those" / "don't want either" / "don't want any of those" /
// "neither" / "no thanks" as escape hatches, exactly like "none of those":
// a leading clause, optional trailing punctuation, then either
// end-of-message or the customer's own restated order.
Deno.test("isDisambiguationListDropSignal: the real live repro — 'I don't want either of those. Just the hoagie, cheeseburgers, and cheesesteak.' drops the list", () => {
  assert(isDisambiguationListDropSignal("I don't want either of those. Just the hoagie, cheeseburgers, and cheesesteak."));
});

Deno.test("isDisambiguationListDropSignal: 'don't want either'/'don't want any of those'/'neither'/'no thanks' all drop the list, bare or with a restated order after", () => {
  const restated = "Just the hoagie and cheeseburgers, please.";
  const phrases = [
    "don't want either",
    "don't want any of those",
    "I don't want either of those",
    "I don't want any of those",
    "neither",
    "Neither of those",
    "no thanks",
    "No thanks!",
  ];
  for (const phrase of phrases) {
    assert(isDisambiguationListDropSignal(phrase), `bare "${phrase}" must trip the drop signal`);
    assert(isDisambiguationListDropSignal(`${phrase}. ${restated}`), `"${phrase}. ${restated}" must trip the drop signal — the escape hatch plus a restated order`);
  }
});

Deno.test("isDisambiguationListDropSignal: naming ONE candidate by declining it is never mistaken for abandoning the whole list", () => {
  assert(!isDisambiguationListDropSignal("I don't want the shrimp wrap, give me the appetizer"),
    "'don't want X' naming a specific candidate must still let the list try to resolve it — only 'either'/'any' abandon the whole thing");
  assert(!isDisambiguationListDropSignal("I don't want the wrap"));
});

Deno.test("facetDisplayValues: kind values keep original casing, deduped, no prices", () => {
  const values = facetDisplayValues(SEVEN_LARGE_PIZZAS, "kind");
  assertEquals(values, ["Pepperoni", "Cheese", "Sausage", "Buffalo Chicken", "Meat Lovers", "Veggie", "Hawaiian"]);
});

Deno.test("facetDisplayValues: size values across a same-kind set", () => {
  const values = facetDisplayValues(SAME_KIND_DIFFERENT_SIZES, "size");
  assertEquals(values, ["Small", "Medium", "Large"]);
});

Deno.test("extractGlobalSizeWord: '4 large pizzas' names a global size", () => {
  assertEquals(extractGlobalSizeWord("large pizzas"), "large");
});

Deno.test("extractGlobalSizeWord: a bare 'pizza' names no size", () => {
  assertEquals(extractGlobalSizeWord("pizza"), null);
});

Deno.test("extractPartialSizeClause: '2 pizzas, one large' is a partial size for 1 of the 2 units", () => {
  const result = extractPartialSizeClause("2 pizzas, one large", 2);
  assertEquals(result?.sizeWord, "large");
  assertEquals(result?.sizeQuantity, 1);
});

Deno.test("extractPartialSizeClause: '4 large pizzas' (no comma clause) is NOT a partial size", () => {
  assertEquals(extractPartialSizeClause("large pizzas", 4), null);
});

Deno.test("extractPartialSizeClause: a sub-quantity equal to the total names nothing partial", () => {
  assertEquals(extractPartialSizeClause("2 pizzas, two large", 2), null);
});

Deno.test("isDisambiguationOptionsRequest: 'what are the options' is an explicit options request", () => {
  assert(isDisambiguationOptionsRequest("what are the options"));
});

Deno.test("isDisambiguationOptionsRequest: 'what do you have' and 'what kinds do you have' are also explicit requests", () => {
  assert(isDisambiguationOptionsRequest("what do you have"));
  assert(isDisambiguationOptionsRequest("what kinds do you have"));
});

Deno.test("isDisambiguationOptionsRequest: an ordinary answer naming a candidate is never mistaken for an options request", () => {
  assert(!isDisambiguationOptionsRequest("pepperoni"));
  assert(!isDisambiguationOptionsRequest("the large one"));
});
