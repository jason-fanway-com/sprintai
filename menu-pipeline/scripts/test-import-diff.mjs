/**
 * Stage B diff/idempotency unit tests (pure, no DB).
 * Run: node --experimental-strip-types menu-pipeline/scripts/test-import-diff.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { stageAFromModel } = await import(join(ROOT, "core", "parse.ts"));
const { parseCanonicalCsv } = await import(join(ROOT, "core", "csv.ts"));
const { buildImportPlan, diffItems } = await import(join(ROOT, "core", "import-plan.ts"));

let failed = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failed++; };

const model = JSON.parse(readFileSync(join(ROOT, "fixtures", "pizza-shop.model.json"), "utf8"));
const csv = stageAFromModel(model, {}).csv;
const rows = parseCanonicalCsv(csv);
const plan = buildImportPlan(rows, "Pizza Shop");

// 1. Plan is non-empty and item count matches the CSV item rows.
check("plan has items", plan.items.length > 0);

// 2. import_hash is stable across identical input (idempotency / no-op skip).
const plan2 = buildImportPlan(parseCanonicalCsv(csv), "Pizza Shop");
check("import_hash stable for identical CSV (enables no-op skip)", plan.importHash === plan2.importHash);

// 3. import_hash CHANGES when content changes.
const changed = csv.replace("17.99", "18.99");
const planChanged = buildImportPlan(parseCanonicalCsv(changed), "Pizza Shop");
check("import_hash changes when a price changes", plan.importHash !== planChanged.importHash);

// 4. First import: all items are inserts (no existing rows).
const firstDiff = diffItems(plan.items, []);
check("first import = all inserts", firstDiff.toInsert.length === plan.items.length && firstDiff.toUpdate.length === 0 && firstDiff.toDeactivate.length === 0);

// 5. Re-import same plan against existing rows = all updates, zero inserts/deactivations.
const existing = plan.items.map((d, i) => ({ id: `id-${i}`, importKey: d.importKey, ownerEdited: false }));
const reDiff = diffItems(plan.items, existing);
check("re-import = all updates, no inserts, no deactivations", reDiff.toInsert.length === 0 && reDiff.toUpdate.length === plan.items.length && reDiff.toDeactivate.length === 0);

// 6. Owner-edited rows are flagged to be SKIPPED (preserved), not overwritten.
const existingOwnerEdited = plan.items.map((d, i) => ({ id: `id-${i}`, importKey: d.importKey, ownerEdited: i === 0 }));
const ownerDiff = diffItems(plan.items, existingOwnerEdited);
check("owner-edited row marked skippedOwnerEdited", ownerDiff.toUpdate.some((u) => u.skippedOwnerEdited));

// 7. Item removed from new menu => DEACTIVATE (never appears as a hard delete in the plan).
const fewer = plan.items.slice(0, plan.items.length - 1);
const removeDiff = diffItems(fewer, existing);
check("removed item is deactivated (not deleted)", removeDiff.toDeactivate.length === 1);

console.log(failed === 0 ? "\nALL IMPORT-DIFF TESTS PASS ✅" : `\n${failed} TEST(S) FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
