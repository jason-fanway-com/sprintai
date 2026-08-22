#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * run.ts — CLI entrypoint for the shop conversation test suite engine.
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read scripts/test-suite/run.ts <shop_id> [--limit N] [--dry-run]
 *
 * --dry-run: generate + print cases, NO bot calls, NO LLM cost, NO persist.
 * --limit N: run at most N cases (default: run all generated cases).
 *
 * Secrets: sourced from environment (see .env or inline). Required:
 *   SPRINTAI_CHAT_SUPABASE_URL
 *   SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (for judge LLM, routed through OpenRouter)
 */

import { generateCases } from "./generator.ts";
import { runCase } from "./runner.ts";
import { judgeCase } from "./judge.ts";
import { buildScorecard, formatScorecard, type ScoredCase } from "./scorecard.ts";
import { persistResults } from "./persist.ts";
import { generateRootCauseFix } from "./fix.ts";

// ── Config from env ────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Chat function URL for web-chat-test path.
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SPRINTAI_CHAT_SUPABASE_URL or SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = Deno.args;
if (args.length === 0 || args.includes("--help")) {
  console.log("Usage: deno run --allow-net --allow-env --allow-read scripts/test-suite/run.ts <shop_id> [--limit N] [--dry-run] [--cases id1,id2,...]");
  console.log("  --dry-run    Generate + print cases, NO bot calls, NO LLM cost.");
  console.log("  --limit N    Run at most N cases.");
  console.log("  --cases CSV  Run only the listed case ids (comma-separated).");
  Deno.exit(0);
}

