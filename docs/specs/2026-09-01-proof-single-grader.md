# Spec: One grader — the autonomous Proof run must be the deterministic one

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** 2 of 5. Depends on spec 1 (`2026-09-01-proof-grading-coverage.md`) landing first.
**Scorer impact:** YES — folded into the same `SCORER_VERSION` 1 → 2 bump as spec 1.

## Why this exists

Two of Jason's decisions are in tension in the current code, and the tension is invisible from the outside.

**Decision A (#3652, 2026-08-30)** — the Proof gate is deterministic. From the Phase 1 spec, quoting the reason verbatim: *"the bot is probabilistic AND the judge is probabilistic, so the score moves on its own and can never be a real gate."* Architecture principle, marked non-negotiable: **NO LLM grading an LLM.**

**Decision B (#3754, 2026-08-30, logged as a permanent boundary)** — *"qa suite needs to be generated and run as an edge function on the site not by you. You can have no role in onboarding or operations."*

Decision B was implemented correctly: `test-runner` runs server-side on pg_cron (migration 070), drains `test_run_queue`, checkpoints per case, and produced Vito's runs hands-free. That is real and it is right.

But Decision A did not come with it. The server-side path grades with the LLM judge.

## Evidence

`supabase/functions/test-runner/index.ts`:

- **line 19–21** — imports are `judgeCase`, `verifyCartOpsInvariants`, `verifyStatedTotal`. `verifyCheckoutFinalize`, `verifyHallucinationGuard`, and `verifyCartPersistence` are **not imported at all**. The P1/P2/P3 Proof invariants do not exist on this path.
- **line 127** — `let judgeResult = await judgeCase(judgeConfig, runResult, tc, …)`. Every case is LLM-graded first.
- **line 132** — `if (tc.category === "cart-ops")` deterministic override. Same category-string dispatch as spec 1, same 21-case limit.
- **line 141** — `if (tc.category === "hours-closed")` override.
- **line 150** — `verifyStatedTotal` as a pass-only rescue.

Everything else — happy-path, proof, edge, adversarial, compliance, conversational — is scored by `deepseek-v4-flash` judging `deepseek-v4-flash`.

So: the number the shop owner sees on the **Production Readiness** page, the number that produced 85.2% then 82.0% on Vito's, and the number Jason has been reacting to for three days, is the probabilistic-judging-probabilistic score the Proof spec was written to abolish. The deterministic engine is a CLI that only runs when a human types it — which Decision B forbids in the operational loop.

`HANDOFF.md` currently states the server-side runner uses "Same test battery (Proof + CartOps) as the launchd worker." That is not accurate and must be corrected as part of this work.

This also explains score bounce that has been read as product instability. Two graders were being compared as one.

## Fix

Make `test-runner` the single authoritative grader, running the deterministic Proof path.

1. **Port the full invariant set into `test-runner`.** Import and apply, via the same capability dispatch spec 1 introduces: totals, checkout finalize, hallucination guard, cart persistence, hours-closed. `_shared/test-suite/` already holds the code; the function simply does not call it.
2. **Remove `judgeCase` from the gate path.** The Proof pass/fail number must have no LLM call in it. Acceptance criterion 4 of the Phase 1 spec — "No LLM judge call in the Proof gate path (grep clean)" — must hold for `test-runner`, not just `proof.ts`.
3. **Keep the judge, demote it.** The LLM judge stays valuable for the conversational quality read: tone, drift, loops, lost context — things no invariant catches, and the reason the 15 multi-turn cases exist. Persist it as a **separate, clearly-labelled advisory score** that never contributes to pass/fail and never gates go-live. Two fields, two meanings:
   - `proof_score` — deterministic, gate-bearing, 100%-or-no-launch.
   - `quality_score` — LLM-judged, advisory, informational to the owner.
   The admin dashboard must render them as distinct things. An owner must never be shown one number that silently blends a guarantee with an opinion.
4. **`proof.ts` becomes a dev tool, explicitly.** Add a header comment stating it is for local development only and is not the gate; the gate is `test-runner`. Both must import the identical verifiers from `_shared/test-suite/` so they cannot drift again. If the CLI and the function ever disagree on the same shop and commit, that is a bug in this contract.

## Acceptance (Melvin verifies)

1. `grep` proves no judge/LLM call contributes to `proof_score` in `test-runner`.
2. A run on the Vito's QA twin produces both `proof_score` and `quality_score`, persisted separately, with `scorer_version = 2`.
3. `proof.ts` and `test-runner` produce the **same** `proof_score` for the same shop at the same commit. Run both on `vitos-pizza-qa` and diff per case; any divergence is a defect in this spec, not an acceptable variance.
4. Re-running the same shop at the same commit twice produces the identical `proof_score`. Determinism means reproducibility — if it bounces, it is not deterministic and this spec has not landed.
5. Production Readiness renders the two scores distinctly, with the gate-bearing one identified as such.
6. `HANDOFF.md` and `RUNBOOK.md` corrected: the server-side runner's battery and grader described as they actually are.

## Expected outcome

`proof_score` will be lower than the 82.0% currently shown, because it will be graded on more and rescued by nothing. `quality_score` will roughly track the old number. Report both. Do not average them.

## Known related defect (carry, do not lose)

Melvin flagged on 2026-08-31 (#3778) and it was logged as non-blocking: the safety gate that refuses protected/phoned shops fires when a **case runs**, not when a job is **enqueued**. No messages can send either way, but a mistakenly-enqueued protected shop burns cron ticks. Move the gate to enqueue time as part of this pass — it is small and it is in the file already being edited.

## Out of scope

- Grading logic itself — spec 1 defines it; this spec only relocates and unifies it.
- Wiring `proof_score` to `go-live` — spec 3.

## Definition of done

`test-runner` grades deterministically and is the sole gate authority. Judge demoted to advisory with separate persistence and separate display. CLI and function verified identical on one shop. Enqueue-time safety gate moved. Docs corrected. **Commit and deploy before the confirming run** (#3813).
