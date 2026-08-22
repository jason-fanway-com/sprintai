/**
 * persist.ts — Write test results to test_runs + test_case_results.
 * Uses the service-role key (bypasses RLS). Columns match migrations 052/053.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { AnyCase } from "./library.ts";
import type { JudgeResult } from "./judge.ts";
import type { Scorecard } from "./scorecard.ts";
import type { RunResult } from "./runner.ts";
import type { FixResult } from "./fix.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PersistInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  shopId: string;
  tenantId: string;
  shopName: string;
  scorecard: Scorecard;
  scored: Array<{ testCase: AnyCase; judge: JudgeResult; run: RunResult; fix?: FixResult | null }>;
  modelTier: string;
}

export interface PersistResult {
  runId: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function persistResults(input: PersistInput): Promise<PersistResult> {
  const supabase = createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Insert test_runs ────────────────────────────────────────────────────
  const categorySubscores: Record<string, { total: number; passed: number; failed: number; pass_pct: number }> = {};
  for (const [cat, v] of Object.entries(input.scorecard.categories)) {
    categorySubscores[cat] = {
      total: v.total,
      passed: v.passed,
      failed: v.failed,
      pass_pct: v.passPct,
    };
  }

  const { data: run, error: runErr } = await supabase
    .from("test_runs")
    .insert({
      shop_id: input.shopId,
      tenant_id: input.tenantId,
      started_at: new Date().toISOString(),
      model_tier: input.modelTier,
      total: input.scorecard.total,
      passed: input.scorecard.passed,
      failed: input.scorecard.failed,
      overall_pass_pct: input.scorecard.overallPassPct,
      category_subscores: categorySubscores,
      critical_failures: input.scorecard.criticalFailures,
      status: "completed",
      notes: `Test suite run against ${input.shopName}`,
    })
    .select("id")
    .single();

  if (runErr || !run) {
    throw new Error(`Failed to insert test_runs: ${runErr?.message ?? "no row"}`);
  }

  const runId = run.id as string;

  // ── Auto-flip: resolve prior fix_status for cases that now PASS ─────────
  // Keyed on stable case_id (not row id). For each case that previously
  // failed with a proposed/open fix and now passes, we carry 'fixed' forward
  // so the remediation loop visibly closes across runs.
  const caseIds = input.scored.map((s) => s.testCase.id);
  const priorStatuses = new Map<string, string>();
  if (caseIds.length > 0) {
    // Latest prior result per case_id (excluding the run we just created).
    const { data: prior } = await supabase
      .from("test_case_results")
      .select("case_id, fix_status, passed")
      .in("case_id", caseIds)
      .order("created_at", { ascending: false });
    for (const p of (prior ?? [])) {
      if (!priorStatuses.has(p.case_id)) {
        priorStatuses.set(p.case_id, p.fix_status);
      }
    }
  }

  // ── Insert test_case_results ────────────────────────────────────────────
  const rows = input.scored.map((s) => {
    const priorStatus = priorStatuses.get(s.testCase.id) ?? null;

    let fixStatus: string | null = null;
    let rootCause: string | null = null;
    let proposedFix: string | null = null;

    if (s.judge.passed) {
      // Passing case. If it previously had an open/proposed fix, mark fixed.
      if (priorStatus === "open" || priorStatus === "proposed") {
        fixStatus = "fixed";
      }
      // Passing cases show empty/— in the UI; root cause/fix left null.
    } else {
      // Failing case: persist the generated root cause + proposed fix.
      rootCause = s.fix?.root_cause ?? null;
      proposedFix = s.fix?.proposed_fix ?? null;
      fixStatus = priorStatus === "wontfix"
        ? "wontfix" // respect an explicit wontfix decision
        : (rootCause || proposedFix ? "proposed" : "open");
    }

    return {
      run_id: runId,
      case_id: s.testCase.id,
      category: s.testCase.category,
      criticality: s.testCase.criticality,
      transcript: JSON.parse(JSON.stringify(s.run.transcript)),
      success_criteria: JSON.parse(JSON.stringify(s.testCase.success_criteria)),
      passed: s.judge.passed,
      verdict: s.judge.verdict,
      reason: s.judge.criteria
        .filter((c) => !c.passed)
        .map((c) => c.reason)
        .join("; "),
      root_cause: rootCause,
      proposed_fix: proposedFix,
      fix_status: fixStatus,
    };
  });

  if (rows.length > 0) {
    const { error: resultsErr } = await supabase.from("test_case_results").insert(rows);
    if (resultsErr) {
      throw new Error(`Failed to insert test_case_results: ${resultsErr.message}`);
    }
  }

  return { runId };
}