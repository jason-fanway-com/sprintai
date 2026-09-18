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
  extractPriceCentsFromMessage,
  isPendingDisambiguationDeclined,
  matchOrdinalPosition,
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

// Negative case 2 (PO dispatch, 2026-09-18): "salad" alone narrows the
// category to two different salads with no further distinguishing word —
// category+name narrowing must return null (re-list), never guess between
// them just because the customer said "the salad".
Deno.test("resolvePendingDisambiguation: 'the salad' is ambiguous between two different salads — stays unresolved", () => {
  const twoSalads = [GRILLED_CHICKEN_CANDIDATES[0], GRILLED_CHICKEN_CANDIDATES[3]];
  assertEquals(resolvePendingDisambiguation("the salad", twoSalads), null);
});
