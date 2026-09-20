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
  // Chicken Bacon Ranch collision (2026-09-18 PO follow-up dispatch, edge
  // 1): the same dish name spread across Flatbreads (no size), Wraps (a
  // differently-worded real item), and 3 sized Pizza rows — a customer
  // naming "chicken bacon ranch" AND "pizzas" must not dead-end into
  // unresolved just because "pizzas" doesn't apply to the Flatbreads/Wraps
  // tie the bare dish name itself produces.
  { id: "5e8fcaf7-a1bd-4c3c-943c-2f066e091c0d", name: "Chicken Bacon Ranch", display_name: "Chicken Bacon Ranch", category: "Flatbreads", price_cents: 1050, active: true, price_provenance: "stated", product_key: "flatbreads:chicken-bacon-ranch", missing_from_source_since: null, groups: [] },
  { id: "8dcd82db-d635-4b2a-8a73-22d5b39c6da4", name: "Grilled Chicken Bacon & Ranch", display_name: "Grilled Chicken Bacon & Ranch", category: "Wraps", price_cents: 999, active: true, price_provenance: "stated", product_key: "wraps:grilled-chicken-bacon-ranch", missing_from_source_since: null, groups: [] },
  { id: "f320da06-15d2-4503-97b2-001c17b444bf", name: "Chicken Bacon Ranch - Small (10\")", display_name: "Small Chicken Bacon Ranch Pizza", category: "Pizza", size_label: "Small (10\")", price_cents: 1295, active: true, price_provenance: "stated", product_key: "pizza:chicken-bacon-ranch", missing_from_source_since: null, groups: [] },
  { id: "dca6fae3-2d94-4a18-b0a9-760474cec7c1", name: "Chicken Bacon Ranch - Medium (14\")", display_name: "Medium Chicken Bacon Ranch Pizza", category: "Pizza", size_label: "Medium (14\")", price_cents: 1999, active: true, price_provenance: "stated", product_key: "pizza:chicken-bacon-ranch", missing_from_source_since: null, groups: [] },
  { id: "edac128c-c963-495a-8e4a-ec09a9787267", name: "Chicken Bacon Ranch - Large (16\")", display_name: "Large Chicken Bacon Ranch Pizza", category: "Pizza", size_label: "Large (16\")", price_cents: 2299, active: true, price_provenance: "stated", product_key: "pizza:chicken-bacon-ranch", missing_from_source_since: null, groups: [] },
  // Italian — same bare name across two categories (Wraps + Homemade Paninis),
  // the real live-menu shape for "an italian sandwich" ambiguity.
  { id: "a3b2c1d0-0001-0000-0000-000000000001", name: "Italian", display_name: "Italian Wrap", category: "Wraps", price_cents: 999, active: true, price_provenance: "stated", product_key: "wraps:italian", missing_from_source_since: null, groups: [] },
  { id: "a3b2c1d0-0001-0000-0000-000000000002", name: "Italian", display_name: "Italian Panini", category: "Homemade Paninis", price_cents: 999, active: true, price_provenance: "stated", product_key: "homemade-paninis:italian", missing_from_source_since: null, groups: [] },
  // "Slice" collision (2026-09-18 PO follow-up dispatch, edge 2): "slice" is
  // simultaneously Regular Slice's own bare item term AND the category noun
  // for "By the Slice" — the exact real live-menu shape that hid the
  // "resolves to the $2.85 Regular Slice instead of a $22.95 stromboli"
  // defect from the narrowing mechanism entirely (it never reached the
  // item-name/category/size pass at all).
  { id: "a26552ec-c1fd-4ac9-b2a8-63e86e72f6ec", name: "Regular Slice - Slice", display_name: "Regular Slice", category: "By the Slice", size_label: "Slice", price_cents: 285, active: true, price_provenance: "stated", product_key: "by-the-slice:regular-slice", missing_from_source_since: null, groups: [] },
  { id: "b1f3a60a-b845-4506-89b4-8df7a4dd77a3", name: "The Slice - 14\"", display_name: "14\" The Slice Stromboli", category: "Stromboli", size_label: "14\"", price_cents: 1895, active: true, price_provenance: "stated", product_key: "stromboli:the-slice", missing_from_source_since: null, groups: [] },
  { id: "1d78ca8d-bdb5-46db-aa93-c8de67a743f8", name: "The Slice - 16\"", display_name: "16\" The Slice Stromboli", category: "Stromboli", size_label: "16\"", price_cents: 2295, active: true, price_provenance: "stated", product_key: "stromboli:the-slice", missing_from_source_since: null, groups: [] },
  { id: "975bdde8-6df6-4d61-81de-9994e2062349", name: "The Slice - Personal", display_name: "Personal The Slice Stromboli", category: "Stromboli", size_label: "Personal", price_cents: 1295, active: true, price_provenance: "stated", product_key: "stromboli:the-slice", missing_from_source_since: null, groups: [] },
  // Meat Lovers collision (2026-09-18 PO dispatch, plural family widening,
  // real conv c9027bee): the Stromboli Rolls "Meat Lovers" item's own
  // name is plural; the Meat Lover pizza family's bare base-key term
  // (compile-menu.ts) is singular, from the raw import's own singular
  // product name. "2 small Meat Lovers pizzas" uniquely matched the
  // ROLL's own plural term at the longest length — the pizza family's
  // singular term never matched the plural span word at all — and
  // silently resolved to the $9.99 roll instead of asking, or resolving
  // to, the $12.95 pizza the customer actually stated a size and category
  // for. Real ids/prices/product_keys, pulled directly from Vito's live
  // menu_items.
  { id: "66878ffc-62d6-44c0-a59f-591cdc08cbfd", name: "Meat Lover - Large (16\")", display_name: "Large Meat Lover Pizza", category: "Pizza", size_label: "Large (16\")", price_cents: 2199, active: true, price_provenance: "stated", product_key: "pizza:meat-lover", missing_from_source_since: null, groups: [] },
  { id: "c0528557-3923-4c2a-91e4-2eb09aea2d11", name: "Meat Lover - Small (10\")", display_name: "Small Meat Lover Pizza", category: "Pizza", size_label: "Small (10\")", price_cents: 1295, active: true, price_provenance: "stated", product_key: "pizza:meat-lover", missing_from_source_since: null, groups: [] },
  { id: "6191bc55-1675-4588-9031-1a907f620b92", name: "Meat Lover - Medium (14\")", display_name: "Medium Meat Lover Pizza", category: "Pizza", size_label: "Medium (14\")", price_cents: 1799, active: true, price_provenance: "stated", product_key: "pizza:meat-lover", missing_from_source_since: null, groups: [] },
  { id: "46fd6e25-263e-4eff-9ebb-dac8697a4819", name: "Meat Lovers", display_name: "Meat Lovers", category: "Stromboli Rolls", price_cents: 999, active: true, price_provenance: "stated", product_key: "stromboli-rolls:meat-lovers", missing_from_source_since: null, groups: [] },
  // Data fix (b), 2026-09-19 (live P0, Jason's transcript conv 0bdc1ae3):
  // "pepperoni pizza" resolved to this real Stromboli Rolls item (real id
  // 9598933c) — its own stated term is the single word "pepperoni" (no
  // standalone Pepperoni pizza item/term exists on Vito's real menu), so
  // the extra word "pizza" in the span, a real category noun for the
  // unrelated "Pizza" category above, must disqualify this match instead
  // of silently winning by default.
  { id: "9598933c-a8d8-4dc4-ba91-408a87b96f82", name: "Pepperoni", display_name: "Pepperoni", category: "Stromboli Rolls", price_cents: 999, active: true, price_provenance: "stated", product_key: "stromboli-rolls:pepperoni", missing_from_source_since: null, groups: [] },
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

