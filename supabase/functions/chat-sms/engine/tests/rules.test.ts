// rules.test.ts — the structural rules from the rebuild plan (§5.0), enforced by
// machine. A failure here blocks merge; it is not a warning.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const DIR = new URL("../", import.meta.url).pathname;
const CORE = ["form.ts", "crossread.ts", "resolve.ts", "price.ts", "next.ts", "render.ts", "turn.ts", "normalize.ts", "menu.ts", "vocab.ts", "interpret.ts", "templates.ts"];
const REGEX_ALLOWED = new Set(["normalize.ts", "vocab.ts", "menu.ts", "templates.ts"]);
const LINE_BUDGET = 2000;

async function read(f: string): Promise<string> {
  try { return await Deno.readTextFile(DIR + f); } catch { return ""; }
}
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}
function countRegexLiterals(src: string): number {
  const code = stripCommentsAndStrings(src);
  const re = /(^|[=(,:!&|?{;\[\s])\/(?![\/*])(?:\\.|\[[^\]]*\]|[^\/\n\\])+\/[gimsuy]*/gm;
  return (code.match(re) ?? []).length;
}

Deno.test("rule: no regular expressions over text outside normalize/vocab/menu/templates", async () => {
  const offenders: string[] = [];
  for (const f of CORE) {
    if (REGEX_ALLOWED.has(f)) continue;
    const n = countRegexLiterals(await read(f));
    if (n > 0) offenders.push(`${f}: ${n}`);
  }
  assertEquals(offenders, []);
});

Deno.test("rule: the engine imports nothing from the old engine or index.ts", async () => {
  const banned = ["turn-engine", "pending-disambiguation", "index.ts", "turn-reconciler", "phrase-split", "dialogue-signals", "intent-router", "guard", "propose.ts", "ask-plan-engine"];
  const offenders: string[] = [];
  for (const f of CORE) {
    const src = await read(f);
    for (const line of src.split("\n")) {
      if (!line.trim().startsWith("import")) continue;
      for (const b of banned) if (line.includes(b)) offenders.push(`${f}: ${line.trim()}`);
      if (line.includes("from \"../") && !line.includes("../pricing.ts")) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("rule: only interpret.ts talks to a model", async () => {
  const offenders: string[] = [];
  for (const f of CORE) {
    if (f === "interpret.ts") continue;
    const code = stripCommentsAndStrings(await read(f));
    if (/\bfetch\s*\(|fetchImpl|api\.anthropic|openrouter/.test(code)) offenders.push(f);
  }
  assertEquals(offenders, []);
});

Deno.test("rule: interpret.ts never sees money", async () => {
  const src = await read("interpret.ts");
  if (!src) return;
  const code = src.toLowerCase();
  for (const bad of ["cents", "price", "$", "total", "subtotal"]) {
    assert(!code.includes(bad), `interpret.ts mentions "${bad}"`);
  }
});

Deno.test("rule: customer-facing sentences live only in templates.ts", async () => {
  const offenders: string[] = [];
  const sentence = /["`][^"`\n]*\b[a-z]+ [a-z]+\b[^"`\n]*[?.!]["`]/g;
  for (const f of CORE) {
    if (f === "templates.ts" || f === "interpret.ts") continue;
    const src = (await read(f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const hits = src.match(sentence) ?? [];
    for (const h of hits) offenders.push(`${f}: ${h}`);
  }
  assertEquals(offenders, []);
});

Deno.test(`rule: engine core stays under ${LINE_BUDGET} lines`, async () => {
  let total = 0;
  const per: string[] = [];
  for (const f of CORE) {
    if (f === "templates.ts") continue;
    const n = (await read(f)).split("\n").length;
    total += n; per.push(`${f}=${n}`);
  }
  assert(total <= LINE_BUDGET, `engine core is ${total} lines (${per.join(", ")}); budget ${LINE_BUDGET}. Do not raise the budget; simplify.`);
});
