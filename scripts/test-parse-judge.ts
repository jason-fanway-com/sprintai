import { parseJudgeJson } from "../supabase/functions/_shared/judge-rubric.ts";

const cases: Array<{ label: string; input: string; expectObj: boolean }> = [
  {
    label: "fenced ```json",
    input: '```json\n{"verdict":"flagged","flags":[]}\n```',
    expectObj: true,
  },
  {
    label: "prose-then-JSON",
    input: 'Here is my verdict: {"verdict":"clean","flags":[]}',
    expectObj: true,
  },
  {
    label: "JSON-then-trailing-text",
    input: '{"verdict":"flagged","flags":[{"check":"cold_tone","severity":"minor"}]} hope that helps',
    expectObj: true,
  },
  {
    label: "trailing comma",
    input: '{"verdict":"clean","flags":[],}',
    expectObj: true,
  },
  {
    label: "already-clean",
    input: '{"verdict":"clean","flags":[]}',
    expectObj: true,
  },
  {
    label: "unparseable garbage",
    input: "completely bogus text with no json",
    expectObj: false,
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const result = parseJudgeJson(c.input);
  const isObj = result !== null && typeof result === "object" && !Array.isArray(result);
  const ok = isObj === c.expectObj;
  if (ok) {
    console.log(`PASS: ${c.label} → ${isObj ? "object" : "null"} (expected ${c.expectObj ? "object" : "null"})`);
    passed++;
  } else {
    console.log(`FAIL: ${c.label} → ${isObj ? "object" : "null"} (expected ${c.expectObj ? "object" : "null"})`);
    console.log(`  result:`, JSON.stringify(result));
    failed++;
  }
}

// Bonus: verify extracted content is correct for a couple cases
const fenced = parseJudgeJson('```json\n{"verdict":"flagged","flags":[{"check":"cold_tone"}]}\n```') as { verdict: string } | null;
if (fenced?.verdict === "flagged") {
  console.log(`PASS: fenced extraction correct → verdict=${fenced.verdict}`);
  passed++;
} else {
  console.log(`FAIL: fenced extraction wrong →`, JSON.stringify(fenced));
  failed++;
}

const prose = parseJudgeJson('Here is my verdict: {"verdict":"clean","flags":[]}') as { verdict: string } | null;
if (prose?.verdict === "clean") {
  console.log(`PASS: prose extraction correct → verdict=${prose.verdict}`);
  passed++;
} else {
  console.log(`FAIL: prose extraction wrong →`, JSON.stringify(prose));
  failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
Deno.exit(failed > 0 ? 1 : 0);