# Launch-readiness spec set — cover note and execution order

**Date:** 2026-09-01
**Origin:** Independent review of `sprintai-ordering` at `5721895`, requested by Jason before Erin takes the demo kit out.
**For:** SprintAI lead (Opus) to dispatch. Build = John Walsh. Verify = Melvin.

## The one-line version

Several things the repo documents as hard gates are not wired. The most consequential is Proof itself: **it does not currently grade the totals or the checkouts** for the large majority of its cases. Everything else in this set follows from fixing that.

## The five specs

| # | Spec | What it fixes | Blocks |
|---|------|---------------|--------|
| 1 | `2026-09-01-proof-grading-coverage.md` | Proof's money invariants are dispatched on a category string and skip ~107 of ~128 cases. Checkout-finalize never runs at all. | 2, 3 |
| 2 | `2026-09-01-proof-single-grader.md` | Two divergent graders. The autonomous one that produces the owner-facing number is the LLM judge. | 3 |
| 3 | `2026-09-01-go-live-gates.md` | `go-live` enforces none of: Proof pass, first-delivery test, ticket destination. | — |
| 4 | `2026-09-01-order-ticket-reliability.md` | A paid order can silently never reach the kitchen, two ways, unmonitored. | — |
| 5 | `2026-09-01-campaign-assignment-gate.md` | Numbers can go live never assigned to the 10DLC campaign; `provision-campaign` doesn't exist. | — |

**Order:** 1 → 2 → 3 sequentially, because each depends on the one before. 4 and 5 are independent and can run in parallel with the whole chain.

## Standing constraints every spec in this set respects

These are Jason's prior decisions, not new opinions. They are restated here so no spec in the set is executed in a way that violates one.

1. **No LLM grading an LLM in the Proof gate path.** Phase 1 spec, marked non-negotiable, with the reason stated: a probabilistic judge over a probabilistic bot produces a score that moves on its own and can never be a real gate.
2. **The QA suite is generated and run by the site, not by the lead.** Permanent boundary, 2026-08-30: *"You can have no role in onboarding or operations."* This is why spec 2 puts the deterministic grader inside `test-runner` rather than fixing only the CLI.
3. **Commit → deploy → Proof. Never Proof against uncommitted code.** Standing rule, 2026-08-31, after stale-log confusion produced two contradictory answers in one evening.
4. **Money paths deterministic, conversation probabilistic.** The approved architecture: totals, checkout, menu grounding, tenant isolation are code-guaranteed. Tone and phrasing are not defects. "What can never be wrong is the price and the checkout."
5. **Scorer freeze discipline.** `SCORER_VERSION` is frozen at 1. Specs 1 and 2 change scoring deliberately and jointly bump it to 2 with a recorded reason. No other scoring change rides along.
6. **Don't touch the Telnyx campaign.** `CSMB9HG` is TCR_ACCEPTED across all seven carriers. Spec 5 reads mapping status only.

## What to expect, so it isn't misread as regression

**The Proof score will drop, on every shop, including NJB.** That drop is the deliverable, not a failure.

The NJB **128/128** reported on 2026-08-30 was produced by the CLI grader described in spec 1 — which, for happy-path cases, checks only that the bot named no off-menu item and did not lose the cart. It did not verify a single total or a single checkout. That number should not be carried forward as evidence, and should not be defended.

It also means the NJB-128/128 vs Vito's-82% comparison has a third explanation nobody has been accounting for. Different shop and different menu are real, but the two numbers also came from **different graders**. They were never measuring the same thing.

The instinct to close the gap by fixing the grader should be resisted hard. It has already happened twice — `b77b9fe` and `35a0096` are both grader false-positive fixes that moved NJB toward green. Under specs 1 and 2, grader changes require a `SCORER_VERSION` bump and a written reason, which is the point of the freeze.

## What this set does not cover

- **The owner-facing Proof report.** Phase 2 of the original spec, still unbuilt. This is the thing Jason actually asked for on 2026-08-30: a report an owner can look at and feel confident putting the bot in front of their customers. The gate is the engine; the report is the product. Worth scheduling as soon as the gate is trustworthy — an untrustworthy report is worse than none.
- **An order queue in the owner dashboard.** Until it exists, email is a single channel (spec 4 makes its failure visible, not impossible).
- **Monitoring generally.** Today `issue-detector` watches conversation quality. Nothing watches ticket failures (spec 4 adds one), Stripe webhook failures, `chat-sms` 5xx, or iMessage bridge liveness. Worth its own spec.
- **The iMessage bridge as a single point of failure.** `+14842018054` routes through a bash script polling Messages.app under launchd on one Mac. Vito's demo correctly uses the Telnyx 610, so the demo kit is not exposed — but confirm the NJB kit doesn't hand out the bridge number.

## Two loose ends worth an hour, not a spec

- **Migration `071_fix_order_type_default.sql` is uncommitted** while the fix that depends on it (`5721895`, 2026-09-01) is committed and deployed. Confirm it is applied in prod, then commit it. This is the same crash-loses-it exposure flagged on 2026-08-31, recurring.
- Three untracked QA scripts sitting in the working tree (`qa-adversarial-delivery.ts`, `qa-adversarial-delivery-v2.ts`, `qa-checkout-fix.ts`). Commit or delete.

## The honest bottom line for the launch decision

The engineering underneath this is strong. The outbound guard, the deterministic grounding intercepts, `cart_json` as single source of truth, the fail-closed delivery zone, the scorer freeze — these are the right instincts, consistently applied.

The gap is not in the building. It is that the gate meant to prove the building works is not yet measuring the two things that matter most, and the gates meant to stop a broken shop from launching are documented but not wired.

Right now, "this shop has been Proofed" is a claim the code does not yet support. Specs 1 and 3 are what make it true. Those two are the ones to treat as non-negotiable before a first restaurant takes a real order — the rest can follow behind a controlled first launch.