// 2026-09-18 PO dispatch (two-regressions follow-up): this test used to pin
// "calzone" being UNREACHABLE under a fresh compile as correct behavior —
// that was the compiler regression itself (compile-menu.ts's ≥1-unsized-
// sibling gate on the bare base-key term, since removed in ac7396db), pinned
// as a green checkmark instead of being fixed. Now that ac7396db makes the
// bare "calzone" term unconditional for every size-folded family (namesake
// or not), the 14" size word in the message narrows the 3-way calzone tie
// to the one candidate whose own size_label is "14\"" — the acceptance
// criteria's original expectation, restored.
Deno.test("resolveItem: 'just a 14-inch calzone' resolves to Calzone - 14\" — the bare base-key term is reachable again after ac7396db", () => {
  const result = resolveItem("just a 14-inch calzone", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("14\" Calzone Stromboli") });
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

// ============================================================
// 2026-09-18 PO follow-up dispatch: two edge cases found probing the live
// Vito's lexicon once narrowing was actually wired into production.
//
// UPDATED same day, item-1 decision (compiler-families): the compiler now
// ties the bare "chicken bacon ranch" term across the Flatbread AND all 3
// Pizza sizes (shared product_key base "chicken-bacon-ranch"). The Wrap
// ("Grilled Chicken Bacon & Ranch", base "grilled-chicken-bacon-ranch")
// shares no base key with that family, so item 1's rule alone would not
// pull it in — but it ties anyway, via a SEPARATE, pre-existing mechanism:
// its own derived trailing-run candidate is the RAW string "chicken bacon
// & ranch" (dropping "grilled" from its stated name), which is a
// different literal lexicon row than "chicken bacon ranch" but
// resolveItem's own normalize() strips the "&" before matching, so the
// two rows collide at resolution time even though they're stored as
// different text. This was already true before today (it's why the
// ORIGINAL version of this test — before the item-1 decision — asserted
// exactly this same Flatbread+Wrap pair); item 1 just adds the 3 real
// pizza sizes into the same pre-existing tie.

Deno.test("resolveItem: 'chicken bacon ranch' alone ties the Flatbread, the Wrap (via its own '&'-normalizing derived term), and all 3 Pizza sizes", () => {
  const result = resolveItem("chicken bacon ranch", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [
      idOf("Chicken Bacon Ranch"), idOf("Grilled Chicken Bacon & Ranch"),
      idOf("Small Chicken Bacon Ranch Pizza"), idOf("Medium Chicken Bacon Ranch Pizza"), idOf("Large Chicken Bacon Ranch Pizza"),
    ].sort(),
  );
});

Deno.test("resolveItem: 'chicken bacon ranch medium pizzas' now narrows cleanly to the one medium pizza (category + size both stated)", () => {
  const result = resolveItem("chicken bacon ranch medium pizzas", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Medium Chicken Bacon Ranch Pizza") });
});

// ── Edge 2: a stated size must be honored even when the unfiltered match is
// already unique. "slice" is both Regular Slice's own bare term AND the
// category noun for "By the Slice", so it's excluded from the item-name pass
// and falls through to the raw, unnarrowed scan — a 16" order must not
// silently become the $2.85 Regular Slice.

const SLICE_16_ID = "1d78ca8d-bdb5-46db-aa93-c8de67a743f8"; // display_name '16" The Slice Stromboli'
const SLICE_14_ID = "b1f3a60a-b845-4506-89b4-8df7a4dd77a3";
const SLICE_PERSONAL_ID = "975bdde8-6df6-4d61-81de-9994e2062349";
const REGULAR_SLICE_ID = "a26552ec-c1fd-4ac9-b2a8-63e86e72f6ec";

Deno.test("resolveItem: 'a 16\" Slice' never resolves directly to Regular Slice, and is ambiguous including The Slice - 16\"", () => {
  const result = resolveItem('a 16" Slice', NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  const candidates = result.kind === "ambiguous" ? result.candidates : [];
  if (result.kind === "resolved") {
    throw new Error(`must never resolve directly — got ${JSON.stringify(result)}`);
  }
  assertEquals([...candidates].includes(SLICE_16_ID), true);
  assertEquals([...candidates].sort(), [REGULAR_SLICE_ID, SLICE_14_ID, SLICE_PERSONAL_ID, SLICE_16_ID].sort());
});

Deno.test("resolveItem: '16 inch the slice' is specific enough to resolve cleanly to The Slice - 16\", not ambiguous", () => {
  const result = resolveItem("16 inch the slice", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: SLICE_16_ID });
});

// ── 2026-09-18 PO amendment: narrowing only reduces a tie, never filters a
// unique match. Category words in the phrase are hints, not constraints.

// "side salad" resolves uniquely to Side Salad (Appetizers). "salad" is a
// real category noun for "Salads" — applying the Salads filter empties the
// set (Side Salad is Appetizers), so it falls back and the unique match stands.
Deno.test("resolveItem: 'side salad' resolves to the Appetizers Side Salad even though 'salad' is a Salads category noun", () => {
  const result = resolveItem("side salad", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Side Salad") });
});

// "italian" ties Italian Wrap (Wraps) and Italian Panini (Homemade Paninis).
// "sandwich" is a category noun for "Hot Sandwiches". Neither tied candidate
// is Hot Sandwiches — category filter empties the set, falls back to the full
// tie, and ASK gets both real options instead of dead-ending.
Deno.test("resolveItem: 'an italian sandwich' stays ambiguous across both Italian items — 'sandwich' category filter falls back when it empties the set", () => {
  const result = resolveItem("an italian sandwich", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [idOf("Italian Panini"), idOf("Italian Wrap")].sort(),
  );
});

// "the slice cheesesteak" names a single item (Hot Sandwiches) via its own
// 3-word item-name term. "slice" is a category noun for "By the Slice" —
// filtering for By the Slice returns empty, falls back, unique match stands.
Deno.test("resolveItem: 'the slice cheesesteak' resolves uniquely even though 'slice' is a By the Slice category noun", () => {
  const result = resolveItem("the slice cheesesteak", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("The Slice Cheesesteak") });
});

// ── Plural family widening (2026-09-18 PO dispatch, real conv c9027bee) ──

Deno.test("resolveItem: 'small meat lovers pizzas' (the live message, verbatim) resolves to Meat Lover - Small (10\"), never the Stromboli Roll", () => {
  const result = resolveItem("small meat lovers pizzas", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Small Meat Lover Pizza") });
});

Deno.test("resolveItem: 'meat lovers' alone is ambiguous across the roll and all 3 pizza sizes — never silently the roll", () => {
  const result = resolveItem("meat lovers", NARROWING_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [
      idOf("Meat Lovers"),
      idOf("Large Meat Lover Pizza"),
      idOf("Small Meat Lover Pizza"),
      idOf("Medium Meat Lover Pizza"),
    ].sort(),
  );
});

// ── Data fix (b), 2026-09-19: "pepperoni pizza" must never resolve to the
// Stromboli Rolls "Pepperoni" — real live P0 (Jason's transcript conv
// 0bdc1ae3, exact repro against the real menu row, id 9598933c) ──

Deno.test("resolveItem: 'pepperoni' alone still resolves to the real Stromboli Rolls Pepperoni — no regression", () => {
  const result = resolveItem("pepperoni", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Pepperoni") });
});

Deno.test("resolveItem (data fix b): 'pepperoni pizza' never resolves to the Stromboli Rolls Pepperoni — 'pizza' is an outside category word Pepperoni's own category shares nothing with", () => {
  const result = resolveItem("pepperoni pizza", NARROWING_LEXICON);
  if (result.kind === "resolved") {
    assertEquals(result.menu_item_id === idOf("Pepperoni"), false, "must never silently resolve to the Stromboli Rolls Pepperoni");
  }
  assertEquals(result.kind, "unresolved", `must be unresolved (no real Pepperoni Pizza item exists on this menu) — got ${JSON.stringify(result)}`);
});

Deno.test("resolveItem (data fix b): 'pepperoni stromboli' still resolves to the Stromboli Rolls Pepperoni — 'stromboli' is a synonym for its own category, not an outside qualifier", () => {
  const result = resolveItem("pepperoni stromboli", NARROWING_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: idOf("Pepperoni") });
});

// ── PO dispatch 2026-09-19 (pepperoni wart b): the fixture above never
// exercises the real live bug, because its own "pepperoni" term has no
// competing Pizza-family item at all (see its own comment: "no real
// Pepperoni Pizza item exists on this menu") — so the category-synonym
// reasoning only ever ran through the UNIQUE-base branch (base.targetIds.
// size === 1). Real Vito's data has an ACTUAL Pepperoni Pizza family that
// also carries the bare "pepperoni" term, so "a pepperoni stromboli" is a
// genuine 3-way TIE (2 pizza sizes + the roll) — and the tied CATEGORY
// filter (a plain `namedCategories.has(category)` equality check) dropped
// the roll entirely, because "stromboli" is only ever indexed as a category
// noun for the UNRELATED "Stromboli" platter category, never for "Stromboli
// Rolls" (categoryNoun only ever reduces a multi-word category to its LAST
// word — "rolls" — same root cause description as the dispatch's own
// singular/plural framing: the customer's own word for this category never
// stem-matches its compiled noun at all). A resolver that doesn't extend the
// synonym reasoning to genuine ties reproduces "did you mean Large/Medium/
// Small Pepperoni Pizza or Pepperoni Roll?" for a customer who plainly named
// the roll.
const TIE_PEPPERONI_PIZZA_LARGE = "item-tie-pepperoni-pizza-large";
const TIE_PEPPERONI_PIZZA_MEDIUM = "item-tie-pepperoni-pizza-medium";
const TIE_PEPPERONI_ROLL = "item-tie-pepperoni-roll";
const TIE_GYRO_PLATTER = "item-tie-gyro-platter"; // populates the unrelated "Stromboli" platter category into the index

const TIE_LEXICON: LexiconTerm[] = [
  { term: "pepperoni", target_id: TIE_PEPPERONI_PIZZA_LARGE, category: "Pizza", size_label: "Large" },
  { term: "large pepperoni pizza", target_id: TIE_PEPPERONI_PIZZA_LARGE, category: "Pizza", size_label: "Large" },
  { term: "pepperoni", target_id: TIE_PEPPERONI_PIZZA_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "medium pepperoni pizza", target_id: TIE_PEPPERONI_PIZZA_MEDIUM, category: "Pizza", size_label: "Medium" },
  { term: "pepperoni", target_id: TIE_PEPPERONI_ROLL, category: "Stromboli Rolls" },
  { term: "gyro", target_id: TIE_GYRO_PLATTER, category: "Stromboli" },
];

Deno.test("resolveItem (wart b, genuine tie): 'a pepperoni stromboli' resolves straight to the Stromboli Rolls Pepperoni, not a 3-way disambiguation, even though a real Pepperoni Pizza family shares the bare term", () => {
  const result = resolveItem("a pepperoni stromboli", TIE_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: TIE_PEPPERONI_ROLL });
});

Deno.test("resolveItem (wart b, no regression): 'a pepperoni pizza' with no size still ties across BOTH pizza sizes only — the roll must not leak back in, and neither size is guessed", () => {
  const result = resolveItem("a pepperoni pizza", TIE_LEXICON);
  assertEquals(result.kind, "ambiguous");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [TIE_PEPPERONI_PIZZA_LARGE, TIE_PEPPERONI_PIZZA_MEDIUM].sort(),
  );
});

Deno.test("resolveItem (wart b, no regression): a stated size still resolves the real Pepperoni Pizza directly, never the roll", () => {
  const result = resolveItem("a large pepperoni pizza", TIE_LEXICON);
  assertEquals(result, { kind: "resolved", menu_item_id: TIE_PEPPERONI_PIZZA_LARGE });
});

// DEFECT 3 (2026-09-19 live QA, PO priority item 4, real transcript conv
// 009de656 #5): "Can I also get a side of bleu cheese?" resolved to a
// 3-way tie of Cheese pizza SIZES instead of correctly saying there's no
// orderable bleu cheese side. Fixture is REAL Vito's live data, queried
// directly from the shop's own `lexicon` and `menu_items` tables
// (shop_id e0000000-0000-0000-0000-000000000001) on 2026-09-19, not
// invented: the single-word term "cheese" is a real, correct term for
// ordering a Cheese pizza and ties across its 3 real active size rows at
// their real ids/prices ($16.50/$12.95/$14.95, matching the live rendered
// list byte-for-byte); the two-word term "bleu cheese" is ALSO real and
// correctly curated (provenance "stated") pointing at the real "Bleu
// Cheese" row (id 6074cba8-b25b-4be4-80ec-a8ce9816f19f) — but that row is
// bot_state "display_only" (a Buffalo Chicken pizza finish, never a
// standalone orderable side), so production's own loadItemLexicon
// deliberately excludes its term from the active lexicon (see that
// function's own header). BEFORE this fix, resolveItem had no way to see
// the excluded term existed at all and fell all the way back to the
// unrelated "cheese" match. AFTER this fix, resolveItem is also given the
// excluded row (production wiring: turn-engine-runner.ts's new
// loadExcludedItemLexicon) and refuses to guess.
const REAL_VITOS_CHEESE_LARGE_ID = "8857b40a-e53b-44fa-8bf0-6fdafb7efa45";
const REAL_VITOS_CHEESE_SMALL_ID = "c7e77443-c55f-4a81-bca1-999b61cc55d3";
const REAL_VITOS_CHEESE_MEDIUM_ID = "fefa53d0-6ca0-4a9b-a507-a80801ae0ab2";
const REAL_VITOS_BLEU_CHEESE_ID = "6074cba8-b25b-4be4-80ec-a8ce9816f19f";

const REAL_VITOS_CHEESE_LEXICON: LexiconTerm[] = [
  { term: "cheese", target_id: REAL_VITOS_CHEESE_LARGE_ID, category: "Pizza", size_label: 'Large (16")' },
  { term: "cheese", target_id: REAL_VITOS_CHEESE_SMALL_ID, category: "Pizza", size_label: 'Small (10")' },
  { term: "cheese", target_id: REAL_VITOS_CHEESE_MEDIUM_ID, category: "Pizza", size_label: 'Medium (14")' },
];
const REAL_VITOS_EXCLUDED_LEXICON: LexiconTerm[] = [
  { term: "bleu cheese", target_id: REAL_VITOS_BLEU_CHEESE_ID },
];

Deno.test("resolveItem (DEFECT 3, real live Vito's data): 'bleu cheese' with no excluded-term visibility reproduces the bug — ties across 3 Cheese pizzas", () => {
  const result = resolveItem("bleu cheese", REAL_VITOS_CHEESE_LEXICON);
  assertEquals(
    result,
    { kind: "ambiguous", candidates: [REAL_VITOS_CHEESE_LARGE_ID, REAL_VITOS_CHEESE_MEDIUM_ID, REAL_VITOS_CHEESE_SMALL_ID].sort() },
    "documents the pre-fix bug shape — this is what production returned live, wrongly offering 3 pizzas for a side request",
  );
});

Deno.test("resolveItem (DEFECT 3 fix, real live Vito's data): 'bleu cheese' now returns unresolved (never a pizza candidate) once the excluded, more-specific term is visible", () => {
  const result = resolveItem("bleu cheese", REAL_VITOS_CHEESE_LEXICON, REAL_VITOS_EXCLUDED_LEXICON);
  assertEquals(result, { kind: "unresolved" }, "a side/dressing question for 'bleu cheese' must never offer a pizza as a candidate");
});

Deno.test("resolveItem (DEFECT 3, no regression): a genuine 'cheese pizza' order is completely unaffected by the excluded-term veto", () => {
  const result = resolveItem("a cheese pizza", REAL_VITOS_CHEESE_LEXICON, REAL_VITOS_EXCLUDED_LEXICON);
  assertEquals(result.kind, "ambiguous", "no size stated -> still an honest 3-way tie, exactly as before this fix");
  assertEquals(
    result.kind === "ambiguous" ? [...result.candidates].sort() : [],
    [REAL_VITOS_CHEESE_LARGE_ID, REAL_VITOS_CHEESE_MEDIUM_ID, REAL_VITOS_CHEESE_SMALL_ID].sort(),
  );
  const sized = resolveItem("a large cheese pizza", REAL_VITOS_CHEESE_LEXICON, REAL_VITOS_EXCLUDED_LEXICON);
  assertEquals(sized, { kind: "resolved", menu_item_id: REAL_VITOS_CHEESE_LARGE_ID }, "a stated size still resolves cleanly — the veto only fires when a longer EXCLUDED term also matches");
});
