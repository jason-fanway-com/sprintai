/**
 * Focused unit test for extractUpsellAddons (Stage-A parser) and the tightened
 * resolves() word-token matching, covering the "or"/"and" add-on split bug and
 * the previously-accidental "or steak" substring match.
 *
 * Run: node --experimental-strip-types menu-pipeline/scripts/extract-upsell-addons.test.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractUpsellAddons } = await import(join(ROOT, "core", "validate.ts"));
// validateRows exercises resolves() end-to-end via real rows.
const { validateRows } = await import(join(ROOT, "core", "validate.ts"));

let fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  — got ${g}, want ${w}`}`);
  if (!ok) fail++;
};
const check = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fail++;
};

console.log("=== extractUpsellAddons — or/and split + clean tokens ===\n");

// 1) the load-bearing real-menu case
eq('"shrimp +$6 or salmon +$8"',
  extractUpsellAddons("add a protein (shrimp +$6 or salmon +$8); suggest a drink"),
  ["shrimp", "salmon"]);

// 2) multiple "or"s
eq('"x +$6 or y +$8 or z +$9"',
  extractUpsellAddons("x +$6 or y +$8 or z +$9"),
  ["x", "y", "z"]);

// 3) "and" connector
eq('"a +$1 and b +$2"',
  extractUpsellAddons("a +$1 and b +$2"),
  ["a", "b"]);

// 4) comma + or mix
eq('"chicken +$4, shrimp +$6 or salmon +$8"',
  extractUpsellAddons("add a protein (chicken +$4, shrimp +$6 or salmon +$8)"),
  ["chicken", "shrimp", "salmon"]);

// 5) plain comma list (regression — must still work)
eq('"chicken +$4, shrimp +$6, salmon +$8, steak +$8"',
  extractUpsellAddons("add a protein (chicken +$4, shrimp +$6, salmon +$8, steak +$8)"),
  ["chicken", "shrimp", "salmon", "steak"]);

// 6) case-insensitive connectors
eq('"shrimp +$6 OR steak +$8" (uppercase OR)',
  extractUpsellAddons("shrimp +$6 OR steak +$8"),
  ["shrimp", "steak"]);

// 7) single add-on (regression). NOTE: the pre-existing regex greedily captures
// the leading verb ("add shrimp") for a bare, non-list add-on; stripJoinWords only
// peels connectors ("or"/"and")/punctuation, NOT generic verbs, so this stays
// "add shrimp" by design. It still resolves because the known option "shrimp" is a
// whole-word subset of {add, shrimp}. Asserting current (unchanged) behavior.
eq('"add shrimp +$6" (verb retained, pre-existing)',
  extractUpsellAddons("add extra dressing; add shrimp +$6; suggest a drink"),
  ["add shrimp"]);

// 8) the previously-accidental "or steak" must NOT appear as a token
const orSteak = extractUpsellAddons("shrimp +$6 or steak +$8");
check('"shrimp +$6 or steak +$8" yields clean ["shrimp","steak"] (no "or steak")',
  JSON.stringify(orSteak) === JSON.stringify(["shrimp", "steak"]), JSON.stringify(orSteak));

// 9) INTERIOR-"or" with an UNPRICED leading option: only the priced option is
// captured; the unpriced one must NOT inherit a price (golden rule: never invent).
eq('"shrimp or salmon +$8" (leading option unpriced) -> ["salmon"]',
  extractUpsellAddons("shrimp or salmon +$8"),
  ["salmon"]);

// 10) trailing option unpriced: only the priced option is captured, no invented price.
eq('"shrimp +$6 or salmon" (trailing option unpriced) -> ["shrimp"]',
  extractUpsellAddons("shrimp +$6 or salmon"),
  ["shrimp"]);

// 11) chained "or" (3 priced options).
eq('"shrimp +$6 or salmon +$8 or steak +$10" -> [shrimp,salmon,steak]',
  extractUpsellAddons("shrimp +$6 or salmon +$8 or steak +$10"),
  ["shrimp", "salmon", "steak"]);

// 12) MIXED comma + or in one list.
eq('"chicken +$4, shrimp +$6 or salmon +$8, steak +$8" -> [chicken,shrimp,salmon,steak]',
  extractUpsellAddons("chicken +$4, shrimp +$6 or salmon +$8, steak +$8"),
  ["chicken", "shrimp", "salmon", "steak"]);

// 13) "and" INSIDE a real option name must be preserved (NOT treated as a
// price-list separator). Splitting on "and" would corrupt "mac and cheese".
eq('"mac and cheese +$3" keeps the real name (and-in-name preserved)',
  extractUpsellAddons("mac and cheese +$3"),
  ["mac and cheese"]);
eq('"surf and turf +$12" keeps the real name',
  extractUpsellAddons("surf and turf +$12"),
  ["surf and turf"]);

console.log("\n=== resolves() — word-token matching, not naive substring ===\n");

// Build a tiny menu: one item that upsells "or steak" garbage vs a real
// "Black Diamond Steak" option, to prove resolves() rejects the connector token
// but accepts the clean short-form "steak".
const blockRows = [
  { category: "Salad Protein Add-ons", name: "Shrimp", size: "", price: "6.00", prompt_for: "", upsell: "", description: "" },
  { category: "Salad Protein Add-ons", name: "Black Diamond Steak", size: "", price: "8.00", prompt_for: "", upsell: "", description: "" },
];

// (a) clean tokens from the FIXED parser resolve fine -> strict validation OK
const goodItem = { category: "Salads", name: "Grilled Chicken", size: "", price: "12.95", prompt_for: "which dressing", upsell: "add a protein (shrimp +$6 or steak +$8); suggest a drink", description: "Tomatoes" };
const goodRes = validateRows([goodItem, ...blockRows], { strictReferences: true });
check('clean "steak" short-form resolves to "Black Diamond Steak" (strict OK)', goodRes.ok,
  goodRes.ok ? "" : goodRes.errors.map((e) => e.code).join(","));

// (b) prove the OLD bug is gone: a token of literally "or steak" must NOT resolve.
// We can't feed the parser garbage (it cleans it), so assert resolves() directly
// by importing it is not exported; instead emulate via a prompt_for that the
// extractor would pass through verbatim would be unfair. Instead, confirm that a
// bogus connector-bearing option name does not validate when there's no clean
// option for it: craft an item whose upsell, if naively substring-matched, would
// have falsely passed. Using extractUpsellAddons we already proved tokens are
// clean; here we assert that an unrelated token ("steakhouse") that merely
// CONTAINS a known word does NOT resolve under word-set rules.
const bogusItem = { category: "Salads", name: "Bogus", size: "", price: "12.95", prompt_for: "", upsell: "add steakhouse +$8", description: "x" };
const bogusRes = validateRows([bogusItem, ...blockRows], { strictReferences: true });
check('"steakhouse" does NOT resolve to "Black Diamond Steak" (whole-word, not substring)',
  !bogusRes.ok && bogusRes.errors.some((e) => e.code === "UPSELL_UNRESOLVED"),
  bogusRes.ok ? "unexpectedly OK" : bogusRes.errors.map((e) => e.code).join(","));

console.log("\n=== no-price golden rule: blank + flag, never invented ===\n");

// An add-on option with an unknown upcharge (priceDelta === null) must serialize
// to a BLANK price (not "0.00") and be flagged "Upcharge TBD" in the row, so the
// Open-Question gate catches it. Proves we never invent a price for an unpriced
// "or"-list option.
const { buildCanonicalRows } = await import(join(ROOT, "core", "serialize.ts"));
const { formatPrice } = await import(join(ROOT, "core", "serialize.ts"));
check('formatPrice(null) is blank (not "0.00")', formatPrice(null) === "", JSON.stringify(formatPrice(null)));
check('formatPrice(undefined) is blank', formatPrice(undefined) === "", JSON.stringify(formatPrice(undefined)));
check('formatPrice(6) -> "6.00"', formatPrice(6) === "6.00", formatPrice(6));

const modelWithTbd = {
  menuName: "NoPrice Test",
  categoryOrder: ["Salad Protein Add-ons"],
  items: [],
  modifierBlocks: [
    { label: "Salad Protein Add-ons", options: [
      { name: "Shrimp", priceDelta: 6 },
      { name: "Salmon", priceDelta: null }, // unknown upcharge -> must stay blank + flagged
    ] },
  ],
  openQuestions: [],
};
const tbdRows = buildCanonicalRows(modelWithTbd);
const salmonRow = tbdRows.find((r) => r.name === "Salmon");
const shrimpRow = tbdRows.find((r) => r.name === "Shrimp");
check('unpriced "Salmon" serializes BLANK price (never invented / never 0.00)',
  !!salmonRow && salmonRow.price === "", salmonRow ? JSON.stringify(salmonRow.price) : "missing");
check('unpriced "Salmon" flagged "Upcharge TBD"',
  !!salmonRow && salmonRow.description === "Upcharge TBD", salmonRow ? salmonRow.description : "missing");
check('priced "Shrimp" serializes "6.00" (real price preserved)',
  !!shrimpRow && shrimpRow.price === "6.00", shrimpRow ? shrimpRow.price : "missing");

console.log("\n=== " + (fail === 0 ? "ALL UNIT TESTS PASS ✅" : fail + " UNIT TEST(S) FAILED ❌") + " ===");
process.exit(fail === 0 ? 0 : 1);