const shopId = args[0];
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && limitIdx + 1 < args.length ? parseInt(args[limitIdx + 1], 10) : null;
const casesIdx = args.indexOf("--cases");
const casesFilter = casesIdx >= 0 && casesIdx + 1 < args.length
  ? new Set(args[casesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// ── Generate cases ─────────────────────────────────────────────────────────

console.log(`\nGenerating test cases for shop ${shopId}...`);
const genResult = await generateCases({
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  shopId,
});

console.log(
  `Shop: ${genResult.shop.name} (tenant: ${genResult.shop.tenant_id}) | ` +
  `Menu items: ${genResult.menuItemCount} | ` +
  `Cases: ${genResult.derivedCount} menu-derived + ${genResult.libraryCount} library + ` +
  `${genResult.conversationalCount} conversational = ${genResult.cases.length} total`,
);

console.log(`\n═══ TEST CASES ═══`);
for (const c of genResult.cases) {
  const crit = c.criticality === "critical" ? " [CRITICAL]" : "";
  console.log(`  [${c.category}] ${c.label}${crit}`);
}

if (dryRun) {
  console.log("\n=== DRY RUN COMPLETE (no bot calls, no LLM cost, no persist) ===");
  // Print one detailed case as a sample
  const sample = genResult.cases[0];
  if (sample) {
    console.log(`\nSAMPLE CASE: ${sample.label}`);
    console.log(JSON.stringify(sample, null, 2));
  }
  Deno.exit(0);
}

// ── Filter by limit ────────────────────────────────────────────────────────

let casesToRun = genResult.cases;

if (casesFilter) {
  const filtered = casesToRun.filter((c) => casesFilter.has(c.id));
  const notFound = [...casesFilter].filter((id) => !casesToRun.some((c) => c.id === id));
  if (notFound.length > 0) {
    console.log(`\n⚠ Missing case ids: ${notFound.join(", ")}`);
  }
  if (filtered.length === 0) {
    console.error("No matching cases found. Exiting.");
    Deno.exit(1);
  }
  console.log(`\nFiltering to ${filtered.length} specific cases: ${filtered.map((c) => c.id).join(", ")}`);
  casesToRun = filtered;
} else if (limit !== null && limit > 0 && limit < casesToRun.length) {
  console.log(`\nLimiting to ${limit} cases...`);
  casesToRun = casesToRun.slice(0, limit);
}

// ── Run cases ──────────────────────────────────────────────────────────────

console.log(`\nRunning ${casesToRun.length} test cases...`);
const runConfig = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
  chatFunctionUrl: CHAT_FUNCTION_URL,
  simulatorApiKey: ANTHROPIC_API_KEY,
  simulatorModel: "deepseek/deepseek-v4-flash",
};
const judgeConfig = {
  judgeApiKey: ANTHROPIC_API_KEY,
  judgeModel: "deepseek/deepseek-v4-flash",
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SUPABASE_KEY,
};
const fixConfig = {
  fixApiKey: ANTHROPIC_API_KEY,
  fixModel: "deepseek/deepseek-v4-flash",
};

const scored: ScoredCase[] = [];
let totalJudgeCost = 0;

for (let i = 0; i < casesToRun.length; i++) {
  const tc = casesToRun[i];
  console.log(`\n[${i + 1}/${casesToRun.length}] ${tc.id}: ${tc.label}`);

  try {
    // 1. Run the bot interaction
    const run = await runCase(runConfig, shopId, tc);
    console.log(`  → ${run.transcript.length} turns returned` + (run.error ? ` (ERROR: ${run.error})` : ""));

    // 2. Judge the result
    console.log(`  → judging...`);
    const judge = await judgeCase(judgeConfig, run, tc, genResult.shop);
    totalJudgeCost += judge.costCents;
    const status = judge.passed ? "PASS" : "FAIL";
    console.log(`  → ${status} | ${judge.criteria.filter(c => c.passed).length}/${judge.criteria.length} criteria | cost $${(judge.costCents / 100).toFixed(4)}`);

    if (!judge.passed) {
      for (const c of judge.criteria.filter(c => !c.passed)) {
        console.log(`      ✗ ${c.id}: ${c.reason || "no reason"}`);
      }
    }

    scored.push({ testCase: tc, judge, run });
  } catch (e) {
    console.log(`  → CRASH: ${(e as Error).message}`);
    // Insert a synthetic failure
    const fakeRun = {
      caseId: tc.id,
      shopId,
      transcript: [{ role: "customer" as const, message: "[crash]", reply: `[CRASH: ${(e as Error).message}]` }],
      sessionId: "error",
      error: (e as Error).message,
    };
    const judge = await judgeCase(judgeConfig, fakeRun, tc, genResult.shop);
    scored.push({ testCase: tc, judge, run: fakeRun });
  }
}

// ── Fix loop: root cause + proposed fix for every FAILING case ────────────
// Criticals first (they must never be left empty).
const failedScored = scored.filter((s) => !s.judge.passed);
failedScored.sort((a, b) => {
  const rank = (c: string) => (c === "critical" ? 0 : 1);
  return rank(a.testCase.criticality) - rank(b.testCase.criticality);
});

console.log(`\nGenerating root cause + fix for ${failedScored.length} failing cases...`);
let fixFailures = 0;
for (let i = 0; i < failedScored.length; i++) {
  const s = failedScored[i];
  try {
    const fix = await generateRootCauseFix(fixConfig, s.run, s.testCase, s.judge);
    s.fix = fix;
    console.log(`  [${i + 1}/${failedScored.length}] ${s.testCase.id}: ${fix.root_cause.slice(0, 80)}${fix.root_cause.length > 80 ? "…" : ""}`);
  } catch (e) {
    fixFailures++;
    console.log(`  [${i + 1}/${failedScored.length}] ${s.testCase.id}: FIX GEN FAILED: ${(e as Error).message}`);
    s.fix = {
      root_cause: `Case "${s.testCase.id}" failed and root-cause generation errored: ${(e as Error).message}`,
      proposed_fix: `Investigate case "${s.testCase.id}" manually.`,
    };
  }
}
if (fixFailures > 0) {
  console.log(`  ⚠ ${fixFailures} fix-generation calls failed (fallback persisted).`);
}

// ── Scorecard ──────────────────────────────────────────────────────────────

const scorecard = buildScorecard(scored);
console.log(formatScorecard(scorecard, genResult.shop.name));
console.log(`\nTotal judge cost: $${(totalJudgeCost / 100).toFixed(4)}`);

// ── Persist ────────────────────────────────────────────────────────────────

console.log(`\nPersisting results...`);
try {
  const persistResult = await persistResults({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SUPABASE_KEY,
    shopId,
    tenantId: genResult.shop.tenant_id,
    shopName: genResult.shop.name,
    scorecard,
    scored: scored.map((s) => s),
    modelTier: "deepseek-v4-flash-test-suite",
  });
  console.log(`  Run ID: ${persistResult.runId}`);
  console.log(`  test_runs: 1 row inserted`);
  console.log(`  test_case_results: ${scored.length} rows inserted`);
} catch (e) {
  console.error(`  Persist failed: ${(e as Error).message}`);
}

console.log("\n=== TEST SUITE COMPLETE ===");