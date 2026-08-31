/**
 * test-runner — Server-side Proof runner, triggered by pg_cron every 60s.
 *
 * Batch-oriented: each tick processes up to BATCH_SIZE cases, tracking
 * progress via test_run_queue.case_index. When all cases are done, it
 * creates the test_runs summary row and marks the job complete.
 *
 * This replaces the local `scripts/test-suite/worker.ts` long-running
 * process. The worker is the diagnostic / interactive copy; this edge
 * function is the hands-free server-side version.
 *
 * SAFETY: runner.ts enforces protected=false + phone_number_e164 IS NULL
 * on every shop. No live shop can be targeted.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generateCases } from "../_shared/test-suite/generator.ts";
import { runCase } from "../_shared/test-suite/runner.ts";
import { judgeCase } from "../_shared/test-suite/judge.ts";
import { buildScorecard, formatScorecard, type ScoredCase } from "../_shared/test-suite/scorecard.ts";
import { verifyCartOpsInvariants, verifyStatedTotal } from "../_shared/test-suite/cart-ops.ts";
import { verifyHoursClosed } from "../_shared/test-suite/hours-closed.ts";
import { persistResults } from "../_shared/test-suite/persist.ts";
import { generateRootCauseFix } from "../_shared/test-suite/fix.ts";
import type { AnyCase } from "../_shared/test-suite/library.ts";

// ── Config ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;
const SCORER_VERSION = 1;
const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

// ── Entry ──────────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonErr(500, "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    // 1. Find active job, or claim next pending
    let job = await findRunningJob(supabase);
    if (!job) {
      const claimed = await claimNextPending(supabase);
      if (!claimed) return Response.json({ status: "idle", message: "queue empty" });
      job = claimed;
    }

    const jobId: string = job.id;
    const shopId: string = job.shop_id;
    const tenantId: string = job.tenant_id;
    let caseIdx: number = job.case_index ?? 0;
    let totalCases: number = job.total_cases ?? 0;
    let cases: AnyCase[] = (job.cases_json as AnyCase[]) ?? [];
    let scored: unknown[] = job.scored_json as unknown[] ?? [];
    let shopName: string = job.shop_name ?? "";
    let shop: { id: string; name: string; tenant_id: string } | null = null;

    // 2. First tick — generate all cases
    if (caseIdx === 0) {
      console.log(`test-runner [${jobId}]: generating cases for shop ${shopId}`);
      const genResult = await generateCases({
        supabaseUrl,
        serviceRoleKey,
        shopId,
      });

      cases = genResult.cases;
      totalCases = cases.length;
      shopName = genResult.shop.name;
      shop = { id: genResult.shop.id, name: genResult.shop.name, tenant_id: genResult.shop.tenant_id };

      await supabase.from("test_run_queue").update({
        total_cases: totalCases,
        cases_json: cases,
        shop_name: shopName,
      }).eq("id", jobId);

      console.log(
        `test-runner [${jobId}]: ${genResult.derivedCount} derived + ` +
        `${genResult.libraryCount} library + ${genResult.cartOpsCount} CartOps + ` +
        `${genResult.hoursClosedCount} hours-closed + ${genResult.conversationalCount} conversational = ${totalCases} total`,
      );
    }

    // 3. Process this batch
    const endIdx = Math.min(caseIdx + BATCH_SIZE, totalCases);

    const runConfig = {
      supabaseUrl,
      serviceRoleKey,
      chatFunctionUrl: CHAT_FUNCTION_URL,
      simulatorApiKey: anthropicKey,
      simulatorModel: "deepseek/deepseek-v4-flash",
    };
    const judgeConfig = {
      judgeApiKey: anthropicKey,
      judgeModel: "deepseek/deepseek-v4-flash",
      supabaseUrl,
      serviceRoleKey,
    };
    const fixConfig = {
      fixApiKey: anthropicKey,
      fixModel: "deepseek/deepseek-v4-flash",
    };

    for (let i = caseIdx; i < endIdx; i++) {
      const tc = cases[i] as AnyCase;
      const tcId = tc.id;
      console.log(`test-runner [${jobId}]: [${i + 1}/${totalCases}] ${tcId}`);

      const runResult = await runCase(runConfig, shopId, tc);

      // Use the shop we stored from generation (or loaded from job state)
      if (!shop) {
        shop = { id: shopId, name: shopName, tenant_id: tenantId };
      }
      let judgeResult = await judgeCase(judgeConfig, runResult, tc, { id: shop.id, name: shop.name });

      // ── Programmatic overrides (same as worker.ts) ──────────────────

      // CartOps HARD verification — overrides LLM judge
      if (tc.category === "cart-ops") {
        const verify = verifyCartOpsInvariants(runResult);
        console.log(`  CartOps invariants ${verify.passed ? "PASS" : "FAIL"} (${verify.invariants.filter((x) => x.passed).length}/${verify.invariants.length})`);
        judgeResult = verify.passed
          ? { ...judgeResult, passed: true }
          : { ...judgeResult, passed: false };
      }

      // Hours-closed HARD verification
      if (tc.category === "hours-closed") {
        const verify = verifyHoursClosed(runResult);
        console.log(`  Hours-closed invariants ${verify.passed ? "PASS" : "FAIL"}`);
        if (!verify.passed) judgeResult = { ...judgeResult, passed: false };
      }

      // Stated-total deterministic override
      const expectedCents = "expectedItemCents" in tc ? (tc as { expectedItemCents?: number }).expectedItemCents : undefined;
      if (expectedCents !== undefined) {
        const totalOverride = verifyStatedTotal(runResult, expectedCents);
        if (totalOverride) {
          console.log(`  Stated-total override: FORCE PASS — ${totalOverride.detail}`);
          judgeResult = { ...judgeResult, passed: true };
        }
      }

      let fix = null;
      if (!judgeResult.passed) {
        try {
          fix = await generateRootCauseFix(fixConfig, runResult, tc, judgeResult);
        } catch (e) {
          console.log(`  fix gen failed for ${tcId}: ${(e as Error).message}`);
        }
      }

      scored.push({ testCase: tc, judge: judgeResult, run: runResult, fix });

      // Persist progress after each case (crash-safe checkpoint)
      await supabase.from("test_run_queue").update({
        case_index: i + 1,
        scored_json: scored,
      }).eq("id", jobId);
    }

    // 4. All done? Persist summary
    if (endIdx >= totalCases) {
      console.log(`test-runner [${jobId}]: all ${totalCases} cases complete, persisting summary`);

      const scorecard = buildScorecard(scored as ScoredCase[]);
      console.log(formatScorecard(scorecard, shopName));

      const persistResult = await persistResults({
        supabaseUrl,
        serviceRoleKey,
        shopId,
        tenantId,
        shopName,
        scorecard,
        scored: scored as ScoredCase[],
        modelTier: "deepseek-v4-flash-test-suite",
        scorerVersion: SCORER_VERSION,
      });

      await supabase.from("test_run_queue").update({
        status: "done",
        test_run_id: persistResult.runId,
        finished_at: new Date().toISOString(),
      }).eq("id", jobId);

      console.log(`test-runner [${jobId}]: done — test_run ${persistResult.runId}`);
      return Response.json({ status: "completed", runId: persistResult.runId, total: totalCases });
    }

    const remaining = totalCases - endIdx;
    console.log(`test-runner [${jobId}]: batch done — ${endIdx}/${totalCases} processed, ${remaining} remaining`);
    return Response.json({ status: "running", processed: endIdx, remaining, jobId });

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`test-runner error: ${message}`);
    return jsonErr(500, message);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function findRunningJob(supabase: any) {
  const { data } = await supabase
    .from("test_run_queue")
    .select("*")
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(1);
  return data?.[0] ?? null;
}

async function claimNextPending(supabase: any) {
  const { data } = await supabase
    .from("test_run_queue")
    .select("*")
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(1);

  if (!data?.length) return null;

  const job = data[0];
  await supabase.from("test_run_queue").update({
    status: "running",
    started_at: new Date().toISOString(),
  }).eq("id", job.id);

  return {
    ...job,
    status: "running",
    case_index: 0,
    cases_json: null,
    scored_json: null,
    shop_name: null,
  };
}

function jsonErr(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}