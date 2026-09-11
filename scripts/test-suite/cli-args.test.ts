/**
 * cli-args.test.ts — regression test for the equals-form flag bug.
 *
 * Incident (2026-09-11): --cases=id1,id2,... (one token) never matched
 * args.indexOf("--cases") (which requires the two-token space form), so the
 * filter was silently skipped and the full 151-case suite ran instead of
 * the intended 10. Nothing distinguished "no filter requested" from
 * "filter requested but silently ignored".
 *
 * Run: deno test --allow-read scripts/test-suite/cli-args.test.ts
 */
import { getFlagValue, hasFlag, UnrecognizedFlagError, validateFlags } from "./cli-args.ts";

function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

Deno.test("getFlagValue: --cases=a,b,c (equals-form) returns the value", () => {
  const args = ["shop123", "--cases=a,b,c"];
  assertEquals(getFlagValue(args, "cases"), "a,b,c", "equals-form --cases must resolve");
});

Deno.test("getFlagValue: --cases a,b,c (space-form) returns the same value", () => {
  const args = ["shop123", "--cases", "a,b,c"];
  assertEquals(getFlagValue(args, "cases"), "a,b,c", "space-form --cases must resolve identically");
});

Deno.test("getFlagValue: equals-form and space-form produce identical filters", () => {
  const toSet = (raw: string | null) =>
    raw === null ? null : new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));

  const eqFilter = toSet(getFlagValue(["shop123", "--cases=menu-single-0,menu-single-1"], "cases"));
  const spaceFilter = toSet(getFlagValue(["shop123", "--cases", "menu-single-0,menu-single-1"], "cases"));

  assertEquals(eqFilter?.size, 2, "equals-form filter should have 2 entries");
  assertEquals(spaceFilter?.size, 2, "space-form filter should have 2 entries");
  assertEquals([...(eqFilter ?? [])].join(","), [...(spaceFilter ?? [])].join(","), "both forms must filter identically");
});

Deno.test("getFlagValue: absent flag returns null (distinguishable from empty)", () => {
  assertEquals(getFlagValue(["shop123"], "cases"), null, "no --cases at all must be null");
});

Deno.test("getFlagValue: --limit works in both forms (same landmine, other flag)", () => {
  assertEquals(getFlagValue(["shop123", "--limit=5"], "limit"), "5", "equals-form --limit");
  assertEquals(getFlagValue(["shop123", "--limit", "5"], "limit"), "5", "space-form --limit");
});

Deno.test("getFlagValue: --trigger/--change-set/--initiated-by work in both forms", () => {
  assertEquals(getFlagValue(["shop123", "--trigger=manual-investigation"], "trigger"), "manual-investigation");
  assertEquals(getFlagValue(["shop123", "--trigger", "manual-investigation"], "trigger"), "manual-investigation");
  assertEquals(getFlagValue(["shop123", "--change-set=abc123"], "change-set"), "abc123");
  assertEquals(getFlagValue(["shop123", "--initiated-by=jason"], "initiated-by"), "jason");
});

Deno.test("hasFlag: --dry-run is detected as a boolean flag", () => {
  assertEquals(hasFlag(["shop123", "--dry-run"], "dry-run"), true);
  assertEquals(hasFlag(["shop123"], "dry-run"), false);
});

Deno.test("validateFlags: recognized flags in either form pass silently", () => {
  validateFlags(["shop123", "--cases=a,b,c", "--limit", "5", "--dry-run"]);
  // No throw = pass.
});

Deno.test("validateFlags: unrecognized flag (typo) throws UnrecognizedFlagError, doesn't silently no-op", () => {
  let threw: unknown = null;
  try {
    validateFlags(["shop123", "--csaes=x"]);
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof UnrecognizedFlagError)) {
    throw new Error(`Expected UnrecognizedFlagError for typo'd flag, got: ${threw}`);
  }
  assertEquals((threw as UnrecognizedFlagError).flag, "--csaes=x", "error should name the offending token");
});

Deno.test("validateFlags: unrecognized space-form flag also throws", () => {
  let threw: unknown = null;
  try {
    validateFlags(["shop123", "--bogus", "value"]);
  } catch (e) {
    threw = e;
  }
  if (!(threw instanceof UnrecognizedFlagError)) {
    throw new Error(`Expected UnrecognizedFlagError for unknown flag, got: ${threw}`);
  }
});

Deno.test("validateFlags: value flag's space-form argument isn't mistaken for a stray flag", () => {
  // "5" doesn't start with "--" so this would pass regardless, but make sure
  // the loop correctly skips the value token and doesn't double-count it.
  validateFlags(["shop123", "--limit", "5", "--cases=a,b"]);
});
