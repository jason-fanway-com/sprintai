# Spec: Proof capped runs — `max_cases` + `case_filter` for fast smoke iteration

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** P1 tonight — enabler for the fix→re-run loop. Highest value.
**Scorer impact:** NONE. This changes WHICH cases run, never HOW a case is scored. If any per-case score or `scorer_version` moves, the change is wrong.

## Why

Tonight's deliverable is proving the test loop turns: smoke run → read failures → fix top product bug → smoke re-run proves it cleared. A full Proof run is 128 cases / 52–71 min. That is far too slow to iterate twice in an evening.

`test-runner/index.ts` currently generates the **entire** suite on the first tick (`cases = genResult.cases; totalCases = cases.length`) with no way to cap it (confirmed: no `max_cases`/`limit`/`capped` param anywhere). We need a capped, deterministic subset run — a "smoke" — and the ability to re-test one specific failing case after a fix.

## Fix — read two optional fields off the queue row

In `test-runner/index.ts`, first-tick block (after `generateCases`, before persisting `total_cases`):

1. **`job.case_filter`** (optional `string[]` of case ids). If present and non-empty: keep only cases whose id is in the list, preserving generated order. This is how the SECOND smoke re-tests exactly the case a fix targeted (e.g. `["menu-single-0"]`).
2. **`job.max_cases`** (optional positive int). If present and `> 0`: after any `case_filter`, deterministically cap to the first `max_cases` cases. Ordering must be **stable and deterministic** across runs (do not shuffle) so a smoke-N is reproducible.
3. Apply `case_filter` first, then `max_cases`. If neither is set, behavior is unchanged (full suite).
4. `total_cases` = the capped length. The run must complete normally, write a `test_runs` row with `scorer_version = 2`, and the Production Readiness surface must show the capped count honestly (N of N), not 128.
5. A capped run is a real run: same grading path, same invariants, same persistence. Only the case set is smaller.

## Acceptance criteria (Melvin, static + one live smoke)

1. `deno check` clean on `test-runner/index.ts`.
2. With `max_cases = 10` on the queue row: run generates full suite, caps to 10 in stable order, `total_cases = 10`, completes, writes `test_runs` row with `scorer_version = 2`.
3. With `case_filter = ["menu-single-0"]`: run processes exactly that one case and writes a row.
4. With neither field set: full suite runs unchanged — case count and per-case scores identical to a pre-change run (scorer untouched).
5. Ordering is deterministic: two `max_cases = 10` runs process the same 10 case ids in the same order.

## Constraints (Jason's standing rules)

- Sequencing: build → Melvin static-verify → commit → deploy → THEN run. Never a Proof run against uncommitted/undeployed code.
- Do not touch the scorer, the grading path, `chat-sms`, safety gates, protected-shop logic, or shop data.
- Generalize: this must work for any shop, not just Vito's QA.

## Hand back

Diff + commit SHA, `deno check` exit, and Melvin's per-criterion output. Do not commit/deploy/run until the lead says both P1 and P2 are landed and verified together.
