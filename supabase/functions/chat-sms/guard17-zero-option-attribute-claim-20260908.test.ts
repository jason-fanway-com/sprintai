// GUARD 17 (2026-09-08, real NJB transcript, relayed via PO session).
// Reproduced exactly: "plain bagel with cream cheese" added correctly
// ($3.50). "everything bagel" (follow-up) → model replied "Got it -
// switched to an everything bagel with cream cheese" but the cart line
// never changed (same menu_item_id, "Bagel with Plain Cream Cheese", no
// modifiers, no options field at all) — NJB has 0 option_groups and the
// "Bagel With" category has no bagel-TYPE variant as a distinct item or
// field anywhere, so there was never anywhere for a bagel type to live.
//
// GUARD 16 (see guard16-*.test.ts) only ever examines items with at least
// one modifier CHOICE in ask_plan (`allModifierDisplays16.length === 0` ->
// skip). A zero-option item — ask_plan.steps: [] — never reaches that
// check at all. This guard fills that specific gap: any zero-option cart
// line where the reply claims a change-of-attribute ("switched," "changed,"
// "swapped," "instead of," "now a/an/with," "make it a/an," "updated to")
// is a false claim, because a zero-option item has NOTHING it could
// legitimately have been changed to.
//
// Revised THREE times against real deployed transcripts, not just this
// file's own hand-written tests — see index.ts's GUARD 17 header comment
// for the full history:
//   v1 stripped the item's exact display_name phrase, required the head
//   noun to survive -- defeated when the false claim embedded the honest
//   phrase as a literal substring (the strip removed the head noun too).
//   v2 checked the word before a single head-noun word directly -- defeated
//   by a real two-item cart ("Plain Bagel" + "Bagel with Plain Cream
//   Cheese") where the two items' shared word "bagel" let an honest recap
//   of one get misread as a claim about the other.
//   v3 anchored on the item's ENTIRE display_name phrase -- fixed the
//   collision, but then a live run showed the model dropping a word
//   ("plain") from its own honest phrasing, which broke the exact-phrase
//   match and produced a false NEGATIVE on the guard's own target case.
//   v4 (current) keeps v2's tolerant single-head-noun check but fixes v2's
//   actual bug directly: a word counts as "honest" if it belongs to ANY
//   cart item's own name, not just the item currently being checked.
//
// This file mirrors GUARD 17's v4 logic verbatim for standalone testing
// (Deno.serve() at module scope makes index.ts non-importable — same
// constraint as every other *.test.ts in this directory).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface CartLineLike { menu_item_id: string; name: string }
interface MenuItemLike { id: string; ask_plan: { display_name: string; steps: unknown[] } | null }

const ZERO_OPTION_CHANGE_CLAIM_RE =
  /\b(?:switch(?:ed|ing)?|chang(?:e|ed|ing)|swap(?:ped|ping)?|instead\s+of|now\s+(?:a|an|with)|make\s+(?:it|that)\s+an?|updat(?:e|ed|ing)\s+to)\b/i;
const NON_DESCRIPTOR_WORD = new Set([
  "a", "an", "the", "one", "two", "three", "four", "five", "some",
  "another", "that", "this", "my", "your", "our", "their", "his", "her",
  "added", "adding", "add", "got", "confirmed", "noted", "noting",
  "plus", "also", "and", "ordered",
]);
const GENERIC_HEAD_NOUN = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "half", "dozen", "some", "few", "several", "single", "double", "triple",
]);

