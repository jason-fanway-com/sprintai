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
import { verifyCartOpsInvariants, verifyStatedTotal, verifyCheckoutFinalize, verifyHallucinationGuard, verifyCartPersistence } from "../_shared/test-suite/cart-ops.ts";
import { verifyHoursClosed } from "../_shared/test-suite/hours-closed.ts";
import { persistResults } from "../_shared/test-suite/persist.ts";
// fix.ts NOT imported here — root-cause generation is a SEPARATE
// post-run/on-demand concern, never called inline in the scoring loop.
import type { AnyCase } from "../_shared/test-suite/library.ts";

// ── Config ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 2;
const SCORER_VERSION = 2;
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

      // ── P1: case_filter + max_cases — deterministic subset for smoke runs ──
      const caseFilter: string[] | undefined = (job as any).case_filter;
      const maxCasesRaw: unknown = (job as any).max_cases;
      const preCount = cases.length;

      // ── case_filter (loud-fail contract) — applied FIRST on full generated set ──
      if (caseFilter != null) {
        if (!Array.isArray(caseFilter) || caseFilter.length === 0) {
          console.warn(
            `test-runner [${jobId}]: case_filter=${JSON.stringify(caseFilter)} INVALID — must be a non-empty array. ` +
            `Filter NOT applied. ${cases.length} cases will run.`,
          );
        } else {
          const filterSet = new Set(caseFilter);
          const postFilter = cases.filter((c) => filterSet.has(c.id));
          if (postFilter.length === 0) {
            console.warn(
              `test-runner [${jobId}]: case_filter matched ZERO of ${cases.length} cases — filter is stale or wrong. ` +
              `Falling through to full run.`,
            );
          } else if (postFilter.length === cases.length) {
            console.warn(
              `test-runner [${jobId}]: case_filter is a NO-OP — all ${cases.length} cases matched. Running full suite.`,
            );
          } else {
            cases = postFilter;
            console.log(
              `test-runner [${jobId}]: case_filter applied: ${cases.length} of ${preCount} matched`,
            );
          }
        }
      }

      // ── max_cases (loud-fail contract) — applied SECOND on filtered result ──
      let maxCases: number | undefined;
      if (maxCasesRaw != null) {
        if (typeof maxCasesRaw === "number" && Number.isInteger(maxCasesRaw) && maxCasesRaw > 0) {
          maxCases = maxCasesRaw;
        } else {
          console.warn(
            `test-runner [${jobId}]: max_cases=${JSON.stringify(maxCasesRaw)} INVALID — must be a positive integer, ` +
            `got ${typeof maxCasesRaw}. Cap NOT applied. ${cases.length} cases will run.`,
          );
        }

        if (typeof maxCases === "number" && maxCases >= cases.length) {
          console.warn(
            `test-runner [${jobId}]: max_cases=${maxCases} has NO EFFECT — >= total cases (${cases.length}). Running full suite.`,
          );
        }
      }

      if (typeof maxCases === "number" && maxCases < cases.length) {
        cases = cases.slice(0, maxCases);
        console.log(
          `test-runner [${jobId}]: max_cases=${maxCases} cap applied (${preCount} -> ${cases.length})`,
        );
      }

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

    // Load menu names once per tick for hallucination guard
    const menuNames = await loadMenuNames(supabase, shopId);

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
    for (let i = caseIdx; i < endIdx; i++) {
      const tc = cases[i] as AnyCase;
      const tcId = tc.id;
      console.log(`test-runner [${jobId}]: [${i + 1}/${totalCases}] ${tcId}`);

      const runResult = await runCase(runConfig, shopId, tc);

      // Use the shop we stored from generation (or loaded from job state)
      if (!shop) {
        shop = { id: shopId, name: shopName, tenant_id: tenantId };
      }

      // ── LLM judge (advisory only — does NOT gate pass/fail) ───────────
      const judgeResult = await judgeCase(judgeConfig, runResult, tc, { id: shop.id, name: shop.name });
      const qualityPassed = judgeResult.passed;

      // ── Deterministic invariants (THE gate — capability dispatch) ─────

      const expectedItemCents = "expectedItemCents" in tc ? (tc as { expectedItemCents?: number }).expectedItemCents : undefined;
      const expectsCheckout = "expects_checkout" in tc ? (tc as { expects_checkout?: boolean }).expects_checkout === true : false;
      const hoursMode = "hoursMode" in tc ? (tc as { hoursMode?: string }).hoursMode : undefined;
      const hasCart = (runResult.transcript ?? []).some((t: any) => (t.cart as any[]).length > 0);
      const appliedInvariants: string[] = [];
      const detReasons: string[] = [];
      let detPassed = true;
      let anyInvariantApplied = false;

      // CartOps invariants (all 5) — apply whenever server cart was produced
      if (hasCart) {
        const cartOpsVerify = verifyCartOpsInvariants(runResult);
        let anyCartOpsApplied = false;
        for (const inv of cartOpsVerify.invariants) {
          console.log(`  CartOps ${inv.id}: ${inv.passed ? "PASS" : "FAIL"}${inv.applied ? "" : " (trivial)"}`);
          appliedInvariants.push(`cartops:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
          if (inv.applied) anyCartOpsApplied = true;
        }
        if (anyCartOpsApplied) anyInvariantApplied = true;
        if (!cartOpsVerify.passed) {
          console.log(`  CartOps invariants FAIL`);
          detPassed = false;
          const failed = cartOpsVerify.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
          detReasons.push(`cartops: ${failed.join("; ")}`);
        }
      }

      // Totals: grade whenever expectedItemCents > 0 OR server cart exists
      if ((expectedItemCents ?? 0) > 0 || hasCart) {
        const totalCheck = verifyStatedTotal(runResult);
        appliedInvariants.push(`stated-total:${totalCheck.passed ? "PASS" : "FAIL"}`);
        if (totalCheck.applied) anyInvariantApplied = true;
        if (!totalCheck.passed) {
          console.log(`  Stated-total FAIL: ${totalCheck.detail}`);
          detPassed = false;
          detReasons.push(`stated-total: ${totalCheck.detail}`);
        } else {
          console.log(`  Stated-total PASS`);
        }
      }

      // Checkout-finalize: whenever expects_checkout === true
      if (expectsCheckout) {
        const checkoutCheck = await verifyCheckoutFinalize(supabase as any, runResult);
        appliedInvariants.push(`checkout-finalize:${checkoutCheck.passed ? "PASS" : "FAIL"}`);
        if (checkoutCheck.applied) anyInvariantApplied = true;
        if (!checkoutCheck.passed) {
          console.log(`  Checkout-finalize FAIL: ${checkoutCheck.detail}`);
          detPassed = false;
          detReasons.push(`checkout-finalize: ${checkoutCheck.detail}`);
        } else {
          console.log(`  Checkout-finalize PASS`);
        }
      }

      // Hours-closed HARD verification
      if (hoursMode === "closed") {
        const verify = verifyHoursClosed(runResult);
        let anyHoursApplied = false;
        for (const inv of verify.invariants) {
          appliedInvariants.push(`hours-closed:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
          if (inv.applied) anyHoursApplied = true;
        }
        if (anyHoursApplied) anyInvariantApplied = true;
        console.log(`  Hours-closed invariants ${verify.passed ? "PASS" : "FAIL"}`);
        if (!verify.passed) {
          detPassed = false;
          const failed = verify.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
          detReasons.push(`hours-closed: ${failed.join("; ")}`);
        }
      }

      // Hallucination guard: all cases (when menu names available)
      if (menuNames.size > 0) {
        const hg = verifyHallucinationGuard(runResult, menuNames);
        appliedInvariants.push(`hallucination-guard:${hg.passed ? "PASS" : "FAIL"}`);
        if (hg.applied) anyInvariantApplied = true;
        if (!hg.passed) {
          console.log(`  Hallucination-guard FAIL: ${hg.detail.slice(0, 120)}`);
          detPassed = false;
          detReasons.push(`hallucination-guard: ${hg.detail}`);
        } else {
          console.log(`  Hallucination-guard PASS`);
        }
      }

      // Cart persistence: all cases with ≥2 turns
      {
        const cp = verifyCartPersistence(runResult);
        appliedInvariants.push(`cart-persistence:${cp.passed ? "PASS" : "FAIL"}`);
        if (cp.applied) anyInvariantApplied = true;
        if (!cp.passed) {
          console.log(`  Cart-persistence FAIL: ${cp.detail.slice(0, 120)}`);
          detPassed = false;
          detReasons.push(`cart-persistence: ${cp.detail}`);
        } else {
          console.log(`  Cart-persistence PASS`);
        }
      }

      // proof_passed: three-state — true/false when invariants were applied, null when ungraded
      const proofPassed: boolean | null = anyInvariantApplied ? detPassed : null;
      if (!anyInvariantApplied) {
        appliedInvariants.push("no-invariant-applied");
      }

      // fix-gen is NOT called in the scoring loop — it lives in a separate
      // post-run pass (or on-demand when a human opens a failing case in the
      // dashboard).  An LLM call per failing case in the cron tick was the
      // throughput bottleneck (0.03 cases/min with v2's higher fail rate).
      scored.push({
        testCase: tc,
        judge: judgeResult,
        run: runResult,
        fix: null,
        appliedInvariants,
        deterministicReason: detReasons.join("; "),
        proofPassed,
        qualityPassed,
      });

      // Persist progress after each case (crash-safe checkpoint)
      await supabase.from("test_run_queue").update({
        case_index: i + 1,
        scored_json: scored,
      }).eq("id", jobId);
    }

    // 4. All done? Persist summary (with orphan-persist guard)
    if (endIdx >= totalCases) {
      // Guard 1: already persisted (test_run_id set by a prior tick)
      if ((job as any).test_run_id) {
        console.log(`test-runner [${jobId}]: already persisted (test_run_id=${(job as any).test_run_id}), skipping`);
        return Response.json({ status: "already-completed", runId: (job as any).test_run_id });
      }

      // Guard 2: conditional claim — atomically transition to 'persisting'.
      // If 0 rows affected, another tick already owns completion.
      const { data: claimed } = await supabase
        .from("test_run_queue")
        .update({ status: "persisting" })
        .eq("id", jobId)
        .eq("status", "running")
        .select("id")
        .single();

      if (!claimed) {
        console.log(`test-runner [${jobId}]: another tick already owns completion, skipping`);
        return Response.json({ status: "already-persisting" });
      }

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

async function loadMenuNames(supabase: any, shopId: string): Promise<Set<string>> {
  const { data: menus } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!menus?.length) return new Set<string>();
  const { data: items } = await supabase
    .from("menu_items")
    .select("name")
    .eq("menu_id", menus[0].id)
    .eq("active", true);
  return new Set<string>((items ?? []).map((i: { name: string }) => i.name));
}