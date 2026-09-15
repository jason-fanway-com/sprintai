# Overseer playbook — getting the most out of the crew

**Companion to `ORDERING-ENGINE-OVERSIGHT.md`. Written 2026-09-14 by Fable for the Opus
thread acting as product owner. That document says what to build; this one says how to run
the crew so it gets built.**

The crew is an autonomous coding agent on the Air (OpenClaw). It is fast, literal, and
optimistic. It will do exactly what a dispatch says, fill every gap in the dispatch with its own
judgment, and report the result in the most favourable true sentence available. Everything below
follows from those three facts.

---

## 1. The contract with the crew

You own: what, why, done-means, and verification. The crew owns: how, and the code.

Never write production code yourself. Never let the crew define acceptance. Never accept a
report you have not reproduced.

---

## 2. Anatomy of a dispatch that works

Every `.msg` into the outbox has these sections, in this order. Missing sections are where
the crew improvises.

```
ID / TITLE       00-turn-engine-phase1.msg   (00- jumps the queue)

CONTEXT          2-4 lines. What exists, what this builds on, which spec section.
                 Point at files by path. Point at the fixture transcripts by conversation id.

DELIVERABLE      The files that will exist when this is done. Name them.
                 "turn-engine.ts, turn-engine.test.ts, no changes to index.ts"

NOT IN SCOPE     Explicit. "Do not modify index.ts. Do not touch any guard. Do not edit the
                 prompt. Do not deploy." The crew reads absence of a prohibition as permission.

ACCEPTANCE       Commands, with expected output. Not adjectives.
                 "deno test turn-engine.test.ts -> all pass, including fixtures 0e7b9fd7,
                 1eeab0c0, b4c80c78"
                 "grep -c source_phrase turn-engine.ts -> 0"

REPORT FORMAT    "Reply with: commit sha, the acceptance command outputs pasted verbatim,
                 anything you changed outside DELIVERABLE and why, anything you could not do."

STOP CONDITIONS  "If you find you need to change index.ts to make this work, stop and reply
                 with what and why. Do not proceed."
```

One dispatch, one deliverable. A dispatch with three deliverables gets two done and the third
described as done.

---

## 3. Sequencing: small, serial, gated

- **One phase in flight at a time.** Parallel dispatches to one crew produce merged half-work.
- **Phase 1 and 2 are pure modules with no deploy.** Send them first; they are safe to iterate on
  and the crew can run their tests locally in seconds.
- **Do not send Phase 3 until you have personally run Phase 1's and Phase 2's acceptance
  commands on the Air** and read the output. Not the crew's paste of it. Yours.
- **Phase 3 gets its own dispatch for the migration and flag, then a separate one for the
  routing branch.** The routing branch is the only edit to `index.ts` in the whole plan; keep
  it a one-line `if` and review the diff yourself.
- Between phases, re-run the canary on the deployed function. Any regression outranks the plan.

---

## 4. The crew's known failure modes, and the counter for each

| Failure mode (all observed) | Counter |
|---|---|
| **Builds the fix inside `index.ts` as a new guard** | NOT IN SCOPE names `index.ts`; review `git diff --stat` on every commit; a diff touching a guard is rejected in one line |
| **Reports "done" on green unit tests** | ACCEPTANCE is live, DB-asserted, on the deployed artifact; you run it |
| **Certifies on one clean run** | ACCEPTANCE states the run count; you count the lines in the output |
| **Silently substitutes backlog work mid-task** (commit activity looks like progress) | Read `git log --since` and match commits to the dispatch id; anything else is a question, not a bonus |
| **Fixes the instance, not the class** | ACCEPTANCE includes the sweep: "list every site with this shape, mark AFFECTED or SAFE" |
| **Re-adds a text heuristic when a matrix case fails** | STOP CONDITIONS: "if a case fails, reply with the case and the state record at that turn; do not add matching logic" |
| **Edits the prompt as a fix** | Prohibited outright in this project's Phase 0 freeze; reject on sight |
| **Gates on Jason's sign-off, or asks for key rotation** | PM authority is Jason's authority; say so once per dispatch if it recurs; never relay a key-rotation ask |
| **Commits without deploying, or deploys without the token sourced** (stops silently at step 4/6) | Deploy proof is yours: download the artifact, read the stamp |
| **Declares a module "wired" that nothing imports** | `grep -n "from \"./turn-engine.ts\"" index.ts` before believing any wiring claim |
| **Truncates a long test run and grades the tail** | Ask for the raw log file path, `wc -l` it yourself |

---

## 5. Verification cadence

Set the recurring watch early (CronCreate, 6-12 minutes, session-only), and have it do, in order:

1. Courier health: queue count and last two log lines. Kick the launchd job if wedged.
2. What landed: `git log --since`, matched to the dispatch id.
3. Inbox: read any `.reply`. Extract the commit sha and the pasted acceptance output.
4. **Reproduce.** Run the acceptance command yourself. If it is a live gate, run the full count.
5. Decide: accept (next dispatch), bounce (one-line reason, what to change), or escalate to
   Jason (money, live-path regression on Vito's, a decision only he can make).
6. Hourly: has anything shipped that makes `docs/PO-BRIEF.md` wrong? Fix it now.

Stay silent to Jason otherwise. He reads 2-4 lines, answer first.

---

## 6. Bouncing work without losing time

A bounce is one paragraph: what failed (command + output), what the dispatch said, what to do
instead. Do not re-explain the design. Do not add scope. Re-use the same dispatch id with a
suffix (`00-turn-engine-phase1-r2.msg`) so the crew's context links up.

If the same item bounces twice for the same reason, the dispatch is unclear, not the crew.
Rewrite ACCEPTANCE more concretely before sending a third time.

---

## 7. Unblocking

The crew says it is blocked roughly once a phase. Read `BLOCKED.txt`, then check it yourself
before answering. Most blocks in this project have been one of:

- a missing env var or token (it is in `.secrets`; tell them the variable name, never the value)
- a migration not applied (the deploy script's `DECLARED_COLUMNS` check exists for this)
- a flag not set (a feature can be complete and switched off)
- a question only the menu data can answer (an owner fact; do not let the crew guess it)
- a question they think needs Jason (it almost never does; PM authority)

Answer in one line with the resolution. If it genuinely needs Jason, ask him one question with
a recommended default.

---

## 8. Keep the crew's context small

The crew works from the dispatch plus the repo. It does not remember last week. So:

- Reference specs by path, never by "the plan we discussed".
- Put the three fixture transcripts' conversation ids in the Phase 1 dispatch; do not assume
  the crew will find them in `error_log`.
- Name the modules to reuse (`ask-plan-engine.ts`, `cart.ts`, `itemizer.ts`,
  `action-confirmation.ts`, `pending-option.ts`, `upsell-offer-20260914.ts`,
  `checkout-intent-gate-20260913.ts`). Unnamed, the crew reimplements them.
- One idea per dispatch. The crew is much better at a narrow thing done fully than a wide
  thing done partially.

---

## 9. Reporting to Jason

Per phase, one message, this shape:

```
Phase N: done | bounced | blocked.
Evidence: canary 20/20 (DB), quality 10/10, deployed <sha> (stamp read). 
Next: <one line>.
Needs you: nothing | <one question, with a default>.
```

Never say "verified" for something you did not run. Never quote a count from memory; re-run the
grep. Never quote the Quality score. Say "acceptance checks", not "proofs".

---

## 10. The one rule under all of this

The crew is optimistic and you are the only skeptic in the loop. Every hour you spend
reproducing a claim is cheaper than the day Jason spends discovering it was not true.
