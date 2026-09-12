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
