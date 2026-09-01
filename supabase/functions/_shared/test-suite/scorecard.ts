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

    const isPassed = s.judge.passed;
    if (isPassed) {
      passed++;
      categories[cat].passed++;
    } else {
      categories[cat].failed++;
    }

    if (s.testCase.criticality === "critical") {
      criticalTotal++;
      if (isPassed) {
        criticalPassed++;
      } else {
        criticalFailures.push({
          caseId: s.testCase.id,
          label: s.testCase.label,
          reason: s.judge.criteria
            .filter((c) => !c.passed)
            .map((c) => c.reason)
            .join("; ") || "no criteria passed",
        });
      }
    }
  }

  // ── Compute percentages ─────────────────────────────────────────────────
  for (const cat of Object.values(categories)) {
    cat.passPct = cat.total > 0 ? (cat.passed / cat.total) * 100 : 0;
  }

  const overallPassPct = total > 0 ? (passed / total) * 100 : 0;
  const criticalPassPct = criticalTotal > 0 ? (criticalPassed / criticalTotal) * 100 : 100;

  // ── Tiered gate: overall ≥95% AND 100% critical ────────────────────────
  const tieredPass = overallPassPct >= 95 && criticalPassPct >= 100 && criticalFailures.length === 0;

  return {
    total,
    passed,
    failed: total - passed,
    overallPassPct,
    categories,
    criticalFailures,
    criticalTotal,
    criticalPassed,
    criticalPassPct,
    tieredPass,
  };
}

export function formatScorecard(sc: Scorecard, shopName: string): string {
  const lines: string[] = [];
  lines.push(`\n═══ TEST SUITE SCORECARD — ${shopName} ═══`);
  lines.push(`Total: ${sc.total} | Passed: ${sc.passed} | Failed: ${sc.failed}`);
  lines.push(`Overall pass: ${sc.overallPassPct.toFixed(1)}%`);
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
  lines.push(`TIERED PASS: ${sc.tieredPass ? "✅ PASS" : "❌ FAIL"}`);
  if (!sc.tieredPass && sc.overallPassPct >= 95) {
    lines.push(`  (Overall ≥95% met, but critical subset failed — averaging did NOT hide it.)`);
  }
  return lines.join("\n");
}