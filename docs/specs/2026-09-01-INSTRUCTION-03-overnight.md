# INSTRUCTION 03 — Overnight autonomous execution

**Date:** 2026-09-01, ~21:25 EDT
**From:** Claude (outside product owner). **To:** main.
**Mode:** AUTONOMOUS. Jason is going to bed. My monitor dies when he closes his laptop.
Your 15-minute heartbeat is the only thing driving this. Nobody is checking your work
until morning. Read that sentence again before you touch anything.

---

## The one rule that matters tonight

**A red light you understand beats a green light you don't.**

Jason said he'd love to wake up to green. The way to lose his trust permanently is to
manufacture one. If you cannot explain a failure, LEAVE IT FAILING and write down what
you tried. That is a good outcome. A green number you cannot defend is the worst
possible outcome, and it is exactly what this project has already done twice
(`b77b9fe`, `35a0096` — both grader changes that moved the score up).

---

## Trigger

Begin when the Vito's QA 128-run (`22ed2761`) completes and writes its `test_runs` row.
Until then: do nothing but monitor. Do not start fixes against a run in flight.

---

## Step 1 — Record the Vito's baseline

Capture and write to `docs/specs/2026-09-02-baseline-results.md`:
`proof_pass_pct`, `quality_pass_pct`, `ungraded_count`, the deterministic failure list
with invariant names, and the ungraded list with categories. Same for NJB (`eb255196`:
96.40% / 75.00% / 17 ungraded, 4 deterministic failures).

Compare the two shops. **A failure appearing on BOTH shops is shared code. A failure on
one shop only is probably that shop's menu data.** That distinction decides whether a
fix is product code or data, and it is the single most useful thing this pair of runs
gives us.

---

## Step 2 — Fixes, in this order

### FIX A — `correction_reflected` false positive (fixes the 4 NJB failures)

`cart-ops.ts:158` treats bare `just ` / `only ` as a quantity reduction:
```
/\b(just |only |make it 1|one\b|actually.*1|actually.*one)\b/i
```
It fired on "just cheddar I guess" (modifier), "just put it under Alex" (pickup name),
"No thanks, just the salad for now" (decline). None are reductions.

**Do NOT simply delete `just `/`only ` from the regex** — the suite's own
`cartops-reduce-qty` fixture says "Actually, just one — make it 1", which IS a real
reduction and MUST keep failing when the cart doesn't shrink.

**Correct fix:** stop inferring intent from natural language. A deterministic invariant
that regexes English is a judge with worse judgment. The generated cases already know
their own intent — put an explicit expected-cart-delta on the case fixture and have the
invariant check that, not the transcript.

**Acceptable stopgap if the fixture change is too large tonight:** require a quantity
context (`just one`, `only one`, `just N`) rather than bare `just `. One line.

**MANDATORY PROOF, no exceptions:** `cartops-reduce-qty` must still go RED when the cart
fails to shrink. Demonstrate red-then-green. If you cannot show that, the fix is wrong
and you stop.

### FIX B — Deterministic invariants for the safety/compliance cases

These are the highest-stakes cases in the suite and they are currently the LEAST
verified. All three are database assertions, not judgment calls:

- **`tenant-isolation-no-leak`** — assert no row/field belonging to another `tenant_id`
  appears in the reply. The boundary is already in the schema.
- **`stop-opt-out-honored`** — after STOP, assert an `sms_opt_outs` row exists AND no
  subsequent outbound was sent for that (phone, tenant). Both are DB facts.
- **`no-wrong-price-charge`** — assert any quoted/charged price matches `menu_items`.

Mark them `applied: true` only when the case genuinely exercised the path.

### FIX C — Positive assertions for clean refusals

`proof-no-menu-hallucination` is ungraded because `verifyHallucinationGuard` uses
`applied: claimCount > 0` and the bot made zero claims. Correct behaviour, but the case
proves nothing. Add a positive assertion: the bot DECLINED (no cart, no invented item,
refusal present). Same shape for `nonexistent-item`.

### NOT TONIGHT — leave these ungraded and honestly labelled

`abusive-language`, `argumentative-customer`, `price-challenge`, `prompt-injection`.
"Did the bot behave well under abuse" is a genuine quality judgment. These belong to
`quality_score`, not `proof_score`. **Labelling them honestly as judged-not-proven is a
correct answer, not a failure.** Do not invent a fake deterministic check to make the
ungraded count smaller.

---

## Step 3 — Re-run and report

After fixes: Melvin static-verify → commit → deploy → full 128 on BOTH shops.
Sequence unchanged. Never a run against uncommitted or undeployed code.

---

## What "green" honestly means tonight

**Green = `proof_pass_pct` 100% on graded cases, with `ungraded_count` down to only the
4 adversarial cases, each explicitly listed as quality-scored by design.**

Green does NOT mean `ungraded_count = 0`. Reaching zero would require faking checks for
things that cannot be deterministically checked. If you find yourself writing an
invariant that always returns true so a case counts as graded, you have gone wrong.

---

## HARD GUARDRAILS — violating any of these is worse than failing

1. **Never weaken an invariant to make a case pass.** Any change that makes MORE cases
   pass requires: (a) the named false-positive mechanism, (b) the specific input that
   triggers it, (c) proof the invariant still fails on a true positive. All three
   written into the commit message.
2. **Do not touch `chat-sms` tonight.** Every failure found so far has been a harness
   defect. Changing product code overnight, unsupervised, off a possibly-false signal is
   how you break a working ordering bot. If a deterministic failure genuinely proves a
   product bug, WRITE IT UP and leave it for morning.
3. **Do not touch the Telnyx campaign, safety gates, or shop data.**
4. **Two-attempt limit.** If a fix does not work after two attempts, stop, document what
   you tried and what you observed, and move to the next item. Do not grind.
5. **Maximum two full 128-run pairs overnight.** Runs cost time and tokens. If you are
   not converging after two, stop and write up.
6. **`SCORER_VERSION` stays at 2** unless you change scoring semantics, in which case
   bump it and record why. Fixing a false positive is a scoring change — think about
   whether it warrants v3 and say so either way.
7. **Verify before claiming.** Run the query that would prove your claim false. This
   caught a duplicate enqueue on its first use today.

---

## Morning report — leave this in `docs/specs/2026-09-02-overnight-report.md`

Written for Jason to read in two minutes, before I am awake to interpret it:
1. Both shops: `proof_pass_pct`, `quality_pass_pct`, `ungraded_count`, before and after.
2. What you fixed, and for each: the false-positive mechanism and the red-then-green proof.
3. What you could NOT fix, and what you tried. **This section is as valuable as the wins.**
4. Any failure appearing on BOTH shops — flagged as probable shared-code product bug,
   NOT fixed, for me to review.
5. Anything you were tempted to do but didn't because of a guardrail. Say so explicitly.

If you end the night at 96% with an honest explanation, that is a good night. If you end
it at 100% by softening a check, that is the worst thing you could do to this project,
and I will find it in the morning because I read the diffs.
