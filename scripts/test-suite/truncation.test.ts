/**
 * truncation.test.ts — Regression test for the 2026-09-12 BUG 4 follow-up.
 *
 * runner.ts's original truncated flag (`!goalReached && !brokeEarly`) treated
 * every max_turns exhaustion as a harness artifact, with no way to tell "was
 * making progress, just needed more turns" apart from "bot stuck in a real
 * loop that consumed all turns" (a genuine looped_no_progress case). The fix
 * adds a third input — phaseAdvanced, whether the bot-reported conversation
 * phase ever changed across the run — and only marks a cap-out as truncated
 * when there's evidence of real progress.
 *
 * Direct unit calls against computeTruncation's own logic — no live bot
 * call, no network, same pattern as safety-gate-channel.test.ts. Imports
 * from truncation.ts, NOT runner.ts: runner.ts has top-level code (a
 * Deno.env.get call) that requires --allow-env, so importing through it
 * would fail a bare `deno test` on a permission prompt.
 *
 * Run: deno test scripts/test-suite/truncation.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeTruncation } from "./truncation.ts";

const BASE = {
  transcriptLength: 8,
  goal: "order a large pepperoni pizza for pickup",
  maxTurns: 8,
};

// (a) max_turns hit, phase advanced at some point → truncated=true.
Deno.test("max_turns cap-out with phase progression is truncated (harness artifact)", () => {
  const result = computeTruncation({
    ...BASE,
    goalReached: false,
    brokeEarly: false,
    phaseAdvanced: true,
  });
  assertEquals(result.truncated, true);
  assertEquals(
    result.truncationNote,
    `customer goal "${BASE.goal}" was NOT reached within ${BASE.maxTurns} turns (harness turn cap)`,
  );
});

// (b) max_turns hit, phase never moved at all → truncated=false (genuine stall).
Deno.test("max_turns cap-out with zero phase progression is NOT truncated (genuine stall)", () => {
  const result = computeTruncation({
    ...BASE,
    goalReached: false,
    brokeEarly: false,
    phaseAdvanced: false,
  });
  assertEquals(result.truncated, false);
  assertEquals(result.truncationNote, undefined);
});

// (c) simulator gives up early (brokeEarly) → truncated=false regardless of
// turns used, even if the phase happened to advance before the give-up.
Deno.test("simulator-decided early give-up is NOT truncated, regardless of phase progression", () => {
  const advanced = computeTruncation({
    ...BASE,
    goalReached: false,
    brokeEarly: true,
    phaseAdvanced: true,
  });
  assertEquals(advanced.truncated, false);

  const flat = computeTruncation({
    ...BASE,
    goalReached: false,
    brokeEarly: true,
    phaseAdvanced: false,
  });
  assertEquals(flat.truncated, false);
});

// Baseline: goal reached outright is never truncated, regardless of the
// other inputs.
Deno.test("goal reached is NOT truncated regardless of phase/brokeEarly", () => {
  const result = computeTruncation({
    ...BASE,
    goalReached: true,
    brokeEarly: false,
    phaseAdvanced: false,
  });
  assertEquals(result.truncated, false);
  assertEquals(result.truncationNote, undefined);
});

// Baseline: an empty transcript (e.g. the very first call errored) is never
// truncated — nothing to grade.
Deno.test("empty transcript is NOT truncated", () => {
  const result = computeTruncation({
    goal: BASE.goal,
    maxTurns: BASE.maxTurns,
    transcriptLength: 0,
    goalReached: false,
    brokeEarly: false,
    phaseAdvanced: true,
  });
  assertEquals(result.truncated, false);
});
