# Spec — Harness false-positive fixes (FIX A + FIX B)

**From:** SprintAI_bot (lead). **To:** John Walsh (builder). **Date:** 2026-09-02 overnight.
**Authority:** product owner 22:57 message + INSTRUCTION-03. **Scope: TEST HARNESS ONLY.**

## Context (do not re-derive)
Both 128-runs analyzed. All 11 deterministic failures across Vito's (`5bf71e0f`) and NJB
(`eb255196`) are HARNESS false positives — **zero product bugs**. Evidence in
`docs/specs/2026-09-02-baseline-results.md`. Two mechanisms, two fixes below.

## HARD GUARDRAILS — violating any is worse than failing
1. **Do NOT touch `chat-sms` or any product code.** Harness files only (list below).
2. **Do NOT touch** Telnyx, safety gates, shop data, migrations unrelated to these fixes.
3. **Never weaken an invariant to make a case pass.** Every change that makes MORE cases pass
   must carry, in the commit message: (a) the false-positive mechanism, (b) the exact input that
   triggers it, (c) proof the invariant STILL FAILS on a true positive.
4. **Parity is mandatory.** Every logic change lands identically in BOTH copies:
   - `scripts/test-suite/cart-ops.ts` (local runners)
   - `supabase/functions/_shared/test-suite/cart-ops.ts` (deployed edge runner — this is the one
     the real 128-run uses via `supabase/functions/test-runner/index.ts`)
   After editing, diff the two files' changed regions and confirm they match.
5. **Two-attempt limit per fix.** If a fix isn't working after two honest attempts, STOP, write
   down what you tried and what you observed, and hand it back. Do not grind.
6. `SCORER_VERSION` currently 2. Both fixes change scoring semantics (removing false FAILs) →
   **bump to 3** in every place it is defined, and state why in the commit.
7. Return only: result, artifact paths, red-then-green evidence, open questions. No working notes.

---

## FIX A — `correction_reflected` false positive (kills 9 of 11)

### Mechanism
`isReduction`/`isRemoval` (cart-ops.ts ~149-159) infer reduction/removal intent from natural
language (bare `just `/`only `/`no`) in the transcript. On `conversational` cases (LLM-generated
turns) this misfires on orders, swaps, declines and pickup names — e.g. "Alright, just give me a
cheesesteak" (an ORDER), "No thanks, just the salad" (a decline), "just put it under Alex" (a
pickup name). It never even applies to the fixtured reduce cases it was written for.

### Correct fix — stop inferring intent from English; read it from the fixture
1. Add an explicit field to the TestCase fixture for cases that genuinely expect a cart shrink:
   `expectCartShrink?: boolean` (name your choice; be consistent). Set it `true` on the fixtured
   reduce/remove cases — at minimum `cartops-reduce-qty` (cart-ops.ts:1034) and `cartops-make-it-1`
   (:1073) — and on any other fixtured case whose defined turns are a real reduction/removal.
2. Thread that flag from the TestCase onto `RunResult` (it already carries `caseId`; add the flag
   the same way `expectedItemCents` is threaded). Do this in EVERY place RunResult is built:
   the edge runner (`supabase/functions/test-runner/index.ts`) and the local runners
   (`scripts/test-suite/run.ts`, `proof.ts`, `worker.ts`, `quick.ts` as needed).
3. In `verifyCartOpsInvariants`, gate `correction_reflected`:
   - If the case fixture declares `expectCartShrink === true`: run the existing shrink check
     (cart item count must drop after the correction turn). `applied: true`.
   - Otherwise: `correction_reflected` does NOT apply — `applied: false`, never FAIL. Do not run
     the NL correction regex on conversational/emergent transcripts at all.
4. You may delete or leave dormant `isCorrection`/`isReduction`/`isRemoval`/`isSwap` as intent
   inference — they must no longer gate a FAIL on non-fixtured cases.

### MANDATORY red-then-green (no exceptions)
- Construct/point a RunResult for `cartops-reduce-qty` where the cart does NOT shrink →
  `correction_reflected` must **FAIL** (RED). Show it.