const NEGATION_RE =
  /\b(?:can(?:no|['’])?t|cannot|won['’]?t|do(?:n['’]?t| not)|isn['’]?t|am\s+not|i['’]?m\s+not|never|unable|not\s+able|no\s+way\s+to)\b/i;

// v6 fix (2026-09-08, real deployed transcript): the new pre-composition
// hint (zero-option-attribute-hint.ts, its own tests) successfully steers
// the model toward an honest denial ("I can't officially change the bagel
// type on that one, but I've noted everything bagel for the kitchen") --
// but that sentence still has a change-verb AND a foreign descriptor before
// the head noun, the exact shape GUARD 17 was built to catch. Without this
// check, GUARD 17 appended its OWN correction onto a reply that was ALREADY
// honest, recreating the self-contradiction on a message that never needed
// fixing. A negation word before the change-verb IN THE SAME SENTENCE means
// the model is denying the change, not claiming it.
function hasUnnegatedChangeClaim(text: string): boolean {
  const changeReGlobal = new RegExp(ZERO_OPTION_CHANGE_CLAIM_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = changeReGlobal.exec(text))) {
    const sentenceStart = Math.max(text.lastIndexOf(".", m.index), text.lastIndexOf("!", m.index), text.lastIndexOf("?", m.index)) + 1;
    const before = text.slice(sentenceStart, m.index);
    if (!NEGATION_RE.test(before)) return true;
  }
  return false;
}

// Mirror of GUARD 17's v6 logic. Takes the FULL cart (menu items keyed by
// menu_item_id) so the "safe word" set can span every cart item's own name,
// not just the one being checked — the actual fix for v2's real bug.
function guard17Flags(cart: { line: CartLineLike; menuItem: MenuItemLike }[], reply: string): string[] {
  const replyLower = reply.toLowerCase();
  if (!hasUnnegatedChangeClaim(replyLower)) return [];

  const allCartItemWords = new Set<string>();
  for (const { menuItem } of cart) {
    const dn = menuItem.ask_plan?.display_name;
    if (!dn) continue;
    for (const w of dn.toLowerCase().split(/\s+/)) {
      const cleaned = w.replace(/[^a-z0-9]/g, "");
      if (cleaned) allCartItemWords.add(cleaned);
    }
  }
  const safeWord = new Set([...NON_DESCRIPTOR_WORD, ...allCartItemWords]);

  const flagged: string[] = [];
  for (const { line, menuItem } of cart) {
    if (!menuItem.ask_plan || menuItem.ask_plan.steps.length > 0) continue;
    const dn = menuItem.ask_plan.display_name.toLowerCase();
    const headNoun = dn.split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "");
    if (!headNoun || GENERIC_HEAD_NOUN.has(headNoun)) continue;
    const precedingRe = new RegExp(`\\b(\\w+)\\s+${headNoun}\\b`, "g");
    let m: RegExpExecArray | null;
    let foundForeign = false;
    while ((m = precedingRe.exec(replyLower))) {
      if (safeWord.has(m[1])) continue;
      foundForeign = true;
      break;
    }
    if (foundForeign) flagged.push(line.name);
  }
  return flagged;
}

const BAGEL_ITEM: MenuItemLike = {
  id: "bagel-plain-cc",
  ask_plan: { display_name: "Bagel with Plain Cream Cheese", steps: [] },
};
const BAGEL_LINE: CartLineLike = { menu_item_id: "bagel-plain-cc", name: "Bagel with Plain Cream Cheese" };
const PLAIN_BAGEL_ITEM: MenuItemLike = {
  id: "plain-bagel",
  ask_plan: { display_name: "Plain Bagel", steps: [] },
};
const PLAIN_BAGEL_LINE: CartLineLike = { menu_item_id: "plain-bagel", name: "Plain Bagel" };

// Single-item cart is the common case for most tests below.
function soloCart(line: CartLineLike, menuItem: MenuItemLike) {
  return [{ line, menuItem }];
}

// v5 -> v6: caught live-verifying the NEW pre-composition hint
// (zero-option-attribute-hint.ts) — the hint successfully steered the model
// to an honest denial, but GUARD 17 didn't recognize the denial and
// appended its own correction anyway, recreating the self-contradiction on
// an ALREADY-honest reply. This is the specific real transcript that broke.
Deno.test("GUARD 17 v6: an HONEST denial ('I can't officially change the bagel type on that one, but I've noted everything bagel for the kitchen') must NOT be flagged (real transcript that broke v5)", () => {
  const reply = "I can't officially change the bagel type on that one, but I've noted everything bagel for the kitchen - they'll take care of it! Want it toasted?";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "an honest, explicit denial must never be corrected — it was never wrong");
});

Deno.test("GUARD 17 v6: other negation phrasings ('cannot', 'won't', 'unable to', 'not able to') are equally recognized as honest denials", () => {
  const variants = [
    "I cannot change the bagel type on that one, but I've noted everything bagel for the kitchen.",
    "I won't be able to change that to an everything bagel, but I've noted it for the kitchen.",
    "I'm unable to change the bagel type, but I noted everything bagel for the kitchen.",
    "I'm not able to change that to an everything bagel, but I've noted it for the kitchen.",
  ];
  for (const reply of variants) {
    assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], `must not flag an honest denial: "${reply}"`);
  }
});

