/**
 * Negative-case unit tests — prove the validator FAILS LOUDLY when it should.
 *
 * Run: node --experimental-strip-types menu-pipeline/scripts/test-validate.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { validateRows, assertValid } = await import(join(ROOT, "core", "validate.ts"));
const { parseCanonicalCsv } = await import(join(ROOT, "core", "csv.ts"));
const { rowsToCsv } = await import(join(ROOT, "core", "serialize.ts"));
const { buildImportPlan } = await import(join(ROOT, "core", "import-plan.ts"));

let failed = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed++;
};

// 1. Unresolved prompt_for reference -> strict error.
{
  const rows = [
    { category: "Salads", name: "Greek", size: "", price: "9.99", description: "", prompt_for: "which dressing (ranch, italian)", upsell: "" },
    { category: "Salad Dressings", name: "Ranch", size: "", price: "0.00", description: "", prompt_for: "", upsell: "" },
  ];
  const v = validateRows(rows, { strictReferences: true });
  check("unresolved prompt_for option flagged (italian missing)", !v.ok && v.errors.some((e) => e.code === "PROMPT_UNRESOLVED"));
}

// 2. Unresolved +$ upsell add-on -> strict error.
{
  const rows = [
    { category: "Salads", name: "Greek", size: "", price: "9.99", description: "", prompt_for: "", upsell: "add a protein (steak +$8)" },
    { category: "Salad Protein Add-ons", name: "Chicken", size: "", price: "4.00", description: "", prompt_for: "", upsell: "" },
  ];
  const v = validateRows(rows, { strictReferences: true });
  check("unresolved +$ add-on flagged (steak missing)", !v.ok && v.errors.some((e) => e.code === "UPSELL_UNRESOLVED"));
}

// 3. Price format: stray symbol + single-decimal -> errors.
{
  const rows = [
    { category: "Pizza", name: "Cheese", size: "", price: "$9.99", description: "", prompt_for: "", upsell: "" },
    { category: "Pizza", name: "Plain", size: "", price: "9.9", description: "", prompt_for: "", upsell: "" },
  ];
  const v = validateRows(rows, {});
  check("stray currency symbol rejected", v.errors.some((e) => e.code === "PRICE_SYMBOL"));
  check("single-decimal price rejected", v.errors.some((e) => e.code === "PRICE_FORMAT"));
}

// 4. Duplicate rows -> error.
{
  const rows = [
    { category: "Pizza", name: "Cheese", size: "", price: "9.99", description: "", prompt_for: "", upsell: "" },
    { category: "Pizza", name: "Cheese", size: "", price: "9.99", description: "", prompt_for: "", upsell: "" },
  ];
  const v = validateRows(rows, {});
  check("duplicate row rejected", v.errors.some((e) => e.code === "DUPLICATE_ROW"));
}

// 5. assertValid throws loudly.
{
  let threw = false;
  try {
    assertValid({ ok: false, errors: [{ code: "X", message: "boom" }], warnings: [] }, "test");
  } catch (e) { threw = /FAILED/.test(e.message); }
  check("assertValid throws on failure", threw);
}

// 6. CSV round-trip is lossless (serialize -> parse -> identical rows).
{
  const rows = [
    { category: "Pizza", name: "Buffalo, Chicken", size: 'Large (16")', price: "22.99", description: "has \"quotes\" and, commas", prompt_for: "a; b", upsell: "x" },
  ];
  const csv = rowsToCsv(rows);
  const back = parseCanonicalCsv(csv);
  check("CSV round-trip preserves quotes/commas", JSON.stringify(back) === JSON.stringify(rows));
}

// 7. buildImportPlan throws on unresolved references.
{
  const rows = [
    { category: "Salads", name: "Greek", size: "", price: "9.99", description: "", prompt_for: "which dressing (ranch, italian)", upsell: "" },
    { category: "Salad Dressings", name: "Ranch", size: "", price: "0.00", description: "", prompt_for: "", upsell: "" },
  ];
  let threw = false;
  try { buildImportPlan(rows, "Test"); } catch (e) { threw = /referential integrity/i.test(e.message); }
  check("buildImportPlan fails loudly on unresolved ref", threw);
}

console.log(failed === 0 ? "\nALL NEGATIVE TESTS PASS ✅" : `\n${failed} TEST(S) FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
