/**
 * Regression test — persist.ts MUST refuse invalid v3 data.
 *
 * Motivated by the false green on 2026-09-02: run.ts (old CLI) never populated
 * proofPassed, every case arrived as `undefined`, the old scorecard counted
 * undefined as PASS, and persist happily wrote a fake 128/128 (NJB run
 * 2deb0599). assertValidProofData now throws BEFORE any DB write. Red-then-green:
 * this test fails the moment that guard is removed or weakened.
 *
 * Run: deno test --allow-net scripts/test-suite/persist-guard.test.ts
 */
import { assertValidProofData } from "./persist.ts";
import type { ScoredCase } from "./scorecard.ts";

Deno.test("assertValidProofData THROWS on undefined proofPassed (regression: false green 2deb0599)", () => {
  const bad = [
    { testCase: { id: "ok-1" }, proofPassed: true },
    { testCase: { id: "poison" }, proofPassed: undefined },
  ] as unknown as ScoredCase[];

  let threw = false;
  let msg = "";
  try {
    assertValidProofData(bad);
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }

  if (!threw) {
    throw new Error("REGRESSION: assertValidProofData accepted an undefined proofPassed — false greens can return.");
  }
  if (!msg.includes("poison")) {
    throw new Error(`Guard threw but did not name the offending case; got: ${msg}`);
  }
});

Deno.test("assertValidProofData PASSES a valid three-state set (true / false / null)", () => {
  const ok = [
    { testCase: { id: "a" }, proofPassed: true },
    { testCase: { id: "b" }, proofPassed: false },
    { testCase: { id: "c" }, proofPassed: null },
  ] as unknown as ScoredCase[];

  // Must not throw. null = ungraded is legitimate; only undefined is invalid.
  assertValidProofData(ok);
});
