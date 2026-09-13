# Defect classes — the register

**Purpose:** stop fixing the same bug five times.

A *defect class* is a root cause with more than one instance. When a root cause
is identified, it is registered HERE, with a runnable detection command, and
**every known site is swept before the fix is accepted** — not just the site
that happened to surface.

## The standing rule

> A root-cause fix is not accepted until the sweep output is attached: every
> site matching the class, each marked AFFECTED or SAFE with one line of why.
>
> "I fixed the reported instance" is a symptom fix. It gets rejected.

This is the PO's job to enforce and the PO failed to enforce it on
2026-09-11/12: class C1 below was correctly diagnosed on 09-11, written into a
dispatch as "find them all, not just this one", never swept, and then rediscovered
four more times by accident over the next day.

---

## C1 — Identity judged on rendered text instead of an id

**Diagnosed:** 2026-09-11, from the Vito's double-charge P0.
**Shape:** two pieces of OUR OWN data are compared by a human-readable string
when a stable id exists. A rename, a reformat or a transpile silently breaks the
link. It fails quietly — no error, no exception, just wrong behaviour.

**Instances found (5 in 2 days):**

| # | Site | Symptom |
|---|---|---|
| 1 | cart-line dedup | same item added twice, $29.98 for one $14.99 salad |
| 2 | judge `invented_item` | correct natural phrasing scored as a hallucination |
| 3 | harness hallucination-guard | "they're already set" read as an item name |
| 4 | judge ground truth | the $0.99 platform fee read as an invented charge |
| 5 | deploy gate step 6 | type-stripped bundle can never byte-match source |

**Detection:**

```bash
# our-data-to-our-data comparisons keyed on a name string
grep -rnE "(item_name|\.name|display_name)[^=]*(===|!==|\.includes\()" \
  --include="*.ts" supabase/functions scripts \
  | grep -viE "test\.ts|^\s*//" \
  | grep -iE "dedup|dupl|same|match|identit|exist|already|find|resolve"
```

**Triage rule.** Matching the CUSTOMER'S words against menu text is legitimate —
text is the only input available at that boundary. Comparing two records we own
is not. If both sides have an id, compare ids.

**Known remaining exposure (2026-09-12, unswept):** ~10 sites of the form
`option_groups.find(g => g.name === groupName)`,
`modifiers_json.find(m => m.name === modName)`,
`itemGroups.find(g => g.name === name)?.id`.
Each breaks if an owner renames an option group. Owners rename things — the
09-12 `display_name` rename is what exposed C1 instance #1. **Sweep required.**

---

## C2 — Shipped, reported done, had no effect

**Diagnosed:** 2026-09-12.
**Shape:** code lands and is reported complete while a switch, a wiring step or
a deploy never happened. Indistinguishable from success unless verified against
the running system.

**Instances found (4 in 2 days):**

| # | Site | Why it did nothing |
|---|---|---|
| 1 | NJB compiled engine | built, deployed, flag never set |
| 2 | test runner `--cases` | equals-form silently ignored; ran 151 as 10 |
| 3 | GUARD 2b delivery fix | read a field the query never selected (TS2339) |
| 4 | `resolver.ts` | 603 lines, 597 lines of tests, zero imports |

**Countermeasures now in place:** `scripts/deploy-function.sh` (type-check, unit
tests, version-moved, artifact check) and `scripts/check-switches.sh`.

**Detection:** never accept a commit hash as evidence. Fetch the live artifact,
read the flag from the live DB, and reproduce the original defect.

---

## C3 — The measurement is wrong, and we react to it anyway

**Diagnosed:** 2026-09-12.
**Shape:** a metric is trusted as signal while its instrumentation is broken.
Work is then aimed at the metric instead of the product.

**Instances:** the suite's Quality score measured 40/50/70/60/90% on IDENTICAL
Vito's code across five runs. Every point of movement was judge or harness bugs:
ungraded counted as failed, self-negating flags, no knowledge of test mode or
the platform fee, truncated conversations scored as give-ups, scripted customers
that never answer the question.

**Countermeasure:** Proof, critical-pass and the money checks are the numbers.
Before reacting to a metric move, confirm the instrument changed nothing. Noise
on this suite is ±20 points; a 10-point move is not signal.

---

## C4 — Confirmation word anywhere licensed an irreversible action

**Diagnosed:** 2026-09-12, from the three-accept-call doubling P0 and the
"You already know my name." Vito's double-charge.
**Shape:** the model sees a confirmation-shaped word anywhere in the turn and
independently decides to add/re-add an item — once per model path that "noticed"
the signal. Each individual call is valid in isolation; the AGGREGATE is wrong
(three valid "accept" calls → three pizzas). No per-call validator can catch it.

**Instances found:**

| # | Trigger phrase | Effect |
|---|---|---|
| 1 | "yes" (C2b-regular offer confirm) | model AND shortcut each proposed the same item → qty 2 |
| 2 | "yes to Jason, can you add fries" | three model-side accept calls → qty 3 instead of 1 |
| 3 | "You already know my name." | unrelated reply re-triggered add_item on existing pizza → qty doubled |
| 4 | "pickup" | add_item re-fired on pending-option item → qty grew while option still open |

**Structural fix (2026-09-12):** `turn-reconciler.ts` — a pure function
`reconcileAddProposals(preTurnCart, loopFinalCart, proposals[], customerText)`
that owns the aggregate add/merge/no-op/drop decision for a whole turn. Replaces
GUARD 9, GUARD 13, GUARD 20, and GUARD 21, which were four narrower patches for
the same aggregation gap. See turn-reconciler.ts header for design.

**Closed:** 2026-09-12. Guards 9/13/20/21 retired; call sites removed from
`index.ts`; tombstones left for archaeological purposes.

**Detection:**

```bash
# look for per-call add guards that re-implement what the reconciler now owns
grep -rn "computeGuard\(9\|13\|20\|21\)" supabase/functions/chat-sms/index.ts
# should return nothing; any hit means a guard was re-introduced without retiring the reconciler
```
