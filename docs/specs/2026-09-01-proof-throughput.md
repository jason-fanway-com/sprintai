# Spec: Proof throughput — parallelize the tick, don't enlarge the batch

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** 6 of 6. **DO NOT SHIP UNTIL THE FIRST CLEAN v2 BASELINE RUN EXISTS.** See §Sequencing.
**Scorer impact:** NONE. This changes throughput only. If any score moves, the change is wrong.
**Approved by Jason 2026-09-01** ("ok to raising the batch size") — with the caveat below that raising the batch size alone is the wrong implementation.

## Why

A full Proof run takes 52–71 minutes. That is the feedback loop for every shop, forever, and at scale it is the onboarding critical path.

It is not slow because there are 128 cases. It is slow because of how the tick is shaped:

```
test-runner/index.ts:30    const BATCH_SIZE = 2;
test-runner/index.ts:117   for (let i = caseIdx; i < endIdx; i++) {
test-runner/index.ts:122     const runResult = await runCase(runConfig, shopId, tc);   // sequential await
migration 070              cron every 60s, timeout_milliseconds := 300000
```

128 cases ÷ 2 per tick × 60s = **64 minutes floor, independent of how fast a case actually runs.** Observed 52–71 min matches.

Meanwhile each tick uses roughly 48s of a **300s** budget. There is ~6× headroom inside the tick that is being left on the floor, because the two cases run one after the other.

## Why NOT simply raise BATCH_SIZE

The obvious change — `BATCH_SIZE = 10` — makes each tick ~240s. That still fits the 300s function timeout, but it badly exceeds the **60s cron interval**, so tick N+1 fires while tick N is still running. Both then operate on the same queue row and the same `case_index`. Consequences: double-processed cases, lost checkpoints, and ticks killed mid-case — which is precisely the orphaned-`running`-row failure mode that cost us two hours on 2026-09-01.

Do not raise `BATCH_SIZE` on the sequential loop. It trades an hour of latency for a correctness bug we have already been bitten by.

## Fix — bounded concurrency inside the tick, under a time budget

1. **Run the batch concurrently.** Replace the sequential `for … await runCase` with a bounded-concurrency map (`Promise.allSettled` over a worker pool). Cases are independent — each has its own `session_id` and its own conversation — so there is no shared state between them within a batch.
2. **Bound the concurrency explicitly.** Start at **8**. The binding constraint is not the edge function, it is the LLM provider: 8 concurrent cases means up to 8 simultaneous `chat-sms` conversations, each making OpenRouter calls. Rate limiting is the real ceiling and it must be measured, not assumed.
3. **Time-budget the tick, don't count cases.** Keep pulling parallel groups until either the queue is drained or elapsed time reaches a budget of **240s** (of the 300s timeout). Then checkpoint and return cleanly. The tick must always end on its own terms — never be killed by the timeout mid-case, because that is what strands a job.
4. **Checkpoint after each settled group, not per case.** Parallel cases must not race on the queue row's progress fields. One write per group, after `allSettled` resolves.
5. **`allSettled`, never `all`.** One failing case must not discard the results of the seven that succeeded alongside it. A rejected case is recorded as a failure with its reason and the group still checkpoints.

## Measure before choosing the number

Do not pick a concurrency value from this spec and ship it. Instrument first:

- Log per-case wall time, split by case type (single-turn menu-derived vs 6-turn conversational — these differ by roughly an order of magnitude).
- Log per-tick elapsed time and how much of the 240s budget was used.
- Run one full Proof at concurrency 4, then one at 8. Compare wall time, failure count, and any provider 429s.

**If the failure count changes between concurrency levels, stop.** That means concurrency is affecting results — a rate limit, a timeout, or shared state we did not account for. A throughput change that alters scores is a correctness bug, not an optimization.

## Expected outcome

At concurrency 8 with a 240s tick budget, a 128-case run should land in **well under 10 minutes** versus 52–71 today. The exact number depends on measured per-case latency and where provider rate limits bite.

## Sequencing — this is the part that matters

**Do not ship this until a clean `scorer_version = 2` baseline run exists on both Vito's QA and the NJB clone.**

Reason: as of today the edge function is the sole drainer for the first time (`worker.ts` retired), and it has completed a full unaided run exactly **twice**, both on 2026-08-31. We are about to test it carrying 128 cases alone. If we simultaneously change its concurrency model and the run fails, we cannot tell whether the cause is spec 1, the sole-drainer change, or this. Three variables, one signal.

Order: clean v2 baseline at `BATCH_SIZE = 2` → then instrument → then concurrency 4 → then 8.

## Dependency

This should land **after or alongside** the telemetry and reaper work in spec 2. Concurrency increases the number of in-flight cases a killed tick can strand, so trustworthy queue progress and a working stale-run reaper matter more once this ships, not less.

## Acceptance (Melvin verifies)

1. A full 128-case run completes end to end at the new concurrency, with the same pass/fail set as the `BATCH_SIZE = 2` baseline run on the same shop and same commit. **Same scores, less time.** Any score delta fails this criterion.
2. Per-tick elapsed never exceeds the 240s budget; no tick is killed by the 300s timeout.
3. Ticks never overlap: instrument invocation start/end and prove no two ticks were in flight simultaneously during a full run.
4. A deliberately failing case does not discard its concurrent siblings — verify with an induced failure that the other 7 in the group still record results.
5. No provider 429s at the chosen concurrency across a full run. If any occur, the concurrency is too high; report the number rather than silently retrying past it.
6. Queue progress fields remain accurate throughout (depends on spec 2's telemetry fix).

## Out of scope

- Reducing the case count. Audited separately 2026-09-01: only 12 of ~199 distinct cases have never failed across 5+ executions, so redundancy is ~6% and not worth the coverage risk. The real rebalance (fewer menu-walk permutations, more conversational/adversarial/proof cases) should wait for v2 discrimination data.
- The two category typos (`happy` → `happy-path`, `86`) — separate, trivial, and worth doing now since six cases were silently falling through category dispatch under v1.
