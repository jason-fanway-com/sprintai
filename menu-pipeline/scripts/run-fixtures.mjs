/**
 * Fixture + determinism harness for the menu pipeline.
 *
 * Run with:  node --experimental-strip-types menu-pipeline/scripts/run-fixtures.mjs
 *
 * For each *.model.json fixture:
 *   1. Stage A run #1  -> CSV + Open Questions + validation
 *   2. Stage A run #2  -> CSV (must be BYTE-IDENTICAL to run #1)  [determinism proof]
 *   3. Validate rows   -> referential integrity / price format / dedupe
 *   4. Build Stage B import plan from the CSV (round-trips through the CSV parser)
 *   5. Re-build the plan from a re-parse and confirm identical importHash (idempotency proof)
 *
 * Writes each fixture's CSV + Open Questions to menu-pipeline/out/<name>.{csv,open-questions.txt}
 * and prints a PASS/FAIL summary. Exits non-zero on any failure.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "fixtures");
const OUT = join(ROOT, "out");

const { stageAFromModel } = await import(join(ROOT, "core", "parse.ts"));
const { validateRows } = await import(join(ROOT, "core", "validate.ts"));
const { parseCanonicalCsv } = await import(join(ROOT, "core", "csv.ts"));
const { buildImportPlan } = await import(join(ROOT, "core", "import-plan.ts"));

mkdirSync(OUT, { recursive: true });

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".model.json")).sort();
let failures = 0;
const summary = [];

for (const file of files) {
  const name = file.replace(/\.model\.json$/, "");
  const model = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));

  // 1 + 2: determinism — two independent runs must be byte-identical.
  const a1 = stageAFromModel(model, { strictReferences: false });
  const a2 = stageAFromModel(model, { strictReferences: false });
  const deterministic = a1.csv === a2.csv && a1.openQuestions === a2.openQuestions;

  // 3: validation (strict references — fixtures are referentially complete).
  const v = validateRows(a1.rows, { strictReferences: true });

  // 4 + 5: Stage B plan round-trips through the CSV + is idempotent (stable hash).
  let planOk = false, hashStable = false, planErr = "";
  try {
    const reparsed = parseCanonicalCsv(a1.csv);
    const plan1 = buildImportPlan(reparsed, model.menuName);
    const plan2 = buildImportPlan(parseCanonicalCsv(a1.csv), model.menuName);
    planOk = plan1.items.length > 0;
    hashStable = plan1.importHash === plan2.importHash;
  } catch (e) {
    planErr = e.message;
  }

  writeFileSync(join(OUT, `${name}.csv`), a1.csv);
  writeFileSync(join(OUT, `${name}.open-questions.txt`), a1.openQuestions);

  const ok = deterministic && v.ok && planOk && hashStable;
  if (!ok) failures++;
  summary.push({
    name,
    rows: a1.rows.length,
    deterministic,
    validation: v.ok ? "ok" : `${v.errors.length} err`,
    warnings: v.warnings.length,
    plan: planOk ? "ok" : "FAIL",
    hashStable,
    importHash: planErr ? `ERR: ${planErr}` : undefined,
  });

  if (!v.ok) {
    console.error(`\n[${name}] validation errors:`);
    for (const e of v.errors) console.error(`  [${e.code}] ${e.message}`);
  }
  if (planErr) console.error(`\n[${name}] plan error: ${planErr}`);
}

console.log("\n=== FIXTURE RESULTS ===");
console.table(summary);
console.log(`\nCSV + Open Questions written to: ${OUT}`);
console.log(failures === 0 ? "ALL FIXTURES PASS ✅" : `${failures} FIXTURE(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