// The negation must be in the SAME sentence as the change-verb — a
// negation elsewhere in the reply must not shield an actual false claim.
Deno.test("GUARD 17 v6: a negation in a DIFFERENT sentence does not shield a genuine false claim in another sentence", () => {
  const reply = "We can't do rush orders today. Switched to an everything bagel with plain cream cheese!";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), ["Bagel with Plain Cream Cheese"], "an unrelated negation must not shield a real false claim in a separate sentence");
});

// The exact real repro, first form (as relayed)
Deno.test("GUARD 17: the exact real repro — 'switched to an everything bagel' on a zero-option item", () => {
  const reply = "Got it - switched to an everything bagel with plain cream cheese";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), ["Bagel with Plain Cream Cheese"]);
});

// v1 -> v2: caught by driving the real deployed endpoint, not the unit test
Deno.test("GUARD 17: second real transcript (deployed endpoint, live NJB data) — the false descriptor is embedded AS A SUBSTRING of the honest full name", () => {
  const reply = "Switched to an everything bagel with plain cream cheese! Still want that toasted?";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), ["Bagel with Plain Cream Cheese"]);
});

// v3 -> v4: caught on the FIRST live re-verification run after v3 shipped —
// the real model dropped "plain" from its own phrasing this time.
Deno.test("GUARD 17: third real transcript (deployed endpoint, live NJB data) — the model DROPS a word from its own honest name ('with cream cheese', no 'plain') — v3's exact-full-phrase match went silent here", () => {
  const reply = "Switched to an everything bagel with cream cheese. Now, want that toasted?";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), ["Bagel with Plain Cream Cheese"]);
});

// v2 -> v3 -> v4: the two-real-item collision an independent adversarial
// reviewer ("Melvin") found by hand-tracing v2 against the real NJB catalog
// before it shipped un-revised. v4 must ALSO pass this (not just v3).
Deno.test("GUARD 17: TWO real zero-option items sharing a word ('Plain Bagel' + 'Bagel with Plain Cream Cheese') — an honest recap of both plus an unrelated change must not misattribute the change to either", () => {
  const reply = "Got it, one Plain Bagel and one Bagel with Plain Cream Cheese — I switched your drink to a large iced coffee.";
  const cart = [
    { line: PLAIN_BAGEL_LINE, menuItem: PLAIN_BAGEL_ITEM },
    { line: BAGEL_LINE, menuItem: BAGEL_ITEM },
  ];
  assertEquals(guard17Flags(cart, reply), [], "neither real item should be flagged");
});

// v4 -> v5: found by an independent adversarial reviewer ("Melvin") given
// v4 specifically to try to break, BEFORE it shipped un-revised. Real NJB
// items "One Dozen Bagels" / "Half Dozen Bagels" derive a headNoun ("one" /
// "half") common enough to appear in totally unrelated replies.
Deno.test("GUARD 17: a display_name whose first word is an overly generic word ('One Dozen Bagels' -> headNoun 'one') must NOT false-positive on unrelated conversation (Melvin finding, v4 bug)", () => {
  const dozenItem: MenuItemLike = { id: "one-dozen", ask_plan: { display_name: "One Dozen Bagels", steps: [] } };
  const line: CartLineLike = { menu_item_id: "one-dozen", name: "One Dozen Bagels" };
  const reply = "Got it, I changed your pickup time to a later one, see you soon!";
  assertEquals(guard17Flags(soloCart(line, dozenItem), reply), [], "an unrelated 'a later one' must never be read as an attribute claim about a bulk bagel order");
});

Deno.test("GUARD 17: 'Half Dozen Bagels' (headNoun 'half') is equally protected", () => {
  const halfDozenItem: MenuItemLike = { id: "half-dozen", ask_plan: { display_name: "Half Dozen Bagels", steps: [] } };
  const line: CartLineLike = { menu_item_id: "half-dozen", name: "Half Dozen Bagels" };
  const reply = "Got it, switched your total to half off with the promo code!";
  assertEquals(guard17Flags(soloCart(line, halfDozenItem), reply), [], "an unrelated discount mention must never be read as an attribute claim about a bulk bagel order");
});

