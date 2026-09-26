// rules.test.ts — the structural rules from the rebuild plan (§5.0), enforced by
// machine. A failure here blocks merge; it is not a warning.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const DIR = new URL("../", import.meta.url).pathname;
const PURE = ["form.ts", "crossread.ts", "resolve.ts", "price.ts", "next.ts", "render.ts", "turn.ts", "normalize.ts", "menu.ts", "vocab.ts"];
// project.ts writes the legacy cart_json shape for tickets and dashboards: persistence, not decisions
const ADAPTERS = ["interpret.ts", "judge.ts", "voice.ts", "runner.ts", "address.ts", "project.ts"];
const CORE = [...PURE, ...ADAPTERS, "templates.ts"];
const REGEX_ALLOWED = new Set(["normalize.ts", "vocab.ts", "menu.ts", "templates.ts"]);
const FETCH_ALLOWED = new Set(["interpret.ts", "judge.ts", "voice.ts", "address.ts"]);
const ADAPTER_IMPORTS_ALLOWED = ["../../_shared/error-log.ts", "https://esm.sh/@supabase/supabase-js", "npm:@anthropic-ai/sdk"];
const PURE_BUDGET = 2000;
const ADAPTER_BUDGET = 800;

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
  let n = 0;
  for (const m of code.matchAll(re)) {
    // a slash after an identifier, number or closing bracket is division, not a literal
    const before = code.slice(0, m.index! + m[1].length).replace(/\s+$/, "");
    if (/[\w)\]]$/.test(before)) continue;
    n++;
  }
  return n;
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
      const external = line.includes("from \"../") || line.includes("from \"http") || line.includes("from \"npm:");
      const allowedForAdapter = ADAPTERS.includes(f) && ADAPTER_IMPORTS_ALLOWED.some((a) => line.includes(a));
      if (external && !allowedForAdapter) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("rule: only interpret.ts, judge.ts and voice.ts talk to a model; only address.ts talks to the geocoder", async () => {
  const offenders: string[] = [];
  for (const f of CORE) {
    const code = stripCommentsAndStrings(await read(f));
    if (!FETCH_ALLOWED.has(f) && /\bfetch\s*\(|fetchImpl/.test(code)) offenders.push(`${f}: fetch`);
    if (f !== "interpret.ts" && f !== "judge.ts" && f !== "voice.ts" && /Anthropic|openrouter/.test(code)) offenders.push(`${f}: model client`);
  }
  assertEquals(offenders, []);
});

Deno.test("rule: the model adapters never see money", async () => {
  for (const f of ["interpret.ts", "judge.ts"]) {
    const src = await read(f);
    if (!src) continue;
    const code = src.toLowerCase();
    for (const bad of ["cents", "price", "subtotal", "total"]) assert(!code.includes(bad), `${f} mentions "${bad}"`);
    assert(!/\$\s?\d/.test(code), `${f} contains a dollar amount`);
  }
});
Deno.test("rule: the judge only answers questions; every threshold lives in JUDGE", async () => {
  const judge = stripCommentsAndStrings(await read("judge.ts"));
  assert(!/add_line|remove_line|change_line|lines\.push|\.status\s*=/.test(judge), "judge.ts must not touch the form");
  const core = stripCommentsAndStrings(await read("turn.ts"));
  assert(/export const JUDGE = \{/.test(core), "JUDGE threshold table missing from turn.ts");
  assert(!/judgments\?\.[a-z_]+\??\.\w+\s*[<>]=?\s*0\.\d/.test(core), "a judge threshold is hard-coded outside JUDGE");
});

Deno.test("rule: customer-facing sentences live only in templates.ts", async () => {
  const offenders: string[] = [];
  const sentence = /["`][^"`\n]*\b[a-z]+ [a-z]+\b[^"`\n]*[?.!]["`]/g;
  for (const f of CORE) {
    if (f === "templates.ts" || f === "interpret.ts" || f === "judge.ts" || f === "voice.ts") continue; // prompts to a model, not to a customer
    const src = (await read(f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const hits = src.match(sentence) ?? [];
    for (const h of hits) offenders.push(`${f}: ${h}`);
  }
  assertEquals(offenders, []);
});

async function lineTotal(files: string[]): Promise<{ total: number; per: string[] }> {
  let total = 0; const per: string[] = [];
  for (const f of files) { const n = (await read(f)).split("\n").length; total += n; per.push(`${f}=${n}`); }
  return { total, per };
}
Deno.test(`rule: pure engine core stays under ${PURE_BUDGET} lines`, async () => {
  const { total, per } = await lineTotal(PURE);
  assert(total <= PURE_BUDGET, `pure core is ${total} lines (${per.join(", ")}); budget ${PURE_BUDGET}. Do not raise the budget; simplify.`);
});
Deno.test(`rule: adapters stay under ${ADAPTER_BUDGET} lines`, async () => {
  const { total, per } = await lineTotal(ADAPTERS);
  assert(total <= ADAPTER_BUDGET, `adapters are ${total} lines (${per.join(", ")}); budget ${ADAPTER_BUDGET}.`);
});

Deno.test("rule: templates.ts contains no character outside GSM-7 (each one doubles the SMS segments)", async () => {
  const src = await read("templates.ts");
  const bad = [...new Set([...src].filter((c) => c.charCodeAt(0) > 127 && !"£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€".includes(c)))];
  assertEquals(bad, []);
});