- Same case where the cart DOES shrink → **PASS** (GREEN). Show it.
- A conversational case like `conv-topic-change-back` (a swap, no expected shrink) →
  `correction_reflected` `applied:false`, not FAIL.
If you cannot show RED on a true reduction, the fix is wrong — stop.

---

## FIX B — `verifyHallucinationGuard` grabs pronouns/fragments (kills 2 of 11)

### Mechanism
`addPat` (cart-ops.ts:349) captures text after "added" as an item name without validating it IS
one, then flags it as a hallucinated menu item. Observed false positives:
- Vito `menu-combo`: `"those"` from `"I've added those…"`.
- Vito `menu-single-500`: `"to your cart. Want anything else"` (a sentence fragment).

### Correct fix — extract real item names, not pronouns/fragments
Apply the SAME guard already used for the `got it X` pattern to the `added X` pattern (and audit
the other claim patterns for the same hole):
- Skip the candidate if `isQuestionOrFragment(candidate)` returns true.
- Add a pronoun/determiner stoplist: `those, them, they, it, that, this, these, one, some, a few,
  your, my` (extend as needed). A candidate that is (or starts with) one of these is NOT an item
  claim → skip (don't count, don't flag).
- A candidate containing a mid-sentence boundary ("your cart", "anything else", "want", trailing
  clause) is a fragment → skip.
Reuse/extend the existing `isQuestionOrFragment` helper and its unit file
`scripts/test-suite/verify-fragment-guard.ts` rather than inventing a parallel mechanism.

### MANDATORY red-then-green (no exceptions)
- Add unit assertions (in `verify-fragment-guard.ts` or a sibling): the two FP strings above →
  now SKIPPED (guard returns "not an item claim"). GREEN.
- A REAL hallucination must still be caught: feed a reply like
  `"I've added a Rattlesnake Pizza to your cart"` against a menu WITHOUT that item →
  `verifyHallucinationGuard` must still return **FAIL** (RED preserved). Show it.
If the real hallucination no longer fails, the fix is too broad — stop.

---

## NOT IN THIS SPEC (leave alone tonight)
- FIX C safety invariants (tenant-isolation-no-leak, stop-opt-out-honored, no-wrong-price-charge):
  DEFERRED to a separate supervised dispatch. Do not build them here.
- The single-turn `menu-cat-*` ungraded gap: a morning decision, not a fix. Do not touch.
- chat-sms: forbidden.

## Definition of done (hand back to Melvin, then lead)
- Both cart-ops.ts copies changed identically; changed regions diffed and confirmed in parity.
- `SCORER_VERSION` bumped to 3 everywhere it's defined, reason in commit.
- Red-then-green shown for BOTH fixes (paste the actual runner/unit output + exit code).
- `deno check` (or repo's typecheck) passes on changed files — show exit 0.
- Commit message carries the (a)/(b)/(c) proof from guardrail 3 for each fix.
- No diff outside the harness file list. Confirm `git diff --stat` touches only harness files.

---

## KNOWN-ACCEPTED FALSE POSITIVES — do not chase (Jason decision, 2026-09-02)

Four deterministic-invariant false positives are **ACCEPTED as-is**. They are not bugs to fix.
Do not re-open them, do not "improve" the invariant to catch them, do not rediscover them in a
month and start churning. 98% with four documented, stable false positives is a better gate than
one we keep destabilizing.

**Root cause (all four, same disease):** the invariant is doing natural-language inference.
Every attempt to fix a case in this class has produced a NEW false positive elsewhere. The class
is net-negative to touch.

| # | Shop / case | Invariant | What it misreads |
|---|---|---|---|
| 1 | Vito 510 | `stated-total` | reads a price inside a *clarifying question* as a quoted total |
| 2 | Vito 517 | `stated-total` | same — price in a clarifying question treated as quote |
| 3 | NJB `conv-multi-with-off-menu` | `correction_reflected` | misclassifies the correction turn |
| 4 | NJB `conv-upsell-accepted` | `correction_reflected` | misclassifies the upsell-accept turn |

**Rule:** if a change would flip any of these four, that change is out of scope — stop.
Any new work on `stated-total` / `correction_reflected` must first prove it does NOT re-touch
these cases. Gate is 98% with these four known-accepted.
