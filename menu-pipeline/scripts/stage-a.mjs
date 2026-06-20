/**
 * Stage A CLI — menu source -> canonical CSV + Open Questions.
 *
 * Usage:
 *   node --experimental-strip-types menu-pipeline/scripts/stage-a.mjs \
 *     --in <path> --kind <pdf|image|html|text|model> --name "<menu name>" \
 *     [--out-dir menu-pipeline/out] [--strict]
 *
 * For pdf/image/html/text this calls Claude (needs ANTHROPIC_API_KEY in env).
 * For `model` it reads a MenuModel JSON and runs the deterministic tail only.
 *
 * Writes <name>.csv and <name>.open-questions.txt; prints validation summary.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const { runStageA, modelFrontEnd } = await import(join(ROOT, "core", "parse.ts"));
const { makeClaudeFrontEnd } = await import(join(ROOT, "frontends", "claude.ts"));

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (flag) => process.argv.includes(flag);

const inPath = arg("--in");
if (!inPath) { console.error("--in <path> is required"); process.exit(2); }
const kind = arg("--kind", extname(inPath) === ".pdf" ? "pdf" : "model");
const name = arg("--name", basename(inPath).replace(/\.[^.]+$/, ""));
const outDir = arg("--out-dir", join(ROOT, "out"));
const strict = has("--strict");

mkdirSync(outDir, { recursive: true });

let source;
if (kind === "model") {
  source = { kind: "model", model: JSON.parse(readFileSync(inPath, "utf8")) };
} else if (kind === "pdf" || kind === "image") {
  source = { kind, base64: readFileSync(inPath).toString("base64"), menuName: name };
  if (kind === "image") source.mediaType = `image/${extname(inPath).slice(1) || "png"}`;
} else if (kind === "html") {
  source = { kind: "html", html: readFileSync(inPath, "utf8"), menuName: name };
} else if (kind === "text") {
  source = { kind: "text", text: readFileSync(inPath, "utf8"), menuName: name };
} else {
  console.error(`unknown --kind "${kind}"`); process.exit(2);
}

const frontEnds = [modelFrontEnd, makeClaudeFrontEnd({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" })];
const out = await runStageA(source, { frontEnds, strictReferences: strict });

const csvPath = join(outDir, `${name}.csv`);
const oqPath = join(outDir, `${name}.open-questions.txt`);
writeFileSync(csvPath, out.csv);
writeFileSync(oqPath, out.openQuestions);

console.log(`rows:        ${out.rows.length}`);
console.log(`validation:  ${out.validation.ok ? "OK" : out.validation.errors.length + " error(s)"}`);
for (const e of out.validation.errors) console.log(`  [${e.code}] ${e.message}`);
console.log(`warnings:    ${out.validation.warnings.length}`);
for (const w of out.validation.warnings) console.log(`  [${w.code}] ${w.message}`);
console.log(`CSV:         ${csvPath}`);
console.log(`OpenQs:      ${oqPath}`);
process.exit(strict && !out.validation.ok ? 1 : 0);
