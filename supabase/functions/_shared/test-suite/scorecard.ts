/**
 * scorecard.ts — Aggregate run results: overall pass %, per-category subscores,
 * critical failures. Tiered pass = (overall ≥95%) AND (100% of critical subset).
 * Averaging MUST NOT hide a critical failure.
 */

import type { AnyCase } from "./library.ts";
import type { JudgeResult } from "./judge.ts";
import type { RunResult } from "./runner.ts";
import type { FixResult } from "./fix.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScorecardCategory {
  total: number;
  passed: number;
  failed: number;
  passPct: number;
}

export interface Scorecard {
  total: number;
  passed: number;
  failed: number;
  overallPassPct: number;
  /** Per-category subscores keyed by category name. */
  categories: Record<string, ScorecardCategory>;
  /** Critical cases that FAILED — must be empty for go-live. */
  criticalFailures: Array<{ caseId: string; label: string; reason: string }>;
  criticalTotal: number;
  criticalPassed: number;
  criticalPassPct: number;
  /** Tiered pass gate. */
  tieredPass: boolean;
  /** Proof gate: deterministic invariants only. */
  proofPassPct: number;
  /** Proof: count of ungraded cases (null proofPassed). */
  proofUngraded: number;
  /** Advisory: LLM judge verdict only. */
  qualityPassPct: number;
}

export interface ScoredCase {
  testCase: AnyCase;
  judge: JudgeResult;
  run: RunResult;
  fix?: FixResult | null;
  /** Programmatic invariants applied to this case (e.g. "cartops:total:PASS"). */
  appliedInvariants?: string[];
  /** Human-readable detail from deterministic invariant failures. */
  deterministicReason?: string;
  /** Deterministic gate pass (invariants only, no judge).
   *  true = materially evaluated and passed, false = failed,
   *  null = no invariants applied (ungraded). */
  proofPassed?: boolean | null;
  /** LLM judge advisory verdict. */
  qualityPassed?: boolean;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function buildScorecard(scored: ScoredCase[]): Scorecard {
  const total = scored.length;
  let passed = 0;
  const categories: Record<string, ScorecardCategory> = {};
  const criticalFailures: Scorecard["criticalFailures"] = [];
  let criticalTotal = 0;
  let criticalPassed = 0;

  for (const s of scored) {
    const cat = s.testCase.category;
    if (!categories[cat]) categories[cat] = { total: 0, passed: 0, failed: 0, passPct: 0 };
    categories[cat].total++;

    // Three-state: true=materially passed, false=materially failed, null/undefined=ungraded
    if (s.proofPassed === true) {
      passed++;
      categories[cat].passed++;
    } else if (s.proofPassed === false) {
      categories[cat].failed++;
    }
    // null → ungraded: counted in total but not in passed or failed

    if (s.testCase.criticality === "critical") {
      criticalTotal++;
      if (s.proofPassed === true) {
        criticalPassed++;
      } else if (s.proofPassed === false) {
        criticalFailures.push({
          caseId: s.testCase.id,
          label: s.testCase.label,
          reason: s.deterministicReason || s.judge.criteria
            .filter((c) => !c.passed)
            .map((c) => c.reason)
            .join("; ") || "no criteria passed",
        });
      }
      // null critical → ungraded, not a failure
    }
  }

  // ── Compute percentages ─────────────────────────────────────────────────
  for (const cat of Object.values(categories)) {
    cat.passPct = cat.total > 0 ? (cat.passed / cat.total) * 100 : 0;
  }

  const overallPassPct = total > 0 ? (passed / total) * 100 : 0;
  const criticalPassPct = criticalTotal > 0 ? (criticalPassed / criticalTotal) * 100 : 100;

  // ── Split scores: proof (gate, deterministic) and quality (advisory, LLM judge) ──
  let proofPass = 0;
  let proofFail = 0;
  let proofUngraded = 0;
  let qualityPass = 0;
  let qualityFail = 0;
  for (const s of scored) {
    if (s.proofPassed === true) proofPass++;
    else if (s.proofPassed === false) proofFail++;
    else if (s.proofPassed === null) proofUngraded++;
    else proofUngraded++; // undefined = no v3 fields populated (e.g. CLI run.ts)
    if (s.qualityPassed === true) qualityPass++;
    else qualityFail++;
  }
  const proofPassPct = (proofPass + proofFail) > 0 ? (proofPass / (proofPass + proofFail)) * 100 : 0;
  const qualityPassPct = (qualityPass + qualityFail) > 0 ? (qualityPass / (qualityPass + qualityFail)) * 100 : 0;

  // ── Tiered gate: proof ≥95% AND 100% critical ────────────────────────
  const tieredPass = proofPassPct >= 95 && criticalPassPct >= 100 && criticalFailures.length === 0 && proofUngraded === 0;

  return {
    total,
    passed: proofPass,
    failed: proofFail,
    overallPassPct: proofPassPct,
    categories,
    criticalFailures,
    criticalTotal,
    criticalPassed,
    criticalPassPct,
    tieredPass,
    proofPassPct,
    proofUngraded,
    qualityPassPct,
  };
}

export function formatScorecard(sc: Scorecard, shopName: string): string {
  const lines: string[] = [];
  lines.push(`\n═══ TEST SUITE SCORECARD — ${shopName} ═══`);
  lines.push(`Total: ${sc.total} | Passed: ${sc.passed} | Failed: ${sc.failed} | Ungraded: ${sc.proofUngraded}`);
  lines.push(`Proof ${sc.passed}/${sc.passed + sc.failed} graded = ${sc.proofPassPct.toFixed(1)}%  |  ${sc.proofUngraded} ungraded  |  Quality ${sc.qualityPassPct.toFixed(1)}%`);
  lines.push(`Critical pass: ${sc.criticalPassed}/${sc.criticalTotal} (${sc.criticalPassPct.toFixed(1)}%)`);
  lines.push(``);
  lines.push(`Category subscores:`);
  for (const [cat, v] of Object.entries(sc.categories)) {
    const bar = "#".repeat(Math.round(v.passPct / 10)) + ".".repeat(10 - Math.round(v.passPct / 10));
    lines.push(`  ${cat.padEnd(16)} [${bar}] ${v.passed}/${v.total} (${v.passPct.toFixed(1)}%)`);
  }
  lines.push(``);
  if (sc.criticalFailures.length > 0) {
    lines.push(`CRITICAL FAILURES (blocking go-live):`);
    for (const f of sc.criticalFailures) {
      lines.push(`  ✗ [${f.caseId}] ${f.label}`);
      lines.push(`      ${f.reason}`);
    }
  } else {
    lines.push(`No critical failures.`);
  }
  lines.push(``);
  lines.push(`TIERED PASS (proof gate): ${sc.tieredPass ? "✅ PASS" : "❌ FAIL"}`);
  if (!sc.tieredPass && sc.overallPassPct >= 95) {
    lines.push(`  (Proof ≥95% met, but critical subset failed — averaging did NOT hide it.)`);
  }
  return lines.join("\n");
}