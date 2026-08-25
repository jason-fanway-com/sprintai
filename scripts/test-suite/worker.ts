#!/usr/bin/env deno run --allow-net --allow-env --allow-read --allow-write
/**
 * worker.ts — Test run queue worker.
 *
 * Polls test_run_queue for the oldest pending row, marks it running,
 * executes the full test suite pipeline (generate → run → judge → fix → persist),
 * and marks the row done or error.
 *
 * Idles when the queue is empty and picks right back up when new work arrives.
 *
 * Secrets from environment:
 *   SPRINTAI_CHAT_SUPABASE_URL
 *   SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 *   WORKER_POLL_INTERVAL (optional, seconds; default 15)
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read --allow-write worker.ts
 *
 * Designed to run under launchd as com.sprintai.test-run-worker.plist.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generateCases } from "./generator.ts";
import { runCase } from "./runner.ts";
import { judgeCase } from "./judge.ts";
import { buildScorecard, formatScorecard, type ScoredCase } from "./scorecard.ts";
import { verifyCartOpsInvariants, verifyStatedTotal } from "./cart-ops.ts";
import { verifyHoursClosed } from "./hours-closed.ts";
import { persistResults } from "./persist.ts";
import { generateRootCauseFix } from "./fix.ts";

// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const POLL_SECS = parseInt(Deno.env.get("WORKER_POLL_INTERVAL") ?? "15", 10) || 15;

const PROJECT_REF = "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("worker: missing SPRINTAI_CHAT_SUPABASE_URL or SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Main loop ──────────────────────────────────────────────────────────────

console.log(`worker: started (poll every ${POLL_SECS}s)`);

while (true) {
  try {
    // ── Claim next pending row ──────────────────────────────────────────
    const { data: rows, error: pollErr } = await supabase
      .from("test_run_queue")
      .select("id, shop_id, tenant_id")
      .eq("status", "pending")
      .order("requested_at", { ascending: true })
      .limit(1);

    if (pollErr) {
      console.error("worker: poll error:", pollErr.message);
      await sleep(POLL_SECS * 1000);
      continue;
    }

    if (!rows || rows.length === 0) {
      await sleep(POLL_SECS * 1000);
      continue;
    }

    const job = rows[0];
    const { id: queueId, shop_id: shopId, tenant_id: tenantId } = job;

    console.log(`worker: picked job ${queueId} (shop ${shopId})`);

    // ── Mark running ────────────────────────────────────────────────────
    const { error: markErr } = await supabase
      .from("test_run_queue")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", queueId);

    if (markErr) {
      console.error(`worker: failed to mark ${queueId} running:`, markErr.message);
      await sleep(POLL_SECS * 1000);
      continue;
    }

    // ── Run the pipeline ────────────────────────────────────────────────
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

    try {
      // 1. Generate cases
      console.log(`worker [${queueId}]: generating cases for shop ${shopId}`);
      const genResult = await generateCases({
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_KEY,
        shopId,
      });
      console.log(
        `worker [${queueId}]: ${genResult.derivedCount} derived + ${genResult.libraryCount} library + ${genResult.cartOpsCount} CartOps + ${genResult.hoursClosedCount} hours-closed + ${genResult.conversationalCount} conversational = ${genResult.cases.length} total`,
      );

      // 2. Run + judge + fix
      const scored: ScoredCase[] = [];
      for (let i = 0; i < genResult.cases.length; i++) {
        const tc = genResult.cases[i];
        console.log(`worker [${queueId}]: [${i + 1}/${genResult.cases.length}] ${tc.id}`);

        const run = await runCase(runConfig, shopId, tc);
        let judge = await judgeCase(judgeConfig, run, tc, genResult.shop);

        // CartOps HARD programmatic verification (overrides LLM judge for cart-ops)
        if (tc.category === "cart-ops") {
          const verify = verifyCartOpsInvariants(run);
          console.log(`worker [${queueId}]:   CartOps invariants ${verify.passed ? "PASS" : "FAIL"} (${verify.invariants.filter((x) => x.passed).length}/${verify.invariants.length})`);
          for (const inv of verify.invariants.filter((x) => !x.passed)) {
            console.log(`worker [${queueId}]:     ✗ ${inv.id}: ${inv.detail}`);
          }
          if (!verify.passed) judge = { ...judge, passed: false };
        }

        // Hours-closed HARD programmatic verification (overrides LLM judge)
        if (tc.category === "hours-closed") {
          const verify = verifyHoursClosed(run);
          console.log(`worker [${queueId}]:   Hours-closed invariants ${verify.passed ? "PASS" : "FAIL"} (${verify.invariants.filter((x) => x.passed).length}/${verify.invariants.length})`);
          for (const inv of verify.invariants.filter((x) => !x.passed)) {
            console.log(`worker [${queueId}]:     ✗ ${inv.id}: ${inv.detail}`);
          }
          if (!verify.passed) judge = { ...judge, passed: false };
        }

        // Stated-total deterministic override (kills judge arithmetic false-positives)
        const expectedCents = (tc as any).expectedItemCents as number | undefined;
        if (expectedCents !== undefined) {
          const totalOverride = verifyStatedTotal(run, expectedCents);
          if (totalOverride) {
            console.log(`worker [${queueId}]:   Stated-total override: ${totalOverride.passed ? "FORCE PASS" : "FORCE FAIL"} — ${totalOverride.detail}`);
            judge = { ...judge, passed: totalOverride.passed };
          }
        }

        let fix = null;
        if (!judge.passed) {
          try {
            fix = await generateRootCauseFix(fixConfig, run, tc, judge);
          } catch (e) {
            console.log(`worker [${queueId}]: fix gen failed for ${tc.id}: ${(e as Error).message}`);
          }
        }
        scored.push({ testCase: tc, judge, run, fix });
      }

      const scorecard = buildScorecard(scored);
      console.log(formatScorecard(scorecard, genResult.shop.name));

      // 3. Persist
      console.log(`worker [${queueId}]: persisting results`);
      const persistResult = await persistResults({
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_KEY,
        shopId,
        tenantId,
        shopName: genResult.shop.name,
        scorecard,
        scored,
        modelTier: "deepseek-v4-flash-test-suite",
      });

      // ── Mark done ────────────────────────────────────────────────────
      const { error: doneErr } = await supabase
        .from("test_run_queue")
        .update({
          status: "done",
          test_run_id: persistResult.runId,
          finished_at: new Date().toISOString(),
        })
        .eq("id", queueId);

      if (doneErr) {
        console.error(`worker [${queueId}]: failed to mark done:`, doneErr.message);
      } else {
        console.log(`worker [${queueId}]: done — test_run ${persistResult.runId}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`worker [${queueId}]: pipeline failed:`, message);

      const { error: errErr } = await supabase
        .from("test_run_queue")
        .update({
          status: "error",
          error: message,
          finished_at: new Date().toISOString(),
        })
        .eq("id", queueId);
      if (errErr) {
        console.error(`worker [${queueId}]: failed to mark error:`, errErr.message);
      }
    }
  } catch (e) {
    console.error("worker: loop error:", (e as Error).message);
    await sleep(POLL_SECS * 1000);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}