// KNOWN, ACCEPTED LIMITATION (same Melvin review, judged lower priority
// than the false positive above, not fixed): three-plus zero-option items
// with overlapping words can let one item's honest name shield a genuine
// false claim about a different item reusing the same shared word. This
// test documents the limitation explicitly (asserts the CURRENT, imperfect
// behavior) so it's a conscious, visible gap rather than a silent one --
// if a future revision closes this, this test should start failing and
// get updated, not silently pass by accident.
Deno.test("GUARD 17 (known limitation, not fixed): a false claim about item B can hide behind item A's honest, unrelated name sharing a word with B", () => {
  const sesameItem: MenuItemLike = { id: "sesame-bagel", ask_plan: { display_name: "Sesame Bagel", steps: [] } };
  const sesameLine: CartLineLike = { menu_item_id: "sesame-bagel", name: "Sesame Bagel" };
  const cart = [
    { line: sesameLine, menuItem: sesameItem },
    { line: BAGEL_LINE, menuItem: BAGEL_ITEM },
  ];
  // A false claim naming "sesame" (Sesame Bagel's own word) as the new type
  // for the OTHER item ("Bagel with Plain Cream Cheese") is NOT caught,
  // because "sesame" is honest context for the Sesame Bagel line already
  // in cart. This is the accepted gap -- documented, not silent.
  const reply = "Got it - switched to a sesame bagel with plain cream cheese, still want it toasted?";
  assertEquals(guard17Flags(cart, reply), [], "documents the known limitation: this SHOULD ideally flag 'Bagel with Plain Cream Cheese' but currently does not");
});

Deno.test("GUARD 17: a real change-of-bagel-type claim about 'Plain Bagel' specifically is still caught, even with 'Bagel with Plain Cream Cheese' ALSO in cart", () => {
  const reply = "Got it - switched to an everything Plain Bagel, and kept your Bagel with Plain Cream Cheese as-is!";
  const cart = [
    { line: PLAIN_BAGEL_LINE, menuItem: PLAIN_BAGEL_ITEM },
    { line: BAGEL_LINE, menuItem: BAGEL_ITEM },
  ];
  assertEquals(guard17Flags(cart, reply), ["Plain Bagel"], "a genuine foreign descriptor must still flag, even alongside a second real item");
});

Deno.test("GUARD 17: 'changed to' / 'swapped for' / 'instead of' / 'now an' / 'make it an' / 'updated to' all trip it", () => {
  const variants = [
    "Got it - changed to an everything bagel with plain cream cheese",
    "Got it - swapped for an everything bagel with plain cream cheese",
    "Got it - instead of plain, that's now an everything bagel with plain cream cheese",
    "Got it, now an everything bagel with plain cream cheese",
    "Sure, I'll make it an everything bagel with plain cream cheese",
    "Got it, updated to an everything bagel with plain cream cheese",
  ];
  for (const reply of variants) {
    assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), ["Bagel with Plain Cream Cheese"], `must flag: "${reply}"`);
  }
});

// The honest, correct reply for the very same add — must NEVER be flagged
Deno.test("GUARD 17: an honest add ('Got it, Bagel with Plain Cream Cheese added') is never flagged", () => {
  const reply = "Got it, Bagel with Plain Cream Cheese added, anything else?";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), []);
});

// No comma before the item name — still must not flag on "Added"/"Got" etc.
Deno.test("GUARD 17: an honest add phrased WITHOUT a comma before the item name ('Added Bagel with Plain Cream Cheese to your order') is never flagged", () => {
  const reply = "Added Bagel with Plain Cream Cheese to your order, anything else?";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "'added' must be treated as an honest confirmation word, not a foreign descriptor");
});

// A legitimate quantity bump is not an attribute claim
Deno.test("GUARD 17: 'switched you to two Bagel with Plain Cream Cheese' (a quantity change, not an attribute claim) is not flagged", () => {
  const reply = "Got it, switched you to two Bagel with Plain Cream Cheese.";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "a quantity word before the item name is not a foreign descriptor");
});

// False-positive guard: an honest change to a DIFFERENT (non-menu-item)
// thing in the same reply, alongside an honest restatement of the
// zero-option item's own full name, must not misattribute the change.
Deno.test("GUARD 17: a legitimate change to a non-item thing (a side), alongside an honest restatement of this item's full name, is not flagged", () => {
  const reply = "Got it, one Bagel with Plain Cream Cheese — I switched your side to home fries.";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "honest restatement + unrelated change must not be flagged");
});

// An unrelated change verb in a separate sentence, with the item name
// honestly stated on its own, must not be flagged either.
Deno.test("GUARD 17: an unrelated change verb in a SEPARATE sentence from the honest item mention is not flagged", () => {
  const reply = "Got it, switched your order to delivery. Bagel with Plain Cream Cheese added.";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "a change verb in a different sentence must not be attributed to this item");
});

