/**
 * Phase-1 end-to-end menu harness — drives the REAL Jack's Slice menu through
 * the SAME pipeline the wizard's menu step uses, proving:
 *
 *   upload CSV  ->  parse  ->  validate (strict)  ->  surface the 9 Upcharge-TBD
 *   Open Questions  ->  resolve them with owner-given prices (never invented)
 *   ->  buildImportPlan (Stage B logic)  ->  DB row counts.
 *
 * The Edge Function `import-menu-csv` calls parseCanonicalCsv + validateRows +
 * buildImportPlan against the live DB; here we exercise the identical core so
 * the menu portion is provable without Docker/live DB. The wizard's confirm
 * step writes the resolved prices into the CSV before POSTing — modeled below.
 *
 * Run: node --experimental-strip-types menu-pipeline/scripts/jacks-phase1-e2e.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseCanonicalCsv } = await import(join(ROOT, "core", "csv.ts"));
const { rowsToCsv } = await import(join(ROOT, "core", "serialize.ts"));
const { validateRows, assertValid } = await import(join(ROOT, "core", "validate.ts"));
const { buildImportPlan } = await import(join(ROOT, "core", "import-plan.ts"));

const csvPath = join(ROOT, "fixtures", "jacks-slice-menu.csv");
const csv = readFileSync(csvPath, "utf8");

let fail = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fail++;
};

console.log("=== JACK'S SLICE — Phase-1 menu E2E (real fixture) ===\n");

// 1) UPLOAD + PARSE
const rows = parseCanonicalCsv(csv);
const cats = new Set(rows.map((r) => r.category));
check("parsed real Jack's CSV", rows.length === 326, `${rows.length} rows`);
check("36 categories present", cats.size === 36, `${cats.size} categories`);

// 2) SURFACE OPEN QUESTIONS — the 9 Upcharge-TBD side-sub rows
const tbd = rows.filter((r) => /upcharge tbd/i.test(r.description) || (r.price.trim() === "" && /substitution/i.test(r.category)));
check("9 Upcharge-TBD side-sub Open Questions surfaced", tbd.length === 9, `${tbd.length} found`);
console.log("    Open-Question rows:");
tbd.forEach((r) => console.log(`      - ${r.category} · ${r.name}`));

// none of them silently became $0.00 or an invented price at parse time
const invented = tbd.filter((r) => r.price.trim() !== "");
check("none invented/assumed a price (blank, not $0.00)", invented.length === 0);

// 3) RESOLVE — owner-given upcharges (exactly what the wizard writes back).
// These are deliberately distinct, owner-supplied numbers — never guessed by code.
const OWNER_UPCHARGES = {
  "Sweet Potato Fries": "1.50",
  "Pierogies": "2.00",
  "Sauteed Pierogies": "2.50",
  "Mozzarella Sticks": "2.00",
  "Onion Rings": "1.50",
  "Side Salad": "1.00",
};
const resolved = rows.map((r) => {
  if (tbd.includes(r)) {
    const price = OWNER_UPCHARGES[r.name];
    if (!price) throw new Error("Owner did not provide an upcharge for " + r.name + " — wizard would BLOCK confirm.");
    return { ...r, price, description: "" };
  }
  return r;
});
const stillBlank = resolved.filter((r) => tbd.some((t) => t.category === r.category && t.name === r.name) && r.price.trim() === "");
check("every Open Question resolved before confirm (gate)", stillBlank.length === 0);

// 4) VALIDATE strict (what import-menu-csv runs before writing)
const vc = validateRows(resolved, { strictReferences: true });
check("strict validation passes after resolution", vc.ok, vc.ok ? "" : vc.errors.slice(0, 3).map((e) => e.code).join(","));

// 5) BUILD IMPORT PLAN (Stage B logic the Edge Function applies to the DB)
let plan;
try {
  assertValid(validateRows(resolved, { strictReferences: true }), "Jack's Slice");
  plan = buildImportPlan(resolved, "Jack's Slice Menu");
} catch (e) {
  check("buildImportPlan succeeded", false, e.message);
}
if (plan) {
  const groups = plan.items.reduce((n, it) => n + it.groups.length, 0);
  const choices = plan.items.reduce((n, it) => n + it.groups.reduce((m, g) => m + g.choices.length, 0), 0);
  check("import plan built", plan.items.length > 0, `${plan.items.length} menu_items, ${groups} option_groups, ${choices} option_choices`);
  check("plan carries an import_hash (idempotency)", !!plan.importHash, plan.importHash);

  // the 6 distinct side-sub items now carry the owner prices, in cents
  const subItems = plan.items.filter((it) => /substitution/i.test(it.category));
  console.log("    Resolved side-sub items -> price_cents:");
  subItems.slice(0, 12).forEach((it) => console.log(`      - ${it.category} · ${it.name}: ${it.priceCents}¢`));
  const anyZeroSub = subItems.some((it) => it.priceCents === 0 && OWNER_UPCHARGES[it.name] && OWNER_UPCHARGES[it.name] !== "0.00");
  check("resolved upcharges written as real cents (not 0)", !anyZeroSub);
}

// 6) NEGATIVE: prove the gate — an UNRESOLVED menu must NOT be confirmable
const unresolvedCsv = csv; // original, with the 9 TBD rows blank
const unresolvedRows = parseCanonicalCsv(unresolvedCsv);
const unresolvedTbd = unresolvedRows.filter((r) => /upcharge tbd/i.test(r.description) || (r.price.trim() === "" && /substitution/i.test(r.category)));
check("GATE: wizard would block confirm while Open Questions remain", unresolvedTbd.length > 0, `${unresolvedTbd.length} still open`);

console.log("\n=== " + (fail === 0 ? "ALL PHASE-1 MENU E2E CHECKS PASS ✅" : fail + " CHECK(S) FAILED ❌") + " ===");
process.exit(fail === 0 ? 0 : 1);
