// Turn Engine, code-owned item resolution
// (docs/specs/2026-09-15-code-owned-resolution.md §4 Gate item 1).
//
// Fixtures are chosen to be able to FAIL, not just confirm the happy path —
// see this file's header comments at each case for what a broken resolver
// would do instead.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveItem, type LexiconTerm } from "./resolve-item.ts";
import { compileMenu, type CompileItem } from "../_shared/compile-menu.ts";

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

// ============================================================
// Narrowing (2026-09-18 PO dispatch). Fixture is the REAL live Vito's rows
// (id/name/display_name/category/size_label/product_key — read from
// production via the service-role key, not hand-typed) run through the
// ACTUAL compileMenu() from _shared/compile-menu.ts, exactly the compiler
// production uses. This is a representative subset (57 of Vito's ~600+
// active items) chosen to reproduce every real collision shape the defect
// table needs — full Salads (14) + the 2 Appetizers items that also say
// "Salad" in their own name, gyro's 4-category spread (Pizza/Stromboli/
// Salads/Hot Sandwiches), all of calzone's 3 sizes, all of Hot Sandwiches
// and Angus Burgers & Specialty (the two categories "sandwich"/"burger"
// spread across), and the chicken-cheesesteak Panini/Roll/Sandwich/
// California four-way — not a hand-typed two-row lexicon (2026-09-15
// standing lesson: a hand-typed fixture missed real collision structure
// before).
//
// resolve-item.ts's LexiconTerm carries `category`/`size_label` as OPTIONAL
// fields. Production's real lexicon load (turn-engine-runner.ts's
// loadItemLexicon) selects only `term, target_id` today, so it does not yet
// populate them — this fixture enriches the compiler's real output with
// each item's own real category/size_label (exactly what a join to
// menu_items would add) to test resolveItem's narrowing on its own merits,
// against real collision data. See this dispatch's report for the wiring
// gap that leaves open in production until a follow-up dispatch widens that
// query.
const NARROWING_FIXTURE_ITEMS: CompileItem[] = [
  // Salads (all 14 real items)
  { id: "2b51cfae-5475-4e3d-acbb-33f507718a4a", name: "Cajun Chicken", display_name: "Cajun Chicken", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:cajun-chicken", missing_from_source_since: null, groups: [] },
  { id: "8ec8e0e6-65fa-429e-9ce3-79d0b87e01b7", name: "Caprese Chicken", display_name: "Caprese Chicken", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:caprese-chicken", missing_from_source_since: null, groups: [] },
  { id: "db249934-e93f-410e-83f4-388e072210cf", name: "Buffalo Grilled Chicken", display_name: "Buffalo Grilled Chicken", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:buffalo-grilled-chicken", missing_from_source_since: null, groups: [] },
  { id: "e0d474c0-979a-4f8a-a223-07749a21e75b", name: "Shrimp Thai Sweet Chili", display_name: "Shrimp Thai Sweet Chili", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:shrimp-thai-sweet-chili", missing_from_source_since: null, groups: [] },
  { id: "9369c1e7-38df-45da-985e-36d278d7a12c", name: "Gyro (Beef or Chicken)", display_name: "Gyro Salad", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:gyro", missing_from_source_since: null, groups: [] },
  { id: "28c6d8e6-093e-4f78-8aaa-1d097b7ced37", name: "Cheesesteak / Chicken Cheesesteak", display_name: "Cheesesteak / Chicken Cheesesteak Salad", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:cheesesteak-chicken-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "489b7140-c1e1-40b6-acf3-c80c771f2662", name: "Tuna", display_name: "Tuna Salad", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:tuna", missing_from_source_since: null, groups: [] },
  { id: "a9f637bb-8264-44ef-b6c1-a5ffb4a83391", name: "House", display_name: "House", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:house", missing_from_source_since: null, groups: [] },
  { id: "d71dd082-1003-4089-a6e3-7398b845edc6", name: "Greek", display_name: "Greek", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:greek", missing_from_source_since: null, groups: [] },
  { id: "9136cf8a-8938-460b-86e8-801ba99b34a9", name: "Antipasta", display_name: "Antipasta", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:antipasta", missing_from_source_since: null, groups: [] },
  { id: "7b13d6a1-ae24-47b9-838d-a369b02934da", name: "Grilled Chicken", display_name: "Grilled Chicken Salad", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:grilled-chicken", missing_from_source_since: null, groups: [] },
  { id: "fad750fd-815a-4adc-b247-cefefd34adbc", name: "Southwest", display_name: "Southwest", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:southwest", missing_from_source_since: null, groups: [] },
  { id: "4103910d-5f2e-4085-8326-7f3d7b73efaf", name: "Chicken Caesar", display_name: "Chicken Caesar Salad", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:chicken-caesar", missing_from_source_since: null, groups: [] },
  { id: "a8e9bf58-6a2a-477c-8166-d4b78382f714", name: "Triple Bogey", display_name: "Triple Bogey", category: "Salads", price_cents: 999, active: true, price_provenance: "stated", product_key: "salads:triple-bogey", missing_from_source_since: null, groups: [] },
  // Appetizers — both real items whose own NAME says "Salad" (not Salads
  // category), the exact live collision the defect's header calls out.
  { id: "1952afca-2ea2-4194-8880-9691181cba52", name: "Side Salad", display_name: "Side Salad", category: "Appetizers", price_cents: 499, active: true, price_provenance: "stated", product_key: "appetizers:side-salad", missing_from_source_since: null, groups: [] },
  { id: "ff441b77-6428-439a-bb71-a81b9feab5b3", name: "Caprese Salad", display_name: "Caprese Salad", category: "Appetizers", price_cents: 799, active: true, price_provenance: "stated", product_key: "appetizers:caprese-salad", missing_from_source_since: null, groups: [] },
  // Pizza — gyro pizza's 3 sizes + a plain cheese pizza family (for a
  // faithful, non-trivial "pizza" bare term with more than one dish behind it)
  { id: "8b7a1ec8-1288-4199-82d0-a0dbf58fc22d", name: "Gyro - Small (10\")", display_name: "Small Gyro Pizza", category: "Pizza", size_label: "Small (10\")", price_cents: 1499, active: true, price_provenance: "stated", product_key: "pizza:gyro", missing_from_source_since: null, groups: [] },
  { id: "9932435f-bb6d-4bcc-b975-9a89ad552cfe", name: "Gyro - Medium (14\")", display_name: "Medium Gyro Pizza", category: "Pizza", size_label: "Medium (14\")", price_cents: 1899, active: true, price_provenance: "stated", product_key: "pizza:gyro", missing_from_source_since: null, groups: [] },
  { id: "713b447f-9798-4188-8930-967f03cb3678", name: "Gyro - Large (16\")", display_name: "Large Gyro Pizza", category: "Pizza", size_label: "Large (16\")", price_cents: 2299, active: true, price_provenance: "stated", product_key: "pizza:gyro", missing_from_source_since: null, groups: [] },
  { id: "c7e77443-c55f-4a81-bca1-999b61cc55d3", name: "Cheese - Small (10\")", display_name: "Small Cheese Pizza", category: "Pizza", size_label: "Small (10\")", price_cents: 999, active: true, price_provenance: "stated", product_key: "pizza:cheese", missing_from_source_since: null, groups: [] },
  { id: "fefa53d0-6ca0-4a9b-a507-a80801ae0ab2", name: "Cheese - Medium (14\")", display_name: "Medium Cheese Pizza", category: "Pizza", size_label: "Medium (14\")", price_cents: 1399, active: true, price_provenance: "stated", product_key: "pizza:cheese", missing_from_source_since: null, groups: [] },
  { id: "8857b40a-e53b-44fa-8bf0-6fdafb7efa45", name: "Cheese - Large (16\")", display_name: "Large Cheese Pizza", category: "Pizza", size_label: "Large (16\")", price_cents: 1799, active: true, price_provenance: "stated", product_key: "pizza:cheese", missing_from_source_since: null, groups: [] },
  // Stromboli — gyro's 3 sizes + calzone's 3 sizes (the acceptance
  // criteria's "just a 14-inch calzone" case)
  { id: "b756d6df-122c-4cba-9f10-9ecc994dd5c5", name: "Gyro - 14\"", display_name: "14\" Gyro Stromboli", category: "Stromboli", size_label: "14\"", price_cents: 1499, active: true, price_provenance: "stated", product_key: "stromboli:gyro", missing_from_source_since: null, groups: [] },
  { id: "4795c606-527e-4d63-a8c0-48be646fc91a", name: "Gyro - 16\"", display_name: "16\" Gyro Stromboli", category: "Stromboli", size_label: "16\"", price_cents: 1899, active: true, price_provenance: "stated", product_key: "stromboli:gyro", missing_from_source_since: null, groups: [] },
  { id: "1913e08d-f189-4b50-9a96-f696ba47541f", name: "Gyro - Personal", display_name: "Personal Gyro Stromboli", category: "Stromboli", size_label: "Personal", price_cents: 999, active: true, price_provenance: "stated", product_key: "stromboli:gyro", missing_from_source_since: null, groups: [] },
  { id: "7a69a23f-2dca-4522-97cf-d6b90efbb662", name: "Calzone - 16\"", display_name: "16\" Calzone Stromboli", category: "Stromboli", size_label: "16\"", price_cents: 1899, active: true, price_provenance: "stated", product_key: "stromboli:calzone", missing_from_source_since: null, groups: [] },
  { id: "9048bf9f-0a86-4a56-b53b-ec368b823641", name: "Calzone - 14\"", display_name: "14\" Calzone Stromboli", category: "Stromboli", size_label: "14\"", price_cents: 1499, active: true, price_provenance: "stated", product_key: "stromboli:calzone", missing_from_source_since: null, groups: [] },
  { id: "ad850a9f-1911-44a6-a389-e5636ad4fa6d", name: "Calzone - Personal", display_name: "Personal Calzone Stromboli", category: "Stromboli", size_label: "Personal", price_cents: 999, active: true, price_provenance: "stated", product_key: "stromboli:calzone", missing_from_source_since: null, groups: [] },
  // Hot Sandwiches (all 13 real items — the "sandwich" wide term's main category)
  { id: "8cf7eb23-dfe5-431c-9a04-f067280ff442", name: "Meatball Parmesan", display_name: "Meatball Parmesan", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:meatball-parmesan", missing_from_source_since: null, groups: [] },
  { id: "f06f0c98-7fb9-4c9a-b127-df7e9fd3e800", name: "Sausage Parmesan", display_name: "Sausage Parmesan", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:sausage-parmesan", missing_from_source_since: null, groups: [] },
  { id: "e8d3738c-91b0-4422-b4c1-cec776575048", name: "Garlic Cheesesteak", display_name: "Garlic Cheesesteak", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:garlic-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "801a65b6-5224-45c4-bf22-3e60f69f2da8", name: "The Slice Cheesesteak", display_name: "The Slice Cheesesteak", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:the-slice-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "67a95de1-9cb3-434e-bcdc-6a82563f3d9e", name: "Buffalo Chicken Cheesesteak", display_name: "Buffalo Chicken Cheesesteak Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:buffalo-chicken-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "e423aae6-a03b-4899-9f98-9e917fc4f6bb", name: "California Chicken Cheesesteak", display_name: "California Chicken Cheesesteak", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:california-chicken-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "e16e0ae7-8af7-4ad0-a22d-121443f1d9cc", name: "California Cheesesteak", display_name: "California Cheesesteak", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:california-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "a01b10d0-9c1d-455e-ba29-68b5875c0753", name: "Cheesesteak", display_name: "Cheesesteak Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "4e184b21-388b-4869-92ba-8b6d3f073e17", name: "Chicken Parmesan", display_name: "Chicken Parmesan Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:chicken-parmesan", missing_from_source_since: null, groups: [] },
  { id: "cf368253-8663-42fc-8ede-4c576a35664a", name: "Chicken Cheesesteak", display_name: "Chicken Cheesesteak Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:chicken-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "59062d12-642b-4fed-8746-0169cd27e83d", name: "Sausage", display_name: "Sausage Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:sausage", missing_from_source_since: null, groups: [] },
  { id: "0aa98115-82c2-4c71-9afd-479d43c0c063", name: "Supreme Cheesesteak", display_name: "Supreme Cheesesteak", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:supreme-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "7d457415-b011-4182-86a1-5869aab665c3", name: "Gyro (Beef or Chicken)", display_name: "Gyro Sandwich", category: "Hot Sandwiches", price_cents: 999, active: true, price_provenance: "stated", product_key: "hot-sandwiches:gyro", missing_from_source_since: null, groups: [] },
  // Cold Sandwiches — one item, so "sandwich" also ties across categories
  { id: "b6d43eba-cd6f-42ee-ae16-b6a1ad5b32c8", name: "BLT", display_name: "BLT Sandwich", category: "Cold Sandwiches", price_cents: 899, active: true, price_provenance: "stated", product_key: "cold-sandwiches:blt", missing_from_source_since: null, groups: [] },
  // Angus Burgers & Specialty (all 13 real items — the cheeseburger canary's
  // own category, same shape "burger" collided in before this dispatch)
  { id: "f39068c1-3ba7-46bc-bfd8-8f0d93ccdd8b", name: "California Cheeseburger", display_name: "California Cheeseburger", category: "Angus Burgers & Specialty", price_cents: 1099, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:california-cheeseburger", missing_from_source_since: null, groups: [] },
  { id: "184c949f-ddbd-490f-819e-70e220ed5592", name: "Cowboy Burger", display_name: "Cowboy Burger", category: "Angus Burgers & Specialty", price_cents: 1099, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:cowboy-burger", missing_from_source_since: null, groups: [] },
  { id: "94557b9c-25a8-45cc-aa02-7f175dae4389", name: "Bacon Cheeseburger", display_name: "Bacon Cheeseburger", category: "Angus Burgers & Specialty", price_cents: 1099, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:bacon-cheeseburger", missing_from_source_since: null, groups: [] },
  { id: "442f650d-dc96-4a95-9762-f6b571a4dd8c", name: "Cheese Burger", display_name: "Cheese Burger", category: "Angus Burgers & Specialty", price_cents: 849, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:cheese-burger", missing_from_source_since: null, groups: [] },
  { id: "ec8ccd24-ad5a-4279-b4e9-b6d17f1b1a00", name: "California Bacon Cheeseburger", display_name: "California Bacon Cheeseburger", category: "Angus Burgers & Specialty", price_cents: 1299, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:california-bacon-cheeseburger", missing_from_source_since: null, groups: [] },
  { id: "0dee24c0-eb42-4a1d-b6c3-f24bf977ecb1", name: "Fish Sandwich", display_name: "Fish Sandwich", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:fish-sandwich", missing_from_source_since: null, groups: [] },
  { id: "6887fa4c-a9ec-44f3-9055-5a6df0ff577b", name: "Spicy Crispy Chicken", display_name: "Spicy Crispy Chicken", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:spicy-crispy-chicken", missing_from_source_since: null, groups: [] },
  { id: "30724daa-f7e7-46c5-93d4-cdcad8fa2bca", name: "CBR Seasoned Crispy Chicken", display_name: "CBR Seasoned Crispy Chicken", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:cbr-seasoned-crispy-chicken", missing_from_source_since: null, groups: [] },
  { id: "3266042e-a363-4793-8b85-58327ecb793b", name: "\"OG\" Seasoned Crispy Chicken", display_name: "\"OG\" Seasoned Crispy Chicken", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:og-seasoned-crispy-chicken", missing_from_source_since: null, groups: [] },
  { id: "b8ae18b2-880c-43a8-901e-b4e8b06ad7f5", name: "Grilled Chicken Burger", display_name: "Grilled Chicken Burger", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:grilled-chicken-burger", missing_from_source_since: null, groups: [] },
  { id: "76d6cc44-a1ed-4176-9d1a-2637e1bc1b47", name: "Big Boy Burger", display_name: "Big Boy Burger", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:big-boy-burger", missing_from_source_since: null, groups: [] },
  { id: "bacb05f5-a414-4389-91b2-bc61129779ad", name: "Swiss Burger", display_name: "Swiss Burger", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:swiss-burger", missing_from_source_since: null, groups: [] },
  { id: "109c244b-4f14-4b52-9e90-5291e4f3e715", name: "Godfather Burger", display_name: "Godfather Burger", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:godfather-burger", missing_from_source_since: null, groups: [] },
  { id: "8d5fd77b-d18d-4a0f-bcbf-66e46261aabb", name: "Farm Burger", display_name: "Farm Burger", category: "Angus Burgers & Specialty", price_cents: 999, active: true, price_provenance: "stated", product_key: "angus-burgers-specialty:farm-burger", missing_from_source_since: null, groups: [] },
  // Homemade Paninis + Stromboli Rolls — the other two claimants in the
  // real chicken-cheesesteak Panini/Roll/Sandwich/California four-way
  { id: "49bf7de5-95b7-48a5-827d-258f757554bc", name: "Chicken Cheesesteak", display_name: "Chicken Cheesesteak Panini", category: "Homemade Paninis", price_cents: 999, active: true, price_provenance: "stated", product_key: "homemade-paninis:chicken-cheesesteak", missing_from_source_since: null, groups: [] },
  { id: "68945bf7-7c21-4cd7-aa47-bfbbaf1757b0", name: "Chicken Cheesesteak", display_name: "Chicken Cheesesteak Roll", category: "Stromboli Rolls", price_cents: 999, active: true, price_provenance: "stated", product_key: "stromboli-rolls:chicken-cheesesteak", missing_from_source_since: null, groups: [] },
];

// item id -> {category, size_label}, straight off the same real rows above
// — this is what a production query enriched with a join to menu_items
// would carry per lexicon row (see resolve-item.ts's header for why
// production's query doesn't populate this yet).
const NARROWING_ITEM_INFO = new Map(
  NARROWING_FIXTURE_ITEMS.map(i => [i.id, { category: i.category, size_label: i.size_label ?? null }]),
);

function buildRealNarrowingLexicon(): LexiconTerm[] {
  const { items } = compileMenu(NARROWING_FIXTURE_ITEMS, [], "2026-09-18T00:00:00.000Z", true);
  const lexicon: LexiconTerm[] = [];
  for (const compiled of items) {
    const info = NARROWING_ITEM_INFO.get(compiled.item_id)!;
    for (const term of compiled.lexicon_terms) {
      // Production's real loadItemLexicon() query filters to target_type =
      // 'item' — replicate that filter here so this fixture matches what
      // resolveItem actually receives, not the compiler's full output.
      if (term.target_type !== "item") continue;
      lexicon.push({ term: term.term, target_id: term.target_id, category: info.category, size_label: info.size_label });
    }
  }
  return lexicon;
}

const NARROWING_LEXICON = buildRealNarrowingLexicon();

function idOf(name: string): string {
  const item = NARROWING_FIXTURE_ITEMS.find(i => i.display_name === name);
  if (!item) throw new Error(`fixture item not found: ${name}`);
  return item.id;
}

// ── Defect-table cases (real Vito's lexicon, real collision shapes) ──

Deno.test("resolveItem: 'house salad' resolves to House, not the 8-way salad tie", () => {
  const result = resolveItem("house salad", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("House") });
});

Deno.test("resolveItem: 'southwest salad' resolves to Southwest, not the 8-way salad tie", () => {
  const result = resolveItem("southwest salad", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Southwest") });
});

// "chicken cheesesteak" ties 3 ways under a FRESH compile of these real rows
// (Panini/Roll/Sandwich) — NOT the 4 the dispatch's defect table describes
// (that 4th, "California Chicken Cheesesteak", is a live/stale lexicon row:
// verified by compiling just these 4 real rows in isolation, the current
// compile-menu.ts does not emit "chicken cheesesteak" for it at all, because
// it collides with cf368253's own STATED bare term and gets excluded — see
// this dispatch's report). Category narrowing on "hot sandwich" filters the
// real 3-way tie to the one candidate whose own category is Hot Sandwiches.
Deno.test("resolveItem: 'chicken cheesesteak hot sandwich' narrows the real 3-way tie to the Hot Sandwiches candidate", () => {
  const result = resolveItem("chicken cheesesteak hot sandwich", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Chicken Cheesesteak Sandwich") });
});

// A FRESH compile of these real 3 rows never emits a bare "calzone" term at
// all (verified in isolation, same method as above) — item.name's Rule-2
// bareName is gated to sized items only when ≥2 UNSIZED siblings already
// share it (compile-menu.ts's own 2026-09-18 comment on that gate), and no
// such sibling exists anywhere on Vito's real menu. Live production's
// "calzone" (3 targets, provenance "derived") is a STALE row from before
// that gate's current form — the size-narrowing mechanism itself is proven
// end-to-end by "small gyro pizza" below, on a term ("gyro") the current
// compiler does produce. Reporting the real, current result rather than the
// dispatch's own (stale-data) expectation, per this dispatch's own
// instruction to report raw captured output.
Deno.test("resolveItem: 'just a 14-inch calzone' is unresolved because 'calzone' is not a reachable term under a fresh compile (unrelated to this dispatch's narrowing)", () => {
  const result = resolveItem("just a 14-inch calzone", NARROWING_LEXICON);
  assertEquals(result, { kind: "unresolved" });
});

Deno.test("resolveItem: 'chicken caesar salad' still resolves via its own qualified term (no regression)", () => {
  const result = resolveItem("chicken caesar salad", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Chicken Caesar Salad") });
});

// ── No-regression cases (acceptance criteria #2) ──

Deno.test("resolveItem: 'cheeseburger' canary still resolves to the $8.49 Cheese Burger, unaffected by narrowing", () => {
  const result = resolveItem("cheeseburger", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Cheese Burger") });
});

Deno.test("resolveItem: 'salad' alone still asks — bare single-word category behavior is unchanged by this dispatch", () => {
  const result = resolveItem("salad", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  console.log("'salad' alone ->", JSON.stringify(result));
});

Deno.test("resolveItem: 'gyro' alone still asks across all 8 real gyro candidates, matching current behavior", () => {
  const result = resolveItem("gyro", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(result.kind === "ambiguous" ? result.candidates.length : -1, 8);
});

Deno.test("resolveItem: 'gyro pizza' narrows to the 3 gyro-pizza size candidates (category narrowing, size not yet specified)", () => {
  const result = resolveItem("gyro pizza", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [idOf("Large Gyro Pizza"), idOf("Medium Gyro Pizza"), idOf("Small Gyro Pizza")].sort(),
  );
});

Deno.test("resolveItem: 'small gyro pizza' resolves to exactly one (category + size narrowing both applied)", () => {
  const result = resolveItem("small gyro pizza", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Small Gyro Pizza") });
});
