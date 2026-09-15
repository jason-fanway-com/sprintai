// Turn Engine, code-owned item resolution
// (docs/specs/2026-09-15-code-owned-resolution.md §4 Gate item 1).
//
// Fixtures are chosen to be able to FAIL, not just confirm the happy path —
// see this file's header comments at each case for what a broken resolver
// would do instead.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveItem, type LexiconTerm } from "./resolve-item.ts";

// ── The defect-class fixture: two items sharing a bare word ("burger"),
// distinguished only by whether "bacon" is also present in the span. This is
// the exact live Vito's pair from the spec's §1 evidence table — 10 of 20
// live calls billed Bacon Cheeseburger ($10.99) for a plain "cheeseburger"
// order ($8.49). A resolver that matches on any substring, or that doesn't
// require "bacon" to be an actual word in the span, reproduces that defect.
const CHEESE_BURGER_ID = "item-cheeseburger";
const BACON_CHEESEBURGER_ID = "item-bacon-cheeseburger";

const CHEESEBURGER_LEXICON: LexiconTerm[] = [
  { term: "cheeseburger", target_id: CHEESE_BURGER_ID },
  { term: "cheeseburgers", target_id: CHEESE_BURGER_ID },
  { term: "cheese burger", target_id: CHEESE_BURGER_ID },
  { term: "bacon cheeseburger", target_id: BACON_CHEESEBURGER_ID },
  { term: "bacon cheeseburgers", target_id: BACON_CHEESEBURGER_ID },
];

Deno.test("resolveItem: a bare 'cheeseburger' span resolves to Cheese Burger, never Bacon Cheeseburger", () => {
  const result = resolveItem("cheeseburger", CHEESEBURGER_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: CHEESE_BURGER_ID });
});

Deno.test("resolveItem: 'bacon cheeseburger' resolves to Bacon Cheeseburger ONLY because the span literally contains the word 'bacon'", () => {
  const result = resolveItem("bacon cheeseburger", CHEESEBURGER_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: BACON_CHEESEBURGER_ID });
});

Deno.test("resolveItem: a span embedding 'bacon cheeseburger' inside a longer sentence still resolves the two-word term, not the shorter one", () => {
  const result = resolveItem("can i get a bacon cheeseburger and a coke", CHEESEBURGER_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: BACON_CHEESEBURGER_ID });
});

Deno.test("resolveItem: punctuation and case never block a match", () => {
  const result = resolveItem("Cheeseburger, please!!", CHEESEBURGER_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: CHEESE_BURGER_ID });
});

Deno.test("resolveItem: a span whose longest match is a multi-word term beats a shorter single-word match for a DIFFERENT item", () => {
  // "chicken" alone would resolve to a generic chicken item; the actual span
  // names the specific three-word dish, which must win because it is the
  // LONGER matched run, not because it appears "more specific" by any other
  // measure. A resolver that stops at the first match, or matches on the
  // shortest/any hit, would incorrectly return item-chicken-tenders here.
  const lexicon: LexiconTerm[] = [
    { term: "chicken", target_id: "item-chicken-tenders" },
    { term: "grilled chicken sandwich", target_id: "item-grilled-chicken-sandwich" },
  ];
  const result = resolveItem("can i get the grilled chicken sandwich please", lexicon);
  assertEquals(result, { kind: "resolved", menu_item_id: "item-grilled-chicken-sandwich" });
});

// ── Ambiguous: genuinely tied candidates at the longest matched length must
// ASK, never guess — this is confirmed product behavior (spec §2), not a
// defect. Fixture: three distinct items that each legitimately carry the
// bare term "burger" (the real live-menu shape the spec's §1 table
// describes — "burger" (7 items) -> ambiguous -> ask).
const AMBIGUOUS_BURGER_LEXICON: LexiconTerm[] = [
  { term: "burger", target_id: "item-cheeseburger" },
  { term: "burger", target_id: "item-bacon-cheeseburger" },
  { term: "burger", target_id: "item-turkey-burger" },
];

Deno.test("resolveItem: a term tying across multiple different items is ambiguous, carrying every tying candidate", () => {
  const result = resolveItem("i'll take a burger", AMBIGUOUS_BURGER_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? result.candidates : [],
    ["item-bacon-cheeseburger", "item-cheeseburger", "item-turkey-burger"],
  );
});

Deno.test("resolveItem: an ambiguous short term never blocks a longer, unique match for the same span", () => {
  // Same ambiguous "burger" lexicon as above, but the span also contains a
  // longer, unique two-word term — the longer match must win outright, with
  // no ambiguity at all. This is what makes longest-match a real fix and not
  // just a narrower version of the same bug: the presence of an ambiguous
  // shorter term must never leak into a span that actually disambiguated
  // itself via a longer phrase.
  const lexicon: LexiconTerm[] = [
    ...AMBIGUOUS_BURGER_LEXICON,
    { term: "cheese burger", target_id: "item-cheeseburger" },
  ];
  const result = resolveItem("cheese burger", lexicon);
  assertEquals(result, { kind: "resolved", menu_item_id: "item-cheeseburger" });
});

Deno.test("resolveItem: a span matching no lexicon term at all is unresolved", () => {
  const result = resolveItem("xyzzy plugh nothing here", CHEESEBURGER_LEXICON);
  assertEquals(result, { kind: "unresolved" });
});

Deno.test("resolveItem: an empty or whitespace-only span is unresolved, never a crash", () => {
  assertEquals(resolveItem("", CHEESEBURGER_LEXICON), { kind: "unresolved" });
  assertEquals(resolveItem("   ", CHEESEBURGER_LEXICON), { kind: "unresolved" });
});

Deno.test("resolveItem: a lexicon term is never matched as a substring inside a different, longer word", () => {
  // "burger" must not match inside "hamburgers" or "burgers-only" as a
  // fused/adjacent token — only as its own whole word.
  const lexicon: LexiconTerm[] = [{ term: "burger", target_id: "item-cheeseburger" }];
  const result = resolveItem("we sell hamburgers here", lexicon);
  assertEquals(result, { kind: "unresolved" });
});

// ── Real fixture with TWO option groups (Zio's live "Boneless Wings" row,
// id cb53dc5b-5abe-4110-a814-3beacec644e8 — "Choose Sauce" +  "Quantity",
// see turn-engine-stale-line-key.test.ts for the compiled ask_plan). Cheese
// Burger has exactly one option group and already hid a defect once before
// under different code (turn-engine's own stale-line_key bug) — this
// resolver's own fixtures must not repeat that mistake by testing
// resolution exclusively against single-group items.
const BONELESS_WINGS_ID = "cb53dc5b-5abe-4110-a814-3beacec644e8";

const MULTI_GROUP_LEXICON: LexiconTerm[] = [
  ...CHEESEBURGER_LEXICON,
  { term: "boneless wings", target_id: BONELESS_WINGS_ID },
  { term: "wings", target_id: BONELESS_WINGS_ID },
];

Deno.test("resolveItem: resolves an item that has two real compiled option groups (sauce + quantity), unaffected by the option-group count", () => {
  const result = resolveItem("can i get the boneless wings", MULTI_GROUP_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: BONELESS_WINGS_ID });
});
