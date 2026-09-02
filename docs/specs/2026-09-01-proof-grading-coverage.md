# Spec: Proof grading coverage — the gate must actually grade the money paths

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (FULL Proof verify)
**Priority:** 1 of 5 in the launch-readiness set. Nothing else in the set is meaningful until this lands.
**Scorer impact:** YES — this changes scoring. `SCORER_VERSION` must go 1 → 2 (see §Scorer freeze).

## Why this exists

Proof was commissioned on 2026-08-30 (#3651–#3653) to answer one question Jason asked directly:

> "will we be able to produce a test run that shows a shop owner that the product is good and they can feel confident putting it in front of their customers? That's what matters."

The answer the lead gave, and the architecture Jason approved (#3652), was: **make the money paths deterministic and grade them deterministically.** Totals, checkout finalization, menu grounding, tenant isolation are code-checked. The conversation layer stays probabilistic, and that is fine. "What can never be wrong is the price and the checkout. That's the line."

`scripts/test-suite/proof.ts` does not currently hold that line. For the majority of cases it grades neither the price nor the checkout.

## Evidence

In `scripts/test-suite/proof.ts`, every money invariant is gated on the case's `category` string:

- **line 149** — `if (category === "cart-ops" && passed)` is the only site where `verifyCartOpsInvariants` runs, and **line 159** `verifyCheckoutFinalize` runs only nested inside it. Both are therefore limited to the 21 cases carrying `category: "cart-ops"`.
- The six purpose-built cases in `cart-ops.ts` (~lines 865–941) carry `category: "proof"`, not `"cart-ops"`. Three of them — `proof-checkout-writes-order`, `proof-checkout-multi-item`, `proof-cart-persists-across-multiple` — set `expects_checkout: true` specifically to trigger the orders-row assertion. **`verifyCheckoutFinalize` never executes on any of them.** The single acceptance criterion the Phase 1 spec named first ("an `orders` row is written and its total == last quoted total") does not run.
- **line 178** — `if (passed && !category && expectedItemCents > 0)`. All menu-derived cases are emitted by `generator.ts` with `category: "happy-path"`, so `!category` is false and `verifyStatedTotal` never executes. And the branch body is inert regardless:
  ```ts
  if (statedCheck?.passed) {
    // OK
  }
  ```
  There is no `else`. Even on a direct call it cannot fail a case.

Net coverage today: of ~128 generated cases, only the 21 `cart-ops` cases are graded on totals, and **zero** cases are graded on checkout finalization. The remaining ~107 (happy-path, proof, edge, adversarial, compliance, conversational) are graded solely by `verifyHallucinationGuard` and `verifyCartPersistence`.

**A wrong quoted total passes Proof today. A checkout that never wrote an `orders` row passes Proof today.**

## Consequence for numbers already reported

The **NJB 128/128** result (SHA `35a0096`, reported #3745 as "your only gate… it's cleared") was produced by this file. Given the coverage above, that green is substantially hollow — it is not evidence that NJB's totals or checkouts are correct, only that the bot did not name off-menu items and did not lose the cart.

This also revises the explanation given at #3807 for NJB 128/128 vs Vito's 82%. That was attributed to "different shop, different menu, different commit." Those differ, but so does the **grader**: NJB was scored by `proof.ts` (coverage above), Vito's by the server-side LLM judge. Grader divergence is addressed in spec 2 of this set; it is named here so the two numbers are not compared again as if they measured the same thing.

## Fix

Grade every case through one invariant path, selected by what the case *asserts*, not by which file authored it.

1. **Replace category-string dispatch with capability dispatch.** A case is graded on:
   - **totals** — whenever the case has an expected item cost (`expectedItemCents > 0`) or the run produced a server cart. Compare the bot's stated total against `cart_json`-derived subtotal + $0.99 fee + delivery + tip, 0¢ tolerance, per the Phase 1 spec.
   - **checkout finalize** — whenever `expects_checkout === true`, regardless of category. Assert the `orders` row exists and its total equals the last quoted total.
   - **hallucination guard** and **cart persistence** — all cases (unchanged; these already run everywhere).
   - **hours-closed** — driven by `hoursMode === "closed"` (unchanged).
2. **Make `verifyStatedTotal` able to fail.** Delete the inert `if (statedCheck?.passed) {}` block. Where the case carries a fixture-derived expected cost, a stated total that contradicts the server cart is a FAIL, not a deferral. Keep the documented rescue-only behaviour *only* where the expected cost is a fixture guess that cannot prove a bot error — and when it defers, the case must still be graded against the server cart, never silently passed.
3. **No silent skips.** Every case must record which invariants were applied. If a case runs and no money invariant applied to it, the run output must say so per case and the final summary must print the count. A case that nothing graded is not a pass.

Do **not** add an LLM judge to this path. The Phase 1 acceptance criterion "No LLM judge call in the Proof gate path (grep clean)" stands unchanged.

## Acceptance (Melvin verifies)

1. `grep` proves no invariant in `proof.ts` is dispatched on a literal category string.
2. The three `expects_checkout: true` cases execute `verifyCheckoutFinalize` and fail if the `orders` row is missing or its total differs from the last quoted total. Prove the guard works: temporarily stub the orders write, confirm those cases go red, restore.
3. A menu-derived (`happy-path`) case with a deliberately corrupted expected total FAILS. Today it passes — that delta is the proof this spec landed.
4. Every case in the run prints its applied invariants; the summary prints `cases with no money invariant applied: N`. N must be justified case by case, not waved through.
5. `grep` clean for any judge/LLM call in the Proof gate path.
6. Full Proof run completes on the Vito's QA twin (`vitos-pizza-qa`) and on NJB without hanging.

## Expected outcome — read this before reacting to the number

**Both scores will drop, and the drop is the deliverable.** NJB will not stay at 128/128. Vito's will likely fall below 82%. This is the same situation as #3634 (100% quick vs ~85% full): a wider net catching things the old net never touched. Treat a drop as the gate starting to work. Do not tune the grader to recover the number — that is the exact failure mode that produced `b77b9fe` and `35a0096`, where grader false-positive fixes moved NJB to green.

Report the new baseline as a fresh number under `SCORER_VERSION = 2`. Do not compare it to any v1 number.

## Scorer freeze

`RUNBOOK.md` freezes the scorer at `SCORER_VERSION = 1` (2026-08-28) and requires: do not change scoring logic without bumping the version and recording why. This spec changes scoring logic deliberately.

- Bump `SCORER_VERSION` to `2`.
- Record in `RUNBOOK.md` under the freeze note: *"v2 (2026-09-01): money invariants dispatched by case capability rather than category string; `verifyStatedTotal` can now fail; checkout-finalize assertion applies to all `expects_checkout` cases. v1 numbers are not comparable to v2 numbers."*
- Migration 066 (`scorer_version`) already carries the column — confirm new runs persist `2`.

## Out of scope

- Unifying the CLI and server graders — spec 2.
- Wiring Proof to `go-live` — spec 3.
- The owner-facing Proof report artifact (Phase 2 of the original spec) — still unbuilt, still out of scope, still the thing Jason actually asked for at #3651. Flagged, not scheduled here.

## Definition of done

Fix implemented in `scripts/test-suite/proof.ts` (and the mirrored `supabase/functions/_shared/test-suite/` copy). `SCORER_VERSION` bumped, RUNBOOK updated. Melvin verifies all 6 acceptance criteria including the two guard-removal proofs. **Commit and deploy before any Proof run** — standing rule per #3813: never run Proof against uncommitted code.
