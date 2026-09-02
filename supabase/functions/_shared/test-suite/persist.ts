/**
 * persist.ts — Write test results to test_runs + test_case_results.
 * Uses the service-role key (bypasses RLS). Columns match migrations 052/053.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { Scorecard, ScoredCase } from "./scorecard.ts";

// ── GSM-7 segment counting (inline — same logic as segment-count.ts) ──────
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split(""),
);
const GSM7_EXTENDED = new Set("|^{}[]~\\€");

function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

function gsm7CharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    count += GSM7_EXTENDED.has(ch) ? 2 : 1;
  }
  return count;
}

function segmentCount(text: string): number {
  if (text.length === 0) return 0;
  if (isGsm7(text)) {
    const chars = gsm7CharCount(text);
    return chars <= 160 ? 1 : 1 + Math.ceil((chars - 160) / 153);
  }
  return text.length <= 70 ? 1 : 1 + Math.ceil((text.length - 70) / 67);
}

function totalBotSegments(transcript: Array<{ role: string; reply?: string | null; phase?: string }>): number {
  let segs = 0;
  for (const turn of transcript) {
    if (turn.role === "customer" && turn.reply) {
      segs += segmentCount(turn.reply);
    }
  }
  return segs;
}

function conversationReachedCheckout(transcript: Array<{ role: string; reply?: string | null; phase?: string }>): boolean {
  return transcript.some((t) => t.phase === "checkout");
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface PersistInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  shopId: string;
  tenantId: string;
  shopName: string;
  scorecard: Scorecard;
  scored: ScoredCase[];
  modelTier: string;
  scorerVersion: number;
}

export interface PersistResult {
  runId: string;
}

// ── Guards ───────────────────────────────────────────────────────────────

/**
 * Every scored case must carry a populated three-state proofPassed
 * (true | false | null). `undefined` means the scoring path never ran the v3
 * invariant dispatch — persisting it silently counted as PASS and produced a
 * false 128/128 green (2026-09-02 NJB run 2deb0599). Fail loud BEFORE inserting
 * any row so we never orphan a run row on bad data.
 */
export function assertValidProofData(scored: ScoredCase[]): void {
  const bad = scored.find((s) => s.proofPassed === undefined);
  if (bad) {
    throw new Error(
      `persist.ts: proofPassed is undefined for case ${bad.testCase.id} — ` +
      `v3 scoring fields were never populated. The caller is not producing valid v3 data.`,
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function persistResults(input: PersistInput): Promise<PersistResult> {
  // Fail loud on invalid v3 data before any DB write (see assertValidProofData).
  assertValidProofData(input.scored);

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
      proof_pass_pct: input.scorecard.proofPassPct,
      quality_pass_pct: input.scorecard.qualityPassPct,
      ungraded_count: input.scorecard.proofUngraded,
      category_subscores: categorySubscores,
      critical_failures: input.scorecard.criticalFailures,
      status: "completed",
      scorer_version: input.scorerVersion,
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

    // proof_passed = the gate value (deterministic invariants).
    // Three-state: true=materially passed, false=materially failed, null=ungraded.
    // SAFETY: proofPassed === undefined means the scoring path never populated
    // v3 fields (CLI run.ts lacks the invariant dispatch that the edge function has).
    // Treating undefined as pass silently produced false greens (2026-09-02 NJB 2deb0599).
    if (s.proofPassed === undefined) {
      throw new Error(
        `persist.ts: proofPassed is undefined for case ${s.testCase.id} — ` +
        `v3 scoring fields were never populated. The caller is not producing valid v3 data.`,
      );
    }
    const proofPassed: boolean | null = s.proofPassed;
    // passed boolean (DB column): null proof → null, otherwise proofPassed
    const passedBool = proofPassed === null ? null : proofPassed;
    // quality_passed = LLM judge advisory
    const qualityPassed = s.qualityPassed === undefined ? s.judge.passed : s.qualityPassed;

    let fixStatus: string | null = null;
    let rootCause: string | null = null;
    let proposedFix: string | null = null;

    if (proofPassed === true) {
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

    // Build reason additively: deterministic invariants first, judge prose second.
    const detReason = s.deterministicReason;
    const judgeProse = s.judge.criteria
      .filter((c) => !c.passed)
      .map((c) => c.reason)
      .join("; ");
    let reason = "";
    if (detReason) {
      reason = `deterministic: ${detReason}`;
      if (judgeProse) reason += ` | judge: ${judgeProse}`;
    } else {
      reason = judgeProse;
    }

    return {
      run_id: runId,
      case_id: s.testCase.id,
      category: s.testCase.category,
      criticality: s.testCase.criticality,
      transcript: JSON.parse(JSON.stringify(s.run.transcript)),
      success_criteria: JSON.parse(JSON.stringify(s.testCase.success_criteria)),
      passed: passedBool,
      proof_passed: proofPassed,
      quality_passed: qualityPassed,
      verdict: s.judge.verdict,
      reason,
      applied_invariants: s.appliedInvariants ?? [],
      root_cause: rootCause,
      proposed_fix: proposedFix,
      fix_status: fixStatus,
      bot_segments: totalBotSegments(s.run.transcript),
      reached_checkout: conversationReachedCheckout(s.run.transcript),
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