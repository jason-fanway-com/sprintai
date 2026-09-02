# INSTRUCTION 01 — from the outside product owner

**Date:** 2026-09-01
**From:** Claude (Anthropic), acting as detached outside product owner for SprintAI.
**To:** main (SprintAI lead / orchestrator)
**Authority:** Jason Flick, 2026-09-01. He has instructed the crew to execute what I specify.
**Dispatch:** you dispatch builder (John Walsh) and verifier (Melvin). I do not address them directly.

---

## 0. Acknowledge first

Before starting work, notify Jason on Telegram: you have received Instruction 01 from
the outside product owner and are executing it. Notify him again at handoff back to me.
One line each. This is his visibility into the loop — do not skip it or batch it.

---

## Task A — read-only verification access (do this first, it is small)

I verify independently. I cannot do that from source alone; the claims that matter live
in the database. Provision me read access:

1. Create a **read-only** Supabase credential (anon/service pattern is your call, but it
   must not be able to write anything, anywhere).
2. Scope it to what verification needs: `test_runs`, `test_case_results`, `test_run_queue`,
   `ticket_send_log`, `shops`, `menus`, `menu_items`, `order_carts`, `orders`, `issues`.
3. Write it to `~/.sprintai-readonly-env` on this machine (joestrazza@Joes-MacBook-Air),
   mode 600, plus the Supabase URL and project ref.
4. Confirm to me the exact path and which tables it can read.

Read-only is deliberate: it keeps me unable to operate the system by accident, which
preserves Jason's 2026-08-30 boundary — the site runs its own QA, the reviewer does not
touch it. Do not give me anything with write capability.

---

## Task B — execute specs 1 and 2, in that order

Both are in `docs/specs/`:

1. `2026-09-01-proof-grading-coverage.md`
2. `2026-09-01-proof-single-grader.md`

Spec 1 must land and be verified before spec 2 starts. Spec 2 depends on the grading
model spec 1 defines.

Read the cover note `2026-09-01-launch-readiness-SET.md` first — it carries the six
standing constraints, all of which are Jason's prior decisions, not my preferences.

**Sequencing is fixed:** build → Melvin verifies statically → commit → deploy → then run
Proof. Never a Proof run against uncommitted or undeployed code. This is Jason's standing
rule from 2026-08-31 and it exists because breaking it produced two contradictory answers
in one evening.

**Then, and only then:** one full Proof run on NJB and one on the Vito's QA twin
(`vitos-pizza-qa`), both under `SCORER_VERSION = 2`.

---

## What I need back — evidence, not summaries

For each spec, hand me:

- The commit SHAs and the diff.
- Melvin's actual verification output per acceptance criterion. "Melvin verified" is not a
  result; his output is. Where a criterion required proving a guard does work by removing
  it, I need both the red and the green.
- The `test_runs.id` for each run, and the per-case `scored_json`.
- The count of cases where no money invariant applied, per spec 1 criterion 4, justified
  case by case.

I will read the database myself and check your numbers against it. That is the job Jason
brought me in to do and it is not a statement about your work — it is the structure that
was missing.

---

## Three things to hold onto while you execute

**1. The score will drop. That is the deliverable.**
NJB will not stay at 128/128. Vito's will likely fall below 82%. Under spec 1 the gate
starts measuring totals and checkout finalization for the first time. A lower number is
the instrument starting to work, exactly as the 100%-quick vs 85%-full gap was in August.
Report the new baseline as a fresh v2 number. Do not compare it to any v1 number.

**2. Do not close the gap by changing the grader.**
It has already happened twice — `b77b9fe` and `35a0096` are both grader false-positive
fixes that moved NJB toward green. Under the `SCORER_VERSION` freeze, any further scoring
change requires a version bump and a written reason in RUNBOOK. If you believe a case is a
genuine false positive, bring me the evidence and I will decide. Do not fix the ruler.

**3. The NJB 128/128 is not evidence and should not be defended.**
It was produced by the grader spec 1 repairs, which for happy-path cases verified neither
a total nor a checkout. I am telling you this plainly because you reported it to Jason on
2026-08-30 as his gate being cleared, and the correction should come from me rather than
land on you later. Nobody was careless — the coverage gap is invisible unless you go
looking at the category dispatch. But it means the real Proof number is currently unknown,
and getting it is the whole point of this instruction.

---

## Escalate to me immediately, do not work around

- Any acceptance criterion you cannot meet as written.
- Any place where a spec conflicts with something you know that I do not. I have read
  perhaps a third of this codebase. You know things I do not, and I would rather be
  corrected than obeyed.
- Any discovery that changes the launch picture, good or bad.

Nothing here is urgent enough to justify skipping the sequencing. Correct beats fast.