// No change-claim language at all → never flagged (mirrors GUARD 16's own
// "no confirmation keyword" negative case)
Deno.test("GUARD 17: no change-claiming language at all means no flag", () => {
  const reply = "Everything bagels are toasted a bit longer, just so you know.";
  assertEquals(guard17Flags(soloCart(BAGEL_LINE, BAGEL_ITEM), reply), [], "no change verb present, should not flag");
});

// An item WITH real options is untouched by GUARD 17 (that's GUARD 16's job)
Deno.test("GUARD 17: an item with real ask_plan steps is never examined by this guard", () => {
  const pizzaItem: MenuItemLike = {
    id: "pizza-1",
    ask_plan: { display_name: "Buffalo Chicken Pizza", steps: [{ kind: "modifier" }] },
  };
  const line: CartLineLike = { menu_item_id: "pizza-1", name: "Buffalo Chicken Pizza" };
  const reply = "Got it - switched to a large Buffalo Chicken Pizza!";
  assertEquals(guard17Flags(soloCart(line, pizzaItem), reply), [], "items with real steps are GUARD 16's job, not GUARD 17's");
});

// No ask_plan at all (uncompiled/legacy item) → skipped, not this guard's job
Deno.test("GUARD 17: an item with no ask_plan at all is skipped", () => {
  const legacyItem: MenuItemLike = { id: "legacy-1", ask_plan: null };
  const line: CartLineLike = { menu_item_id: "legacy-1", name: "Legacy Item" };
  const reply = "Got it - switched to something else with legacy!";
  assertEquals(guard17Flags(soloCart(line, legacyItem), reply), [], "no ask_plan means no compiled data to check against");
});

// Regression: GUARD 17 exists in index.ts with its key structural invariants
Deno.test("regression: GUARD 17 is present in index.ts and has the key structural invariants", () => {
  assert(INDEX_SOURCE.includes("GUARD 17 (zero-option item false attribute-change claim)"),
    "GUARD 17 must log a trip with that exact label");
  assert(INDEX_SOURCE.includes("menuItem.ask_plan.steps.length > 0) continue"),
    "GUARD 17 must only examine items with zero ask_plan steps");
  assert(INDEX_SOURCE.includes("zeroOptionChangeClaimRe"),
    "GUARD 17 must gate on a change-claiming verb regex, not a generic confirmation regex");
  assert(
    /dn17 = menuItem\.ask_plan\.display_name\.toLowerCase\(\)/.test(INDEX_SOURCE),
    "GUARD 17 must derive its head noun from the item's own display_name",
  );
  assert(INDEX_SOURCE.includes("headNoun17"),
    "GUARD 17 must check the word immediately preceding a single head-noun word, tolerant of the model dropping other words from the honest name");
  assert(INDEX_SOURCE.includes("allCartItemWords17"),
    "GUARD 17 must treat a word from ANY cart item's own name as honest context, not just the item currently being checked — the actual fix for the real two-item collision bug");
  assert(INDEX_SOURCE.includes("nonDescriptorWord17") && INDEX_SOURCE.includes("safeWord17"),
    "GUARD 17 must combine articles/quantifiers/confirmation words with all cart items' own words into one safe-word set");
  assert(INDEX_SOURCE.includes("genericHeadNoun17"),
    "GUARD 17 must refuse to anchor on an overly generic head noun ('one', 'half', ...) — real bug: 'One Dozen Bagels'/'Half Dozen Bagels' false-positive on unrelated conversation otherwise");
  assert(INDEX_SOURCE.includes("hasUnnegatedChangeClaim17") && INDEX_SOURCE.includes("negation17Re"),
    "GUARD 17 must recognize an honest denial ('can't change', 'unable to') in the SAME sentence as the change-verb and skip it — real bug: the pre-composition hint steers the model to an honest denial that still contains change-verb + foreign-descriptor language, and GUARD 17 must not re-correct an already-honest reply");
  assert(INDEX_SOURCE.includes("foundForeignDescriptor"),
    "GUARD 17 must flag on a genuine foreign descriptor word immediately preceding the head noun");
  assert(
    /reply = `\$\{reply\}.*Just to be clear/.test(INDEX_SOURCE),
    "GUARD 17 must append a correction, never replace the model's reply",
  );
});
